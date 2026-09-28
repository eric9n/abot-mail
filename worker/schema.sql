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
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
