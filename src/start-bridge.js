import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProvider } from './agents/providers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid config.json');
  await startProvider({ config, root });
} catch (error) {
  // Do not print raw config/SDK errors: these often include tokens and URLs.
  if (error.code === 'BRIDGE_ALREADY_RUNNING') {
    console.error('bridge.lock exists. Stop the running bridge, or verify its PID is gone before removing a stale lock.');
    process.exitCode = 2;
  } else {
    console.error('Bridge startup failed. Check config.json, provider, authentication and local file permissions.');
    process.exitCode = 1;
  }
}
