-- Existing emails tables only. A database created from the current schema.sql
-- already has these columns; running this file there fails with
-- "duplicate column name", which means the migration is already applied.
-- Execute one statement at a time. Do not batch them.
ALTER TABLE emails ADD COLUMN is_read INTEGER DEFAULT 0;
ALTER TABLE emails ADD COLUMN deleted_at INTEGER;
ALTER TABLE emails ADD COLUMN is_archived INTEGER DEFAULT 0;
