// Offline protocol check. No account/login call, no turn/start, no QQ network.
// Uses a temporary empty CODEX_HOME, not the operator's personal credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppServerRpc } from '../src/agents/rpc.js';
import { childEnvironment, codexPolicy, CodexAdapter } from '../src/agents/codex.js';
import { validateCodexConfig } from '../src/agents/config.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-codex-probe-'));
const home = path.join(directory, 'home');
fs.mkdirSync(home);
// A real configured MCP canary must never start for a non-owner session.
const marker = path.join(directory, 'mcp-started');
fs.writeFileSync(path.join(home, 'config.toml'),
  `[mcp_servers.probe_canary]\ncommand = ${JSON.stringify(process.execPath)}\n`
  + `args = ${JSON.stringify(['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker])}\nrequired = true\n`);
const { OPENAI_API_KEY, ...env } = childEnvironment();
const policy = codexPolicy(false, directory);
const rpc = new AppServerRpc({ binary: process.env.CODEX_BINARY || (process.platform === 'win32' ? 'codex.exe' : 'codex'),
  home, cwd: directory, env, overrides: { ...policy.config, 'mcp_servers.probe_canary.enabled': false } });
let adapter;
rpc.on('request', ({ id }) => rpc.unsupported(id));
try {
  await rpc.request('initialize', { clientInfo: { name: 'qq_bridge_probe', version: '0.2.1' } });
  rpc.notify('initialized');
  const effective = await rpc.request('config/read', { includeLayers: false, cwd: directory });
  if (!effective.config || effective.config.features?.shell_tool !== false) throw new Error('Missing or unsafe config');
  const { sandboxPolicy, ...parameters } = policy;
  const thread = await rpc.request('thread/start', { ...parameters, cwd: directory });
  if (!thread.thread?.id || thread.sandbox?.type !== 'readOnly' || thread.approvalsReviewer !== 'user') throw new Error('Policy mismatch');
  // Codex does not persist a rollout until the first turn. This empty offline
  // thread cannot yet be resumed; the mock suite covers multi-turn resume.
  await rpc.close();
  const config = validateCodexConfig({ codex: { binary: process.env.CODEX_BINARY || (process.platform === 'win32' ? 'codex.exe' : 'codex'), home },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001' } });
  adapter = new CodexAdapter({ key: 'group:1', config, stateDir: path.join(directory, 'bridge-state'),
    rpcFactory: (options) => new AppServerRpc({ ...options, env }) });
  await adapter.connect();
  if (fs.existsSync(marker)) throw new Error('MCP canary unexpectedly executed');
  console.log('PASS: real Codex initialize/config/read/thread/start; adapter readOnly/user policy; inherited MCP canary disabled; no inference or QQ sends. Resume requires a persisted first turn and is covered offline by fixtures.');
} catch (error) {
  console.error(`FAIL: Codex protocol probe (${error.code ?? 'PROTOCOL_MISMATCH'}, ${error.operation ?? 'validation'}, RPC ${error.rpcCode ?? 'n/a'}). Check binary version and sandbox setup.`);
  process.exitCode = 1;
} finally {
  await rpc.close();
  await adapter?.close();
  // Only our generated temporary directory is removed.
  fs.rmSync(directory, { recursive: true, force: true });
}
