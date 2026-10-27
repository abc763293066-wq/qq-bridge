import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AppServerRpc, AgentError } from '../src/agents/rpc.js';
import { CodexAdapter, childEnvironment } from '../src/agents/codex.js';
import { validateCodexConfig, providerName } from '../src/agents/config.js';
import { startProvider } from '../src/agents/providers.js';
import { CodexQQHost, safeReply } from '../src/codex-bridge.js';

const root = fileURLToPath(new URL('..', import.meta.url));
fs.mkdirSync(path.join(root, 'state'), { recursive: true });
const ownedDirectories = [];
const temporary = () => {
  const directory = fs.mkdtempSync(path.join(root, 'state', 'test-agents-'));
  ownedDirectories.push(directory);
  return directory;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function configuration(directory) {
  return validateCodexConfig({ ownerQQ: 42, allow: { private: [42, 43], groups: [7, 8] }, deny: {},
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'onebot-secret-value' },
    codex: { home: directory, turnTimeoutMs: 1000, requestTimeoutMs: 100, retries: 1, progress: true } });
}

class FakeRpc extends EventEmitter {
  calls = [];
  thread = 'thread-one';
  turns = 0;
  constructor(behavior = {}) { super(); Object.assign(this, behavior); }
  notify(method) { this.calls.push({ method }); }
  respond(id, result) { this.calls.push({ id, result }); }
  unsupported(id) { this.calls.push({ id, unsupported: true }); }
  async request(method, params) {
    this.calls.push({ method, params });
    if (this.reject?.(method)) throw new AgentError('RPC_TIMEOUT');
    if (method === 'initialize') return {};
    if (method === 'config/read') return { config: { mcp_servers: { qq: { command: 'not-run' } } } };
    if (method.startsWith('thread/')) return { thread: { id: params.threadId ?? this.thread },
      approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: { type: params.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly' } };
    if (method === 'turn/start') {
      if (this.overloaded) { this.overloaded = false; const e = new AgentError('RPC_REJECTED'); e.rpcCode = -32001; throw e; }
      const id = `turn-${++this.turns}`;
      const emit = (method, extra) => this.emit('notification', { method, params: { threadId: this.thread, turnId: id, ...extra } });
      // Deliberately emit before the request response, including another turn
      // and another thread, to catch cross-turn leakage and event races.
      this.emit('notification', { method: 'item/completed', params: { threadId: 'foreign', turnId: id,
        item: { id: 'wrong', type: 'agentMessage', text: 'OTHER CHAT SECRET' } } });
      emit('item/completed', { turnId: 'stale-turn', item: { id: 'old', type: 'agentMessage', text: 'STALE SECRET' } });
      if (!this.hang) {
        emit('item/started', { item: { type: 'mcpToolCall', arguments: 'secret-arguments' } });
        emit('item/agentMessage/delta', { itemId: 'reply', delta: '你好😀' });
        emit('item/completed', { item: { id: 'thinking', type: 'agentMessage', text: 'commentary', phase: 'commentary' } });
        emit('item/completed', { item: { id: 'reply', type: 'agentMessage', text: '你好😀', phase: 'final_answer' } });
        emit('turn/completed', { turn: { id, status: this.status ?? 'completed' } });
      }
      return { turn: { id, status: 'inProgress' } };
    }
    return {};
  }
  async close() { this.closing = true; }
}

test('provider defaults, fail-closed selection, DSH/Codex runtime contract', async () => {
  assert.equal(providerName({}), 'dsh');
  assert.throws(() => providerName({ agent: { provider: 'typo' } }));
  const calls = [];
  const registry = Object.fromEntries(['dsh', 'codex'].map((name) => [name, { start: async (options) => calls.push([name, options.root]) }]));
  await startProvider({ config: {}, root: '/fixture' }, registry);
  await startProvider({ config: { agent: { provider: 'codex' } }, root: '/fixture' }, registry);
  assert.deepEqual(calls, [['dsh', '/fixture'], ['codex', '/fixture']]);
});

test('configuration rejects unsafe endpoints, implicit identity and invalid limits', () => {
  const c = configuration(temporary());
  for (const codex of [{ home: '' }, { retries: -1 }, { maxQueue: 100 }, { ownerLocalTools: 'yes' }]) {
    assert.throws(() => validateCodexConfig({ ...c, codex: { ...c.codex, ...codex } }));
  }
  assert.throws(() => validateCodexConfig({ ...c, ownerQQ: null, codex: { ...c.codex, ownerLocalTools: true } }));
  for (const wsUrl of ['ws://remote.invalid:3001', 'wss://user:secret@remote.invalid/', 'http://localhost']) {
    assert.throws(() => validateCodexConfig({ ...c, snowluma: { wsUrl } }));
  }
  assert.equal(childEnvironment({ PATH: 'path', OPENAI_API_KEY: 'key', QQ_TOKEN: 'secret', DSH_TOKEN: 'secret' }).QQ_TOKEN, undefined);
});

test('Codex handshake, early events, final text, isolation, tools and multi-turn history', async () => {
  const stateDir = temporary(), rpc = new FakeRpc(), progress = [];
  const adapter = new CodexAdapter({ key: 'group:7', config: configuration(stateDir), stateDir, rpcFactory: () => rpc });
  assert.equal(await adapter.run('hi', (event) => progress.push(event)), '你好😀');
  assert.equal(await adapter.run('again'), '你好😀');
  assert.deepEqual(rpc.calls.slice(0, 4).map((c) => c.method), ['initialize', 'initialized', 'config/read', 'thread/start']);
  assert.equal(rpc.calls.filter((c) => c.method === 'thread/start').length, 1);
  const params = rpc.calls.find((c) => c.method === 'thread/start').params;
  assert.equal(params.config['mcp_servers.qq.enabled'], false);
  assert.equal(params.config['features.shell_tool'], false);
  assert.equal(params.config['features.goals'], false);
  assert.equal(params.config['features.multi_agent'], false);
  assert.equal(params.sandbox, 'read-only');
  assert.equal(progress.find((e) => e.type === 'tool').tool, 'mcpToolCall');
  assert.ok(!JSON.stringify(progress).includes('secret-arguments'));
  await adapter.close();
  const resumedRpc = new FakeRpc();
  const resumed = new CodexAdapter({ key: 'group:7', config: configuration(stateDir), stateDir, rpcFactory: () => resumedRpc });
  await resumed.run('after restart');
  assert.equal(resumedRpc.calls.find((c) => c.method === 'thread/resume').params.threadId, 'thread-one');
  await resumed.reset();
  assert.equal(fs.existsSync(resumed.file), false);
});

test('local tools and configured MCP are available only in explicit owner private session', async () => {
  const directory = temporary(), config = configuration(directory);
  config.codex.ownerLocalTools = true;
  config.codex.ownerMcp = true;
  for (const key of ['group:7', 'private:43', 'private:42']) {
    const rpc = new FakeRpc();
    const adapter = new CodexAdapter({ key, config, stateDir: directory, rpcFactory: () => rpc });
    await adapter.run('hi');
    const params = rpc.calls.find((c) => c.method === 'thread/start').params;
    assert.equal(params.config['features.shell_tool'], key === 'private:42');
    assert.equal(params.config['mcp_servers.qq.enabled'], key === 'private:42' ? undefined : false);
    await adapter.close();
  }
});

test('server requests always deny escalation; unknown requests receive method error', async () => {
  const directory = temporary(), rpc = new FakeRpc();
  const adapter = new CodexAdapter({ key: 'private:42', config: configuration(directory), stateDir: directory, rpcFactory: () => rpc });
  await adapter.run('hi');
  const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'item/tool/requestUserInput', 'future/tool'];
  for (const [id, method] of methods.entries()) rpc.emit('request', { id, method, params: { command: 'dangerous secret' } });
  const replies = rpc.calls.filter((c) => Object.hasOwn(c, 'id'));
  assert.deepEqual(replies[0].result, { decision: 'decline' });
  assert.deepEqual(replies[2].result, { permissions: {}, scope: 'turn' });
  assert.equal(replies.at(-1).unsupported, true);
  assert.ok(!JSON.stringify(replies).includes('dangerous'));
  await adapter.close();
});

test('timeout interrupts, closes process, rejects busy turn and removes listeners', async () => {
  const directory = temporary(), config = configuration(directory), rpc = new FakeRpc({ hang: true });
  config.codex.turnTimeoutMs = 100;
  const adapter = new CodexAdapter({ key: 'group:7', config, stateDir: directory, rpcFactory: () => rpc });
  const pending = adapter.run('wait');
  await assert.rejects(adapter.run('duplicate'), { code: 'SESSION_BUSY' });
  await assert.rejects(pending, { code: 'TURN_TIMEOUT' });
  assert.equal(rpc.closing, true);
  assert.ok(rpc.calls.some((c) => c.method === 'turn/interrupt'));
  assert.equal(rpc.listenerCount('notification'), 0);
});

test('explicit overload retries, but unknown turn acceptance and failed/interrupted turns do not replay', async () => {
  for (const status of ['completed', 'failed', 'interrupted', 'timeout']) {
    const directory = temporary(), rpc = new FakeRpc(status === 'completed' ? { overloaded: true }
      : status === 'timeout' ? { reject: (method) => method === 'turn/start' } : { status });
    const adapter = new CodexAdapter({ key: 'group:7', config: configuration(directory), stateDir: directory, rpcFactory: () => rpc });
    if (status === 'completed') assert.equal(await adapter.run('once'), '你好😀');
    else await assert.rejects(adapter.run('once'));
    assert.equal(rpc.calls.filter((c) => c.method === 'turn/start').length, status === 'completed' ? 2 : 1);
    await adapter.close();
  }
});

test('state corruption and policy mismatch fail closed; changed policy does not resume old thread', async () => {
  const directory = temporary(), config = configuration(directory);
  const adapter = new CodexAdapter({ key: 'private:42', config, stateDir: directory, rpcFactory: () => new FakeRpc() });
  await adapter.run('hi'); await adapter.close();
  config.codex.ownerLocalTools = true;
  const rpc = new FakeRpc(), changed = new CodexAdapter({ key: 'private:42', config, stateDir: directory, rpcFactory: () => rpc });
  await changed.run('new policy');
  assert.equal(rpc.calls.some((c) => c.method === 'thread/resume'), false);
  await changed.close();
  fs.writeFileSync(changed.file, 'broken');
  await assert.rejects(changed.run('broken'), { code: 'STATE_INVALID' });
  const badRpc = new FakeRpc();
  const request = badRpc.request.bind(badRpc);
  badRpc.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'thread/start') result.approvalsReviewer = 'auto_review';
    return result;
  };
  const another = new CodexAdapter({ key: 'group:8', config, stateDir: directory, rpcFactory: () => badRpc });
  await assert.rejects(another.run('bad'), { code: 'POLICY_MISMATCH' });
});

