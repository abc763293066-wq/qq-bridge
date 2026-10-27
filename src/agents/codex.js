import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppServerRpc, AgentError } from './rpc.js';
import { canonicalConversationKey } from '../core/session-router.mjs';

export function childEnvironment(parent = process.env) {
  const env = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
    'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT', 'SSL_CERT_FILE', 'CODEX_CA_CERTIFICATE',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'OPENAI_API_KEY']) {
    if (parent[key]) env[key] = parent[key];
  }
  return env;
}

export function codexPolicy(localTools, cwd) {
  return {
    approvalPolicy: 'on-request', approvalsReviewer: 'user',
    sandbox: localTools ? 'workspace-write' : 'read-only',
    config: {
      'features.shell_tool': localTools,
      'features.apps': false, 'features.plugins': false, 'features.hooks': false,
      'features.memories': false, 'features.goals': false,
      'features.multi_agent': false, 'agents.enabled': false,
      'features.request_permissions_tool': false,
      'web_search': 'disabled', 'shell_environment_policy.inherit': 'none',
    },
    sandboxPolicy: localTools
      ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false,
        readOnlyAccess: { type: 'restricted', includePlatformDefaults: true, readableRoots: [cwd] } }
      : { type: 'readOnly', access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [cwd] } },
  };
}

