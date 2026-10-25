ALTER TABLE workspaces DROP CONSTRAINT workspaces_status_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_status_check CHECK (status IN ('staging', 'active', 'archived'));
ALTER TABLE content_objects DROP CONSTRAINT content_objects_kind_check;
ALTER TABLE content_objects ADD CONSTRAINT content_objects_kind_check CHECK (kind IN ('manifest', 'workspace-backup'));
ALTER TABLE content_objects DROP CONSTRAINT content_objects_contract_check;
ALTER TABLE content_objects ADD CONSTRAINT content_objects_contract_check CHECK (contract IN ('endless-object-manifest/1', 'endless-backup/1'));
ALTER TABLE content_objects ADD CONSTRAINT content_objects_kind_contract_check CHECK (
  (kind = 'manifest' AND contract = 'endless-object-manifest/1') OR
  (kind = 'workspace-backup' AND contract = 'endless-backup/1')
);

CREATE TABLE import_previews (
  account_id uuid NOT NULL,
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  object_id uuid NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  validation_binding text NOT NULL CHECK (validation_binding ~ '^[a-f0-9]{64}$'),
  details jsonb NOT NULL,
  state text NOT NULL DEFAULT 'preparing' CHECK (state IN ('preparing', 'ready', 'activated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, workspace_id, snapshot_digest, validation_binding),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id),
  FOREIGN KEY (account_id, workspace_id, object_id) REFERENCES content_objects (account_id, workspace_id, id)
);

CREATE TABLE workspace_imports (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  source_object_id uuid NOT NULL,
  copy_digest text NOT NULL CHECK (copy_digest ~ '^[a-f0-9]{64}$'),
  copy_created_at timestamptz NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (account_id, workspace_id),
  UNIQUE (account_id, id),
  UNIQUE (account_id, workspace_id, id),
  FOREIGN KEY (account_id, id) REFERENCES import_previews (account_id, id),
  FOREIGN KEY (account_id, workspace_id, source_object_id) REFERENCES content_objects (account_id, workspace_id, id)
);

CREATE TABLE cloud_id_mappings (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  import_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('workspace', 'profile', 'content', 'revision', 'branch', 'volume', 'checkpoint', 'ticket', 'management')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 128),
  canonical_id text NOT NULL CHECK (canonical_id = source_id),
  PRIMARY KEY (account_id, workspace_id, kind, source_id),
  UNIQUE (account_id, workspace_id, kind, canonical_id),
  FOREIGN KEY (account_id, workspace_id, import_id) REFERENCES workspace_imports (account_id, workspace_id, id)
);

CREATE TABLE workspace_installations (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  import_id uuid NOT NULL,
  device_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  copy_digest text NOT NULL CHECK (copy_digest ~ '^[a-f0-9]{64}$'),
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id, import_id, device_id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, workspace_id, import_id) REFERENCES workspace_imports (account_id, workspace_id, id),
  FOREIGN KEY (device_id, account_id) REFERENCES devices (id, account_id)
);

CREATE TABLE cloud_content_identities (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  delivery_key uuid NOT NULL,
  content_id text NOT NULL CHECK (content_id ~ '^ent_[0-9a-f-]{36}$'),
  revision_id text NOT NULL CHECK (revision_id ~ '^rev_[0-9a-f-]{36}$'),
  PRIMARY KEY (account_id, workspace_id, delivery_key),
  UNIQUE (account_id, workspace_id, content_id),
  UNIQUE (account_id, workspace_id, revision_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id)
);

GRANT SELECT, INSERT ON import_previews, workspace_imports, cloud_id_mappings, workspace_installations, cloud_content_identities TO endless_app;
GRANT UPDATE (state) ON import_previews TO endless_app;

ALTER TABLE import_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_previews
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE workspace_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_imports
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE cloud_id_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_id_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cloud_id_mappings
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE workspace_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_installations
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE cloud_content_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_content_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cloud_content_identities
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
