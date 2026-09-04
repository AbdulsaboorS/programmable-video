PRAGMA defer_foreign_keys = ON;

CREATE TABLE migration_0010_unsupported_sources (
  count INTEGER NOT NULL CHECK (count = 0)
);

INSERT INTO migration_0010_unsupported_sources (count)
SELECT
  (SELECT count(*) FROM projects WHERE authoring_source_kind != 'local')
  + (SELECT count(*) FROM project_revisions
     WHERE source_kind != 'r2-bundle'
       OR source_bundle_key IS NULL
       OR source_bundle_digest IS NULL
       OR source_bundle_size IS NULL);

DROP TABLE migration_0010_unsupported_sources;
DROP TABLE agent_handoffs;

DROP TRIGGER project_revisions_source_fields_insert;
DROP TRIGGER project_revisions_source_fields_update;
DROP TRIGGER project_revisions_immutable_identity;
DROP TRIGGER managed_render_jobs_require_publication;
DROP TRIGGER revision_approvals_immutable;
DROP TRIGGER project_feedback_immutable;
DROP TRIGGER project_feedback_revision_matches_project;
DROP TRIGGER managed_render_jobs_publication_immutable;
DROP TRIGGER project_media_assets_owner_matches_project;
DROP TRIGGER project_media_assets_immutable_identity;
DROP TRIGGER managed_publications_owner_and_revision_match_project;
DROP TRIGGER managed_publications_audio_kind;
DROP TRIGGER managed_publications_caption_kind;
DROP TRIGGER managed_publications_immutable;
DROP TRIGGER managed_publication_attempts_immutable_identity;

ALTER TABLE managed_publication_attempts RENAME TO migration_0010_publication_attempts;
ALTER TABLE managed_publications RENAME TO migration_0010_publications;
ALTER TABLE managed_render_jobs RENAME TO migration_0010_render_jobs;
ALTER TABLE project_media_assets RENAME TO migration_0010_media_assets;
ALTER TABLE project_feedback RENAME TO migration_0010_feedback;
ALTER TABLE revision_approvals RENAME TO migration_0010_approvals;
ALTER TABLE revision_builds RENAME TO migration_0010_builds;
ALTER TABLE project_references RENAME TO migration_0010_references;
ALTER TABLE project_revisions RENAME TO migration_0010_revisions;
ALTER TABLE projects RENAME TO migration_0010_projects;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed')),
  source_host TEXT NOT NULL,
  source_project_path TEXT NOT NULL,
  source_web_url TEXT NOT NULL,
  source_default_branch TEXT NOT NULL,
  source_selected_ref TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  request_id TEXT,
  video_brief TEXT,
  video_brief_updated_at TEXT
);

INSERT INTO projects (
  id, owner_email, name, status,
  source_host, source_project_path, source_web_url,
  source_default_branch, source_selected_ref, default_branch,
  created_at, updated_at, request_id, video_brief, video_brief_updated_at
)
SELECT
  id, owner_email, name, status,
  source_host, source_project_path, source_web_url,
  source_default_branch, source_selected_ref, repository_default_branch,
  created_at, updated_at, request_id, video_brief, video_brief_updated_at
FROM migration_0010_projects;

CREATE TABLE project_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL
    CHECK (
      length(commit_sha) = 40
      AND commit_sha NOT GLOB '*[^0-9A-Fa-f]*'
    ),
  ref TEXT NOT NULL
    CHECK (length(ref) BETWEEN 12 AND 1024 AND ref LIKE 'refs/heads/%'),
  is_default_branch INTEGER NOT NULL
    CHECK (is_default_branch IN (0, 1)),
  inspection_version INTEGER NOT NULL DEFAULT 1
    CHECK (inspection_version BETWEEN 1 AND 1000),
  inspection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (inspection_status IN ('pending', 'valid', 'invalid', 'error')),
  inspection_findings TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(inspection_findings)
      AND json_type(inspection_findings) = 'array'
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_bundle_key TEXT NOT NULL
    CHECK (length(source_bundle_key) BETWEEN 1 AND 1024),
  source_bundle_digest TEXT NOT NULL
    CHECK (
      length(source_bundle_digest) = 64
      AND source_bundle_digest NOT GLOB '*[^0-9a-f]*'
    ),
  source_bundle_size INTEGER NOT NULL
    CHECK (source_bundle_size BETWEEN 1 AND 26214400),
  source_provenance TEXT,
  UNIQUE (project_id, commit_sha)
);

