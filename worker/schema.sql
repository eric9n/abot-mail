CREATE TABLE emails (
  resend_id   TEXT PRIMARY KEY,
  direction   TEXT NOT NULL,
  msg_from    TEXT,
  msg_to      TEXT,
  cc          TEXT,
  subject     TEXT,
  date        TEXT,
  text_body   TEXT,
  html_body   TEXT,
  message_id  TEXT,
  auth        TEXT,
  attachments TEXT,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_emails_date ON emails(date);
CREATE INDEX idx_emails_from ON emails(msg_from);
