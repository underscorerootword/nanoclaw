/**
 * Matrix channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Supports two auth methods (resolved from env):
 *   - Access token: <PREFIX>_ACCESS_TOKEN + <PREFIX>_USER_ID
 *   - Password:     <PREFIX>_USERNAME + <PREFIX>_PASSWORD (+ optional <PREFIX>_USER_ID)
 *
 * Optional env vars per instance:
 *   <PREFIX>_BOT_USERNAME              — display name for the bot (default: "bot")
 *   <PREFIX>_INVITE_AUTOJOIN           — "true" to auto-accept room invites (default: true)
 *   <PREFIX>_INVITE_AUTOJOIN_ALLOWLIST — comma-separated user IDs allowed to invite
 *   <PREFIX>_RECOVERY_KEY              — enable E2EE cross-signing
 *   <PREFIX>_DEVICE_ID                 — stable device ID across restarts
 *
 * Primary instance: env prefix MATRIX, adapter name "matrix".
 * Additional instances: call registerMatrixAdapter('matrix-<name>', 'MATRIX_<NAME>')
 * and add the corresponding env vars. See docs/multi-matrix.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMatrixAdapter } from '@beeper/chat-adapter-matrix';

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// ---------------------------------------------------------------------------
// Per-agent-group Matrix room config (groups/<folder>/matrix.yaml)
// ---------------------------------------------------------------------------

interface MatrixConfig {
  rooms: Record<string, string>; // userHandle → roomId
}

function matrixConfigPath(groupFolder: string): string {
  return path.join('groups', groupFolder, 'matrix.yaml');
}

// Minimal parser for the specific YAML shape we write:
//   rooms:
//     "@user:server": "!room:server"
function parseMatrixYaml(raw: string): MatrixConfig {
  const config: MatrixConfig = { rooms: {} };
  let inRooms = false;
  for (const line of raw.split('\n')) {
    if (/^rooms\s*:/.test(line)) { inRooms = true; continue; }
    if (inRooms) {
      if (/^\S/.test(line)) { inRooms = false; continue; } // new top-level key
      const m = line.match(/^\s+"([^"]+)"\s*:\s*"([^"]+)"/);
      if (m) config.rooms[m[1]] = m[2];
    }
  }
  return config;
}

function serializeMatrixYaml(config: MatrixConfig): string {
  const lines = ['rooms:'];
  for (const [k, v] of Object.entries(config.rooms)) {
    lines.push(`  "${k}": "${v}"`);
  }
  return lines.join('\n') + '\n';
}

function loadMatrixConfig(groupFolder: string): MatrixConfig {
  try {
    const raw = fs.readFileSync(matrixConfigPath(groupFolder), 'utf8');
    return parseMatrixYaml(raw);
  } catch {
    return { rooms: {} };
  }
}

function saveMatrixConfig(groupFolder: string, config: MatrixConfig): void {
  try {
    fs.writeFileSync(matrixConfigPath(groupFolder), serializeMatrixYaml(config), 'utf8');
  } catch (err) {
    log.warn('Failed to save matrix.yaml', { groupFolder, err });
  }
}

const SUFFIX_KEYS = [
  'BASE_URL',
  'ACCESS_TOKEN',
  'USERNAME',
  'PASSWORD',
  'USER_ID',
  'BOT_USERNAME',
  'DEVICE_ID',
  'RECOVERY_KEY',
  'INVITE_AUTOJOIN',
  'INVITE_AUTOJOIN_ALLOWLIST',
] as const;

/**
 * Wrap the Matrix adapter so DM conversations are identified by user handle
 * across the whole system, not by ephemeral room IDs.
 *
 * Matrix DMs live in rooms (e.g. "!abc:server"), but NanoClaw identifies
 * channels by platform_id. Using a user handle as platform_id means both
 * the user and the messaging group reference the same stable identifier.
 *
 * Two directions to bridge:
 *   - Outbound: delivery passes "matrix:@user:server" → resolve to room via openDM
 *   - Inbound: adapter emits "matrix:!room:server" → rewrite to user handle
 *     so the router finds the existing messaging group instead of creating
 *     a new one.
 *
 * Both resolutions are cached for the process lifetime.
 */
