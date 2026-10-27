import path from 'node:path';

export function providerName(config) {
  const name = config.agent?.provider ?? 'dsh';
  if (!['dsh', 'codex'].includes(name)) throw new Error('Unknown agent.provider; expected dsh or codex');
  return name;
}

const id = (value) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
function integer(value, fallback, min, max, name) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid codex.${name}`);
  return value;
}

export function validateCodexConfig(config) {
  const c = { ...config.codex };
  if (typeof c.home !== 'string' || !path.isAbsolute(c.home)) throw new Error('codex.home must be an absolute, dedicated CODEX_HOME');
  c.binary ??= process.platform === 'win32' ? 'codex.exe' : 'codex';
  if (typeof c.binary !== 'string' || !c.binary || /[\r\n\0]/.test(c.binary)
    || (process.platform === 'win32' && !c.binary.toLowerCase().endsWith('.exe'))) {
    throw new Error('codex.binary must be an executable (use codex.exe, not a .cmd shim, on Windows)');
  }
  for (const field of ['ownerLocalTools', 'ownerMcp', 'progress', 'groupRequireMention']) {
    if (c[field] !== undefined && typeof c[field] !== 'boolean') throw new Error(`Invalid codex.${field}`);
  }
  if ((c.ownerLocalTools || c.ownerMcp) && !id(config.ownerQQ)) throw new Error('Codex owner capabilities require ownerQQ');
  if (c.ownerMcp && !c.ownerLocalTools) throw new Error('codex.ownerMcp requires ownerLocalTools');
  for (const field of ['private', 'groups']) {
    for (const map of ['allow', 'deny']) {
      const list = config[map]?.[field] ?? [];
      if (!Array.isArray(list) || list.some((v) => !id(v))) throw new Error(`Invalid ${map}.${field}`);
    }
  }
  if (config.allowAllWhenEmpty !== undefined && typeof config.allowAllWhenEmpty !== 'boolean') throw new Error('Invalid allowAllWhenEmpty');
  if (c.model !== undefined && (typeof c.model !== 'string' || c.model.length > 100)) throw new Error('Invalid codex.model');
  if (c.effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(c.effort)) throw new Error('Invalid codex.effort');
  c.requestTimeoutMs = integer(c.requestTimeoutMs, 15000, 100, 120000, 'requestTimeoutMs');
  c.turnTimeoutMs = integer(c.turnTimeoutMs, 180000, 100, 3600000, 'turnTimeoutMs');
  c.retries = integer(c.retries, 2, 0, 5, 'retries');
  c.maxSessions = integer(c.maxSessions, 8, 1, 64, 'maxSessions');
  c.maxQueue = integer(c.maxQueue, 4, 1, 32, 'maxQueue');
  c.idleTimeoutMs = integer(c.idleTimeoutMs, 900000, 1000, 86400000, 'idleTimeoutMs');
  c.maxInputChars = integer(c.maxInputChars, 12000, 1, 100000, 'maxInputChars');
  c.groupRequireMention ??= true;
  const url = new URL(config.snowluma?.wsUrl ?? 'ws://127.0.0.1:3001');
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid snowluma.wsUrl');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!loopback && !(url.protocol === 'wss:' && config.snowluma?.accessToken)) throw new Error('Remote OneBot requires wss and an accessToken');
  return { ...config, codex: c, snowluma: { ...config.snowluma, wsUrl: url.href } };
}

export function allowedConversation(config, key) {
  const [kind, value] = key.split(':');
  if (!id(value) || !['private', 'group'].includes(kind)) return false;
  const field = kind === 'group' ? 'groups' : 'private';
  if ((config.deny?.[field] ?? []).map(String).includes(value)) return false;
  const allow = (config.allow?.[field] ?? []).map(String);
  return allow.length ? allow.includes(value) : config.allowAllWhenEmpty === true;
}
