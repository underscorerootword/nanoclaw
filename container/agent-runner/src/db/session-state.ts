/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

export function setApiRetryState(timestamp: string): void {
  // Only set on first retry — preserve the original timestamp so the host
  // can calculate how long the retry has been ongoing.
  if (getValue('api_retry_at') === undefined) {
    setValue('api_retry_at', timestamp);
  }
}

export function clearApiRetryState(): void {
  deleteValue('api_retry_at');
}

// Threshold: sessions that compact >80k tokens are flagged as large. Routine
// small compactions (e.g. a single long tool result) stay below this.
const CONTEXT_COMPACTION_THRESHOLD = 80_000;

export function setContextCompactionState(preTokens: number): void {
  if (preTokens < CONTEXT_COMPACTION_THRESHOLD) return;
  setValue('context_compaction_pre_tokens', String(preTokens));
  // Preserve the earliest compaction timestamp — if compaction fires multiple
  // times in one session, the host sees when the session first became large.
  if (getValue('context_compaction_at') === undefined) {
    setValue('context_compaction_at', new Date().toISOString());
  }
}

export function clearContextCompactionState(): void {
  deleteValue('context_compaction_at');
  deleteValue('context_compaction_pre_tokens');
}