function wrapWithDmResolution(
  adapter: ReturnType<typeof createMatrixAdapter>,
  groupFolder?: string,
): typeof adapter {
  const origPostMessage = adapter.postMessage.bind(adapter);
  const origStartTyping = adapter.startTyping.bind(adapter);
  const origChannelIdFromThreadId = adapter.channelIdFromThreadId.bind(adapter);

  // roomId → user handle, used to rewrite inbound channel IDs.
  const roomToUserCache = new Map<string, string>();
  // user handle → roomId. Seeded from matrix.yaml on startup; updated from
  // inbound messages and persisted back to matrix.yaml so it survives restarts.
  const userHandleToRoomCache = new Map<string, string>();

  // Seed from matrix.yaml if a group folder is configured.
  if (groupFolder) {
    const config = loadMatrixConfig(groupFolder);
    for (const [userHandle, roomId] of Object.entries(config.rooms)) {
      userHandleToRoomCache.set(userHandle, roomId);
      roomToUserCache.set(roomId, userHandle);
    }
    if (Object.keys(config.rooms).length > 0) {
      log.info('Matrix: loaded room mappings from matrix.yaml', {
        groupFolder,
        count: Object.keys(config.rooms).length,
      });
    }
  }

  function persistRoomMapping(userHandle: string, roomId: string): void {
    if (!groupFolder) return;
    try {
      const config = loadMatrixConfig(groupFolder);
      if (config.rooms[userHandle] === roomId) return; // already saved
      config.rooms[userHandle] = roomId;
      saveMatrixConfig(groupFolder, config);
      log.info('Matrix: persisted room mapping to matrix.yaml', { groupFolder, userHandle, roomId });
    } catch (err) {
      log.warn('Matrix: failed to persist room mapping', { err });
    }
  }

  function isUserHandle(threadId: string): boolean {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      return !roomID.startsWith('!');
    } catch {
      return true;
    }
  }

  async function resolveThreadId(threadId: string): Promise<string> {
    if (!isUserHandle(threadId)) return threadId;

    const userHandle = threadId.startsWith('matrix:') ? threadId.slice('matrix:'.length) : threadId;

    // Use the room we last received a message from — avoids openDM which requires
    // createRoom permissions that may be blocked server-side.
    let cachedRoomId = userHandleToRoomCache.get(userHandle);

    if (cachedRoomId) {
      try {
        return adapter.encodeThreadId({ roomID: cachedRoomId });
      } catch {
        // fall through to openDM
      }
    }

    // No known room — fall back to the Chat SDK's openDM (which tries m.direct
    // account data then createRoom). If it succeeds, persist the result.
    log.info('Matrix: resolving DM room via openDM', { userHandle });
    const resolved = await adapter.openDM(userHandle);

    try {
      const { roomID } = adapter.decodeThreadId(resolved);
      roomToUserCache.set(roomID, userHandle);
      userHandleToRoomCache.set(userHandle, roomID);
      persistRoomMapping(userHandle, roomID);
    } catch {
      // decode failure is non-fatal — outbound still works
    }

    return resolved;
  }

  // Rewrite inbound room-based channel IDs to user-handle form for DM rooms.
  // Non-DM rooms pass through unchanged.
  adapter.channelIdFromThreadId = (threadId: string): string => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      if (!roomID.startsWith('!')) return origChannelIdFromThreadId(threadId);

      const cached = roomToUserCache.get(roomID);
      if (cached) return `matrix:${cached}`;

      // Not cached — check if this is a DM by membership count
      const client = (adapter as any).client;
      const room = client?.getRoom(roomID);
      if (!room) return origChannelIdFromThreadId(threadId);
      if (room.getJoinedMemberCount() > 2) return origChannelIdFromThreadId(threadId);

      const botId = (adapter as any).userID;

      // getJoinedMembers() only returns loaded members; with lazy loading enabled
      // the sender's member event may not be loaded yet on first message.
      // Fall back to currentState.members, which is populated from the event batch.
      let otherUserId = room.getJoinedMembers().find((m: { userId: string }) => m.userId !== botId)?.userId;

      if (!otherUserId) {
        const members = room.currentState?.members as
          | Record<string, { userId: string; membership: string }>
          | undefined;
        if (members) {
          otherUserId = Object.values(members).find((m) => m.membership === 'join' && m.userId !== botId)?.userId;
        }
      }

      if (!otherUserId) return origChannelIdFromThreadId(threadId);

      roomToUserCache.set(roomID, otherUserId);
      // Also populate the reverse cache so outbound replies go to this room.
      if (!userHandleToRoomCache.has(otherUserId)) {
        userHandleToRoomCache.set(otherUserId, roomID);
        persistRoomMapping(otherUserId, roomID);
      }
      return `matrix:${otherUserId}`;
    } catch {
      return origChannelIdFromThreadId(threadId);
    }
  };

  // The Chat SDK calls adapter.isDM(threadId) synchronously to decide whether
  // to dispatch to onDirectMessage handlers. The Matrix adapter doesn't expose
  // this method — it only has an async isDirectRoom(). We add a synchronous
  // isDM that checks room membership count: 2 members = DM.
  (adapter as any).isDM = (threadId: string): boolean => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      const client = (adapter as any).client;
      if (!client) return false;
      const room = client.getRoom(roomID);
      if (!room) return false;
      const members = room.getJoinedMemberCount();
      return members <= 2;
    } catch {
      return false;
    }
  };

  adapter.postMessage = async (
    threadId: string,
    ...args: Parameters<typeof origPostMessage> extends [string, ...infer R] ? R : never
  ) => {
    const resolvedTid = await resolveThreadId(threadId);
    return origPostMessage(resolvedTid, ...args);
  };

  adapter.startTyping = async (threadId: string) => {
    const resolvedTid = await resolveThreadId(threadId);
    return origStartTyping(resolvedTid);
  };

  return adapter;
}

