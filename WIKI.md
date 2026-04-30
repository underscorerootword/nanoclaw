# NanoClaw Wiki

## Agent-to-Agent Wiring

Agent-to-agent (a2a) wiring lets one agent send messages to another agent as easily as it sends messages to a user channel. Agents communicate through the same session DB mechanism used for all messages — there is no special IPC, shared memory, or direct model-to-model connection.

### How it works

Each agent has a **destinations table** in its session `inbound.db`, populated by the host on every container wake. A destination is a named entry that points at either a channel (e.g. a Matrix room) or another agent group. When wired to another agent, a destination entry looks like:

| Field | Example |
|-------|---------|
| `name` | `parent` |
| `type` | `agent` |
| `target` | A1-O1's agent group ID |

When an agent sends `<message to="parent">...</message>`, the host intercepts it during delivery, writes it into the target agent's `inbound.db` as a `channel_type='agent'` message, and wakes that agent's container. The receiving agent sees an inbound message and responds normally — it has no idea whether the sender was a human or another agent.

### Setting it up

Wiring is two rows in the central `agent_destinations` table — one for each direction:

```
Agent A  →  local_name='child-name'  →  Agent B
Agent B  →  local_name='parent'      →  Agent A
```

Both agents pick up the new destinations on their next container wake. No restart is required.

### The "parent" convention

The name `parent` has no special meaning to the host — it is purely a human-readable convention. When an agent is created as a sub-agent of another, the back-channel destination is named `parent` by convention so it is obvious which agent to report back to. You can name destinations anything you like.

### Single-destination fallback

When an agent has exactly one destination configured and does not specify a `to`, the host automatically routes the message to that destination. This is why a sub-agent with only `parent` wired will always reply to its parent, even without explicit `<message to="parent">` wrapping.

### Creating sub-agents dynamically

An admin agent can call the `create_agent` MCP tool to spawn a new sub-agent at runtime. The host creates the agent group, scaffolds its filesystem, and wires `parent` back to the calling agent automatically. The calling agent is notified when the new agent is ready and can begin delegating immediately.

### What agents share (and don't)

| | Shared? |
|---|---|
| Message channel (session DBs) | Yes |
| Session history / conversation context | No |
| Memory / workspace files | No |
| Model state | No |

Each agent runs in its own container with its own context window. Collaboration happens entirely through the messages they exchange — there is no hidden shared state between agents.

### Benefits

- **Specialisation** — Give each agent a narrow role (researcher, scheduler, formatter) and let a parent agent coordinate them.
- **Parallelism** — A parent can fire tasks at multiple sub-agents simultaneously, each running in its own container.
- **Escalation** — A sub-agent with limited permissions can ask its parent to perform actions it cannot do itself (e.g. admin operations, credential use).
- **Composability** — Chains and hierarchies of arbitrary depth are possible. An agent can be both a child of one agent and a parent of others.
- **Decoupling** — Sub-agents can be rewired, replaced, or added without changing the parent's instructions, as long as the destination name stays the same.

---

## Skill Types

NanoClaw has four skill types. The type determines where the skill lives, who runs it, and when it takes effect.

### Operational

Pure instruction workflows — the SKILL.md is the entire skill. No code files, no branch merges. The user invokes it on the host (Claude Code), Claude reads the instructions and executes them step by step.

**Lives in:** `.claude/skills/<name>/` on `main`  
**Invoked by:** the user or host-side Claude, on demand  
**Examples:** `/setup`, `/debug`, `/customize`, `/update-nanoclaw`, `/init-first-agent`

Use this type for guided processes: interactive setup flows, troubleshooting guides, administrative workflows. Anything that is a series of steps rather than a capability.

**Example — `/debug`:** A troubleshooting guide that walks through checking host logs, session DBs, container state, and common failure modes. The entire skill is markdown instructions — no scripts, no installs. The user invokes it when something breaks and Claude follows the steps.

```
.claude/skills/debug/
└── SKILL.md    ← the whole skill
```

**Developing and adding to NanoClaw:**
1. Create `.claude/skills/<name>/SKILL.md` with the standard frontmatter (`name`, `description`)
2. Write the instructions as a step-by-step workflow. Use `AskUserQuestion` calls in the instructions where the skill needs interactive input from the user
3. Test end-to-end on a fresh clone — run the skill yourself and verify every step works
4. Open a PR to `main` with only the new skill directory. No source code changes should be needed

### Utility

Ships code files alongside a SKILL.md. The SKILL.md contains installation instructions; the supporting scripts or binaries live in the skill directory itself. Nothing needs to be merged from another branch — the code is self-contained. Use `${CLAUDE_SKILL_DIR}` in the SKILL.md to reference files in the skill folder.

**Lives in:** `.claude/skills/<name>/` with supporting files  
**Invoked by:** the user or host-side Claude, on demand  
**Examples:** `/claw` (Python CLI in `scripts/claw`)

