# ENDLESS 云化基线记录（C0/C1 交付基线）

日期：2026-10-25（初始切片）；2026-10-26（C1 补齐）
关联计划：桌面《ENDLESS-云端后端存储与付费实施计划-2026-10-25.md》
代码基点：工作区（含 desktop 未提交改动）+ 本轮新增 `apps/api/src/cloud/` 与 `packages/cloud-contracts/`

## 1. C0 基线事实

- `pnpm typecheck`：全部 workspace 通过。
- `pnpm -C apps/api test`：本机域 105 项通过（云化前基线）。
- `docs/bugfix-plan.md` 中 P0/P1 项经代码抽查均已落地（1.1 弹窗冒泡、1.2 review 死锁、2.1/2.2 Edition 语境与去重、2.3 pick effects、2.4 plannedAt、2.5 isResume/合并提交、2.6 closingTicketId、2.7 runId 派生、2.8 取消覆盖、3.1 preview 清空等）；未发现仍开放的阻断项。
- 本机与云边界不变：`apps/api/src/main.ts`（本机回环）未被云代码引用；`jobs.json`、`edition.sqlite` 与云库互不读写；页面 Key 在云侧被显式 403 拒绝。

## 2. 已实现（C1 工程及本地隔离验收）

| 项 | 落点 | 状态 |
| --- | --- | --- |
| 共享网络信封 | `packages/cloud-contracts/`（错误信封、capabilities、auth、workspace、限制、幂等键） | 已实现 |
| 云组合根 | `apps/api/src/cloud/{main,server,config,runtime}.ts`，独立启动，不加载本机 `.env` | 已实现 |
| 独立 Worker | `cloud/{worker,mail-worker,smtp}.ts`；仅负责邮件，不包含 C5 模型任务 | 已实现并以独立进程验证 |
| PG 迁移 + 角色 | `0001_identity.sql` + 追加的 `0002_c1.sql`，不改写旧迁移；重复/并发/漂移检查 | 已实现 |
| 租户隔离 | 业务域表 FORCE RLS + `endless.tenant_id` 事务内 GUC；身份/业务双角色 `endless_auth`/`endless_app` | 已实现并真库验证 |
| 关联归属 | workspace membership、device binding、session device 的复合 owner 外键 | 已实现并覆盖跨租户伪造关联 |
| 登录渠道 | 邮箱 OTP：HMAC、10 分钟、8 次尝试、一次消费；错误次数独立于 401 异常回滚；收件人并发串行限流 + DB 原子 IP 限流 | 已实现 |
| 邮件投递 | 事务内 AES-256-GCM 密文出站队列，密文绑定行 ID；SMTP TLS/强制 STARTTLS；未知投递不自动重发，过期不发送，终态清除正文 | 已实现，本地模拟 SMTP 验证；未发真实邮件 |
| 会话/设备 | 32B 令牌仅存摘要、Secure/HttpOnly Cookie；登录旋转旧会话、设备撤销联动、非 active 账号拒绝访问 | 已实现并通过 HTTPS 浏览器验证 |
| 工作区 | owner、sourceLocalId 幂等复用、Idempotency-Key 同事务裁决、第二设备复用时显式绑定 | 已实现；不等于已上传存档 |
| 账号切换元数据 | `/me.context` 返回 deployment、environment、账号隔离 namespace；不改游客 LocalProfile/IndexedDB | 已实现；实际客户端接入属于 C8 |
| 审计 | `audit_events` 只写不读（业务角色无 SELECT） | 已实现 |
| 健康检查 | `/api/cloud/v1/health/live`、`/api/cloud/v1/health/ready`；DB 故障返回安全 503 | 已实现 |
| 环境隔离 | 迁移绑定独立数据库环境，API/Worker 启动核对环境与最小权限角色，API 双角色须指向同一 deployment | 已实现并拒绝测试库冒充生产库 |
| 能力发现 | `GET /api/cloud/v1/capabilities` 如实报告：sync/generation/billing 等恒为 false | 已实现 |

## 3. 本轮验证（真实 PostgreSQL，非内存模拟）

