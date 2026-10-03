-- Permanent archive of abot.run mail. Safe to re-run.
CREATE TABLE IF NOT EXISTS emails (
  resend_id   TEXT PRIMARY KEY,
  direction   TEXT NOT NULL,            -- 'in' | 'out'
  msg_from    TEXT,
  msg_to      TEXT,                     -- JSON array
  cc          TEXT,                     -- JSON array
  subject     TEXT,
  date        TEXT,                     -- ISO8601; Date header, else event time
  text_body   TEXT,
  html_body   TEXT,
  message_id  TEXT,
  auth        TEXT,                     -- JSON {spf,dkim,dmarc}, inbound only
  attachments TEXT,                     -- JSON [{filename, content_type, size, r2_key}]
  summary     TEXT,                     -- JSON {"points":[...],"todos":[{"text","deadline"}]} or NULL
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  is_read     INTEGER DEFAULT 0,        -- 1 read, 0 unread
  deleted_at  INTEGER,                  -- unix ms when soft-deleted; NULL is live
  is_archived INTEGER DEFAULT 0         -- 1 hidden from default search/list
);

CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(msg_from);

-- Ingest dead letters. Queryable replay list. Does not change emails.
CREATE TABLE IF NOT EXISTS ingest_failures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  resend_id   TEXT,
  event_type  TEXT,
  error       TEXT,
  attempts    INTEGER,
  failed_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ingest_failures_resend_id ON ingest_failures(resend_id);

-- Generation for MCP read-cache keys. One row, advanced in the same commit as
-- an emails insert. Fetch handlers read it from the primary on every read and
-- put it in the cache key, so a stale colo entry is never addressed.
-- caches.default is per-colo, and a queue consumer does not share it with fetch.
CREATE TABLE IF NOT EXISTS cache_revision (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL
);

INSERT OR IGNORE INTO cache_revision (id, rev) VALUES (1, 0);

DROP TRIGGER IF EXISTS cache_revision_after_email_insert;
CREATE TRIGGER cache_revision_after_email_insert
AFTER INSERT ON emails
BEGIN
  INSERT INTO cache_revision (id, rev) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET rev = rev + 1;
END;

-- summary is nullable and is not indexed. This file is safe to re-run:
-- CREATE TABLE IF NOT EXISTS does not add columns to a table that already
-- exists, and AFTER INSERT is the only revision bump (UPDATE does not fire).
-- The worker adds summary on "no such column: summary" and ignores
-- "duplicate column name: summary", so an already-deployed database picks
-- the column up without a second manual ALTER.
--
-- is_read, deleted_at, and is_archived are part of this CREATE for a new
-- database. They are NOT added by re-running this file on a database created
-- before them. Readers detect the columns. When they are missing, the worker
-- applies worker/migrations/mailbox-columns.sql (duplicate column name is
-- ignored) and, if that ALTER fails, omits the column from that SELECT.
-- A missing column must not turn search_emails or email_stats into JSON-RPC
-- -32603. Run the migration on the existing production database anyway.
