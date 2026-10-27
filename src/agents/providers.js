import { providerName } from './config.js';

// Runtime adapter contract: start({ config, root }) -> optional { close() }.
// Lazy imports keep Codex independent of DSH authentication and startup probes.
export const providers = Object.freeze({
  dsh: { start: async () => { await import('../bridge.js'); } },
  codex: { start: async (options) => {
    const { startCodexBridge } = await import('../codex-bridge.js');
    return startCodexBridge(options);
  } },
});

export async function startProvider(options, registry = providers) {
  const provider = providerName(options.config);
  if (!registry[provider]?.start) throw new Error('Provider is unavailable');
  return registry[provider].start(options);
}