INSERT INTO project_revisions (
  id, project_id, commit_sha, ref, is_default_branch,
  inspection_version, inspection_status, inspection_findings,
  created_at, updated_at,
  source_bundle_key, source_bundle_digest, source_bundle_size,
  source_provenance
)
SELECT
  id, project_id, commit_sha, ref, is_default_branch,
  inspection_version, inspection_status, inspection_findings,
  created_at, updated_at,
  source_bundle_key, source_bundle_digest, source_bundle_size,
  source_provenance
FROM migration_0010_revisions;

CREATE TABLE project_references (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 127),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 26214400),
  note TEXT NOT NULL CHECK (length(note) <= 500),
  storage_state TEXT NOT NULL CHECK (storage_state IN ('metadata-only', 'uploaded')),
  object_key TEXT,
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  CHECK (
    (storage_state = 'metadata-only' AND object_key IS NULL AND sha256 IS NULL AND width IS NULL AND height IS NULL)
    OR
    (storage_state = 'uploaded' AND media_type = 'image/png' AND object_key IS NOT NULL
      AND byte_size BETWEEN 1 AND 10485760
      AND sha256 IS NOT NULL AND length(sha256) = 64
      AND width IS NOT NULL AND width BETWEEN 1 AND 4096
      AND height IS NOT NULL AND height BETWEEN 1 AND 4096
      AND width * height <= 8294400)
  )
);

INSERT INTO project_references SELECT * FROM migration_0010_references;

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
  fps INTEGER CHECK (fps IS NULL OR fps = 30),
  duration_in_frames INTEGER
    CHECK (duration_in_frames IS NULL OR duration_in_frames IN (360, 450)),
  lease_owner TEXT,
  CHECK (
    status != 'ready'
    OR (preview_prefix IS NOT NULL AND manifest_digest IS NOT NULL AND input_digest IS NOT NULL)
  )
);

INSERT INTO revision_builds SELECT * FROM migration_0010_builds;

CREATE TABLE revision_approvals (
  revision_id TEXT PRIMARY KEY REFERENCES project_revisions(id) ON DELETE CASCADE,
  build_attempt INTEGER NOT NULL CHECK (build_attempt BETWEEN 1 AND 1000),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL
);

INSERT INTO revision_approvals SELECT * FROM migration_0010_approvals;

CREATE TABLE project_feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES project_revisions(id) ON DELETE RESTRICT,
  frame INTEGER NOT NULL CHECK (frame >= 0),
  fps INTEGER NOT NULL CHECK (fps = 30),
  duration_in_frames INTEGER NOT NULL CHECK (duration_in_frames IN (360, 450)),
  feedback TEXT NOT NULL CHECK (length(feedback) BETWEEN 1 AND 1500),
  created_at TEXT NOT NULL,
  CHECK (frame < duration_in_frames)
);

INSERT INTO project_feedback SELECT * FROM migration_0010_feedback;

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
  updated_at TEXT NOT NULL,
  publication_id TEXT REFERENCES managed_publications(id)
);

CREATE TABLE project_media_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('audio', 'captions')),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
  sha256 TEXT NOT NULL
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending', 'valid', 'invalid')),
  validation_error TEXT CHECK (validation_error IS NULL OR length(validation_error) <= 1000),
  decoded_duration_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  CHECK (
    (kind = 'audio'
      AND media_type IN ('audio/mpeg', 'audio/wav', 'audio/mp4')
      AND byte_size <= 26214400
      AND (decoded_duration_ms IS NULL OR decoded_duration_ms BETWEEN 1 AND 60000))
    OR
    (kind = 'captions'
      AND media_type = 'text/vtt'
      AND byte_size <= 1048576
      AND decoded_duration_ms IS NULL)
  )
);

INSERT INTO project_media_assets SELECT * FROM migration_0010_media_assets;

