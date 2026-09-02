CREATE TABLE revision_builds (
  revision_id TEXT PRIMARY KEY REFERENCES project_revisions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'invalid', 'error', 'ready')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 1000),
  check_results TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(check_results) AND json_type(check_results) = 'array'),
  preview_prefix TEXT,
  manifest_digest TEXT CHECK (manifest_digest IS NULL OR length(manifest_digest) = 64),
  input_digest TEXT CHECK (input_digest IS NULL OR length(input_digest) = 64),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 1000),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    status != 'ready'
    OR (preview_prefix IS NOT NULL AND manifest_digest IS NOT NULL AND input_digest IS NOT NULL)
  )
);

CREATE TABLE revision_approvals (
  revision_id TEXT PRIMARY KEY REFERENCES project_revisions(id) ON DELETE CASCADE,
  build_attempt INTEGER NOT NULL CHECK (build_attempt BETWEEN 1 AND 1000),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL
);

CREATE TABLE managed_render_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES project_revisions(id) ON DELETE CASCADE,
  owner_email TEXT NOT NULL,
  build_attempt INTEGER NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  workflow_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
  stream_video_id TEXT,
  preview_url TEXT,
  hls_url TEXT,
  thumbnail_url TEXT,
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX managed_render_jobs_revision_created
  ON managed_render_jobs (revision_id, created_at DESC);

CREATE TRIGGER revision_approvals_immutable
BEFORE UPDATE ON revision_approvals
BEGIN
  SELECT RAISE(ABORT, 'revision approval is immutable');
END;
