-- Quota counters for send_email and POST /mcp.
-- Safe to re-run. This file no longer creates mail archive tables.
-- Do not DROP emails, ingest_failures, or cache_revision from this change:
-- historical rows stay until a separate data-destruction step.
CREATE TABLE IF NOT EXISTS rate_limits (
  k      TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count  INTEGER NOT NULL
);