Use this type when the skill needs to ship a script or small tool alongside its instructions but does not require changes to the NanoClaw source tree.

**Example — `/claw`:** A Python CLI that lets you send prompts to an agent container directly from the terminal. The SKILL.md explains how to install it; the actual Python script lives in `scripts/claw` inside the skill directory and gets copied into place during installation.

```
.claude/skills/claw/
├── SKILL.md        ← install instructions, references ${CLAUDE_SKILL_DIR}/scripts/claw
└── scripts/
    └── claw        ← the Python CLI
```

**Developing and adding to NanoClaw:**
1. Create `.claude/skills/<name>/` and put all supporting code in subdirectories alongside `SKILL.md` (e.g. `scripts/`, `src/`)
2. Use `${CLAUDE_SKILL_DIR}` in the SKILL.md to reference those files — this resolves to the skill's directory at runtime so paths stay correct wherever the skill is installed
3. Keep code in separate files, not inlined as code blocks in the SKILL.md
4. The SKILL.md should contain installation instructions (how to copy or symlink the files into place), usage docs, and troubleshooting — not the code itself
5. Test on a fresh clone: follow the SKILL.md installation steps yourself and verify the tool works
6. Open a PR to `main` with the full skill directory

### Container

Runs inside the agent container, not on the host. These skills are synced into each agent group's `.claude/skills/` directory when a container starts, and are loaded by Claude Code inside the container. They influence how the agent behaves during its conversations — not how the host is set up.

**Lives in:** `container/skills/<name>/`  
**Invoked by:** the container agent, automatically or on demand  
**Examples:** `agent-browser` (web browsing), `slack-formatting` (mrkdwn syntax), `self-customize`, `vercel-cli`, `welcome`

A container skill can optionally ship an `instructions.md` alongside its SKILL.md. If present, the instructions are injected into the agent's CLAUDE.md on every turn (always-on context). Without one, the skill is on-demand — the agent invokes it explicitly when needed.

Use the `allowed-tools` frontmatter field to scope which tools the skill is permitted to use (e.g. `Bash(agent-browser:*)`).

Use this type when the behavior needs to be active inside agent sessions: formatting rules, proactive tool use, always-available capabilities like browsing or deployment.

**Example — `slack-formatting`:** Teaches the agent to use Slack's mrkdwn syntax (`*bold*`, `<url|text>`, `:emoji:`) instead of standard Markdown. Because this must apply to every message sent to a Slack channel — not just when the user asks — it is a good candidate for an `instructions.md` that gets injected into every turn. The `SKILL.md` contains the full formatting reference for when the agent needs detail.

```
container/skills/slack-formatting/
├── SKILL.md            ← full mrkdwn reference, invoked on demand
└── instructions.md     ← (candidate) short always-on rule: "in Slack contexts use mrkdwn"
```

**Example — `agent-browser`:** Gives the agent access to the `agent-browser` CLI for web browsing, form filling, screenshots, and data extraction. Uses `allowed-tools: Bash(agent-browser:*)` in the frontmatter to scope the permission to that binary only.

```
container/skills/agent-browser/
└── SKILL.md    ← command reference + allowed-tools: Bash(agent-browser:*)
```

**Developing and adding to NanoClaw:**
1. Create `container/skills/<name>/SKILL.md`. Use `allowed-tools` frontmatter to scope any tool permissions the skill needs — don't leave them open-ended
2. Decide whether the skill needs an `instructions.md`: if its rules must be active on every agent turn (formatting, proactive behaviors, always-on defaults), add one alongside the SKILL.md. Keep it short — it is injected into every turn's context. If the skill is reference material the agent looks up on demand, SKILL.md alone is sufficient
3. Keep container skills focused — the context window is shared across all enabled container skills. Strip anything that isn't needed on every turn
4. The skill is automatically available to agent groups that include it in their `container.json` skills list (or `"skills": "all"`). No registration step is needed
5. To test: add the skill to a group's `container.json`, rebuild the container image (`./container/build.sh`), and verify the agent uses it correctly in a live session
6. Open a PR to `main` with the new `container/skills/<name>/` directory

### Feature

The largest category. Adds a new capability to NanoClaw by merging a git branch. The SKILL.md on `main` contains setup instructions; the actual code (channel adapter, provider module, etc.) lives on a `skill/*` or `channels`/`providers` branch. Step one of the SKILL.md is always merging that branch.

**Lives in:** `.claude/skills/<name>/` on `main` (instructions); code on a `skill/*` branch  
**Invoked by:** the user or host-side Claude, once during setup  
**Examples:** `/add-telegram`, `/add-slack`, `/add-discord`, `/add-gmail`, `/add-opencode`

Use this type when adding a channel adapter, provider, or any capability that requires new source files merged into the host codebase.

