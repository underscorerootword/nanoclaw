# Changelog

All notable changes to NanoClaw will be documented in this file.

For detailed release notes, see the [full changelog on the documentation site](https://docs.nanoclaw.dev/changelog).

---

## Local customisations

Changes made to this install relative to the upstream base. Most recent first.
DB-only changes (messaging group wiring, session cleanup) are noted here but not captured in git.

### 2026-05-05 — Weekend delay post-mortem: four reliability fixes

Root-cause analysis of delays observed 2026-05-03/04 (A1-O1, A1-O2) produced four fixes.

**Fix 1 — Matrix sync watchdog (`src/channels/matrix.ts`)**

`localTimeoutMs: 60_000` does not apply to `/sync` long-polls in matrix-js-sdk v41 — observed hangs of 9–18 min (646–1082s in logs). Added a custom `fetchFn` (`fetchWithSyncWatchdog`) that wraps every `/sync` request with an `AbortController` capped at 90s. Non-sync requests are passed through unchanged.

**Fix 2 — API retry debug logging (`src/host-sweep.ts`)**

The sweep now emits a `log.debug` entry whenever it reads a non-null `api_retry_at` from a session's `outbound.db`, enabling future incidents to distinguish "was retrying, alert threshold not yet reached" from "was not retrying at all."

**Fix 3 — Context near-limit alert via Matrix Alerts room**

Large auto-compactions (>80k tokens) now trigger an operator alert in `MATRIX_ALERTS_ROOM_ID`, then a resolved alert when the session ends.

- Container (`container/agent-runner/src/providers/claude.ts`): emits a new `compact` event type from the `compact_boundary` SDK event.
- Container (`container/agent-runner/src/providers/types.ts`): adds `compact` to the `ProviderEvent` union.
- Container (`container/agent-runner/src/db/session-state.ts`): `setContextCompactionState` / `clearContextCompactionState` persist `context_compaction_at` + `context_compaction_pre_tokens` in `session_state`.
- Container (`container/agent-runner/src/poll-loop.ts`): handles `compact` event in `handleEvent`; clears state in the `finally` block.
- Host (`src/db/session-db.ts`): `getContextCompactionState` reads the two keys from `outbound.db`.
- Host (`src/alerts.ts`): `sendContextNearLimitAlert` / `sendContextNearLimitResolvedAlert` deliver to `MATRIX_ALERTS_ROOM_ID`.
- Host (`src/host-sweep.ts`): reads compaction state each sweep tick; fires alert once per session per run; clears when session ends.

**Fix 4 — Mid-task status acknowledgement (`container/agent-runner/src/poll-loop.ts`)**

When a status-request message ("update?", "still working?", etc.) arrives during an active query, a system instruction is prepended to the push prompt so the agent acknowledges before continuing. Previously the message was silently absorbed until the task completed.

**Files:** `src/channels/matrix.ts`, `src/host-sweep.ts`, `src/db/session-db.ts`, `src/alerts.ts`, `container/agent-runner/src/providers/claude.ts`, `container/agent-runner/src/providers/types.ts`, `container/agent-runner/src/db/session-state.ts`, `container/agent-runner/src/poll-loop.ts`

---

### 2026-05-01 — Matrix Alerts room for Anthropic API delay notifications

**Problem:** When the Anthropic API was degraded, agents retried silently for up to 81 minutes with no operator visibility. The only signal was a belated response appearing long after the original message.

**Fix:** Two-part implementation:

1. **Container side** (`container/agent-runner/src/poll-loop.ts`, `container/agent-runner/src/db/session-state.ts`): When the SDK emits a retryable error event, the poll-loop writes the first-retry ISO timestamp to `session_state` in `outbound.db` (`api_retry_at`). Cleared on turn completion or any exit path.

2. **Host side** (`src/host-sweep.ts`, `src/alerts.ts`, `src/db/session-db.ts`): The 60s host sweep reads `api_retry_at` from each session's `outbound.db`. If the value is older than 3 minutes and no alert has been sent this run, it delivers a warning directly to `MATRIX_ALERTS_ROOM_ID` via the Matrix adapter — no agent container or Anthropic API call involved. A resolved message is sent when the key clears.

**Setup:** Create a dedicated Matrix room, invite `@a1-o1` (the primary Matrix bot), then add to `.env`:
```
MATRIX_ALERTS_ROOM_ID=!<room-id>:chat.rootword.cc
```

**Caveats:**
- Alert threshold is 3 minutes (constant `API_RETRY_ALERT_THRESHOLD_MS` in `host-sweep.ts`).
- `alerted­Sessions` is an in-memory set — a host restart during a retry window will re-send the alert on the next sweep tick after the threshold elapses again.
- `MATRIX_ALERTS_ROOM_ID` must be read via `readEnvFile` (not `process.env`) — NanoClaw does not auto-load `.env` into the process environment.

**Files:** `src/alerts.ts` (new), `src/host-sweep.ts`, `src/db/session-db.ts`, `container/agent-runner/src/poll-loop.ts`, `container/agent-runner/src/db/session-state.ts`

---

### 2026-04-28 — poll-loop: heartbeat now updated during API retry windows

**Problem:** `touchHeartbeat()` in `processQuery` was only called on incoming streaming events from the SDK. When the Claude API was degraded and the SDK retried silently (no events emitted during the backoff window), the heartbeat file went stale. The host sweep then killed the container at the 30-minute absolute ceiling, even though the container was legitimately waiting for the API to recover.

**Fix:** Added `touchHeartbeat()` to the `pollHandle` setInterval inside `processQuery` (`container/agent-runner/src/poll-loop.ts`). This interval runs every 500ms concurrently with the streaming loop, so the heartbeat stays alive regardless of whether the SDK is emitting events or sitting silently through a retry.

**Files:** `container/agent-runner/src/poll-loop.ts`

---

### 2026-04-28 — Agent-specific skills and dashboard Skills page

**Agent skills (`agent-skills/`):** New skill tier between container skills (global) and host skills (operator-only). Skills placed in `agent-skills/<name>/` are never available by default — each agent group opts in via `"agentSkills": ["name"]` in its `container.json`. A skill can be assigned to multiple groups without duplication. At spawn, the `agent-skills/` directory is mounted RO at `/app/agent-skills`, symlinks are created in `.claude-shared/skills/`, and any `instructions.md` is included in the composed `CLAUDE.md` as `agent-skill-<name>.md` fragments.

Also fixed an existing TODO: container skill `instructions.md` fragments now respect the group's `skills` selection in `container.json` rather than always including all skills.

**Caveats:**
- The `agent-skills/` directory must be created manually at the project root — it is not created automatically.
- Each skill directory must contain a file named exactly `SKILL.md` (not `<name>-SKILL.md` or any other variant) for the dashboard to detect it.
- No restart needed when adding new skills — the pusher re-scans `agent-skills/` every 60 seconds.

**Files:** `src/container-config.ts`, `src/container-runner.ts`, `src/claude-md-compose.ts`, `src/dashboard-pusher.ts`, dashboard package patch (`patches/@nanoco__nanoclaw-dashboard@0.3.0.patch`)

---
### 2026-04-28 — Matrix: room-based inbound routing

**Problem:** Both A1-O1 and A1-O2 were wired to a single handle-based messaging group (`@upgrade0999`). A message sent to A1-O2's dedicated room was normalised to the user handle by `channelIdFromThreadId`, then fanned out to both agents — so A1-O1 also responded.

**Fix:** `channelIdFromThreadId` in `src/channels/matrix.ts` now checks the adapter's `matrix.yaml` before normalising. If the room appears in the `agents:` section it is returned as-is, routing to a room-specific messaging group wired to only that agent. Applied to both the `matrix` and `matrix-a1t1` adapters.

**DB changes:**
- Created dedicated messaging groups per room: A1-O1 room → A1-O1 only, A1-O2 room → A1-O2 only, A1-T1 room → A1-T1 only
- Removed A1-O2 and A1-T1 from handle-based fallback groups; deleted now-empty handle-based `matrix-a1t1` group
- Deleted two stale room-ID messaging groups left over from initial Matrix setup, plus their orphaned session and pending channel approval

**Files:** `src/channels/matrix.ts`

### 2026-04-26 — Matrix: per-agent room overrides and yaml persistence

Three changes landed together:

1. **Per-agent room overrides** — Added optional `agents:` section to `matrix.yaml`. When present, delivery for a named agent resolves to that agent's specific room rather than the shared default. Agent folder name is threaded through the delivery chain via `AsyncLocalStorage`.

2. **matrix.yaml applied to primary adapter** — Extended room persistence from `matrix-a1t1` to the primary `matrix` adapter. Config files: `groups/matrix/matrix.yaml` (A1-O1 + A1-O2) and `groups/a1-t1/matrix.yaml` (A1-T1).

3. **Persistent room config to survive restarts** — Matrix DM room IDs are now persisted to `matrix.yaml` in the agent group's `groups/<folder>/` directory. Loaded synchronously at adapter startup before the first delivery poll fires. Fixes delivery failures after host restarts caused by empty in-memory cache + blocked `createRoom` (`M_INVITE_BLOCKED`).

**Files:** `src/channels/matrix.ts`, `src/channels/chat-sdk-bridge.ts`, `src/channels/adapter.ts`, `src/delivery.ts`, `src/index.ts`

---

## [2.0.0] - 2026-04-22

Major version. NanoClaw v2 is a substantial architectural rewrite. Existing forks should run `/migrate-nanoclaw` (clean-base replay of customizations) or `/update-nanoclaw` (selective cherry-pick) before resuming work.

- [BREAKING] **New entity model.** Users, roles (owner/admin), messaging groups, and agent groups are now tracked as separate entities, wired via `messaging_group_agents`. Privilege is user-level instead of channel-level, so the old "main channel = admin" concept is retired. See [docs/architecture.md](docs/architecture.md) and [docs/isolation-model.md](docs/isolation-model.md).
- [BREAKING] **Two-DB session split.** Each session now has `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads) with exactly one writer each. Replaces the single shared session DB and eliminates cross-mount SQLite contention. See [docs/db-session.md](docs/db-session.md).
- [BREAKING] **Install flow replaced.** `bash nanoclaw.sh` is the new default: a scripted installer that hands off to Claude Code for error recovery and guided decisions. The `/setup` Claude-guided skill still works as an alternative.
- [BREAKING] **Channels moved to the `channels` branch.** Trunk no longer ships Discord, Slack, Telegram, WhatsApp, iMessage, Teams, Linear, GitHub, WeChat, Matrix, Google Chat, Webex, Resend, or WhatsApp Cloud. Install them per fork via `/add-<channel>` skills, which copy from the `channels` branch. `/update-nanoclaw` will re-install the channels your fork had.
- [BREAKING] **Alternative providers moved to the `providers` branch.** OpenCode, Codex, and Ollama install via `/add-opencode`, `/add-codex`, `/add-ollama-provider`. Claude remains the default provider baked into trunk.
- [BREAKING] **Three-level channel isolation.** Wire channels to their own agent (separate agent groups), share an agent with independent conversations (`session_mode: 'shared'`), or merge channels into one shared session (`session_mode: 'agent-shared'`). Chosen per channel via `/manage-channels`.
- [BREAKING] **Apple Container removed from default setup.** Still available as an opt-in via `/convert-to-apple-container`.
- **Shared-source agent-runner.** Per-group `agent-runner-src/` overlays are gone; all groups mount the same agent-runner read-only. Per-group customization flows through composed `CLAUDE.md` (shared base + per-group fragments).
- **Agent-runner runtime moved from Node to Bun.** Container image is self-contained; no host-side impact. Host remains on Node + pnpm.
- **OneCLI Agent Vault is the sole credential path.** Containers never receive raw API keys; credentials are injected at request time.

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
