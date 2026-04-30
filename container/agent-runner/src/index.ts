/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  const instructions = buildSystemPromptAddendum(config.assistantName || undefined);

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  // Build explicit skill allowlist: container skills + agent skills + workspace skills.
  // Passing this to the provider suppresses Claude Code's built-in skills from the listing.
  const allowedSkills: string[] = [];
  for (const dir of ['/app/skills', '/app/agent-skills']) {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        try {
          if (fs.statSync(path.join(dir, entry)).isDirectory()) allowedSkills.push(entry);
        } catch {
          /* skip unreadable entries */
        }
      }
    }
  }
  const workspaceSkillsDir = path.join(CWD, 'skills');
  if (fs.existsSync(workspaceSkillsDir)) {
    for (const entry of fs.readdirSync(workspaceSkillsDir)) {
      try {
        if (fs.statSync(path.join(workspaceSkillsDir, entry)).isDirectory()) allowedSkills.push(entry);
      } catch {
        /* skip unreadable entries */
      }
    }
  }
  if (allowedSkills.length > 0) {
    log(`Allowed skills: ${allowedSkills.join(', ')}`);
  }

  // Build a skill listing for the system prompt so the agent always sees the
  // authoritative current list on every turn — including resumed sessions where
  // Claude Code never re-injects a fresh skill_listing attachment.
  let finalInstructions = instructions;
  if (allowedSkills.length > 0) {
    const seenSkills = new Set<string>();
    const skillLines: string[] = [];
    for (const dir of ['/app/skills', '/app/agent-skills', workspaceSkillsDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (seenSkills.has(entry)) continue;
        const skillDir = path.join(dir, entry);
        try {
          if (!fs.statSync(skillDir).isDirectory()) continue;
          seenSkills.add(entry);
          const skillMdPath = path.join(skillDir, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) {
            skillLines.push(`- /${entry}`);
            continue;
          }
          const content = fs.readFileSync(skillMdPath, 'utf-8');
          const match = content.match(/^---\n[\s\S]*?description:\s*(.+?)\n[\s\S]*?---/m);
          const description = match ? match[1].trim() : '';
          skillLines.push(description ? `- /${entry} — ${description}` : `- /${entry}`);
        } catch {
          /* skip unreadable skill */
        }
      }
    }
    if (skillLines.length > 0) {
      const skillsSection =
        `## Currently loaded skills\n\nThese are the ONLY skills available to you — do not reference any others:\n\n${skillLines.join('\n')}`;
      finalInstructions = instructions ? `${instructions}\n\n${skillsSection}` : skillsSection;
    }
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    autoCompactWindow: config.autoCompactWindow,
    allowedSkills: allowedSkills.length > 0 ? allowedSkills : undefined,
  });

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions: finalInstructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