// A single adapter owns exactly one QQ conversation and one child process.
// Contract: run(text, onProgress), cancel(), reset(), close(). DSH retains its
// richer legacy runtime behind the provider registry instead of emulating its
// mux/approval/preset semantics with lossy Codex-shaped RPCs.
export class CodexAdapter {
  constructor({ key, config, stateDir, rpcFactory = (options) => new AppServerRpc(options) }) {
    if (canonicalConversationKey(key) !== key) throw new AgentError('INVALID_CONVERSATION');
    this.key = key;
    this.config = config;
    this.stateDir = stateDir;
    this.rpcFactory = rpcFactory;
    this.cwd = path.join(stateDir, 'workspaces', key.replace(':', '-'));
    this.file = path.join(stateDir, key.replace(':', '-') + '.json');
    this.localTools = config.codex.ownerLocalTools === true && key === `private:${config.ownerQQ}`;
    this.policy = codexPolicy(this.localTools, this.cwd);
    this.fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      key, cwd: this.cwd, home: config.codex.home, model: config.codex.model,
      effort: config.codex.effort, mcp: config.codex.ownerMcp, policy: this.policy,
    })).digest('hex');
  }

  async connect() {
    if (this.rpc && !this.rpc.failed && !this.rpc.closing) return;
    fs.mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    const rpc = this.rpc = this.rpcFactory({ binary: this.config.codex.binary,
      home: this.config.codex.home, cwd: this.cwd, env: childEnvironment(), overrides: this.policy.config,
      requestTimeoutMs: this.config.codex.requestTimeoutMs });
    rpc.on('request', (message) => this.denyRequest(message));
    await rpc.request('initialize', { clientInfo: { name: 'qq_bridge', title: 'QQ Bridge', version: '0.2.1' } });
    rpc.notify('initialized');
    const effective = await rpc.request('config/read', { includeLayers: false, cwd: this.cwd });
    if (!effective?.config) throw new AgentError('PROTOCOL_INVALID');
    const mcpDisabled = {};
    if (!(this.localTools && this.config.codex.ownerMcp === true)) {
      for (const name of Object.keys(effective.config.mcp_servers ?? {})) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new AgentError('MCP_CONFIG_INVALID');
        mcpDisabled[`mcp_servers.${name}.enabled`] = false;
      }
    }
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new AgentError('STATE_INVALID'); }
    if (saved && (saved.version !== 1 || saved.key !== this.key || typeof saved.threadId !== 'string')) {
      throw new AgentError('STATE_INVALID');
    }
    const { sandboxPolicy, ...policy } = this.policy;
    const params = { ...policy, config: { ...policy.config, ...mcpDisabled }, cwd: this.cwd,
      ...(this.config.codex.model ? { model: this.config.codex.model } : {}) };
    // A changed permission/model/home configuration starts a new conversation.
    // Resume errors are explicit: never silently replace a missing history.
    const result = saved?.fingerprint === this.fingerprint
      ? await this.retryRejected('thread/resume', { ...params, threadId: saved.threadId, excludeTurns: true })
      : await this.retryRejected('thread/start', params);
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new AgentError('PROTOCOL_INVALID');
    if (result.approvalPolicy !== 'on-request' || result.approvalsReviewer !== 'user'
      || result.sandbox?.type !== (this.localTools ? 'workspaceWrite' : 'readOnly')) {
      throw new AgentError('POLICY_MISMATCH');
    }
    this.threadId = threadId;
    const temporary = this.file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, key: this.key,
        threadId, fingerprint: this.fingerprint }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }

  async retryRejected(method, params) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.rpc.request(method, params); }
      catch (error) {
        // Only an explicit server overload rejection proves non-acceptance.
        // Timeouts/disconnects and failed turns can already have tool effects.
        if (error.rpcCode !== -32001 || attempt >= this.config.codex.retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt + Math.random() * 100));
      }
    }
  }

  denyRequest({ id, method }) {
    try {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
        this.rpc.respond(id, { decision: 'decline' });
      } else if (method === 'item/permissions/requestApproval') {
        this.rpc.respond(id, { permissions: {}, scope: 'turn' });
      } else if (method === 'mcpServer/elicitation/request') {
        this.rpc.respond(id, { action: 'decline', content: null });
      } else if (method === 'item/tool/requestUserInput') {
        this.rpc.respond(id, { answers: {} });
      } else this.rpc.unsupported(id);
      this.progress?.({ type: 'approvalDenied' });
    } catch { /* A closed connection has already failed the active turn. */ }
  }

  async run(text, onProgress = () => {}) {
    if (this.running) throw new AgentError('SESSION_BUSY');
    this.running = true;
    let timer, rpc, listener, disconnect;
    try {
      // Bound initialization, resume, start and execution with one wall clock.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new AgentError('TURN_TIMEOUT'));
          void this.cancel();
        }, this.config.codex.turnTimeoutMs);
      });
      const work = (async () => {
        await this.connect();
        rpc = this.rpc;
        const items = new Map();
        const deltas = new Map();
        let early = [], bytes = 0;
        let resolveDone, rejectDone;
        const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
        // Attach a handler before awaiting turn/start (events can precede its reply).
        done.catch(() => {});
        this.progress = onProgress;
        const handle = ({ method, params = {} }) => {
          if (params.threadId !== this.threadId) return;
          const turnId = params.turnId ?? params.turn?.id;
          if (turnId && turnId !== this.turnId) return;
          if (method === 'item/agentMessage/delta') {
            const delta = String(params.delta ?? '');
            bytes += Buffer.byteLength(delta);
            if (bytes > 128 * 1024) return rejectDone(new AgentError('OUTPUT_TOO_LARGE'));
            deltas.set(params.itemId, (deltas.get(params.itemId) ?? '') + delta);
            onProgress({ type: 'delta', text: delta });
          }
          if (method === 'item/started' && ['commandExecution', 'mcpToolCall', 'fileChange', 'webSearch'].includes(params.item?.type)) {
            onProgress({ type: 'tool', tool: params.item.type });
          }
          if (method === 'item/completed' && params.item?.type === 'agentMessage') {
            const item = params.item;
            bytes += Buffer.byteLength(item.text ?? '');
            if (bytes > 256 * 1024) return rejectDone(new AgentError('OUTPUT_TOO_LARGE'));
            items.set(item.id, item);
          }
          if (method === 'turn/completed') {
            if (params.turn?.status !== 'completed') return rejectDone(new AgentError(
              params.turn?.status === 'interrupted' ? 'TURN_INTERRUPTED' : 'TURN_FAILED'));
            const final = [...items.values()].filter((item) => item.phase === 'final_answer');
            const selected = final.length ? final : [...items.values()].filter((item) => item.phase !== 'commentary');
            resolveDone(selected.length ? selected.map((item) => item.text).join('\n') : [...deltas.values()].join('\n'));
          }
        };
        listener = (message) => {
          if (!this.turnId) {
            if (early.length >= 256) return rejectDone(new AgentError('PROTOCOL_BACKLOG'));
            early.push(message);
          } else handle(message);
        };
        disconnect = (error) => rejectDone(error);
        rpc.on('notification', listener);
        rpc.on('disconnect', disconnect);
        this.turnId = null;
        const result = await this.retryRejected('turn/start', { threadId: this.threadId,
          input: [{ type: 'text', text }], cwd: this.cwd,
          approvalPolicy: this.policy.approvalPolicy, sandboxPolicy: this.policy.sandboxPolicy,
          ...(this.config.codex.effort ? { effort: this.config.codex.effort } : {}) });
        this.turnId = result?.turn?.id;
        if (!this.turnId) throw new AgentError('PROTOCOL_INVALID');
        for (const message of early) handle(message);
        early = [];
        return await done;
      })();
      return await Promise.race([work, deadline]);
    } catch (error) {
      await this.cancel();
      throw error;
    } finally {
      clearTimeout(timer);
      if (rpc) { rpc.off('notification', listener); rpc.off('disconnect', disconnect); }
      this.progress = null;
      this.turnId = null;
      this.running = false;
    }
  }

  async cancel() {
    const rpc = this.rpc;
    if (!rpc) return;
    if (this.turnId && !rpc.failed && !rpc.closing) {
      try { await rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 1000); } catch {}
    }
    await rpc.close();
    rpc.emit('disconnect', new AgentError('TURN_INTERRUPTED'));
    if (this.rpc === rpc) this.rpc = null;
  }

  async reset() {
    if (this.rpc) await this.cancel();
    try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.threadId = null;
  }
  async close() { await this.cancel(); }
}
