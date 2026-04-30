---
name: port-openclaw
description: Port an OpenClaw skill to NanoClaw format. Use when the user provides an OpenClaw skill URL, file, or pasted content and wants it adapted for use in this NanoClaw agent.
---

# /port-openclaw — Port an OpenClaw Skill to NanoClaw

Given an OpenClaw skill (URL, file path, or pasted content), work through these four phases in order. Do not skip Phase 1 — security matters more than speed.

## Checkpoints

Three mandatory pause points where you must stop and wait for the user before continuing:

- **Checkpoint A** — after Phase 1: present the risk classification and all flags found (even LOW), ask "Shall I continue with the port?"
- **Checkpoint B** — after Phase 2: present the full analysis and ask "Does this look right before I start porting?"
- **Checkpoint C** — before Phase 4 writes anything: show draft outputs and ask for confirmation

Beyond these, stop and ask whenever:
- The skill's purpose is ambiguous or overlaps with a NanoClaw built-in
- A Type C skill could be curl-in-SKILL.md or an MCP server — ask which the user prefers
- The `instructions.md` decision is a close call — explain the tradeoff and ask
- The ported SKILL.md would exceed 500 lines and splitting changes its character
- A macOS-only binary has no Linux equivalent — ask whether to port partially or skip

---

## Phase 1: Security Vetting

OpenClaw's skill registry has weak security controls. Vet heavily before porting.

### 1a. Source check
- Who is the author? Are they known/reputable?
- Download count and star rating (higher = more community scrutiny)
- When was it last updated? (Stale skills may have unreviewed vulnerabilities)
- Does the ClawHub/OpenClaw security scan flag it? Note the result and confidence level.

### 1b. Code review — red flags

**EXTREME — stop immediately, do not port:**
- Reads or transmits credentials, tokens, or keys to external destinations
- Obfuscated code (base64 blobs, minified scripts, eval() calls)
- Downloads and executes remote code at runtime
- **Opens or exposes a port to the internet** — starts a server, opens a listening socket, or configures firewall/NAT rules that expose the container to external traffic. A container agent reachable from the internet is an unmonitored attack surface. Tell the user to achieve the goal a different way (e.g. a webhook receiver on the host, not inside the agent container)

**HIGH — warn clearly, list issues, ask for explicit confirmation twice before proceeding:**
- Accesses arbitrary filesystem paths outside the skill's stated purpose
- Contradictory permission directives (e.g. "don't ask permission" alongside "access .credentials")
- Uses `tmux capture-pane` or similar to read terminal output that could expose secrets
- Metadata mismatch: SKILL.md declares dependencies/credentials not listed in registry (or vice versa)
- Undeclared binary dependencies (installed silently, not documented)

**MEDIUM — warn clearly, list issues, ask for explicit confirmation once before proceeding:**
- Uses credentials or external APIs with minor scoping issues
- macOS-only hardcoded paths with no cross-platform fallback

**LOW — note any flags, then proceed after Checkpoint A.**

### 1c. Risk classification
Assign one of: **LOW / MEDIUM / HIGH / EXTREME**

**→ Checkpoint A:** Present the classification and every flag found. Ask: "Shall I continue with the port?"

---

## Phase 2: Skill Analysis

### 2a. OpenClaw skill type
- **Type A** — Pure instruction skill: only a SKILL.md (or equivalent prompt file), no scripts, no binaries, no API calls
- **Type B** — CLI tool integration: wraps a binary, may include shell scripts, requires system package installation
- **Type C** — REST API integration: makes HTTP calls to an external service, requires credentials/API keys
- **Type D** — Hybrid: combination of the above

### 2b. Dependencies
- What credentials/secrets are needed (if any)
- What binaries or packages are required
- Any OpenClaw-specific APIs, env vars, or paths used
- Any macOS-specific assumptions

### 2c. NanoClaw skill type
Map the OpenClaw skill to one of NanoClaw's four types:
- **Operational** — instruction-only, no code (most Type A ports land here; user-invoked from the host)
- **Utility** — ships supporting scripts alongside SKILL.md (Type B tools with self-contained code)
- **Container** — should always be active inside agent containers (always-on formatting rules, proactive behaviors, "when you detect X do Y" patterns)
- **Feature** — requires a branch merge + source code (unlikely in a port; stop and ask the user for guidance if so)

### 2d. `instructions.md` assessment
Does this skill need to influence the agent's behavior on *every turn*, or only when explicitly invoked?
- **Always-on** → needs an `instructions.md` alongside SKILL.md. Key signals: formatting rules that apply to all messages, proactive tool-use guidance, behavioral defaults the agent must apply before the user asks anything, "when you detect X do Y" patterns
- **On-demand** → SKILL.md alone is sufficient

If it's a close call, explain the tradeoff at Checkpoint B and ask.

### 2e. MCP server consideration (Type C and D only)
Would `add_mcp_server` serve this skill better than curl commands in a SKILL.md? If the skill is essentially a thin wrapper around one API, an MCP server gives the agent structured tool calls instead of raw curl output. Note the recommendation but let the user decide.

### 2f. `allowed-tools` identification
If the skill wraps a specific tool or binary, note what `allowed-tools` frontmatter should be added. Examples: `Bash(agent-browser:*)`, `Bash(vercel:*)`.

