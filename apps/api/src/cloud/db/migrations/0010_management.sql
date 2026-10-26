-- One commit-ordered feed for display and lifecycle management. Learning event identities remain unchanged.
ALTER TABLE metadata_commands ADD CONSTRAINT metadata_command_workspace_identity UNIQUE (account_id, workspace_id, command_id);
CREATE TABLE content_lifecycle (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  content_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('bundled', 'generated')),
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740990),
  value jsonb NOT NULL,
  restore_archive_id text,
  restore_ambiguous boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, workspace_id, content_id),
  FOREIGN KEY (account_id, workspace_id, content_id) REFERENCES content_metadata (account_id, workspace_id, content_id)
);
CREATE TABLE management_heads (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  change_seq bigint NOT NULL DEFAULT 0 CHECK (change_seq BETWEEN 0 AND 9007199254740990),
  PRIMARY KEY (account_id, workspace_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id)
);
CREATE TABLE management_changes (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  change_seq bigint NOT NULL CHECK (change_seq BETWEEN 1 AND 9007199254740990),
  command_id uuid NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (account_id, workspace_id, change_seq),
  UNIQUE (account_id, command_id),
  FOREIGN KEY (account_id, workspace_id, command_id) REFERENCES metadata_commands (account_id, workspace_id, command_id),
  FOREIGN KEY (account_id, workspace_id) REFERENCES management_heads (account_id, workspace_id)
);
GRANT SELECT, INSERT, UPDATE ON content_lifecycle, management_heads TO endless_app;
GRANT SELECT, INSERT ON management_changes TO endless_app;
ALTER TABLE content_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_lifecycle FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_lifecycle
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE management_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE management_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON management_heads
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE management_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE management_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON management_changes
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
