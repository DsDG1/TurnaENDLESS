CREATE TABLE content_objects (
  account_id uuid NOT NULL REFERENCES accounts (id),
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  domain_id text NOT NULL CHECK (length(domain_id) BETWEEN 1 AND 128),
  kind text NOT NULL DEFAULT 'manifest' CHECK (kind = 'manifest'),
  contract text NOT NULL CHECK (contract = 'endless-object-manifest/1'),
  digest_algorithm text NOT NULL DEFAULT 'sha256-bytes/1' CHECK (digest_algorithm = 'sha256-bytes/1'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 2097152),
  deployment_id uuid NOT NULL REFERENCES cloud_deployment (id),
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'staging' CHECK (status IN ('staging', 'verified', 'committed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  upload_expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  retain_until timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  verified_at timestamptz,
  committed_at timestamptz,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, workspace_id, id),
  UNIQUE (account_id, workspace_id, contract, domain_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces (id, account_id),
  CHECK (storage_key = 'cloud/' || deployment_id::text || '/tenants/' || account_id::text || '/objects/' || id::text),
  CHECK (
    (status = 'staging' AND verified_at IS NULL AND committed_at IS NULL) OR
    (status = 'verified' AND verified_at IS NOT NULL AND committed_at IS NULL) OR
    (status = 'committed' AND verified_at IS NOT NULL AND committed_at IS NOT NULL)
  )
);
CREATE INDEX content_objects_retention ON content_objects (account_id, retain_until) WHERE status <> 'committed';

CREATE TABLE object_references (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  from_object_id uuid NOT NULL,
  to_object_id uuid NOT NULL,
  PRIMARY KEY (account_id, from_object_id, to_object_id),
  FOREIGN KEY (account_id, workspace_id, from_object_id) REFERENCES content_objects (account_id, workspace_id, id),
  FOREIGN KEY (account_id, workspace_id, to_object_id) REFERENCES content_objects (account_id, workspace_id, id),
  CHECK (from_object_id <> to_object_id)
);
CREATE INDEX object_references_target ON object_references (account_id, to_object_id);

CREATE TABLE workspace_object_roots (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  object_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id, object_id),
  FOREIGN KEY (account_id, workspace_id, object_id) REFERENCES content_objects (account_id, workspace_id, id)
);

CREATE FUNCTION guard_content_object() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.account_id, NEW.id, NEW.workspace_id, NEW.domain_id, NEW.kind, NEW.contract,
         NEW.digest_algorithm, NEW.digest, NEW.size, NEW.deployment_id, NEW.storage_key)
    IS DISTINCT FROM
     ROW(OLD.account_id, OLD.id, OLD.workspace_id, OLD.domain_id, OLD.kind, OLD.contract,
         OLD.digest_algorithm, OLD.digest, OLD.size, OLD.deployment_id, OLD.storage_key)
    OR (OLD.status <> NEW.status AND NOT (
      (OLD.status = 'staging' AND NEW.status = 'verified') OR
      (OLD.status = 'verified' AND NEW.status = 'committed')))
    OR (OLD.verified_at IS NOT NULL AND OLD.verified_at IS DISTINCT FROM NEW.verified_at)
    OR (OLD.committed_at IS NOT NULL AND OLD.committed_at IS DISTINCT FROM NEW.committed_at)
  THEN
    RAISE EXCEPTION 'immutable object or invalid transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_object_immutable BEFORE UPDATE ON content_objects
  FOR EACH ROW EXECUTE FUNCTION guard_content_object();

CREATE FUNCTION guard_object_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM content_objects
    WHERE account_id = NEW.account_id AND workspace_id = NEW.workspace_id
      AND id = NEW.from_object_id AND status = 'staging'
  ) OR NOT EXISTS (
    SELECT 1 FROM content_objects
    WHERE account_id = NEW.account_id AND workspace_id = NEW.workspace_id
      AND id = NEW.to_object_id AND status IN ('verified', 'committed')
  ) THEN
    RAISE EXCEPTION 'invalid immutable object reference' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER object_reference_verified BEFORE INSERT ON object_references
  FOR EACH ROW EXECUTE FUNCTION guard_object_reference();

CREATE FUNCTION guard_object_root() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM content_objects
    WHERE account_id = NEW.account_id AND workspace_id = NEW.workspace_id
      AND id = NEW.object_id AND status = 'committed'
  ) THEN
    RAISE EXCEPTION 'object root is not committed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER object_root_committed BEFORE INSERT ON workspace_object_roots
  FOR EACH ROW EXECUTE FUNCTION guard_object_root();

GRANT SELECT, INSERT ON content_objects, object_references, workspace_object_roots TO endless_app;
GRANT UPDATE (status, verified_at, committed_at) ON content_objects TO endless_app;

ALTER TABLE content_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_objects
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE object_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_references FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON object_references
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
ALTER TABLE workspace_object_roots ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_object_roots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_object_roots
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());
