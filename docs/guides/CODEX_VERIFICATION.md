# Codex adapter verification

Verified on 2026-10-27, based on upstream `a49877f4e58d04e47532d44b803360d0f001160d`.

Environment: Windows, Node 24.22.1, npm 11.21.1, Codex CLI 0.164.0-alpha.11.1. Dependencies were installed with `npm ci --ignore-scripts` and the repository's existing `patch-snowluma-sdk.mjs` was then run explicitly. No dependency versions or lockfile contents were changed. Locked versions include SnowLuma SDK 1.14.20, MCP SDK 1.30.0 and schemastery 3.18.1.

| Check | Result |
| --- | --- |
| `node --test test/agents.test.js` | 15/15 passed |
| `node --test src/core/session-router.test.mjs` | 33/33 passed |
| `node scripts/test-mcp-servers-stdio.mjs` | All three existing MCP servers initialized and listed tools |
| `node scripts/probe-codex.mjs` | Real local App Server handshake/config/thread creation and policy checks passed; configured MCP canary did not execute for a group adapter |
| `node scripts/test-audit.mjs` | 33/35 scripts passed; two external prerequisites unavailable, detailed below |
| `git diff --check` | Passed |

The two audit failures were also reproduced against an unmodified checkout of the base commit with the same dependencies:

* `test-voice-system.mjs`: the published repository does not contain its required `docs/guides/VOICE.md` (the file is ignored by the existing repository rules).
* `test-preset-local-tools.mjs`: checking registered real DSH tool names requires a separately installed DSH `node_modules`; set `DSH_INSTALL_MODULES` in a suitably provisioned environment.

Optional external voice/ffmpeg/installed-DSH checks can also skip subchecks. These are not claims of live coverage. An initial test run with newer dependencies selected by pnpm exposed an additional schemastery assertion failure; that disappeared on both the original and modified code after installing the npm lockfile's exact versions. Only the locked-dependency results above are the final results.

The new tests cover provider selection, configuration validation, RPC framing/Unicode/IDs, process errors, event-before-response races, thread/turn filtering, multi-turn resume, permission changes, denied approvals/MCP elicitations, overload-only retries, ambiguous submission failures, turn deadlines/cancellation, QQ allow/deny/mention/self-message gates, deduplication, per-chat FIFO/limits/idle eviction, reset/queue invalidation, text-only CQ output and sensitive-reply filtering.

The real Codex probe uses a disposable home without account credentials and never sends `turn/start`. A newly created empty thread has no persisted rollout; successful real resume, model output, real tool execution and account authentication still require a live first turn. No real QQ messages, paid model calls, user authentication or gateway deployment were performed. Cross-platform CI is supplied for Node 22/24 on Windows/Linux but has not been run remotely as part of this local verification.

Deployment/authentication and unsupported features are documented in [CODEX_SETUP.md](CODEX_SETUP.md). GitHub publication is separate from local verification and requires a writable repository or fork.