CREATE TABLE managed_publications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES project_revisions(id) ON DELETE RESTRICT,
  owner_email TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  build_attempt INTEGER NOT NULL CHECK (build_attempt BETWEEN 1 AND 1000),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  finishing_spec_version INTEGER NOT NULL CHECK (finishing_spec_version = 1),
  finishing_spec_json TEXT NOT NULL CHECK (json_valid(finishing_spec_json) AND json_type(finishing_spec_json) = 'object'),
  finishing_spec_digest TEXT NOT NULL CHECK (length(finishing_spec_digest) = 64 AND finishing_spec_digest NOT GLOB '*[^0-9a-f]*'),
  output_profile TEXT NOT NULL CHECK (output_profile IN ('landscape', 'square', 'portrait')),
  output_width INTEGER NOT NULL,
  output_height INTEGER NOT NULL,
  output_fit TEXT NOT NULL CHECK (output_fit IN ('contain', 'cover')),
  trim_start_frame INTEGER NOT NULL CHECK (trim_start_frame >= 0),
  trim_end_frame INTEGER NOT NULL CHECK (trim_end_frame BETWEEN 1 AND 450),
  audio_gain_percent INTEGER CHECK (audio_gain_percent BETWEEN 0 AND 100),
  audio_asset_id TEXT,
  audio_asset_digest TEXT,
  caption_mode TEXT NOT NULL CHECK (caption_mode IN ('none', 'uploaded', 'generated')),
  caption_asset_id TEXT,
  caption_asset_digest TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, audio_asset_id) REFERENCES project_media_assets(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, caption_asset_id) REFERENCES project_media_assets(project_id, id) ON DELETE RESTRICT,
  CHECK (trim_start_frame < trim_end_frame),
  CHECK (
    (output_profile = 'landscape' AND output_width = 1280 AND output_height = 720)
    OR (output_profile = 'square' AND output_width = 1080 AND output_height = 1080)
    OR (output_profile = 'portrait' AND output_width = 1080 AND output_height = 1920)
  ),
  CHECK (
    (audio_asset_id IS NULL AND audio_asset_digest IS NULL AND audio_gain_percent IS NULL)
    OR (audio_asset_id IS NOT NULL AND audio_asset_digest IS NOT NULL
      AND length(audio_asset_digest) = 64 AND audio_asset_digest NOT GLOB '*[^0-9a-f]*'
      AND audio_gain_percent IS NOT NULL)
  ),
  CHECK (
    (caption_mode = 'none' AND caption_asset_id IS NULL AND caption_asset_digest IS NULL)
    OR (caption_mode = 'uploaded' AND caption_asset_id IS NOT NULL
      AND caption_asset_digest IS NOT NULL AND length(caption_asset_digest) = 64
      AND caption_asset_digest NOT GLOB '*[^0-9a-f]*')
    OR (caption_mode = 'generated' AND caption_asset_id IS NULL
      AND caption_asset_digest IS NULL AND audio_asset_id IS NOT NULL)
  )
);

INSERT INTO managed_publications SELECT * FROM migration_0010_publications;
INSERT INTO managed_render_jobs SELECT * FROM migration_0010_render_jobs;

CREATE TABLE managed_publication_attempts (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES managed_publications(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 1000),
  workflow_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 1000),
  stream_video_id TEXT,
  stream_upload_url TEXT,
  playback_status TEXT NOT NULL CHECK (playback_status IN ('pending', 'processing', 'ready', 'failed')),
  player_url TEXT,
  hls_url TEXT,
  caption_status TEXT NOT NULL CHECK (caption_status IN ('not_requested', 'pending', 'processing', 'ready', 'failed')),
  caption_error TEXT CHECK (caption_error IS NULL OR length(caption_error) <= 1000),
  thumbnail_status TEXT NOT NULL CHECK (thumbnail_status IN ('pending', 'processing', 'ready', 'failed', 'not_requested')),
  thumbnail_url TEXT,
  manifest_status TEXT NOT NULL CHECK (manifest_status IN ('pending', 'processing', 'ready', 'failed')),
  download_status TEXT NOT NULL CHECK (download_status IN ('not_requested', 'pending', 'processing', 'ready', 'failed')),
  download_percent REAL CHECK (download_percent IS NULL OR download_percent BETWEEN 0 AND 100),
  download_url TEXT,
  download_error TEXT CHECK (download_error IS NULL OR length(download_error) <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (publication_id, attempt)
);

INSERT INTO managed_publication_attempts SELECT * FROM migration_0010_publication_attempts;

DROP TABLE migration_0010_publication_attempts;
DROP TABLE migration_0010_render_jobs;
DROP TABLE migration_0010_publications;
DROP TABLE migration_0010_media_assets;
DROP TABLE migration_0010_feedback;
DROP TABLE migration_0010_approvals;
DROP TABLE migration_0010_builds;
DROP TABLE migration_0010_references;
DROP TABLE migration_0010_revisions;
DROP TABLE migration_0010_projects;

CREATE INDEX projects_owner_updated
  ON projects (owner_email, updated_at DESC);