**Example — `/add-telegram`:** Installs the Telegram channel adapter. The SKILL.md on `main` walks through fetching and merging the `channels` branch, adding credentials, and running the pairing setup. All the actual TypeScript lives on that branch — the SKILL.md on `main` is just the installation guide.

```
.claude/skills/add-telegram/
└── SKILL.md    ← step 1: merge channels branch; steps 2–N: credentials + setup

channels branch:
src/channels/telegram.ts            ← adapter code
src/channels/telegram-pairing.ts
setup/pair-telegram.ts
```

**Developing and adding to NanoClaw:**
1. Fork `qwibitai/nanoclaw` and branch from `main` to write the code (new source files, updated `package.json`, etc.)
2. Add `.claude/skills/<name>/SKILL.md` on that same branch. Step 1 of the SKILL.md must be the branch merge — subsequent steps cover credentials, env vars, and any interactive setup
3. Open a PR. The maintainers will split your work: the code lands on a new `skill/<name>` branch (or `channels`/`providers`), and the SKILL.md lands on `main`. This keeps `main` clean while making the capability opt-in
4. The skill is idempotent by convention: running it twice on an already-installed adapter should be a safe no-op. Gate each step on whether the target file or import already exists before writing
5. Test on a fresh clone by following the SKILL.md from scratch — every step should work without prior knowledge of the implementation

### Comparison

| | Operational | Utility | Container | Feature |
|---|---|---|---|---|
| Has code files | No | Yes (in skill dir) | Yes (in skill dir) | Yes (on branch) |
| Branch merge required | No | No | No | Yes |
| Runs on | Host | Host | Agent container | Host (setup) |
| When active | On demand | On demand | On container start | After merge |
| Can have `instructions.md` | No | No | Yes | No |

---

## Building Agent Teams

Wiring agents together technically is only half the job. For agents to collaborate effectively, each agent also needs instructions — in its `CLAUDE.md` — describing the team structure, the role of each member, and when to communicate with whom.

### Agents have no shared topology awareness

An agent can only see its own destinations table. It has no visibility into the wider agent network — it does not know what destinations other agents have, or even that other agents exist unless told. If you want A1-T1 to know that A1-O2 exists, you have to say so in A1-T1's `CLAUDE.md`.

### The two things you always need to define

1. **Who can talk to whom** — `agent_destinations` wiring in the central DB
2. **When and why** — instructions in each agent's `CLAUDE.md` describing roles, responsibilities, and when to reach out to which destination

Neither alone is sufficient. Wiring without instructions leaves agents unaware of when to use each other. Instructions without wiring give agents nowhere to send messages.

### Topology patterns

**Hub and spoke** (recommended for most teams)

One coordinator agent is wired to all specialists. Each specialist only knows about the coordinator (`parent`). The coordinator's `CLAUDE.md` describes every specialist and when to delegate to them.

```
              ┌──→ Specialist A
Coordinator ──┼──→ Specialist B
              └──→ Specialist C

Each specialist only knows: parent → Coordinator
```

- Simple to reason about and maintain
- Easy to add new specialists without touching existing ones
- Coordinator becomes the single point of context across the team

**Full mesh**

Every agent is wired to every other agent. Each agent's `CLAUDE.md` must describe all peers and when to contact each.

```
Agent A ←──→ Agent B
  ↕              ↕
Agent C ←──→ Agent D
```

- Maximum flexibility
- Destination table grows with the square of team size
- Instructions become complex quickly — generally only practical for small, tightly coupled teams

### Intermediary relaying

Agents that are not directly wired cannot address each other. However, a mutual peer (e.g. a coordinator) can act as an intermediary — receiving a message from one agent and forwarding it to another. This only works if the sending agent's instructions tell it to ask the intermediary to relay, and the intermediary's instructions tell it how to handle that request. Nothing in the system does this automatically.

### Example CLAUDE.md team instructions

A coordinator's `CLAUDE.md` might include:

```
## Team

You coordinate a small team of specialist agents. Use them as follows:

- `a1-t1` — handles scheduled tasks and recurring daily briefings. Delegate any request involving timed or recurring delivery.
- `a1-o2` — handles research tasks. Delegate any request requiring deep web research or document summarisation.

When delegating, send a clear task description including any relevant context the specialist will need. They have no access to your conversation history.
```

A specialist's `CLAUDE.md` might include:

```
## Role

You are a research specialist. You receive task requests from your coordinator via the `parent` destination and return your findings as a message back to `parent`. You do not communicate directly with users.
```

---

### Current wiring in this install

```
A1-O1 ──── a1-t1 ──→ A1-T1
      └─── a1-o2 ──→ A1-O2

A1-T1 ──── parent ──→ A1-O1
A1-O2 ──── parent ──→ A1-O1
```

A1-O1 acts as the coordinating agent. A1-T1 handles scheduled tasks (e.g. daily morning briefings). A1-O2 is a standalone agent that has been wired to A1-O1 as of April 2026.
