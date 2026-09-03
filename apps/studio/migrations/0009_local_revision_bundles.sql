ALTER TABLE projects
  ADD COLUMN authoring_source_kind TEXT NOT NULL DEFAULT 'artifacts'
    CHECK (authoring_source_kind IN ('artifacts', 'local'));

ALTER TABLE project_revisions
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'artifacts'
    CHECK (source_kind IN ('artifacts', 'r2-bundle'));

ALTER TABLE project_revisions
  ADD COLUMN source_bundle_key TEXT;

ALTER TABLE project_revisions
  ADD COLUMN source_bundle_digest TEXT
    CHECK (
      source_bundle_digest IS NULL
      OR (
        length(source_bundle_digest) = 64
        AND source_bundle_digest NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE project_revisions
  ADD COLUMN source_bundle_size INTEGER
    CHECK (
      source_bundle_size IS NULL
      OR source_bundle_size BETWEEN 1 AND 26214400
    );

ALTER TABLE project_revisions
  ADD COLUMN source_provenance TEXT;

CREATE TRIGGER project_revisions_source_fields_insert
BEFORE INSERT ON project_revisions
WHEN
  (
    NEW.source_kind = 'r2-bundle'
    AND (
      NEW.source_bundle_key IS NULL
      OR NEW.source_bundle_digest IS NULL
      OR NEW.source_bundle_size IS NULL
    )
  )
  OR (
    NEW.source_kind = 'artifacts'
    AND (
      NEW.source_bundle_key IS NOT NULL
      OR NEW.source_bundle_digest IS NOT NULL
      OR NEW.source_bundle_size IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'revision source fields do not match source kind');
END;

CREATE TRIGGER project_revisions_source_fields_update
BEFORE UPDATE OF source_kind, source_bundle_key, source_bundle_digest,
  source_bundle_size
ON project_revisions
WHEN
  (
    NEW.source_kind = 'r2-bundle'
    AND (
      NEW.source_bundle_key IS NULL
      OR NEW.source_bundle_digest IS NULL
      OR NEW.source_bundle_size IS NULL
    )
  )
  OR (
    NEW.source_kind = 'artifacts'
    AND (
      NEW.source_bundle_key IS NOT NULL
      OR NEW.source_bundle_digest IS NOT NULL
      OR NEW.source_bundle_size IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'revision source fields do not match source kind');
END;

DROP TRIGGER project_revisions_immutable_identity;

CREATE TRIGGER project_revisions_immutable_identity
BEFORE UPDATE OF id, project_id, commit_sha, ref, is_default_branch, created_at,
  source_kind, source_bundle_key, source_bundle_digest, source_bundle_size
ON project_revisions
BEGIN
  SELECT RAISE(ABORT, 'project revision identity is immutable');
END;
