ALTER TABLE projects ADD COLUMN video_brief TEXT;
ALTER TABLE projects ADD COLUMN video_brief_updated_at TEXT;
ALTER TABLE revision_builds ADD COLUMN fps INTEGER CHECK (fps IS NULL OR fps = 30);
ALTER TABLE revision_builds ADD COLUMN duration_in_frames INTEGER
  CHECK (duration_in_frames IS NULL OR duration_in_frames IN (360, 450));

-- Builder v1 accepted only the original 360-frame starter contract.
UPDATE revision_builds
SET fps = 30, duration_in_frames = 360
WHERE status = 'ready';

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

CREATE INDEX project_feedback_project_created
  ON project_feedback (project_id, created_at ASC);

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