/**
 * Register a Matrix adapter instance.
 *
 * adapterName — the channel type stored in the DB (e.g. "matrix", "matrix-a1t1").
 * envPrefix   — the env var prefix to read credentials from (e.g. "MATRIX", "MATRIX_A1T1").
 * groupFolder — optional agent group folder (e.g. "a1-t1"). When provided,
 *               room mappings are loaded from and persisted to groups/<folder>/matrix.yaml.
 *
 * Each instance maintains independent sync state (keyed by adapterName) so
 * multiple bot accounts can run in the same process without colliding.
 */
function registerMatrixAdapter(adapterName: string, envPrefix: string, groupFolder?: string): void {
  registerChannelAdapter(adapterName, {
    factory: () => {
      const envKeys = SUFFIX_KEYS.map((s) => `${envPrefix}_${s}`);
      const env = readEnvFile(envKeys);

      const get = (suffix: (typeof SUFFIX_KEYS)[number]): string =>
        env[`${envPrefix}_${suffix}`] || process.env[`${envPrefix}_${suffix}`] || '';

      const baseURL = get('BASE_URL');
      if (!baseURL) return null;

      const accessToken = get('ACCESS_TOKEN');
      const username = get('USERNAME');
      const password = get('PASSWORD');
      if (!accessToken && !(username && password)) return null;

      const userID = get('USER_ID') || undefined;
      const auth =
        username && password
          ? { type: 'password' as const, username, password, userID }
          : { type: 'accessToken' as const, accessToken: accessToken!, userID };

      const allowlistRaw = get('INVITE_AUTOJOIN_ALLOWLIST');
      const inviterAllowlist = allowlistRaw
        ? allowlistRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const autoJoinRaw = get('INVITE_AUTOJOIN');
      // Default to true (same as original adapter behaviour).
      const inviteAutoJoin = autoJoinRaw ? autoJoinRaw === 'true' || autoJoinRaw === '1' : true;

      const matrixAdapter = wrapWithDmResolution(
        createMatrixAdapter({
          baseURL,
          auth,
          userName: get('BOT_USERNAME') || 'bot',
          deviceID: get('DEVICE_ID') || undefined,
          recoveryKey: get('RECOVERY_KEY') || undefined,
          inviteAutoJoin: inviteAutoJoin ? { inviterAllowlist } : undefined,
          // Each instance gets its own persistence namespace so sync state,
          // session tokens, and DM caches don't bleed across bot accounts.
          persistence: { keyPrefix: adapterName },
        }),
        groupFolder,
      );

      const bridge = createChatSdkBridge({
        adapter: matrixAdapter,
        concurrency: 'concurrent',
        supportsThreads: false,
      });

      // Override so routing uses adapterName, not the hardcoded "matrix" from
      // the underlying adapter. This is what gets stored as channel_type in the DB.
      bridge.name = adapterName;
      bridge.channelType = adapterName;

      // Matrix user IDs contain ":" (e.g. "@user:matrix.org") which the shared
      // permissions module interprets as already-prefixed. Wrap onInbound to
      // ensure senderId always carries the "matrix:" channel prefix so user
      // records match between init-first-agent and inbound routing.
      const origSetup = bridge.setup.bind(bridge);
      bridge.setup = async (hostConfig) => {
        const origOnInbound = hostConfig.onInbound.bind(hostConfig);
        await origSetup({
          ...hostConfig,
          onInbound: (platformId, threadId, message) => {
            if (message.content && typeof message.content === 'object') {
              const content = message.content as Record<string, unknown>;
              if (typeof content.senderId === 'string' && !content.senderId.startsWith('matrix:')) {
                content.senderId = `matrix:${content.senderId}`;
              }
            }
            return origOnInbound(platformId, threadId, message);
          },
        });

        // Wait for Matrix sync to reach PREPARED state before returning from setup.
        // Without this, the host's delivery poll and sweep timer start immediately
        // and can starve the SDK's sync generator microtask queue, blocking
        // incremental syncs so new inbound messages never get dispatched.
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if ((matrixAdapter as unknown as { liveSyncReady?: boolean }).liveSyncReady) {
              log.info('Matrix sync ready', { adapter: adapterName });
              clearInterval(check);
              resolve();
            }
          }, 500);
          setTimeout(() => {
            clearInterval(check);
            resolve();
          }, 30_000);
        });
      };

      return bridge;
    },
  });
}

// Primary Matrix instance — reads MATRIX_* env vars.
registerMatrixAdapter('matrix', 'MATRIX');

// Additional Matrix instances — one per extra bot account.
// Each reads <PREFIX>_* env vars and registers under a distinct channel type.
// The messaging group's channel_type in the DB must match the adapterName here.
// See docs/multi-matrix.md for the full setup procedure.
registerMatrixAdapter('matrix-a1t1', 'MATRIX_A1T1', 'a1-t1');