function hostFixture(options = {}) {
  const directory = temporary(), config = configuration(directory), sent = [], adapters = [], logs = [];
  Object.assign(config.codex, options);
  const bot = { close() {}, async sendGroupMessage(id, message) { sent.push({ kind: 'group', id, message }); },
    async sendPrivateMessage(id, message) { sent.push({ kind: 'private', id, message }); } };
  const host = new CodexQQHost({ config, bot, stateDir: directory, log: (value) => logs.push(value),
    adapterFactory: ({ key }) => {
      const adapter = { key, calls: [], async run(text, progress) {
        this.calls.push(text); progress({ type: 'tool', text: 'secret-tool-output' });
        if (options.gate) return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
        return options.reply ?? 'reply [CQ:at,qq=all]';
      }, async cancel() { this.reject?.(new AgentError('TURN_INTERRUPTED')); }, async reset() { this.resetCalled = true; },
      async close() { await this.cancel(); this.closed = true; } };
      adapters.push(adapter); return adapter;
    } });
  let sequence = 0;
  const event = (value = {}) => ({ post_type: 'message', message_type: 'group', user_id: 43,
    self_id: 99, group_id: 7, message_id: ++sequence,
    message: [{ type: 'at', data: { qq: 99 } }, { type: 'text', data: { text: 'hello' } }], ...value });
  return { host, config, sent, adapters, logs, event };
}

