-- 0001_identity：C1 身份域 + 业务域最小切片（计划 §4.1 / §5.2 / §5.4）。
-- 由迁移角色执行；每个迁移文件自含授权与 RLS，新表不遗漏。

-- 租户上下文读取：未设置或为空都返回 NULL，RLS 失配即拒绝（fail-closed）。
CREATE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('endless.tenant_id', true), '')::uuid
$$;

-- ---------- 身份域（endless_auth；无 RLS，只授予身份服务角色） ----------

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deletion_pending', 'deleted')),
  home_region text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- 登录方式唯一键 (issuer, subject)：同一邮箱身份不能绑定两个账号。
CREATE TABLE auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  issuer text NOT NULL,
  subject text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

-- 一次性验证码：服务端只存 HMAC 摘要；绑定用途+接收方+挑战 ID，短有效期、一次消费。
CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose IN ('sign_in')),
  recipient_digest bytea NOT NULL,
  code_digest bytea NOT NULL,
  delivery_ref uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  request_ip_digest bytea
);
CREATE INDEX auth_challenges_recipient_rate ON auth_challenges (recipient_digest, created_at);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  device_id uuid,
  token_digest bytea NOT NULL UNIQUE,
  auth_strength text NOT NULL DEFAULT 'email_otp',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_from uuid
);
CREATE INDEX sessions_account ON sessions (account_id);
CREATE INDEX sessions_device ON sessions (device_id);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX devices_account ON devices (account_id);

ALTER TABLE sessions
  ADD CONSTRAINT sessions_device_fk FOREIGN KEY (device_id) REFERENCES devices (id);

-- 邮件外发队列：验证码只经此进入投递通道，不进入 HTTP 响应/日志。
CREATE TABLE mail_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- ---------- 业务域（endless_app；FORCE RLS + 租户 GUC 第二道隔离） ----------

-- 账号级串行入口：多资源商业变更先锁此行（§5.5 锁顺序第一步）。
CREATE TABLE account_control (
  account_id uuid PRIMARY KEY REFERENCES accounts (id),
  active_generation_job uuid,
  external_call_hold boolean NOT NULL DEFAULT false,
  risk_flags jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 业务请求幂等：同 (account, operation, key) 唯一；异摘要 409，不复用不相关结果。
CREATE TABLE idempotency_keys (
  account_id uuid NOT NULL REFERENCES accounts (id),
  operation text NOT NULL,
  key text NOT NULL,
  request_digest bytea NOT NULL,
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (account_id, operation, key)
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  source_local_id text,
  contract text NOT NULL,
  display_name text,
  cloud_version bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 导入锚幂等：同账号+原本地 ID 只建一个云实例（NULL 不参与）。
CREATE UNIQUE INDEX workspaces_source_unique
  ON workspaces (account_id, source_local_id) WHERE source_local_id IS NOT NULL;

-- 首版只有 owner；表先建好，协作权限不开放。
CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  account_id uuid NOT NULL REFERENCES accounts (id),
  role text NOT NULL CHECK (role IN ('owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id)
);

-- 本地实例与账号/工作区的显式绑定：不写进原 LocalProfile。
CREATE TABLE device_bindings (
  device_id uuid NOT NULL REFERENCES devices (id),
  account_id uuid NOT NULL REFERENCES accounts (id),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  bound_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, workspace_id)
);

-- 审计：只写不读（业务角色无 SELECT）；不记秘密正文。
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_account_id uuid REFERENCES accounts (id),
  action text NOT NULL,
  object_type text,
  object_id text,
  reason text,
  ticket_id text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- 授权与 RLS ----------

GRANT SELECT, INSERT ON accounts TO endless_auth;
GRANT SELECT, INSERT ON auth_identities TO endless_auth;
GRANT SELECT, INSERT, UPDATE (attempts, consumed_at) ON auth_challenges TO endless_auth;
GRANT SELECT, INSERT, UPDATE ON sessions TO endless_auth;
GRANT SELECT, INSERT, UPDATE ON devices TO endless_auth;
GRANT SELECT, INSERT, UPDATE ON mail_outbox TO endless_auth;
GRANT INSERT ON audit_events TO endless_auth;

GRANT SELECT, INSERT, UPDATE ON workspaces TO endless_app;
GRANT SELECT, INSERT ON workspace_memberships TO endless_app;
GRANT SELECT, INSERT ON device_bindings TO endless_app;
GRANT SELECT, INSERT, UPDATE ON account_control TO endless_app;
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO endless_app;
GRANT INSERT ON audit_events TO endless_app;

-- 迁移水位对外只读：服务启动只校验版本，不自动改库。
GRANT SELECT ON schema_migrations TO endless_auth, endless_app;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspaces
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());

ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_memberships
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());

ALTER TABLE device_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_bindings
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());

ALTER TABLE account_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_control FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_control
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (account_id = current_tenant_id()) WITH CHECK (account_id = current_tenant_id());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (actor_account_id = current_tenant_id() OR actor_account_id IS NULL)
  WITH CHECK (actor_account_id = current_tenant_id() OR actor_account_id IS NULL);
