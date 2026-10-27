# Codex provider

`npm start` / `start.bat` now select `agent.provider`: `dsh` (default, including old configurations) or `codex`. Changing providers requires stopping the old bridge and restarting. There is no automatic fallback between accounts/providers after a failed task. `npm run start:dsh` and `node src/bridge.js` explicitly launch the original DSH runtime.

## What was inspected

The implementation was based on the repository at `a49877f`, not on assumptions about its layout:

* `src/bridge.js`: SnowLuma SDK OneBot v11 private/group events; per-conversation `private:<id>` / `group:<id>` keys, allow/deny gates, persisted DSH sessions, four DSH modes and an authenticated local control plane.
* `src/dsh-client.js`: DSH browser-cookie authentication (including local secret discovery), slash RPC, `remote.mux`, projection/inbox handling and turn collectors. These are DSH protocols, not OpenAI APIs.
* `src/mcp-snowluma-safe.js`: stdio MCP tools call the existing bridge's authenticated HTTP routes; v2 uses conversation agent tokens and tool gates. `mcp-host-server.js` only probes the gateway. `mcp-web-search-safe.js` is a separate stdio service.
* `src/core/session-router.mjs`: pure policy routing, not an existing transport adapter that could be swapped for JSON-RPC.

The new provider registry wraps the complete DSH runtime as a legacy runtime adapter, preserving its semantics, and starts a separate QQ host with `CodexAdapter` for Codex. It deliberately does not pretend DSH presets, mux projections and Codex threads share a wire protocol. A future provider implements the registry's async `start({ config, root })` contract and owns cleanup. The Codex turn adapter implements `run(text, onProgress)`, `cancel`, `reset`, `close`; the QQ host owns authentication, queueing and output checks.

## Official protocol decision

