ALTER TABLE project_references RENAME TO project_references_legacy;

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

INSERT INTO project_references (
  id, project_id, file_name, media_type, byte_size, note, storage_state, created_at
)
SELECT id, project_id, file_name, media_type, byte_size, note, storage_state, created_at
FROM project_references_legacy;

DROP TABLE project_references_legacy;

CREATE INDEX project_references_project_created
  ON project_references (project_id, created_at ASC);
