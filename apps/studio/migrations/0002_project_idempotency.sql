ALTER TABLE projects ADD COLUMN request_id TEXT;

CREATE UNIQUE INDEX projects_owner_request
  ON projects (owner_email, request_id)
  WHERE request_id IS NOT NULL;
