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
  UNIQUE (project_id, commit_sha)
);

CREATE INDEX project_revisions_project_created
  ON project_revisions (project_id, created_at DESC);

CREATE TRIGGER project_revisions_immutable_identity
BEFORE UPDATE OF id, project_id, commit_sha, ref, is_default_branch, created_at
ON project_revisions
BEGIN
  SELECT RAISE(ABORT, 'project revision identity is immutable');
END;
