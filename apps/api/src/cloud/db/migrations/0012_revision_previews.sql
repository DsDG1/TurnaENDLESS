-- Preview only: no mutable content head or branch adoption is activated here.
CREATE TABLE revision_previews (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  request_id uuid NOT NULL,
  device_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  revision_id text NOT NULL CHECK (revision_id ~ '^rev_[0-9a-f-]{36}$'),
  branch_id text NOT NULL CHECK (branch_id ~ '^brn_[0-9a-f-]{36}$'),
  authored_at timestamptz NOT NULL,
  receipt jsonb,
  PRIMARY KEY (account_id, request_id),
  UNIQUE (account_id, workspace_id, revision_id),
  UNIQUE (account_id, workspace_id, branch_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id),
  FOREIGN KEY (device_id, account_id) REFERENCES devices (id, account_id)
);
-- Identity, original request and final adjudication cannot be rebound, even by a future buggy caller.
CREATE FUNCTION preserve_revision_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'receipt') IS DISTINCT FROM (to_jsonb(OLD) - 'receipt')
     OR OLD.receipt IS NOT NULL THEN
    RAISE EXCEPTION 'immutable revision preview';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_preview_immutable BEFORE UPDATE ON revision_previews
  FOR EACH ROW EXECUTE FUNCTION preserve_revision_preview();
GRANT SELECT, INSERT, UPDATE ON revision_previews TO endless_app;
ALTER TABLE revision_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE revision_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON revision_previews
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