CREATE UNIQUE INDEX projects_owner_request
  ON projects (owner_email, request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX project_revisions_project_created
  ON project_revisions (project_id, created_at DESC);

CREATE INDEX project_references_project_created
  ON project_references (project_id, created_at ASC);

CREATE INDEX revision_builds_status_updated
  ON revision_builds (status, updated_at);

CREATE INDEX managed_render_jobs_revision_created
  ON managed_render_jobs (revision_id, created_at DESC);

CREATE UNIQUE INDEX managed_render_jobs_publication
  ON managed_render_jobs (publication_id);

CREATE INDEX project_feedback_project_created
  ON project_feedback (project_id, created_at ASC);

CREATE INDEX project_media_assets_project_created
  ON project_media_assets (project_id, created_at DESC);

CREATE INDEX project_media_assets_validation_updated
  ON project_media_assets (validation_status, updated_at);

CREATE INDEX managed_publications_project_created
  ON managed_publications (project_id, created_at DESC);

CREATE INDEX managed_publications_revision_created
  ON managed_publications (revision_id, created_at DESC);

CREATE INDEX managed_publication_attempts_publication_created
  ON managed_publication_attempts (publication_id, created_at DESC);

CREATE INDEX managed_publication_attempts_status_updated
  ON managed_publication_attempts (status, updated_at);

CREATE TRIGGER project_revisions_immutable_identity
BEFORE UPDATE OF id, project_id, commit_sha, ref, is_default_branch, created_at,
  source_bundle_key, source_bundle_digest, source_bundle_size
ON project_revisions
BEGIN
  SELECT RAISE(ABORT, 'project revision identity is immutable');
END;

CREATE TRIGGER revision_approvals_immutable
BEFORE UPDATE ON revision_approvals
BEGIN
  SELECT RAISE(ABORT, 'revision approval is immutable');
END;

CREATE TRIGGER project_feedback_immutable
BEFORE UPDATE ON project_feedback
BEGIN
  SELECT RAISE(ABORT, 'project feedback is immutable');
END;

CREATE TRIGGER project_feedback_revision_matches_project
BEFORE INSERT ON project_feedback
WHEN NOT EXISTS (
  SELECT 1 FROM project_revisions
  WHERE id = NEW.revision_id AND project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'feedback revision must belong to project');
END;

CREATE TRIGGER managed_render_jobs_publication_immutable
BEFORE UPDATE OF publication_id ON managed_render_jobs
BEGIN
  SELECT RAISE(ABORT, 'managed render publication link is immutable');
END;

CREATE TRIGGER project_media_assets_owner_matches_project
BEFORE INSERT ON project_media_assets
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE id = NEW.project_id AND owner_email = NEW.owner_email
)
BEGIN
  SELECT RAISE(ABORT, 'media asset owner must match project owner');
END;

CREATE TRIGGER project_media_assets_immutable_identity
BEFORE UPDATE OF id, project_id, owner_email, kind, file_name, media_type,
  byte_size, object_key, sha256, created_at
ON project_media_assets
BEGIN
  SELECT RAISE(ABORT, 'media asset identity is immutable');
END;

CREATE TRIGGER managed_publications_owner_and_revision_match_project
BEFORE INSERT ON managed_publications
WHEN NOT EXISTS (
  SELECT 1 FROM projects AS p
  JOIN project_revisions AS r ON r.project_id = p.id
  WHERE p.id = NEW.project_id AND p.owner_email = NEW.owner_email
    AND r.id = NEW.revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'publication owner and revision must match project');
END;

CREATE TRIGGER managed_publications_audio_kind
BEFORE INSERT ON managed_publications
WHEN NEW.audio_asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_media_assets
  WHERE id = NEW.audio_asset_id AND project_id = NEW.project_id
    AND kind = 'audio' AND validation_status = 'valid'
    AND sha256 = NEW.audio_asset_digest
)
BEGIN
  SELECT RAISE(ABORT, 'publication audio asset must be valid project audio with matching digest');
END;

CREATE TRIGGER managed_publications_caption_kind
BEFORE INSERT ON managed_publications
WHEN NEW.caption_asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_media_assets
  WHERE id = NEW.caption_asset_id AND project_id = NEW.project_id
    AND kind = 'captions' AND validation_status = 'valid'
    AND sha256 = NEW.caption_asset_digest
)
BEGIN
  SELECT RAISE(ABORT, 'publication caption asset must be valid project captions with matching digest');
END;

CREATE TRIGGER managed_publications_immutable
BEFORE UPDATE ON managed_publications
BEGIN
  SELECT RAISE(ABORT, 'managed publication is immutable');
END;

CREATE TRIGGER managed_publication_attempts_immutable_identity
BEFORE UPDATE OF id, publication_id, attempt, workflow_id, created_at
ON managed_publication_attempts
BEGIN
  SELECT RAISE(ABORT, 'publication attempt identity is immutable');
END;

CREATE TABLE migration_0010_foreign_key_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO migration_0010_foreign_key_guard (valid)
SELECT 0
FROM pragma_foreign_key_check
LIMIT 1;

DROP TABLE migration_0010_foreign_key_guard;