- 初始切片为 16 项；补齐后为 45 项：10 原语、4 配置/密文、1 模块边界、18 真库身份/权限/迁移、10 邮件队列/SMTP/Worker、2 HTTPS 浏览器/环境隔离。
- 集成测试经 `embedded-postgres` 启动真实集群：角色引导 → 迁移 → HTTP。数据库启动失败必须使测试失败，不再把提前 return 当通过。
- 新增回归先复现三个失败：错码后 `attempts` 仍为 0、B 可把 membership 关联到 A 的 workspace、`deletion_pending` 账号的旧会话返回 200。修复后均拒绝对应路径。
- 覆盖连接池 max=1 的成功/回滚租户切换、跨租户读写及复合关联、并发验证码单次消费、收件人并发限流、工作区幂等、第二设备绑定、会话旋转、账号状态和审计最小权限。
- 邮件测试使用本地 SMTP 协议服务器及临时证书：验证 TLS、STARTTLS、拒绝不受信证书、双 Worker 竞争、SMTP 接受后写库失败、旧 claim 迟到、重启 unknown、不自动重发及密文清除；另启动独立 Worker 进程验证环境注入。
- HTTPS 测试只监听回环：临时 TLS 入口 → 独立云 API → 真 PG + 本地 SMTP；Chromium 验证 Secure/HttpOnly Cookie、刷新、CSRF、换账号隔离、旧会话失效、设备撤销。不修改系统信任、不关闭全局 TLS 校验、不部署公网。
- 命令：`pnpm -C apps/api test:cloud`；HTTPS 子集：`pnpm -C apps/api test:cloud:https`。需要已安装 Playwright Chromium，或设置 `PLAYWRIGHT_CHANNEL=msedge`。
- 已通过 `pnpm test`（全仓 573 项，API 150 项含上述 45 项）、`pnpm typecheck`、`pnpm build`、构建后的 `pnpm test:e2e`（桌面/移动 38 项）。构建仍有原有的大 chunk 警告，不作为已解决项。

## 4. 明确未实现（不得声称）

C2–C9 全部：对象存储/导入清单、同步 Outbox/事件 ID/冲突、长历史流式契约（C4）、jobs/attempts/Worker/计量（C5）、额度账本/报价/交付（C6）、支付/订阅/退款/对账（C7）、客户端/管理后台/运维（C8）、灰度上线（C9）。capabilities 中对应项恒为 false。

## 5. 待决策（计划 §24，未默认放行）

首发市场/主体、自动续费资格、定价/份数、体验额度（默认 0）、云空间配额、身份表 PII 静态加密口径，以及真实邮件服务商/发信域名/可达性。IP 计数已跨进程入库，但不采信请求自行传入的转发头；生产网关真实客户端 IP、入口风控和历史限流记录维护仍需部署设计。

C1 本轮通过的是代码与本地隔离验收，不是生产上线验收。真实 SMTP 凭据、公开域名/受信证书、生产数据库与秘密管理、实际邮件送达均未配置或验证，也没有真实邮件/模型/支付调用。完整登录页面、账号隔离阅读库和游客导入不在 C1 内，分别属于 C8/C2。

## 6. 运行方式（开发）

- 云脚本只接受显式注入的 `ENDLESS_CLOUD_*`，不自动读取本机 API `.env`。
- `bootstrap:cloud`：管理员 DSN + AUTH/APP_PASSWORD；`migrate:cloud`：MIGRATION_DSN + 必填 `ENV=development|test|staging|production`。已有环境绑定不允许被改写；原 `0001` 水位需要受控追加 `0002` 后再启动。
- `dev:cloud` / `start:cloud`：ENV、AUTH_DSN、APP_DSN、SESSION_PEPPER（至少 32 字符）、MAIL_KEY（独立随机 32 字节的 64 位 hex）、ORIGINS、HOSTS；HOST 默认回环，PORT 默认 4178。预发布/生产要求显式 HTTPS 来源、禁止验证码日志；可在回环后接 TLS 网关。
- `worker:cloud`：ENV、AUTH_DSN、同一 MAIL_KEY，以及 `SMTP_ENV/HOST/PORT/MODE/FROM/USER/PASSWORD`；MODE 为 `tls`（默认端口 465）或 `starttls`。可选 SMTP_CA_FILE 追加受信 CA，不能禁用证书验证。`--once` 只处理至多一封邮件，便于隔离验收。
- 以上缩写均加 `ENDLESS_CLOUD_` 前缀。实际秘密通过独立环境的秘密管理注入，不写入仓库、命令示例或浏览器。

SMTP 接收不代表收件箱已送达；超时、断连、进程中断的投递尝试保留 unknown，不自动重发。用户可显式申请新的验证码。升级前已有明文队列记录不作为新密文格式解释；不可投递或过期时安全终止，需重新获取验证码。会话仅存摘要，投递所需的验证码只在短期加密队列中可恢复，终态清除密文。
