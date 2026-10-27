import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { CodexAdapter } from './agents/codex.js';
import { validateCodexConfig, allowedConversation } from './agents/config.js';
import { canonicalConversationKey } from './core/session-router.mjs';
import { SENSITIVE_RE } from './sensitive.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { hardenDir } from './state-acl.mjs';

export function safeReply(value, secrets = []) {
  const text = String(value ?? '').slice(0, 32000);
  if (SENSITIVE_RE.test(text) || /sk-[a-zA-Z0-9_-]{16,}/.test(text)
    || secrets.some((secret) => secret && text.includes(secret))) {
    return '回复包含可能敏感的信息，已阻止发送。请在受信任的主机上查看。';
  }
  return text;
}

// This host owns QQ authorization, bounded FIFO scheduling and output gates.
// The agent adapter only receives the already-authorized conversation text.
export class CodexQQHost {
  constructor({ config, bot, stateDir, adapterFactory = (options) => new CodexAdapter(options), log = console.error }) {
    this.config = validateCodexConfig(config);
    this.bot = bot;
    this.stateDir = stateDir;
    this.adapterFactory = adapterFactory;
    this.log = log;
    this.sessions = new Map();
    this.seen = new Map();
    this.secrets = [config.snowluma?.accessToken, config.dsh?.authToken, config.consoleToken,
      process.env.OPENAI_API_KEY, config.codex.home, stateDir];
    this.sweeper = setInterval(() => { void this.evictIdle(); }, 30000);
    this.sweeper.unref();
  }

  async send(key, content) {
    if (this.stopping || !allowedConversation(this.config, key)) return;
    const [kind, value] = key.split(':');
    const safe = safeReply(content, this.secrets);
    for (const part of splitForQQ(mdToPlain(safe), 3000)) {
      // Text segments prevent model-controlled CQ strings becoming actions.
      const message = [{ type: 'text', data: { text: part } }];
      if (kind === 'group') await this.bot.sendGroupMessage(Number(value), message, { timeoutMs: 10000 });
      else await this.bot.sendPrivateMessage(Number(value), message, { timeoutMs: 10000 });
    }
  }

  async incoming(kind, event) {
    if (this.stopping || event?.post_type === 'message_sent') return;
    const sender = canonicalConversationKey(`private:${event?.user_id}`);
    const self = canonicalConversationKey(`private:${event?.self_id}`);
    if (!sender || !self || sender === self || event?.anonymous) return;
    const key = canonicalConversationKey(`${kind}:${kind === 'group' ? event.group_id : event.user_id}`);
    if (!key || !allowedConversation(this.config, key)) return;
    // Only structured text/@ segments are accepted. Never execute CQ/raw_message.
    const segments = Array.isArray(event.message) ? event.message : [];
    let text = segments.filter((s) => s?.type === 'text').map((s) => String(s.data?.text ?? '')).join('').trim();
    if (!text) return;
    const owner = sender === canonicalConversationKey(`private:${this.config.ownerQQ}`);
    const control = /^\/(reset|cancel|status)$/.exec(text)?.[1];
    if (text.startsWith('/') && !text.startsWith('/codex ') && !control) return;
    if (control && !owner) return;
    const mention = segments.some((s) => s?.type === 'at' && String(s.data?.qq) === String(event.self_id));
    if (kind === 'group' && this.config.codex.groupRequireMention && !mention && !text.startsWith('/codex ') && !control) return;
    text = text.replace(/^\/codex\s+/, '');
    if (text.length > this.config.codex.maxInputChars) { await this.send(key, '消息过长，请缩短后重试。'); return; }
    if (event.message_id === undefined || event.message_id === null) return;
    const dedupe = `${key}:${event.message_id}`;
    const now = Date.now();
    for (const [id, at] of this.seen) if (now - at > 600000) this.seen.delete(id);
    if (this.seen.has(dedupe)) return;
    this.seen.set(dedupe, now);
    if (this.seen.size > 4000) this.seen.delete(this.seen.keys().next().value);
    let session = this.sessions.get(key);
    if (session?.controlling) return;
    if (control === 'status') { await this.send(key, session?.busy ? 'Codex 正在处理消息。' : 'Codex 空闲。'); return; }
    if (control === 'cancel' || control === 'reset') {
      if (session) {
        session.controlling = true;
        session.generation++;
        try {
          await session.adapter.cancel();
          await session.tail; // Prevent a queued prompt from recreating a reset session.
          if (control === 'reset') await session.adapter.reset();
        } finally { session.controlling = false; }
      } else if (control === 'reset') {
        await this.adapterFactory({ key, config: this.config, stateDir: this.stateDir }).reset();
      }
      await this.send(key, control === 'reset' ? '已重置此会话。' : '已停止此会话的任务。');
      return;
    }
    if (!session) {
      // Reserve synchronously, before the first await. A simultaneous reset or
      // message must observe the same session instead of creating a second one.
      void this.evictIdle();
      session = this.sessions.get(key);
    }
    if (!session) {
      if (this.sessions.size >= this.config.codex.maxSessions) { await this.send(key, '当前会话数已达上限，请稍后重试。'); return; }
      session = { adapter: this.adapterFactory({ key, config: this.config, stateDir: this.stateDir }),
        tail: Promise.resolve(), busy: 0, generation: 0, at: now };
      this.sessions.set(key, session);
    }
    if (session.busy >= this.config.codex.maxQueue) { await this.send(key, '此会话消息队列已满，请稍后重试。'); return; }
    session.busy++;
    const generation = session.generation;
    const task = session.tail.then(async () => {
      if (this.stopping || generation !== session.generation || !allowedConversation(this.config, key)) return;
      let progressAt = 0, progressCount = 0;
      // Progress uses fixed labels only; partial text, tool arguments, paths and
      // tool results are not safe to forward before whole-message auditing.
      const progress = ({ type }) => {
        if (this.stopping || generation !== session.generation) return;
        if (!this.config.codex.progress || Date.now() - progressAt < 5000 || progressCount >= 3) return;
        progressAt = Date.now(); progressCount++;
        const message = type === 'tool' ? 'Codex 正在调用工具…'
          : type === 'approvalDenied' ? '需要新增权限的操作已拒绝。' : 'Codex 正在生成回复…';
        void this.send(key, message).catch(() => {});
      };
      try {
        const reply = await session.adapter.run(`[QQ sender ${event.user_id}]\n${text}`, progress);
        if (!this.stopping && generation === session.generation) await this.send(key, reply || 'Codex 已完成，本轮没有文本回复。');
      } catch (error) {
        const code = /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'AGENT_FAILED';
        this.log(JSON.stringify({ event: 'agent_failed', conversation: crypto.createHash('sha256').update(key).digest('hex').slice(0, 12), code }));
        if (!this.stopping && generation === session.generation) {
          await this.send(key, `Codex 本轮未完成（${code}）。为避免重复执行，未自动重放；请确认任务状态后再试。`);
        }
      }
    }).finally(() => { session.busy--; session.at = Date.now(); });
    session.tail = task.catch(() => { this.log('{"event":"qq_send_failed"}'); });
    return session.tail;
  }

