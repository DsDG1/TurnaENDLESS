-- Append-only native revision registrations. Original import mappings and source objects stay immutable.
ALTER TABLE revision_previews ADD CONSTRAINT revision_preview_workspace_identity UNIQUE (account_id, workspace_id, request_id);
CREATE TABLE revision_registrations (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 64),
  command_id uuid NOT NULL,
  preview_request_id uuid NOT NULL,
  content_id text NOT NULL,
  revision_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  PRIMARY KEY (account_id, workspace_id, version),
  UNIQUE (account_id, workspace_id, revision_id),
  UNIQUE (account_id, preview_request_id),
  UNIQUE (account_id, command_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id),
  FOREIGN KEY (account_id, workspace_id, content_id) REFERENCES content_metadata (account_id, workspace_id, content_id),
  FOREIGN KEY (account_id, workspace_id, command_id) REFERENCES metadata_commands (account_id, workspace_id, command_id),
  FOREIGN KEY (account_id, workspace_id, preview_request_id) REFERENCES revision_previews (account_id, workspace_id, request_id)
);
GRANT SELECT, INSERT ON revision_registrations TO endless_app;
ALTER TABLE revision_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE revision_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON revision_registrations
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
