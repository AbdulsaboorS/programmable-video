ALTER TABLE revision_builds ADD COLUMN lease_owner TEXT;

CREATE INDEX revision_builds_status_updated
  ON revision_builds (status, updated_at);
