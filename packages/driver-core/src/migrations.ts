export interface DriverMigration { readonly version: number; readonly name: string; readonly sql: string }

export const DRIVER_MIGRATIONS: readonly DriverMigration[] = Object.freeze([{ version: 1, name: "encrypted_driver_projection", sql: `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS local_session (id INTEGER PRIMARY KEY CHECK (id = 1), installation_generation TEXT NOT NULL, session_generation TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS manifest_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, encrypted_projection BLOB NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS manifest_stop (stop_reference TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, encrypted_projection BLOB NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sync_cursor (projection_reference TEXT PRIMARY KEY, encrypted_cursor BLOB NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS client_action (action_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, resource_reference TEXT NOT NULL, expected_version INTEGER NOT NULL, causal_sequence INTEGER NOT NULL, command TEXT NOT NULL, encrypted_payload BLOB NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL, next_attempt_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS location_epoch (epoch INTEGER PRIMARY KEY, tracking_generation TEXT NOT NULL, policy_version TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS location_sample (sample_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL REFERENCES location_epoch(epoch), sequence INTEGER NOT NULL, captured_at TEXT NOT NULL, encrypted_sample BLOB NOT NULL, policy_version TEXT NOT NULL, state TEXT NOT NULL, UNIQUE(epoch, sequence));
CREATE TABLE IF NOT EXISTS location_batch (batch_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL REFERENCES location_epoch(epoch), first_sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL, item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 500), state TEXT NOT NULL, UNIQUE(epoch, first_sequence, last_sequence));
CREATE TABLE IF NOT EXISTS evidence_draft (draft_id TEXT PRIMARY KEY, kind TEXT NOT NULL, digest TEXT NOT NULL, encrypted_content BLOB NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evidence_blob (blob_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES evidence_draft(draft_id), digest TEXT NOT NULL, encrypted_content BLOB NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_attempt (attempt_id TEXT PRIMARY KEY, work_reference TEXT NOT NULL, work_kind TEXT NOT NULL, outcome TEXT NOT NULL, duration_bucket TEXT NOT NULL, occurred_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS safe_diagnostic (id INTEGER PRIMARY KEY AUTOINCREMENT, metric TEXT NOT NULL, outcome TEXT NOT NULL, state TEXT, duration_bucket TEXT, occurred_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS client_action_pending_idx ON client_action(state, next_attempt_at, causal_sequence);
CREATE INDEX IF NOT EXISTS location_sample_pending_idx ON location_sample(state, epoch, sequence);
CREATE INDEX IF NOT EXISTS evidence_draft_pending_idx ON evidence_draft(state, created_at);
`}]);