  async evictIdle() {
    const closing = [];
    for (const [key, session] of this.sessions) {
      if (!session.busy && Date.now() - session.at > this.config.codex.idleTimeoutMs) {
        this.sessions.delete(key);
        closing.push(session.adapter.close());
      }
    }
    await Promise.allSettled(closing);
  }

  async close() {
    this.stopping = true;
    clearInterval(this.sweeper);
    this.bot.close();
    for (const session of this.sessions.values()) session.generation++;
    await Promise.allSettled([...this.sessions.values()].map((s) => s.adapter.close()));
    await Promise.allSettled([...this.sessions.values()].map((s) => s.tail));
    this.sessions.clear();
  }
}

export async function startCodexBridge({ config, root }) {
  config = validateCodexConfig(config);
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const hardened = hardenDir(state);
  if (!hardened.ok) throw new Error('State directory permissions could not be hardened');
  const lock = path.join(state, 'bridge.lock');
  // Compatible with DSH's PID lock, so switching providers cannot start two bots.
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid bridge lock');
    // Do not unlink a stale lock automatically: concurrent starters could
    // otherwise remove the newly acquired lock of another process.
    const error = new Error('bridge.lock exists; stop the running bridge or remove a confirmed stale lock');
    error.code = 'BRIDGE_ALREADY_RUNNING';
    throw error;
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const release = () => {
    try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {}
  };
  let host;
  try {
    const bot = new SnowLumaWebSocketClient({ url: config.snowluma.wsUrl,
      accessToken: config.snowluma.accessToken || undefined, reconnect: true, requestTimeoutMs: 10000 });
    host = new CodexQQHost({ config, bot, stateDir: path.join(state, 'codex') });
    bot.onPrivateMessage((event) => { void host.incoming('private', event).catch(() => console.error('QQ private event failed')); });
    bot.onGroupMessage((event) => { void host.incoming('group', event).catch(() => console.error('QQ group event failed')); });
    bot.on('error', () => console.error('OneBot connection error; check gateway/token'));
    bot.on('open', () => console.error('OneBot connected; agent provider: codex'));
    void bot.connect().catch(() => console.error('OneBot unavailable; reconnecting'));
    let closing;
    const close = () => closing ??= host.close().finally(release);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close(); });
    process.once('exit', release);
    process.once('uncaughtException', () => { process.exitCode = 1; void close(); });
    process.once('unhandledRejection', () => { process.exitCode = 1; void close(); });
    return { close };
  } catch (error) { if (host) await host.close(); release(); throw error; }
}