**→ Checkpoint B:** Present the full analysis (OpenClaw type, NanoClaw type, `instructions.md` verdict, MCP consideration if applicable, `allowed-tools` if applicable). Ask: "Does this look right before I start porting?"

---

## Phase 3: Porting

Apply the relevant transformations below based on skill type.

### All types — universal changes

**File structure:**
- OpenClaw uses YAML frontmatter (name, description) — keep this, it's the same in NanoClaw
- Add `allowed-tools` frontmatter if identified in Phase 2
- Remove any OpenClaw/ClawHub install instructions from the skill body
- Remove references to `openclaw skills install`, `npx clawhub`, `init_skill.py`, `package_skill.py`
- If the ported SKILL.md exceeds 500 lines, move the excess detail into a `reference.md` in the same directory and link to it — do not leave an oversized file

**Paths:**
- Replace `~/.openclaw/` with `/workspace/agent/`
- Replace macOS paths (`~/Library/Application Support/`, `/Applications/`) with a container-appropriate path or a note that this feature requires a mounted host directory
- Memory/log files referenced in the skill use `/workspace/agent/` subdirectories

**OpenClaw-specific env vars:**
- `CLAWDBOT_TMUX_SOCKET_DIR` — remove; tmux is not required in NanoClaw containers
- Any `OPENCLAW_*` vars — identify purpose and replace with NanoClaw equivalents or remove

**Container skill focus:**
If the port becomes a container skill, strip anything not needed on every agent turn. The agent's context window is shared across all container skills — keep it focused.

### Type B — CLI tool integrations

**Package installation:**
- Replace `brew install <package>` with a note that the agent must run `install_packages({ apt: ["<package>"] })` to install it persistently
- If no apt equivalent exists, note that a custom Dockerfile addition is required
- Remove instructions to manually install binaries into PATH

**tmux patterns:**
- Replace tmux-based workflows with direct `bash -c` calls where possible
- For tools that require an active session (e.g. 1Password desktop unlock), note this as a human prerequisite
- Remove `tmux capture-pane` patterns — read output directly from command stdout instead

**macOS-only tools:**
- If the binary has no Linux equivalent, note the limitation clearly at the top of the ported skill
- Suggest a Linux-native alternative if one exists

### Type C — REST API integrations

**Credentials:**
- Replace all shell-based credential patterns with the NanoClaw vault approach:

  > Credentials are managed via the OneCLI agent vault. Ask the user to add `<CREDENTIAL_NAME>` to the vault. The agent can then reference it as an environment variable without storing it in any file.

- Do NOT store credentials in SKILL.md, CLAUDE.local.md, or any workspace file
- Keep all curl commands as-is — they work in the container
- If `jq` is used, note that `install_packages({ apt: ["jq"] })` is needed if not already present

**MCP server alternative:**
If Phase 2 recommended an MCP server and the user agreed, replace the curl pattern with `add_mcp_server` instructions instead of porting the curl commands directly.

**Rate limits and API notes:**
- Preserve any rate limit warnings from the original skill verbatim

### Type D — Hybrid
Apply both Type B and Type C transformations as applicable.

---

## Phase 4: Output

### 1. Ported SKILL.md
Full content of the ported skill, ready to save. Format as a code block.

### 1b. `instructions.md` (conditional)
If Phase 2 concluded always-on, produce an `instructions.md` containing only the always-active behavioral rules — not a full command reference. Keep it short: these fragments are injected into every agent turn and every line costs context. Format as a code block.

### 2. Prerequisites checklist
A short bulleted list of what the user needs to do before the skill will work:
- Packages to install (with the exact `install_packages` call)
- Credentials to add to the vault (with the credential name)
- Any human-in-the-loop steps (e.g. unlock desktop app)
- Any limitations that could not be resolved in the port (e.g. macOS-only binary with no Linux equivalent)

### 3. Security summary
One short paragraph: what was flagged, what was resolved in the port, and what (if anything) the user should continue to be aware of.

**→ Checkpoint C:** Show all of the above and ask for confirmation before writing anything to disk.

### 4. Save to staging directory
Write the files to `/workspace/agent/ported-skills/<skill-name>/`:
- `SKILL.md` — always
- `instructions.md` — only if produced in step 1b
- `reference.md` — only if the SKILL.md was split

Do **not** copy to any active skills directory. The user reviews the staging directory and decides where it goes:
- Host skill → `.claude/skills/<name>/`
- Container skill → `container/skills/<name>/`
- Agent skill → `agent-skills/<name>/`

Confirm the staging path and remind the user that if they activate the skill, any `instructions.md` must be placed alongside the SKILL.md in the same directory.

---

## Important notes

- Never port a skill that exfiltrates credentials, executes remote code, or exposes a port to the internet
- If the skill's core purpose cannot work in a Linux container (e.g. it controls a macOS GUI app), say so plainly — a partial port that silently fails is worse than no port
- Prefer keeping the spirit of the original skill intact; only change what must change for the NanoClaw environment
- If the skill references OpenClaw memory conventions (SESSION-STATE.md, SOUL.md, USER.md), map these to NanoClaw equivalents: `CLAUDE.local.md` for persistent memory, `/workspace/agent/memory/` for structured notes
