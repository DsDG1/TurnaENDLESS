-- Display metadata is mutable under a version check. Commands and adjudications are immutable.
-- No content revision, event body, import source or learning state is rewritten.
CREATE TABLE content_metadata (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  content_id text NOT NULL CHECK (content_id ~ '^ent_[0-9a-f-]{36}$'),
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, workspace_id, content_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id)
);
CREATE TABLE metadata_commands (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  command_id uuid NOT NULL,
  device_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, command_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id),
  FOREIGN KEY (device_id, account_id) REFERENCES devices (id, account_id)
);
GRANT SELECT, INSERT, UPDATE ON content_metadata TO endless_app;
GRANT SELECT, INSERT ON metadata_commands TO endless_app;
ALTER TABLE content_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_metadata FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_metadata
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE metadata_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metadata_commands
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
