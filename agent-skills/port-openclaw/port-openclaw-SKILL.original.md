---
name: port-openclaw
description: Port an OpenClaw skill to NanoClaw format. Use when the user provides an OpenClaw skill URL, file, or pasted content and wants it adapted for use in this NanoClaw agent.
---

# /port-openclaw — Port an OpenClaw Skill to NanoClaw

Given an OpenClaw skill (URL, file path, or pasted content), work through these four phases in order. Do not skip Phase 1 — security matters more than speed.

---

## Phase 1: Security Vetting

OpenClaw's skill registry has weak security controls. Vet heavily before porting.

### 1a. Source check
- Who is the author? Are they known/reputable?
- Download count and star rating (higher = more community scrutiny)
- When was it last updated? (Stale skills may have unreviewed vulnerabilities)
- Does the ClawHub/OpenClaw security scan flag it? Note the result and confidence level.

### 1b. Code review — red flags that may warrant rejection
- Reads or transmits credentials, tokens, or keys to external destinations
- Obfuscated code (base64 blobs, minified scripts, eval() calls)
- Downloads and executes remote code at runtime
- Accesses arbitrary filesystem paths outside the skill's stated purpose
- Contradictory permission directives (e.g. "don't ask permission" alongside "access .credentials")
- Uses `tmux capture-pane` or similar to read terminal output that could expose secrets
- Metadata mismatch: SKILL.md declares dependencies/credentials not listed in registry (or vice versa)
- Undeclared binary dependencies (installed silently, not documented)
- macOS-only hardcoded paths with no cross-platform fallback

### 1c. Risk classification
Assign one of:
- **LOW** — instruction-only, no credentials, no binaries, no network calls
- **MEDIUM** — uses credentials or external APIs with proper scoping; minor flag(s) present
- **HIGH** — contradictory directives, undeclared access, or suspicious patterns
- **EXTREME** — credential exfiltration risk, remote code execution, obfuscation

**If EXTREME:** Stop. Do not port. Tell the user why.
**If HIGH:** Warn the user clearly, list the specific issues and potential risks, and ask for explicit confirmation twice before proceeding.
**If MEDIUM** Warn the user clearly, list the specific issues, and ask for explicit confirmation before proceeding 
**If LOW:** Note any flags, then proceed.

---

## Phase 2: Skill Analysis

Identify the skill type — this determines which porting steps apply:

**Type A — Pure instruction skill**
Only a SKILL.md (or equivalent prompt file). No scripts, no binaries, no API calls. Examples: skill-vetter, proactive-agent.

**Type B — CLI tool integration**
Wraps a binary (e.g. obsidian-cli, op, ffmpeg). May include shell scripts. Requires system package installation.

**Type C — REST API integration**
Makes HTTP calls (curl or equivalent) to an external service. Requires credentials/API keys.

**Type D — Hybrid**
Combination of the above.

Also note:
- What credentials/secrets are needed (if any)
- What binaries or packages are required
- Any OpenClaw-specific APIs, env vars, or paths used
- Any macOS-specific assumptions

---

## Phase 3: Porting

Apply the relevant transformations below based on skill type.

### All types — universal changes

**Communication with the user**
- At all times where there are grey areas, ask the user for clarification

**File structure:**
- OpenClaw uses YAML frontmatter (name, description) — keep this, it's the same in NanoClaw
- Remove any OpenClaw/ClawHub install instructions from the skill body
- Remove references to `openclaw skills install`, `npx clawhub`, `init_skill.py`, `package_skill.py`
- Skills live in `/home/node/.claude/skills/<skill-name>/SKILL.md` — no additional registry step. If you do not have permission to access that folder then please store it in a local directory and inform the user so they can move it themselves

**Paths:**
- Replace `~/.openclaw/` with `/workspace/agent/`
- Replace macOS paths (`~/Library/Application Support/`, `/Applications/`) with a container-appropriate path or a note that this feature requires a mounted host directory
- Memory/log files referenced in the skill use `/workspace/agent/` subdirectories

**OpenClaw-specific env vars:**
- `CLAWDBOT_TMUX_SOCKET_DIR` — remove; tmux is not required in NanoClaw containers
- Any `OPENCLAW_*` vars — identify purpose and replace with NanoClaw equivalents or remove

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

**Rate limits and API notes:**
- Preserve any rate limit warnings from the original skill verbatim

### Type D — Hybrid
Apply both Type B and Type C transformations as applicable.

---

## Phase 4: Output

Produce the following:

### 1. Ported SKILL.md
Full content of the ported skill, ready to save. Format as a code block.

### 2. Prerequisites checklist
A short bulleted list of what the user needs to do before the skill will work:
- Packages to install (with the exact `install_packages` call)
- Credentials to add to the vault (with the credential name)
- Any human-in-the-loop steps (e.g. unlock desktop app)
- Any limitations that could not be resolved in the port (e.g. macOS-only binary with no Linux equivalent)

### 3. Security summary
One short paragraph: what was flagged, what was resolved in the port, and what (if anything) the user should continue to be aware of.

### 4. Save the file
Write the ported SKILL.md to `/home/node/.claude/skills/<skill-name>/SKILL.md`. Use the original skill name (lowercased, hyphens for spaces) unless it conflicts with an existing skill. Confirm the path to the user.

---

## Important notes

- Never port a skill that exfiltrates credentials or executes remote code without user awareness
- If the skill's core purpose cannot work in a Linux container (e.g. it controls a macOS GUI app), say so plainly — a partial port that silently fails is worse than no port
- Prefer keeping the spirit of the original skill intact; only change what must change for the NanoClaw environment
- If the skill references OpenClaw memory conventions (SESSION-STATE.md, SOUL.md, USER.md), map these to NanoClaw equivalents: `CLAUDE.local.md` for persistent memory, `/workspace/agent/memory/` for structured notes