Checked on 2026-10-27 against [OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server), [authentication](https://learn.chatgpt.com/docs/auth), [configuration](https://learn.chatgpt.com/docs/config-file/config-reference) and [feature flags](https://learn.chatgpt.com/docs/config-file/config-basic). Local protocol shapes were also checked with `codex app-server generate-json-schema` using `codex-cli 0.164.0-alpha.11.1`.

The adapter spawns `codex app-server --listen stdio://`, uses JSONL RPC without a `jsonrpc` header, and performs `initialize` → `initialized`, `config/read`, `thread/start` / `thread/resume`, `turn/start`, notifications and `turn/interrupt`. Only a `turn/completed` with successful status is a success. The official interface already supplies lifecycle and streamed events, so no fragile terminal scraping or additional `codex exec` fallback is needed. WebSocket App Server exposure is not used. App Server remains a version-sensitive integration: validate your installed binary with the probe before upgrading.

## Install and authenticate

Use Node >=22.13 and install dependencies in this repository:

```sh
npm ci
npm install -g @openai/codex
codex --version
```

Install/start your OneBot v11 gateway separately, log in to QQ and enable its WebSocket endpoint. This project does not install or start SnowLuma. Use its **WebSocket** token (it may differ from the HTTP token). The Codex host does not discover or rewrite gateway tokens automatically.

Use a dedicated OS account and a dedicated `CODEX_HOME`, outside the bridge checkout and all agent working directories. Do not reuse your personal desktop home containing unrelated skills, MCP servers or account history. `codex.home` is mandatory and must be absolute. Protect the home directory, bridge `state/` and local `config.json` from other users; never commit them. The bridge hardens its state directory before connecting to QQ and fails if hardening fails. You must protect the external Codex home and configuration yourself.

PowerShell example (replace the path with your chosen directory):

```powershell
$env:CODEX_HOME = 'C:\qq-bridge-codex-home'
New-Item -ItemType Directory -Force -Path $env:CODEX_HOME
codex login
# On a headless host, where your account/workspace allows device login:
codex login --device-auth
codex login status
```

Linux example, as the service user:

```sh
export CODEX_HOME=/srv/qq-codex/home
mkdir -p "$CODEX_HOME"
chmod 700 "$CODEX_HOME"
codex login --device-auth
codex login status
```

For API-key authentication, follow the official CLI's `codex login --with-api-key` stdin workflow in that same dedicated home. The bridge also passes `OPENAI_API_KEY` if already present in its service environment. Never put a key in QQ, the repository, command arguments or screenshots. Browser/device authentication, account access, subscription/API billing and renewal remain the operator's responsibility. The bridge never asks QQ users for credentials and does not extract desktop tokens. If credentials expire, reauthenticate locally and retry after checking the task state.

## Configure and launch

Windows: copy `config.example.json` to `config.json`, set `agent.provider` to `codex`, set `codex.home` to the home used during login. `codex.binary` can be a full executable path; Windows requires the real `codex.exe`, not the npm `.cmd` shim. Linux: start with `config.codex.linux.example.json` and adapt the paths.

Set `snowluma.wsUrl` and `snowluma.accessToken`; populate `allow.private` and/or `allow.groups` with actual numeric QQ IDs. Empty lists deny everyone unless `allowAllWhenEmpty` is explicitly true; avoid that option for agent operation. Deny rules win. `ownerQQ` does not bypass the allowlist. Group allowlisting authorizes the group members to participate in that group's shared history; it does not create a private history per group member.

Leave `codex.model` empty to use your installed Codex default, or name a model available to your authenticated account. A catalog entry alone is not proof of account access. `codex.effort` is optional and must be supported by the chosen model. No model entitlement is assumed.

```sh
npm run test:agents
npm run probe:codex
npm start
```

For Linux service deployment, adapt [deploy/qq-bridge.service.example](../../deploy/qq-bridge.service.example). Create the dedicated `qqbridge` account and both writable directories yourself, authenticate Codex as that service user, set matching paths in `config.json`, and review the unit before installing it. `KillMode=control-group` adds service-manager cleanup of descendant processes. This unit does not install or control the QQ gateway. Do not put credentials directly in the unit; use your service manager's protected secret/environment mechanism if needed.

The protocol probe uses an empty temporary home, creates no inference turn and sends nothing to QQ. It verifies the real local process handshake/config/thread creation and policy result. An empty thread has no persisted rollout, so real resume/inference requires a first actual turn. Multi-turn, streaming, rejection and timeout behavior are covered with protocol fixtures; full live validation requires your own account and QQ gateway.

Private text messages trigger an allowlisted friend's conversation. Groups default to requiring an `@` mention of the bot or a `/codex your request` prefix. Set `groupRequireMention: false` to trigger on all allowed group text. The gateway must send structured OneBot message segments; media, anonymous events and raw CQ strings are not processed as commands. Only text segments reach Codex, and outgoing replies are also text segments.

Only the configured owner can use `/status`, `/cancel`, `/reset`. These commands affect the current conversation, including a group's shared conversation. `/cancel` stops active and queued work. `/reset` also removes the local thread mapping; old Codex history/files are retained in the protected Codex home for operator review, not deleted or archived. No QQ command can change provider, allowlist, tool policy, model or host paths.

## Sessions, progress and retries

Each key gets a separate process, working directory `state/codex/workspaces/<kind>-<id>/` and metadata `state/codex/<kind>-<id>.json`. No prompt transcript is copied to bridge logs. Native Codex history stays under the dedicated home. Reconnect/restart resumes the saved thread; changed policy/home/model/effort starts a new mapping. Corrupt state, missing rollouts or refused resumes fail explicitly instead of silently discarding history; inspect locally, then use owner `/reset` if appropriate.

Messages are FIFO within a conversation; different conversations can progress concurrently. `maxQueue` includes the running message. `maxSessions` caps active adapters; idle adapters are closed after `idleTimeoutMs` and later resumed from disk. Message IDs are deduplicated for ten minutes in bounded memory; this is not durable exactly-once delivery across restarts. If the limit is reached, the user gets a busy response instead of unbounded processes/queues.

`progress: true` emits at most three throttled status messages per turn (generation, tool use, denied permissions). Raw partial model text/tool arguments/results are intentionally withheld until final content passes sensitive-data checks. This is progress streaming, not token-by-token QQ output. Final answers are split into QQ-sized text messages. Sensitive patterns and known gateway/API credentials block a reply; this is a heuristic, not complete data-loss prevention.

`requestTimeoutMs` bounds individual RPCs; `turnTimeoutMs` bounds the whole operation including initialization. Only explicit RPC `-32001` overload rejections are retried, with bounded exponential backoff and jitter (`retries`). An ambiguous timeout, process death, failed turn or interrupted tool sequence is **not automatically replayed**. A task may already have had effects: inspect before manually retrying. OneBot sends also have timeouts and are not replayed automatically when delivery is uncertain.

Normal SIGINT/SIGTERM closes the QQ connection, interrupts turns, closes each owned Codex process tree (including command/MCP children), releases the shared PID lock, and retains resumable metadata. Force-kill/power-loss cleanup cannot be guaranteed. If `state/bridge.lock` remains, verify its PID is no longer running before manually removing it. Never run DSH and Codex bridges against the same gateway simultaneously. `restart.bat` is the old Windows force-stop helper; prefer Ctrl+C and a clean restart to allow child cleanup.

## Permissions and MCP

Default group/private sessions request read-only sandboxing, restricted read roots, disabled shell tooling, no browser web search, no apps/plugins/hooks/memories/subagents/goals, no inherited shell environment, and disabled configured MCP servers. Goals are disabled so tasks cannot continue autonomously after a turn completes. Per-turn restricted roots include only that conversation's working directory plus platform defaults. The dedicated Codex process receives a small environment allowlist; QQ/DSH variables are not copied. Prompt instructions are not used as a security boundary.

`ownerLocalTools: true` enables command tools **only** for `private:<ownerQQ>`, within that conversation's workspace-write sandbox, with tool network access disabled. It does not grant full disk access or disable sandboxing. Command/file escalation requests are declined even for the owner; permission requests receive no grants, MCP elicitations are declined and unsupported requests return errors. Interactive approvals/user questions over QQ are not implemented. Installed managed requirements can reject configuration; unexpected effective approval/sandbox policy fails closed. Prepare Windows sandbox support on the host yourself if required by your Codex installation.

`ownerMcp: true` additionally permits operator-configured MCP servers only in that owner private session and requires `ownerLocalTools: true`. Configure those servers in the dedicated Codex home's `config.toml` using the [official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp). For example, a separately installed read-only service can use:

```toml
[mcp_servers.example_read_only]
command = "/absolute/path/to/your/mcp-server"
args = []
```

Verify the server's tools/credentials and network permissions independently. MCP programs are separate processes and may not share the native tool sandbox; enabling them delegates their full configured capabilities to the owner conversation. Do not attach the existing `mcp-snowluma-safe.js` as a Codex QQ service: its DSH HTTP control plane and v2 tokens are not supplied by this host. Other groups/friends never inherit owner MCP servers. Tool start events are shown as generic progress, without exposing arguments or results.

Conversation/process/root isolation is not an OS multi-tenant security boundary. Use a dedicated OS account/container with minimal filesystem and network access for hostile group content, protect the shared credential store, and audit Codex upgrades/managed defaults. No full-access, approval auto-accept, arbitrary QQ shell command or gateway administration endpoint is added.

## Current scope

| Feature | DSH provider | Codex provider |
| --- | --- | --- |
| Existing DSH authentication, presets, four modes, control panel | Preserved | Separate provider; not emulated |
| Per-group/friend text multi-turn | Existing implementation | App Server threads and bounded queues |
| Progress and native/MCP tool events | Existing DSH events | Generic streamed status; final text delivery |
| Simulation/proactive wake, stickers, voice, image/forward parsing, slang and token ledger | Preserved | Not implemented |
| Existing QQ HTTP/MCP v2 tools | Preserved | Not bridged; owner may configure independent MCP |
| Interactive approval/questions over QQ | Existing DSH behavior | Deny/empty answers; no permission escalation |
| `codex exec`/terminal scraping/remote App Server transport | N/A | Not implemented; stdio is sufficient |

Automated checks: `npm run test:agents`, `node --test src/core/session-router.test.mjs`, selected DSH fixture suites in `.github/workflows/agent-adapters.yml`, and optional `npm run probe:codex`. The original `npm run test:audit` also includes optional external voice/installed-DSH checks; report unavailable prerequisites explicitly rather than treating skips as live validation. No live QQ send, paid inference, production account login or deployment is performed by the offline tests.
