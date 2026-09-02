-- In-flight legacy Workflows cannot be backfilled with their exact step history.
-- Drain all legacy jobs before applying this migration.
CREATE TABLE migration_0008_legacy_render_guard (
  no_active_legacy_renders INTEGER NOT NULL CHECK (no_active_legacy_renders = 1)
);

INSERT INTO migration_0008_legacy_render_guard (no_active_legacy_renders)
SELECT 0
WHERE EXISTS (
  SELECT 1 FROM managed_render_jobs WHERE status IN ('queued', 'rendering')
);

DROP TABLE migration_0008_legacy_render_guard;

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

CREATE INDEX project_media_assets_project_created
  ON project_media_assets (project_id, created_at DESC);
CREATE INDEX project_media_assets_validation_updated
  ON project_media_assets (validation_status, updated_at);

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
BEFORE UPDATE OF
  id, project_id, owner_email, kind, file_name, media_type, byte_size,
  object_key, sha256, created_at
ON project_media_assets
BEGIN
  SELECT RAISE(ABORT, 'media asset identity is immutable');
END;

CREATE TABLE managed_publications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES project_revisions(id) ON DELETE RESTRICT,
  owner_email TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  build_attempt INTEGER NOT NULL CHECK (build_attempt BETWEEN 1 AND 1000),
  manifest_digest TEXT NOT NULL
    CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  input_digest TEXT NOT NULL
    CHECK (length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  finishing_spec_version INTEGER NOT NULL CHECK (finishing_spec_version = 1),
  finishing_spec_json TEXT NOT NULL
    CHECK (json_valid(finishing_spec_json) AND json_type(finishing_spec_json) = 'object'),
  finishing_spec_digest TEXT NOT NULL
    CHECK (length(finishing_spec_digest) = 64 AND finishing_spec_digest NOT GLOB '*[^0-9a-f]*'),
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
  FOREIGN KEY (project_id, audio_asset_id)
    REFERENCES project_media_assets(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, caption_asset_id)
    REFERENCES project_media_assets(project_id, id) ON DELETE RESTRICT,
  CHECK (trim_start_frame < trim_end_frame),
  CHECK (
    (output_profile = 'landscape' AND output_width = 1280 AND output_height = 720)
    OR (output_profile = 'square' AND output_width = 1080 AND output_height = 1080)
    OR (output_profile = 'portrait' AND output_width = 1080 AND output_height = 1920)
  ),
  CHECK (
    (audio_asset_id IS NULL AND audio_asset_digest IS NULL AND audio_gain_percent IS NULL)
    OR (audio_asset_id IS NOT NULL AND audio_asset_digest IS NOT NULL
      AND length(audio_asset_digest) = 64
      AND audio_asset_digest NOT GLOB '*[^0-9a-f]*'
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

CREATE INDEX managed_publications_project_created
  ON managed_publications (project_id, created_at DESC);
CREATE INDEX managed_publications_revision_created
  ON managed_publications (revision_id, created_at DESC);

CREATE TRIGGER managed_publications_owner_and_revision_match_project
BEFORE INSERT ON managed_publications
WHEN NOT EXISTS (
  SELECT 1
  FROM projects AS p
  JOIN project_revisions AS r ON r.project_id = p.id
  WHERE p.id = NEW.project_id
    AND p.owner_email = NEW.owner_email
    AND r.id = NEW.revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'publication owner and revision must match project');
END;

CREATE TRIGGER managed_publications_audio_kind
BEFORE INSERT ON managed_publications
WHEN NEW.audio_asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_media_assets
  WHERE id = NEW.audio_asset_id
    AND project_id = NEW.project_id
    AND kind = 'audio'
    AND validation_status = 'valid'
    AND sha256 = NEW.audio_asset_digest
)
BEGIN
  SELECT RAISE(ABORT, 'publication audio asset must be valid project audio with matching digest');
END;

CREATE TRIGGER managed_publications_caption_kind
BEFORE INSERT ON managed_publications
WHEN NEW.caption_asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_media_assets
  WHERE id = NEW.caption_asset_id
    AND project_id = NEW.project_id
    AND kind = 'captions'
    AND validation_status = 'valid'
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

CREATE TABLE managed_publication_attempts (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES managed_publications(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 1000),
  workflow_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 1000),
  stream_video_id TEXT,
  stream_upload_url TEXT,
  playback_status TEXT NOT NULL
    CHECK (playback_status IN ('pending', 'processing', 'ready', 'failed')),
  player_url TEXT,
  hls_url TEXT,
  caption_status TEXT NOT NULL
    CHECK (caption_status IN ('not_requested', 'pending', 'processing', 'ready', 'failed')),
  caption_error TEXT CHECK (caption_error IS NULL OR length(caption_error) <= 1000),
  thumbnail_status TEXT NOT NULL
    CHECK (thumbnail_status IN ('pending', 'processing', 'ready', 'failed', 'not_requested')),
  thumbnail_url TEXT,
  manifest_status TEXT NOT NULL
    CHECK (manifest_status IN ('pending', 'processing', 'ready', 'failed')),
  download_status TEXT NOT NULL
    CHECK (download_status IN ('not_requested', 'pending', 'processing', 'ready', 'failed')),
  download_percent REAL CHECK (download_percent IS NULL OR download_percent BETWEEN 0 AND 100),
  download_url TEXT,
  download_error TEXT CHECK (download_error IS NULL OR length(download_error) <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (publication_id, attempt)
);

CREATE INDEX managed_publication_attempts_publication_created
  ON managed_publication_attempts (publication_id, created_at DESC);
CREATE INDEX managed_publication_attempts_status_updated
  ON managed_publication_attempts (status, updated_at);

CREATE TRIGGER managed_publication_attempts_immutable_identity
BEFORE UPDATE OF id, publication_id, attempt, workflow_id, created_at
ON managed_publication_attempts
BEGIN
  SELECT RAISE(ABORT, 'publication attempt identity is immutable');
END;

-- Existing render IDs are stable publication IDs. The canonical JSON and digest
-- below match createNoOpFinishingSpec for the two managed source durations.
INSERT INTO managed_publications (
  id, project_id, revision_id, owner_email, idempotency_key,
  build_attempt, manifest_digest, input_digest,
  finishing_spec_version, finishing_spec_json, finishing_spec_digest,
  output_profile, output_width, output_height, output_fit,
  trim_start_frame, trim_end_frame, audio_gain_percent,
  audio_asset_id, audio_asset_digest, caption_mode,
  caption_asset_id, caption_asset_digest, created_at
)
SELECT
  job.id, job.project_id, job.revision_id, job.owner_email, 'legacy:' || job.id,
  job.build_attempt, lower(job.manifest_digest), lower(job.input_digest),
  1,
  CASE WHEN COALESCE(build.duration_in_frames, 360) = 450
    THEN '{"version":1,"trim":{"startFrame":0,"endFrame":450},"output":{"profile":"landscape","width":1280,"height":720,"fit":"contain","containBackground":"#0b0d10"},"audio":null,"captions":{"mode":"none"}}'
    ELSE '{"version":1,"trim":{"startFrame":0,"endFrame":360},"output":{"profile":"landscape","width":1280,"height":720,"fit":"contain","containBackground":"#0b0d10"},"audio":null,"captions":{"mode":"none"}}'
  END,
  CASE WHEN COALESCE(build.duration_in_frames, 360) = 450
    THEN '305f3daf41b5159d8676f19c7dd6a57634a4508154a8b52f869200d43e7d9151'
    ELSE 'c7ef7e422b39bf651459f1ee42ff897966dbb39b284459f455ddc0783521c601'
  END,
  'landscape', 1280, 720, 'contain', 0,
  CASE WHEN COALESCE(build.duration_in_frames, 360) = 450 THEN 450 ELSE 360 END,
  NULL, NULL, NULL, 'none', NULL, NULL, job.created_at
FROM managed_render_jobs AS job
LEFT JOIN revision_builds AS build ON build.revision_id = job.revision_id;

INSERT INTO managed_publication_attempts (
  id, publication_id, attempt, workflow_id, status, error_message,
  stream_video_id, stream_upload_url, playback_status, player_url, hls_url,
  caption_status, caption_error, thumbnail_status, thumbnail_url,
  manifest_status, download_status, download_percent, download_url,
  download_error, created_at, updated_at
)
SELECT
  id, id, 1, workflow_id, status, error_message, stream_video_id, NULL,
  CASE status
    WHEN 'ready' THEN 'ready'
    WHEN 'failed' THEN 'failed'
    WHEN 'rendering' THEN 'processing'
    ELSE 'pending'
  END,
  preview_url, hls_url, 'not_requested', NULL,
  CASE
    WHEN thumbnail_url IS NOT NULL THEN 'ready'
    WHEN status = 'failed' THEN 'failed'
    WHEN status = 'ready' THEN 'not_requested'
    WHEN status = 'rendering' THEN 'processing'
    ELSE 'pending'
  END,
  thumbnail_url,
  CASE status
    WHEN 'ready' THEN 'ready'
    WHEN 'failed' THEN 'failed'
    WHEN 'rendering' THEN 'processing'
    ELSE 'pending'
  END,
  'not_requested', NULL, NULL, NULL, created_at, updated_at
FROM managed_render_jobs;

ALTER TABLE managed_render_jobs
  ADD COLUMN publication_id TEXT REFERENCES managed_publications(id);

UPDATE managed_render_jobs SET publication_id = id;

CREATE UNIQUE INDEX managed_render_jobs_publication
  ON managed_render_jobs (publication_id);

CREATE TRIGGER managed_render_jobs_publication_immutable
BEFORE UPDATE OF publication_id ON managed_render_jobs
BEGIN
  SELECT RAISE(ABORT, 'managed render publication link is immutable');
END;

-- Reject legacy writes during the migration-first deployment window. New
-- publications no longer create managed_render_jobs rows.
CREATE TRIGGER managed_render_jobs_require_publication
BEFORE INSERT ON managed_render_jobs
WHEN NEW.publication_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'managed renders must be created as publications');
END;
