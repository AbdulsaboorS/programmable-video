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
  repository_name TEXT NOT NULL UNIQUE,
  repository_remote_url TEXT NOT NULL,
  repository_default_branch TEXT NOT NULL,
  repository_state TEXT NOT NULL CHECK (repository_state = 'seeded'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX projects_owner_updated
  ON projects (owner_email, updated_at DESC);

CREATE TABLE project_references (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  note TEXT NOT NULL,
  storage_state TEXT NOT NULL CHECK (storage_state = 'metadata-only'),
  created_at TEXT NOT NULL
);

CREATE INDEX project_references_project_created
  ON project_references (project_id, created_at ASC);

CREATE TABLE agent_handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'write'),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX agent_handoffs_project_created
  ON agent_handoffs (project_id, created_at DESC);