test('QQ deny/allow, mention, self-message, anonymous, command and malformed-event authorization', async () => {
  const { host, config, event, adapters } = hostFixture();
  const denied = [event({ group_id: 9 }), event({ user_id: 99 }), event({ anonymous: {} }),
    event({ message: [{ type: 'text', data: { text: 'unmentioned' } }] }), event({ user_id: undefined }),
    event({ message: [{ type: 'text', data: { text: '/reset' } }] }), event({ post_type: 'message_sent' })];
  for (const e of denied) await host.incoming('group', e);
  assert.equal(adapters.length, 0);
  config.deny.groups = [7]; // Host config shares the policy arrays.
  await host.incoming('group', event()); assert.equal(adapters.length, 0);
  config.deny.groups = [];
  await host.incoming('group', event()); assert.equal(adapters.length, 1);
  await host.close();
});

test('QQ concurrent creation uses one FIFO per conversation; private/group numeric IDs stay separate; dedupe works', async () => {
  const { host, event, adapters, sent } = hostFixture();
  const duplicate = event();
  await Promise.all([host.incoming('group', duplicate), host.incoming('group', event()), host.incoming('group', duplicate)]);
  await host.incoming('private', event({ user_id: 43 }));
  assert.deepEqual(adapters.map((a) => a.key), ['group:7', 'private:43']);
  assert.equal(adapters[0].calls.length, 2);
  assert.ok(sent.every((s) => Array.isArray(s.message) && s.message.every((segment) => segment.type === 'text')));
  assert.ok(!JSON.stringify(sent).includes('secret-tool-output'));
  await host.close();
});

