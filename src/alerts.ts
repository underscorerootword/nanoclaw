/**
 * Host-side alert delivery for agent health events.
 *
 * Sends pre-packaged notifications directly to a configured Matrix room
 * (MATRIX_ALERTS_ROOM_ID) without going through the session / outbound DB
 * model. This keeps the alert path API-free — no agent container or Anthropic
 * API call is involved — so it works even when the API itself is the problem.
 */
import { log } from './log.js';
import { getChannelAdapter } from './channels/channel-registry.js';

function getAlertsRoomId(): string | null {
  return process.env.MATRIX_ALERTS_ROOM_ID ?? null;
}

async function sendToAlertsRoom(text: string): Promise<void> {
  const roomId = getAlertsRoomId();
  if (!roomId) return;

  const adapter = getChannelAdapter('matrix');
  if (!adapter) {
    log.warn('Alerts: matrix adapter not ready, skipping alert');
    return;
  }

  // Matrix adapter's decodeThreadId expects "matrix:<url-encoded-room-id>".
  // A raw "!room:server" string fails to decode, falls into the user-handle
  // path, and silently no-ops. Encode it so the adapter routes correctly.
  const encodedRoomId = `matrix:${encodeURIComponent(roomId)}`;

  try {
    await adapter.deliver(encodedRoomId, null, { kind: 'chat', content: { text } });
  } catch (err) {
    log.error('Alerts: failed to deliver alert to Matrix room', {
      roomId,
      err,
    });
  }
}

function elapsedMinutes(since: string): number {
  return Math.floor((Date.now() - new Date(since).getTime()) / 60_000);
}

export async function sendApiRetryAlert(agentGroupName: string, retryAt: string): Promise<void> {
  const minutes = elapsedMinutes(retryAt);
  const text =
    `⚠️ Agent delay: **${agentGroupName}** has been retrying the Anthropic API for ${minutes} min.\n` +
    `It will continue automatically — no action needed unless this persists.`;
  await sendToAlertsRoom(text);
  log.info('Alerts: API retry alert sent', { agentGroupName, retryAt });
}

export async function sendApiRetryResolvedAlert(agentGroupName: string): Promise<void> {
  const text = `✅ **${agentGroupName}**: API delay resolved. Response delivered.`;
  await sendToAlertsRoom(text);
  log.info('Alerts: API retry resolved alert sent', { agentGroupName });
}
