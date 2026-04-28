# Multiple Matrix Bot Accounts

NanoClaw supports running multiple Matrix bot accounts in the same process. Each account uses a distinct env var prefix and registers as its own channel type, so different agent groups can appear as different Matrix users.

## How It Works

`src/channels/matrix.ts` exports a `registerMatrixAdapter(adapterName, envPrefix)` function. Each call spins up an independent Matrix client with its own sync state, session storage, and DM cache. The `adapterName` is stored as `channel_type` in the DB and is how the router knows which adapter to use for inbound and outbound messages.

## Adding a New Bot Account

### 1. Register the adapter in `matrix.ts`

Open `src/channels/matrix.ts` and add a line at the bottom:

```ts
registerMatrixAdapter('matrix-<name>', 'MATRIX_<NAME>');
```

Use lowercase-hyphenated for the adapter name and UPPER_SNAKE for the env prefix. Example for an agent named "ops":

```ts
registerMatrixAdapter('matrix-ops', 'MATRIX_OPS');
```

### 2. Add credentials to `.env`

Add the following vars, substituting `<NAME>` with your prefix:

```env
MATRIX_<NAME>_BASE_URL=https://your.matrix.server
MATRIX_<NAME>_ACCESS_TOKEN=your_access_token_here
MATRIX_<NAME>_USER_ID=@botuser:your.matrix.server
MATRIX_<NAME>_BOT_USERNAME=Display Name
MATRIX_<NAME>_DEVICE_ID=STABLE_DEVICE_ID
```

You can use password auth instead of an access token:

```env
MATRIX_<NAME>_BASE_URL=https://your.matrix.server
MATRIX_<NAME>_USERNAME=botuser
MATRIX_<NAME>_PASSWORD=password
MATRIX_<NAME>_USER_ID=@botuser:your.matrix.server
MATRIX_<NAME>_BOT_USERNAME=Display Name
```

Optional vars:

```env
MATRIX_<NAME>_INVITE_AUTOJOIN=true                    # auto-accept invites (default: true)
MATRIX_<NAME>_INVITE_AUTOJOIN_ALLOWLIST=@user:server  # restrict who can invite
MATRIX_<NAME>_RECOVERY_KEY=your_recovery_key          # E2EE cross-signing
```

### 3. Create and wire the messaging group

```bash
sqlite3 data/v2.db "
INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
VALUES (
  'mg-' || CAST(strftime('%s', 'now') * 1000 AS TEXT) || '-<shortid>',
  'matrix-<name>',
  'matrix:!RoomId%3Ayour.matrix.server',
  'Room Display Name',
  1,
  'strict',
  datetime('now')
);
"
```

Note: the `platform_id` depends on member count. If the room has only 2 members (you + the bot), the adapter's DM resolution rewrites the channel ID to the sender's user handle — use `matrix:@user:server` as the platform_id. For group rooms with 3+ members, use the URL-encoded room ID (`:` → `%3A`): `matrix:!RoomId%3Aserver`.

In practice it is easier to let the first message auto-create the messaging group (the correct platform_id is logged as `channelId` in "Inbound DM/group received"), then wire that auto-created group to the agent group rather than pre-creating it.

Then wire it to the agent group:

```bash
sqlite3 data/v2.db "
INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, priority, created_at)
VALUES (
  'mga-' || CAST(strftime('%s', 'now') * 1000 AS TEXT) || '-<shortid>',
  '<messaging_group_id from above>',
  '<agent_group_id from agent_groups table>',
  'agent-shared',
  0,
  datetime('now')
);
"
```

Use `agent-shared` if you may wire additional rooms to this agent later and want them in one conversation thread. Use `shared` to keep rooms in separate sessions.

### 4. Invite the bot to the room

The new bot user needs to be a member of the room before it can receive messages. In your Matrix client, invite `@botuser:your.matrix.server` to the room. With `INVITE_AUTOJOIN=true` (the default), the bot will accept automatically on startup.

### 5. Build and restart

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                 # Linux
```

## Installed Instances

| Adapter name | Env prefix | Agent group | Room |
|---|---|---|---|
| `matrix` | `MATRIX` | A1-O1 | upgrade0999 DM + shared room |
| `matrix-a1t1` | `MATRIX_A1T1` | A1-T1 | `!VhYNKhMMaAReSayJKn:chat.rootword.cc` |

Update this table whenever you add a new instance.

## How Persistence Is Isolated

Each adapter instance passes `persistence: { keyPrefix: adapterName }` to `createMatrixAdapter`. This namespaces all stored state (sync tokens, session keys, DM room cache) under the adapter name, so two bots connecting to the same homeserver don't collide.

## Credentials via OneCLI (optional)

Matrix credentials are currently read from `.env`. If you prefer vault-managed secrets, store each bot's access token in OneCLI and reference it via the agent's secret assignments — but the current adapter reads from env vars, so you would need to extend the factory to use the OneCLI SDK or inject secrets as env vars at process start.
