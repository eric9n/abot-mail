-- botu-secrets v1. Safe to re-run. Does not touch other databases.
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  is_ops INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bots_token ON bots(token_hash);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  dek_wrapped_b64 TEXT NOT NULL,
  nonce_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  version INTEGER NOT NULL,
  rotate_every_days INTEGER,
  last_rotated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_secrets_scope ON secrets(scope);

CREATE TABLE IF NOT EXISTS grants (
  bot_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  PRIMARY KEY (bot_id, scope)
);

CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  secret_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_leases_secret ON leases(secret_id);
CREATE INDEX IF NOT EXISTS idx_leases_bot ON leases(bot_id);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  action TEXT NOT NULL,
  secret_name_hash TEXT,
  lease_id TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
CREATE INDEX IF NOT EXISTS idx_audit_bot ON audit(bot_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action, ts);
CREATE INDEX IF NOT EXISTS idx_audit_name ON audit(secret_name_hash);