test('QQ queue limit, reset flushes old work, cancellation and shutdown', async () => {
  const { host, event, adapters, sent } = hostFixture({ gate: true, maxQueue: 2 });
  const first = host.incoming('group', event()); await tick();
  const second = host.incoming('group', event());
  await host.incoming('group', event());
  assert.ok(JSON.stringify(sent).includes('队列已满'));
  await host.incoming('group', event({ user_id: 42, message: [{ type: 'text', data: { text: '/reset' } }] }));
  await Promise.all([first, second]);
  assert.equal(adapters[0].calls.length, 1);
  assert.equal(adapters[0].resetCalled, true);
  await host.close();
  assert.equal(adapters[0].closed, true);
});

test('QQ capacity and idle eviction preserve bounded resources', async () => {
  const { host, event, adapters, sent } = hostFixture({ maxSessions: 1 });
  await host.incoming('group', event());
  await host.incoming('group', event({ group_id: 8 }));
  assert.ok(JSON.stringify(sent).includes('会话数已达上限'));
  host.sessions.get('group:7').at = 0;
  await host.evictIdle();
  assert.equal(adapters[0].closed, true);
  await host.incoming('group', event({ group_id: 8 }));
  assert.equal(adapters[1].key, 'group:8');
  await host.close();
});

test('QQ reply gate blocks known secrets, paths, keys and never logs prompts/errors', async () => {
  for (const reply of ['onebot-secret-value', 'token=super-secret', 'C:\\private\\file', 'sk-1234567890abcdefxyz']) {
    const { host, event, sent } = hostFixture({ reply });
    await host.incoming('group', event());
    assert.ok(!JSON.stringify(sent).includes(reply));
    await host.close();
  }
  assert.equal(safeReply('ordinary answer'), 'ordinary answer');
});

function transportFixture(options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const writes = []; child.stdin.on('data', (chunk) => writes.push(JSON.parse(chunk.toString())));
  let launch;
  const rpc = new AppServerRpc({ binary: 'fixture', home: root, cwd: root, requestTimeoutMs: 50, ...options,
    spawnProcess: (...args) => { launch = args; return child; } });
  return { rpc, child, writes, launch };
}

test('JSONL transport correlates out-of-order IDs and split Unicode; uses no shell', async () => {
  const { rpc, child, writes, launch } = transportFixture();
  const first = rpc.request('first'), second = rpc.request('second');
  const bytes = Buffer.from(JSON.stringify({ id: writes[1].id, result: '你好😀' }) + '\n');
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  child.stdout.write(JSON.stringify({ id: writes[0].id, result: 'first' }) + '\n');
  assert.deepEqual(await Promise.all([first, second]), ['first', '你好😀']);
  assert.equal(launch[2].shell, false);
  assert.ok(!JSON.stringify(writes).includes('jsonrpc'));
  await rpc.close();
});

test('JSONL timeout, malformed/oversized frames, spawn failure and disconnect settle pending requests', async () => {
  for (const failure of ['timeout', 'invalid', 'oversized', 'exit', 'spawn']) {
    const { rpc, child } = transportFixture({ maxFrameBytes: 100 });
    const pending = rpc.request('pending');
    if (failure === 'invalid') child.stdout.write('{invalid}\n');
    if (failure === 'oversized') child.stdout.write('x'.repeat(101));
    if (failure === 'exit') child.emit('exit', 1);
    if (failure === 'spawn') child.emit('error', new Error('sensitive process path'));
    await assert.rejects(pending);
    assert.equal(rpc.pending.size, 0);
    await rpc.close();
  }
});

test.after(() => {
  // Only directories created by this test process, never another test run.
  for (const directory of ownedDirectories) fs.rmSync(directory, { recursive: true, force: true });
});
