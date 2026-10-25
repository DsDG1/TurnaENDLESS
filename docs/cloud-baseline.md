# ENDLESS 云化基线记录（C0/C1 交付基线）

日期：2026-10-25
关联计划：桌面《ENDLESS-云端后端存储与付费实施计划-2026-10-25.md》
代码基点：工作区（含 desktop 未提交改动）+ 本轮新增 `apps/api/src/cloud/` 与 `packages/cloud-contracts/`

## 1. C0 基线事实

- `pnpm typecheck`：全部 workspace 通过。
- `pnpm -C apps/api test`：本机域 105 项通过（云化前基线）。
- `docs/bugfix-plan.md` 中 P0/P1 项经代码抽查均已落地（1.1 弹窗冒泡、1.2 review 死锁、2.1/2.2 Edition 语境与去重、2.3 pick effects、2.4 plannedAt、2.5 isResume/合并提交、2.6 closingTicketId、2.7 runId 派生、2.8 取消覆盖、3.1 preview 清空等）；未发现仍开放的阻断项。
- 本机与云边界不变：`apps/api/src/main.ts`（本机回环）未被云代码引用；`jobs.json`、`edition.sqlite` 与云库互不读写；页面 Key 在云侧被显式 403 拒绝。

## 2. 本轮已实现（C1 最小切片）

| 项 | 落点 | 状态 |
| --- | --- | --- |
| 共享网络信封 | `packages/cloud-contracts/`（错误信封、capabilities、auth、workspace、限制、幂等键） | 已实现 |
| 云组合根 | `apps/api/src/cloud/{main,server,config,capabilities,errors,http,mail}.ts` | 已实现 |
| PG 迁移 + 角色 | `cloud/db/migrations/0001_identity.sql`、`cloud/db/{migrate,roles,bootstrap}.ts` | 已实现 |
| 租户隔离 | 业务域表 FORCE RLS + `endless.tenant_id` 事务内 GUC；身份/业务双角色 `endless_auth`/`endless_app` | 已实现并真库验证 |
| 登录渠道 | 邮箱一次性验证码：HMAC 摘要存储、绑定用途+挑战+接收方、10 分钟、8 次尝试、一次消费、收件人 DB 计数 + IP 进程内限流 | 已实现 |
| 会话/设备 | 32B 不透明令牌仅存摘要、`__Host-` HttpOnly+Secure+SameSite=Lax、撤销/设备吊销联动 | 已实现 |
| 工作区 | owner 归属、(account+sourceLocalId) 幂等复用、Idempotency-Key 同事务裁决（重放/异摘要 409/在途 409） | 已实现 |
| 审计 | `audit_events` 只写不读（业务角色无 SELECT） | 已实现 |
| 能力发现 | `GET /api/cloud/v1/capabilities` 如实报告：sync/generation/billing 等恒为 false | 已实现 |

## 3. 本轮验证（真实 PostgreSQL，非内存模拟）

- 集成测试经 `embedded-postgres`（npm 内嵌 PG 18.4 二进制，MIT，仅 devDependency）启动真实集群：角色引导 → 迁移 → HTTP 全链路。
- 覆盖：挑战签发/错码/重放/换邮箱绑定、会话签发与撤销、设备吊销联动、/me、工作区幂等（重放同回执、异摘要 409、sourceLocalId 复用）、B 租户对 A 行 SELECT=0 行、无租户上下文 SELECT=0 行、跨租户 INSERT 被 RLS WITH CHECK 拒绝、CSRF Origin 缺失 403、非法 Host 403、`X-Endless-Provider-Key` 403。
- 命令：`pnpm -C apps/api exec vitest run test/cloud`（16 项：10 单元 + 6 真库集成）。

## 4. 明确未实现（不得声称）

C2–C9 全部：对象存储/导入清单、同步 Outbox/事件 ID/冲突、长历史流式契约（C4）、jobs/attempts/Worker/计量（C5）、额度账本/报价/交付（C6）、支付/订阅/退款/对账（C7）、客户端/管理后台/运维（C8）、灰度上线（C9）。capabilities 中对应项恒为 false。

## 5. 待决策（计划 §24，未默认放行）

首发市场/主体、自动续费资格、真实邮件通道、定价/份数、体验额度（默认 0）、云空间配额、身份表 PII 静态加密口径、IP 维度跨实例限流（当前进程内，生产需网关层）。

## 6. 运行方式（开发）

```text
# 1) 引导角色（管理员 DSN）
ENDLESS_CLOUD_ADMIN_DSN=postgres://postgres:...@127.0.0.1:5432/postgres \
ENDLESS_CLOUD_AUTH_PASSWORD=... ENDLESS_CLOUD_APP_PASSWORD=... pnpm -C apps/api bootstrap:cloud
# 2) 受控迁移（迁移角色/owner DSN）
ENDLESS_CLOUD_MIGRATION_DSN=postgres://owner:...@host/db pnpm -C apps/api migrate:cloud
# 3) 启动（业务双角色 DSN + pepper + 白名单）
ENDLESS_CLOUD_AUTH_DSN=... ENDLESS_CLOUD_APP_DSN=... \
ENDLESS_CLOUD_SESSION_PEPPER=<32B+> ENDLESS_CLOUD_ORIGINS=https://app.example \
ENDLESS_CLOUD_HOSTS=api.example ENDLESS_CLOUD_PORT=4178 pnpm -C apps/api dev:cloud
```

验证码经 `mail_outbox` 表投递（真实邮件通道未实现）；开发可用 `ENDLESS_CLOUD_MAIL_ECHO=1` 把验证码打到服务端 stdout（绝不进 HTTP 响应）。
