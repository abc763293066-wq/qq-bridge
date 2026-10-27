import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export class AgentError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// App Server uses JSONL, without the JSON-RPC version header. Never log wire
// messages: both stderr and protocol errors can contain credentials or prompts.
export class AppServerRpc extends EventEmitter {
  constructor({ binary, home, cwd, env = {}, overrides = {}, requestTimeoutMs = 15000, maxFrameBytes = 4 * 1024 * 1024, spawnProcess = spawn }) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.timeoutMs = requestTimeoutMs;
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(overrides)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    this.child = spawnProcess(binary, args, {
      cwd, env: { ...env, CODEX_HOME: home }, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail('TRANSPORT_CLOSED'));
    this.child.on('error', () => this.fail('PROCESS_START_FAILED'));
    this.child.on('exit', () => this.fail('PROCESS_EXITED'));
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > maxFrameBytes) return this.fail('PROTOCOL_FRAME_TOO_LARGE');
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { return this.fail('PROTOCOL_INVALID'); }
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) this.fail('PROTOCOL_FRAME_TOO_LARGE');
    });
  }

  receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new AgentError('PROTOCOL_INVALID');
    if (typeof message.method === 'string') {
      this.emit(Object.hasOwn(message, 'id') ? 'request' : 'notification', message);
    } else if (Object.hasOwn(message, 'id')) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return; // Late responses after a timeout must not revive work.
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        const error = new AgentError('RPC_REJECTED');
        error.rpcCode = message.error.code;
        error.operation = waiter.method;
        waiter.reject(error);
      } else waiter.resolve(message.result);
    } else throw new AgentError('PROTOCOL_INVALID');
  }

  write(message) {
    if (this.failed || this.closing || !this.child.stdin.writable) throw new AgentError('TRANSPORT_CLOSED');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError('RPC_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) { this.write({ method, params }); }
  respond(id, result) { this.write({ id, result }); }
  unsupported(id) { this.write({ id, error: { code: -32601, message: 'Unsupported by QQ bridge' } }); }

  fail(code) {
    if (this.failed) return;
    this.failed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new AgentError(code)); }
    this.pending.clear();
    this.emit('disconnect', new AgentError(code));
    void this.close();
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new AgentError('TRANSPORT_CLOSED')); }
      this.pending.clear();
      this.child.stdin.destroy();
      const pid = this.child.pid;
      if (!pid) return;
      // Kill the owned process tree, including command/MCP children. Never use a
      // shell or match other users' Codex processes by executable name.
      if (process.platform === 'win32') {
        await new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true, timeout: 5000 }, () => resolve()));
      } else {
        try { process.kill(-pid, 'SIGTERM'); } catch {}
        await new Promise((resolve) => setTimeout(resolve, 200));
        try { process.kill(-pid, 'SIGKILL'); } catch {}
      }
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    })();
    return this.closePromise;
  }
}
