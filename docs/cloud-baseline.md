# ENDLESS 云化基线记录（C0/C1、C2、C3 分轮与 C4 第一切片）

日期：2026-10-25（初始切片）；2026-10-26（C1 补齐、C2 第一/二/三轮）；2026-10-26（C3 第一轮：事件身份、事务内 Outbox、增量同步与冲突；第二轮：云副本阅读器接线；第三轮：分叉流注册；第四轮：冲突独立保留与恢复）；2026-10-26（C4 第一切片：共享重放与云历史契约，阶段出口未过）
关联计划：桌面《ENDLESS-云端后端存储与付费实施计划-2026-10-25.md》
初始代码基点（历史记录）：当时工作区（含 desktop 未提交改动）+ 首轮新增 `apps/api/src/cloud/` 与 `packages/cloud-contracts/`
最新进度基点：C4 第一切片提交 `e5a7cb2`。§10.5 是云阅读按需目录。C3 与 C4 的阶段出口都未验收。

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
| 能力发现 | `GET /api/cloud/v1/capabilities` 如实报告：generation/billing 等恒为 false；objects/import/sync 跟随实际挂载的路由（未挂载即 false，不会声明未实现的入口） | 已实现 |

## 3. C1 交付验证（真实 PostgreSQL，非内存模拟）

- 初始切片为 16 项；补齐后为 45 项：10 原语、4 配置/密文、1 模块边界、18 真库身份/权限/迁移、10 邮件队列/SMTP/Worker、2 HTTPS 浏览器/环境隔离。
- 集成测试经 `embedded-postgres` 启动真实集群：角色引导 → 迁移 → HTTP。数据库启动失败必须使测试失败，不再把提前 return 当通过。
- 新增回归先复现三个失败：错码后 `attempts` 仍为 0、B 可把 membership 关联到 A 的 workspace、`deletion_pending` 账号的旧会话返回 200。修复后均拒绝对应路径。
- 覆盖连接池 max=1 的成功/回滚租户切换、跨租户读写及复合关联、并发验证码单次消费、收件人并发限流、工作区幂等、第二设备绑定、会话旋转、账号状态和审计最小权限。
- 邮件测试使用本地 SMTP 协议服务器及临时证书：验证 TLS、STARTTLS、拒绝不受信证书、双 Worker 竞争、SMTP 接受后写库失败、旧 claim 迟到、重启 unknown、不自动重发及密文清除；另启动独立 Worker 进程验证环境注入。
- HTTPS 测试只监听回环：临时 TLS 入口 → 独立云 API → 真 PG + 本地 SMTP；Chromium 验证 Secure/HttpOnly Cookie、刷新、CSRF、换账号隔离、旧会话失效、设备撤销。不修改系统信任、不关闭全局 TLS 校验、不部署公网。
- 命令：`pnpm -C apps/api test:cloud`；HTTPS 子集：`pnpm -C apps/api test:cloud:https`。需要已安装 Playwright Chromium，或设置 `PLAYWRIGHT_CHANNEL=msedge`。
- 已通过 `pnpm test`（全仓 573 项，API 150 项含上述 45 项）、`pnpm typecheck`、`pnpm build`、构建后的 `pnpm test:e2e`（桌面/移动 38 项）。构建仍有原有的大 chunk 警告，不作为已解决项。

## 4. 明确未实现（不得声称）

C2 尚未整体完成：第一轮对象清单底座见 §7；第二轮服务端导入闭环与本地安装存储、第三轮浏览器最小入口与能力上报修正见 §8。仍未完成的是：浏览器对真实云 API 的完整旅程验收（cookie 往返、导入与领取）；云副本阅读器已经在 C3 第二轮接线。

C3 已推进到第四轮并提交为 `5c5c78e`，见 §9：第一轮是事件同步内核；第二轮把云副本接进阅读器；第三轮补上本机新建分支的云流注册；第四轮增加冲突「保留为独立分支」、原分支恢复和持久化请求恢复，并修复首次安装跳过既有云端进度的问题。**仍未完成**：元数据（标题/标签/回收站/归档/采用修订）的命令通道、游标过期后的安全重引导、真实云 API 的双设备浏览器完整旅程。`discard` 仍沿用原来的「停止该分支推送并标记 needsRebase」语义，不把它声称为已经恢复主线。因此 C3 的完整阶段出口仍未验收。

C4 已有两段工程，见 §10：第一段是共享 reducer、云历史引用契约、有界 JSONL 扫描，以及无 HTTP 路由的服务端检查点；第二段是云阅读按需目录（§10.5）。打开云阅读仍会编译当前集和事件碰到的集。C4 阶段出口未过。C5–C9 仍未实现：jobs/attempts/Worker/计量（C5）、额度账本/报价/交付（C6）、支付/订阅/退款/对账（C7）、完整客户端/管理后台/运维（C8）、灰度上线（C9）。`capabilities` 的 generation/credits/billing/payments/exports/edition 仍为 false；`contracts.workspace` 仍是 `endless-workspace/1`。默认组合根未启用对象/导入/同步时，这三项仍为 false。

## 5. 待决策（计划 §24，未默认放行）

首发市场/主体、自动续费资格、定价/份数、体验额度（默认 0）、云空间配额、身份表 PII 静态加密口径，以及真实邮件服务商/发信域名/可达性。IP 计数已跨进程入库，但不采信请求自行传入的转发头；生产网关真实客户端 IP、入口风控和历史限流记录维护仍需部署设计。

C1 本轮通过的是代码与本地隔离验收，不是生产上线验收。真实 SMTP 凭据、公开域名/受信证书、生产数据库与秘密管理、实际邮件送达均未配置或验证，也没有真实邮件/模型/支付调用。完整登录页面、账号隔离阅读库和游客导入不在 C1 内，分别属于 C8/C2。

## 6. 运行方式（开发）

- 云脚本只接受显式注入的 `ENDLESS_CLOUD_*`，不自动读取本机 API `.env`。
- `bootstrap:cloud`：管理员 DSN + AUTH/APP_PASSWORD；`migrate:cloud`：MIGRATION_DSN + 必填 `ENV=development|test|staging|production`。已有环境绑定不允许被改写；当前 API 双角色要求水位 8，须通过受控迁移追加 `0002_c1.sql`、`0003_objects.sql`、`0004_imports.sql`、`0005_sync.sql`、`0006_sync_forks.sql`、`0007_sync_conflict_preservation.sql`、`0008_replay_checkpoints.sql`，不原地修改旧迁移。邮件 Worker 仍只要求水位 2（C1）。
- `dev:cloud` / `start:cloud`：ENV、AUTH_DSN、APP_DSN、SESSION_PEPPER（至少 32 字符）、MAIL_KEY（独立随机 32 字节的 64 位 hex）、ORIGINS、HOSTS；HOST 默认回环，PORT 默认 4178。预发布/生产要求显式 HTTPS 来源、禁止验证码日志；可在回环后接 TLS 网关。存档导入另需显式 `ENDLESS_CLOUD_IMPORTS_ENABLED=1` 且对象存储已启用，并提供 `ENDLESS_CLOUD_LEXICON_FILE`（服务端完整校验必须用与应用一致的词库/目录）。
- `worker:cloud`：ENV、AUTH_DSN、同一 MAIL_KEY，以及 `SMTP_ENV/HOST/PORT/MODE/FROM/USER/PASSWORD`；MODE 为 `tls`（默认端口 465）或 `starttls`。可选 SMTP_CA_FILE 追加受信 CA，不能禁用证书验证。`--once` 只处理至多一封邮件，便于隔离验收。
- Web 端接入云 API：`pnpm dev` 或 `pnpm preview` 的 `/api/cloud` 默认代理到 `http://127.0.0.1:4178`，可用 `ENDLESS_CLOUD_WEB_TARGET` 指向别的开发实例。云 API 的 `ENDLESS_CLOUD_ORIGINS`/`ENDLESS_CLOUD_HOSTS` 必须包含该 Web 来源与代理后的 Host，否则状态变更会被 Origin/Host 检查拒绝。页面入口是 `#cloud`（桌面侧栏「云端副本」，移动端在偏好设置里）。对象/导入路由仍需显式启用，未启用时页面只说明未启用。
- 以上缩写均加 `ENDLESS_CLOUD_` 前缀。实际秘密通过独立环境的秘密管理注入，不写入仓库、命令示例或浏览器。

SMTP 接收不代表收件箱已送达；超时、断连、进程中断的投递尝试保留 unknown，不自动重发。用户可显式申请新的验证码。升级前已有明文队列记录不作为新密文格式解释；不可投递或过期时安全终止，需重新获取验证码。会话仅存摘要，投递所需的验证码只在短期加密队列中可恢复，终态清除密文。

## 7. C2 第一轮：对象底座，不是存档导入

### 7.1 已实现的工程切片

- `packages/cloud-contracts/src/objects.ts` 只注册严格、有界的 `endless-object-manifest/1` 清单契约，引用含对象 ID、SHA-256 和字节数；未知类型、额外字段、自引用、重复引用、未验证/过期引用及跨工作区引用均拒绝。它不是工作区备份或生成正文，也不能用它绕过后续正文校验。
- 摘要为明确标识的 `sha256-bytes/1`：覆盖实际 UTF-8 上传字节，不先重写 JSON；空白或字段顺序不同会产生不同摘要。原有 ENDLESS FNV hash、业务 ID、内容和事件语义不变。UUID 仅作大小写规范化，不改写所存原始字节。
- `0003_objects.sql` 新增 `content_objects`、`object_references`、`workspace_object_roots`，FORCE RLS、同租户/工作区复合外键、不可变身份/正文元数据、前向状态转换和引用冻结。无租户上下文默认不可读。
- 准备上传时，以账号锁串行预留声明空间并绑定工作区；`(account, objectId)` 和 `(account, workspace, contract, domainId)` 共同裁决重试。同 ID 异文或换域/工作区返回 409，不覆盖。对象路径由数据库环境 deployment、当前会话账号和对象 ID 生成，不接受客户端 owner、bucket 或 key。
- 通过有会话和 Origin 保护的 API 上传实际字节，最大 2 MiB、仅 identity 编码，先比对长度/摘要，再调用 S3 `If-None-Match: *` 写入不可变 key。重复写只有实际字节一致才复用。暂存是数据库可见性状态，不向浏览器发放可覆盖对象的直传凭证。
- 服务端重新读取有界正文并校验清单、引用闭包后进入 verified。S3 网络 I/O 不在会被数据库重试的事务内；SDK 自动重试关闭，请求及响应正文读取有 10 秒总边界。
- `commitObjectGraph` 只能由服务端业务事务调用，原子提交整份引用闭包和持久根，可重复执行；没有 HTTP commit 入口。后续导入必须把业务激活和此调用放在同一事务里。当前根不是付费交付授权，不实现 C5/C6。
- 仅 committed 且由本工作区根可达的对象可领取。鉴权后先复查实际正文摘要，再生成 60 秒签名 GET；下载强制 attachment、octet-stream、private/no-store。已签发链接是短期 bearer 凭据，登出/撤销设备不保证立刻撤回这 60 秒内已发出的链接，不得记录链接查询串。
- 空间按 staging/verified/committed 分项统计；每账号最多 4096 个对象、清单最多 256 个引用。上传窗口 15 分钟、暂存保留 24 小时，均为封闭测试初值，不是商业承诺。过期记录仍计入预留，避免未删字节被虚假释放；无引用候选查询只返回结果，不删除数据库或对象。

### 7.2 默认关闭及配置

默认没有对象路由，`capabilities.features.objects/import` 保持 false。仅内部验收显式设置 `ENDLESS_CLOUD_OBJECTS_ENABLED=1` 后，挂载：

| 方法/路径（均在 `/api/cloud/v1`） | 用途 |
| --- | --- |
| POST `/objects/uploads` | 准备/复用同一对象，返回受保护的上传路径 |
| PUT `/objects/:id/body` | 有界不可变上传，必须 `application/octet-stream` |
| POST `/objects/:id/verify` | 重新读取实际字节并验证清单及引用 |
| GET `/objects/:id/download` | 对已提交可达对象返回短期签名链接 |
| GET `/objects/usage` | 本账号声明空间计量，不等于云厂商实际账单 |

必须同时显式注入 `ENDLESS_CLOUD_S3_ENV/ENDPOINT/BUCKET/REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY` 和 `ENDLESS_CLOUD_OBJECT_QUOTA_BYTES`。S3_ENV 必须匹配数据库环境；无 AWS 默认凭据链，也不读取本机 `.env`。端点只允许无用户名、密码、路径、查询串的来源；必须 HTTPS，仅 development/test 的回环协议替身允许 HTTP。不自动创建 bucket、不修改 bucket/IAM 策略、不发送真实用户数据。

S3 使用服务端 AWS SDK 3.1000.0（client-s3、s3-request-presigner，Apache-2.0），显式 path-style、签名及 SHA-256 校验，PUT 请求要求 SSE-AES256。真实服务商的条件写、静态加密、IAM 私有访问、网络、域名和签名 GET 兼容性仍须另行授权验收；本地替身收到加密请求头不等于验证了真实静态加密。

### 7.3 验证边界

`pnpm -C apps/api test:cloud` 包含新增配置及对象测试；对象事务使用真实 PostgreSQL，存储使用只监听回环、校验 SigV4/预签名/过期/条件写/摘要的 S3 协议替身，不用内存数据库证明并发。

覆盖上传失败、已保存但响应失败、准备/验证/提交事务失败、显式同 ID 恢复、跨租户/工作区与默认 RLS、并发空间预留/验证/提交、正文损坏/不可读/超限/压缩/挂起、错误契约及无破坏性候选查询。未执行真实云存储操作，迁移只运行于临时测试集群。真实备份正文验证、游客保留与账号切换的客户端验收、双设备安装和稳定 content/revision ID 属下一轮，不由这些对象测试代替。

本轮验证通过：新增 C2 测试 22 项（18 真库/协议、4 配置），云专项合计 67 项；`pnpm test` 全仓 595 项（API 172 项）、`pnpm typecheck`、`pnpm build` 均通过。构建后的 `pnpm test:e2e` 在独立 `PLAYWRIGHT_PORT=4183` 运行，桌面/移动 38 项通过，未复用或停止原 4173 预览。前端仍有原来的大 chunk 警告；这不是 C2 云客户端或真实云厂商的验收。

## 8. C2 第二轮与第三轮：导入闭环与浏览器最小入口

### 8.1 已落到代码的部分（第二轮：服务端与安装存储）

- 服务端完整校验 `validateCloudBackup`（`packages/content/src/cloud-import.ts`）：复用 `endless-backup/1`/`endless-workspace/1` 解析器且要求未知字段零剥离；复算捆绑修订摘要、事件→采用关系盖章、生成依据前缀哈希；用 `content.accept` 以原 `plannedAt` 重放全部（含未采用分支的隐藏）生成修订；检查点投影和归档卷事实/引文按真实事件前缀重算，不信任自报 verified；进行中票据只验证依据。任何一步失败统一 `CONTENT_REJECTED`，不迁移、不截断、不覆盖。
- 显式云副本 `deriveCloudCopy`：原 business ID（ent_/rev_/brn_ 等）原样保留并登记 `cloud_id_mappings`；`repositoryRevision` 归零；reserved/submitted 的本机票据仅在副本中按 `local-origin-only` 结束，原件字节永不变更——云端不恢复本机 AI 调用，generation 仍关闭。
- 迁移 `0004_imports.sql`（水位 4）：`import_previews`（preparing→ready→activated，24h 过期）、`workspace_imports`（唯一持久回执）、`cloud_id_mappings`、`workspace_installations`（按设备幂等）、`cloud_content_identities`（未来一次性交付 ID 预留，非生成/计费）；全部 FORCE RLS + 复合 owner 外键；workspaces 增加 `staging` 状态、content_objects 增加 `workspace-backup`/`endless-backup/1`。
- `ImportService`：预览在账号锁+Idempotency-Key 事务内准备对象并登记预览，事务外完成有界上传与完整验证后置 ready；激活在同一数据库事务内完成副本派生、回执、`commitObjectGraph` 与 `staging→active`，S3 I/O 不进重试事务。同账号+同来源+同快照返回同一回执；同 ID 异文/验证器版本变化返回 `BASIS_CHANGED` 409，绝不静默覆盖。领取包与按设备安装回执均幂等。
- 路由（仅显式启用时挂载）：`POST /workspaces/import-previews`、`GET /workspaces/import-previews/:id`、`POST /workspaces/imports`、`GET /workspaces/:id/package`、`POST /workspaces/:id/installations`，均需会话+Origin+Idempotency-Key。
- 客户端存储层（无 UI）：`cloudNamespace` = `endless-cloud:<deployment>:<account>:<workspace>` 独立 IndexedDB；`installCloudCopy` 在单事务内完成非空命名空间检查、SHA-256 副本摘要核对与安装记录写入——中断不留半份书架；重复领取只补安装记录、不覆盖本机后续进度；游客库不可被安装，`acknowledgeCloudInstallation` 只接受与本机记录一致的设备回执。
- `reserveContentIdentity` 按 (workspace, deliveryKey) 只分配一次 content/revision ID，为后续云生成结果铺路；本轮不实现模型调用、额度或交付。

### 8.2 本轮专项验证（真实 PG + S3 协议替身）

- `packages/content/test/cloud-import.test.ts`：9 项通过（捆绑摘要、事件盖章、生成篡改/跨期重放、隐藏修订、未知字段与密钥载荷剥离拒绝、票据策略、检查点与归档重算）。
- `apps/api/test/cloud/imports.test.ts`：9 项通过（预览不激活、双设备领取同 ID/幂等安装、并发与响应丢失复用、exportedAt 抖动归并、同 ID 异文/基线变更冲突、跨账号隔离与 RLS、上传中断恢复、过期拒绝、激活事务失败后可沿原请求恢复、交付 ID 一次性）；与对象测试合计 27 项通过。
- `apps/web/test/cloud-storage.test.ts`：4 项通过（游客/他账号隔离、中途失败无半装、重复领取不覆盖进度、坏摘要/换导入拒绝覆盖）。
- `pnpm -C packages/content typecheck`、`pnpm -C apps/api typecheck`、`pnpm -C apps/web typecheck` 通过。

### 8.3 第三轮：浏览器最小入口、能力如实上报与全量回归

- `apps/web/src/cloud/client.ts`：同源 Cookie 客户端（`credentials: same-origin`、`cache: no-store`、30s 超时），导入走 `application/octet-stream` 原始字节 + `Idempotency-Key`；错误只依赖共享错误信封的 `code`/`retryAction`/`correlationId`，不解析服务端文案；网络失败、非 JSON、契约不符分别归类为 `NETWORK`/`INVALID_RESPONSE`，不推断业务结果。超上限存档在上传前就拒绝，不截断。
- `apps/web/src/cloud/controller.ts`：不依赖 React 的流程控制器（HTTP、IndexedDB 仓库、摘要、幂等键全部注入，可在 Node 直接测）。一次用户操作一个幂等键：同一份字节重试复用预览键，字节变化才换键；确认键在首次确认时生成并在失败重试中沿用；领取安装键取自本机持久化记录，回执丢失时沿用原键恢复，不新建第二份副本。`UNAUTHENTICATED` 立即退回未登录，不写回执、不写本地副本，也不触碰游客库。
- `apps/web/src/cloud/page.tsx`：账号登录（邮箱 OTP）、设备列表、导入预览/确认、云端工作区与“领取到这台设备”。措辞边界：预览显示“仅预览，未写入云端”，领取后说明可以“打开云端副本”并交代元数据同步没接，不出现“已同步”。能力未开启时按钮直接禁用并说明。（阅读入口在 C3 第二轮接上，见 §9.4。）
- `apps/web/src/cloud/use-cloud.ts` + `App.tsx`：新增 `#cloud` 页与侧栏入口；移动端经“偏好设置 → 云端副本”进入（移动导航仍为 5 项，避免 320–390px 挤压）。
- `apps/web/vite.config.ts`：`/api/cloud` 代理先于 `/api` 匹配，默认指向 `127.0.0.1:4178`，可用 `ENDLESS_CLOUD_WEB_TARGET` 覆盖；云 API 的 HOSTS/ORIGINS 需包含开发来源。
- 能力发现改为由**实际挂载的路由**推出（`cloud/server.ts`）：显式启用对象/导入后不再报 false，声明与实现无法分叉；对应断言从“挂载了也必须报 false”改为“挂载了必须报 true”。

### 8.4 验证（真实 PG + S3 协议替身 + 静态/浏览器渲染）

- 内容与服务端专项沿用 §8.2 的结果（`cloud-import` 9 项、`imports` 9 项，均未回退）。
- `apps/web/test/cloud-client.test.ts`：5 项（请求形状与幂等头、超限前置拒绝、错误信封分类、网络/非 JSON/401 可辨、契约不符拒绝采纳）。
- `apps/web/test/cloud-controller.test.ts`：12 项（401 退未登录、能力不可达落“不可用”、登录/退出、预览复用同键与换字节换键、确认失败重试同键、确认时会话失效不留回执、激活后列表刷新失败不改变回执、领取写入账号隔离命名空间且游客库不变、回执丢失复用安装键、重复领取不再请求安装、非法领取包不落库、副本可被本地备份解析）。幂等键两条断言做过变异验证：改成每次新生成键，相应用例立即变红。
- `apps/web/test/cloud-page.test.tsx`：7 项（未启用/未登录/有预览/已激活/领取后/故障/导入上限的静态渲染与措辞边界）。
- `apps/web/e2e/cloud.spec.ts`：4 项（桌面/移动；云 API 不可达时如实说明、无假成功、无“读取中”卡死、返回首页仍可阅读；320–1440px 无横向溢出）。
- 全量：`pnpm typecheck` 全仓通过；`pnpm test` 全仓 641 项（web 67、api 181、content 107、lab 99、director 45、learning 18、player 10、world 12、esl 99、desktop 3）；`pnpm build` 通过（仍有原有大 chunk 警告）；构建后 `pnpm test:e2e` 42 项通过（桌面/移动）。

### 8.5 仍缺（C2 不能标完成）

- 浏览器端**未对真实云 API 验收**：cookie 往返、`__Host-` 在开发代理下的行为、导入与领取的完整浏览器旅程都没有跑过；现有浏览器测试只覆盖“云 API 不可达”的诚实降级。生产等效验收仍属 C8-04。
- 云副本**阅读器不存在**：副本已写入独立命名空间，但 `use-player`/阅读页仍只打开游客库，领取后的副本不能打开阅读。
- 增量同步、云生成、额度、支付均未实现（C3–C7）；`0004_imports.sql` 只在临时测试集群运行过。
- 真实对象存储、真实凭据、公网 TLS、生产部署、真实邮件/模型/支付均未验收。

## 9. C3 第一轮：事件身份、事务内 Outbox 与增量同步

### 9.1 已落到代码的部分

- 迁移 `0005_sync.sql`（水位 5）：`sync_streams`（流头 = 连续序号 + 最后事件 ID）、`event_objects`（不可变事件正文、SHA-256、来源设备）、`stream_events`（流成员关系，与事件正文分离，便于日后按分支引用同一前缀）、`workspace_change_heads` / `workspace_changes`（提交有序变更流）、`sync_batches`（批次幂等回执）、`sync_conflicts`（被拒绝的整批候选）、`device_stream_state`（设备级界面状态）；全部 FORCE RLS + 复合 owner 外键，`workspaces.sync_epoch` 用于游标换代。
- `SyncService`（`apps/api/src/cloud/sync/`）：
  - 推送在**账号锁 → 工作区行锁 → 流锁（按 streamId 排序）** 的固定顺序下进行，批次幂等键为 `(account, workspace, batchId)`，同键异摘要返回 `IDEMPOTENCY_MISMATCH`，同一批次重复 20 次只生效一次并返回同一回执。
  - 每个流显式声明 `baseSeq` + `baseEventId`，必须同时等于服务端流头才追加；不匹配则**整批拒绝**并写入 `sync_conflicts`（候选事件原样保留），返回 `SYNC_CONFLICT` + `conflictId`，绝不把两条离线历史拼成一条。
  - 事件去重**只按 eventId**；同一 eventId 换正文返回冲突，相同正文的不同 eventId 视为两条合法历史。服务端重算事件正文摘要并与客户端声明比对。
  - 事件盖章（`contentId`/`revisionId`）必须是本工作区 `cloud_id_mappings` 里真实存在的映射，且必须成对出现；伪造或单边盖章返回 400。
  - `change_seq` 在 `workspace_change_heads` 行锁内递增，**分配顺序即提交顺序**；一个批次对每个流写一条变更记录。
  - 拉取使用不透明 base64url 游标（绑定工作区 + 序号 + `sync_epoch`），分页默认 50/上限 100；游标超前、换代或格式损坏分别返回 `CURSOR_EXPIRED` / `BAD_REQUEST`，不猜位置继续读。
  - 冲突列表包含被拒绝的候选事件；首版只接受 `discard`（明确放弃本机候选），**「保留为独立分支」不接受也不假装支持**。
  - 设备级界面状态（当前集、字号）按设备读写，不进变更流、不推进 `cloud_version`——`select`/`text` 只是界面偏好，永远不会写进事件流。
- 导入激活时一次性持久化整段前缀的事件身份（`seedSyncStreams`）：每个分支一个流，每个事件分配稳定 eventId 并记录正文摘要与可重放命令；之后所有设备沿该绑定追加，不需要重新分配 ID。
- 路由（仅显式启用时挂载）：`GET /sync/bootstrap`、`POST /sync/push`、`GET /sync/pull`、`GET /sync/conflicts`、`POST /sync/conflicts/:id/resolve`、`GET|PUT /sync/device-state`；会话 + 严格 Origin 校验；`capabilities.sync` 由实际挂载推出。
- 客户端存储层（`apps/web/src/storage.ts`，IDB v2）：新增 `outbox` / `eventIds` / `sync` 三个 store，**与业务数据同一事务**写入。一次提交内对比存储态与提交态：追加事件分配 eventId 并排队；分支复制父前缀时沿用父流身份；存储态不是严格前缀时标记 `needsRebase` 而不是把替换后的历史当成「追加」。
- `apps/web/src/cloud/outbox.ts`（纯函数）与 `sync.ts`（驱动）：先推送后拉取；只推送能接在已确认前缀之后的连续段（有空洞就停）；推送成功在一个事务里删除已确认事件并推进云端前缀；拉取逐条重放云端命令、**比对重放结果与事件正文**，不一致就停在该处；本机自己的变更按 deviceId 跳过；游标过期时先报告本机未同步条数，不用云端快照覆盖。
- `apps/web/src/cloud/page.tsx` 增加同步面板：待推送条数、已确认版本、上次成功时间、暂停/恢复、冲突列表与「放弃本机候选」、`needsRebase` 警告；文案明确写出「跨设备应用到阅读器尚未接线」「元数据同步与按分支保留尚未实现」。

### 9.2 明确不做的部分（不要当成已完成）

- **只有事件同步**：标题、标签、备注、回收站、归档卷、采用修订这些管理操作没有命令通道。
- **没有「保留为独立分支」**：冲突只能显式放弃本机候选；本机这批事件不删除，但该分支从此不再推送。
- **本机新建分支（forkForRevision）的云流注册已补上（见 §9.5）**：客户端先按父流 + 分叉点注册，再推送分叉点之后的事件；父流前缀没推完时等待下一轮。
- **服务端学习重放在第一轮未做**：当时只校验事件契约、盖章与流前缀。后来的 C4 第一切片增加了无 HTTP 路由的检查点服务，见 §10。
- **界面没有「应用云端变更」入口**：驱动层已实现并在测试里跑通双设备往返，但云副本阅读器（C2 遗留）还没接线。
- 没有任何真实云 API 的浏览器旅程；对象存储/CDN 未参与事件正文（正文存 PG jsonb）。
- 未验证 10k 事件级别的推送/拉取与分页压力。

### 9.3 验证（真实 PostgreSQL + fake-indexeddb）

- `apps/api/test/cloud/sync.test.ts`：18 项通过（导入即持久化前缀身份、空工作区首次推送、能力随挂载、变更按序与游标分页、同批次并发 20 次只生效一次、同正文异 eventId 不去重、同 eventId 异正文冲突且主链不变、两设备相反选择整批拒绝、显式放弃只改状态、账号锁内串行不留序号空洞、游标超前/换代/损坏、跨账号一律拒绝、伪造盖章拒绝、设备级界面状态隔离、HTTP 路由与未挂载时 404、未知流不静默创建、未激活工作区不分配身份）。
- 云专项合计 **94 项**通过（C1 45 + 对象/导入 31 + 同步 18）。
- `apps/web/test/cloud-sync.test.ts`：13 项通过（事务内身份与排队、提交失败时 Outbox 同样不落库、历史替换标记 `needsRebase`、远端身份不入队、分支前缀沿用父流身份、空洞/未绑定不推送、坏状态容错、**双设备 A 推→B 拉→B 追加→A 拉**全链路、两设备相反选择整批拒绝且不拼接、暂停/恢复、游标过期不覆盖、状态不伪造「已同步」）。
- `apps/web/test/cloud-page.test.tsx`：9 项（新增同步面板：真实待推送条数、冲突与「放弃本机候选」、未启用部署禁用按钮、`needsRebase` 单独警告；断言不含「已同步全部内容」）。
- 三条关键断言做过**变异验证**：去掉流前缀 CAS → 两条冲突用例立即变红；把去重键从 eventId 改成摘要 → 两条身份用例变红；让远端身份也入队 → 两条回声用例变红。
- 全量：`pnpm typecheck` 全仓通过；`pnpm test` 全仓 **674 项**（api 199、web 82、content 107、lab 99、director 45、learning 18、player 10、world 12、esl 99、desktop 3）。

### 9.4 C3 第二轮：云副本阅读器接线

第一轮的驱动层能应用云端事件，但界面没有入口——云副本只能「领取后放在那里」。这一轮把它接到阅读器上。

- 深链 `#cloud-read/<deploymentId>/<accountId>/<workspaceId>[/home|watch|progress]`：云库命名空间由「部署 + 账号 + 工作区」共同决定，三个 ID 都写进链接后，刷新、书签、另开标签都落回同一个库；不额外维护「最近打开的副本」指针，就不会出现指针指向已清理库时的静默失败。缺 ID 或非 UUID 回落到云端页说明，不猜。
- `App` 拆成路由壳与 `StoryApp`：换命名空间时以 `namespace` 为 key 整棵树重建，游客库与云库的会话、光标、未提交状态不会互相渗。
- `usePlayer` 接受可选云参数：云库必须**同时**有存档与安装记录才可打开，只有其一都明确失败（不创建空工作区）；设备 ID 取自本机安装记录，同步驱动在打开时跑一次。
- 每次本地提交后延迟 700ms 同步（连续点「继续」只发一批）；同步进行中本地提交先等它落地，避免两边同时写同一个仓库撞版本校验；同步结束**从仓库重新读取**再渲染，不拿驱动层内存副本当界面状态。
- 云副本里只开放「故事 / 阅读记录」：内容管理、Edition、偏好设置写的是本机存档字段，这一轮没有元数据命令通道，放进来会让人以为改动会同步；AI 生成入口隐藏（云端生成属 C5）。状态条只写待推送条数、上次成功时间、暂停、冲突候选，没有待推送事件时也只说「没有待推送事件」，不替其他设备下结论。
- 云端页只有本机**确有安装记录**的工作区才显示「打开云端副本」；列表来自服务端，安装记录来自本机，两者都满足才给入口。

验证：

- `apps/web/test/cloud-routes.test.ts` 7 项：游客页识别、三个 ID 与命名空间推导、非阅读页回落、缺 ID/非 UUID/多余段、末尾斜杠、深链往返。
- `apps/web/test/cloud-reader.test.tsx` 6 项（静态渲染）：不写「已同步全部内容」、不说「所有设备」、冲突/游标/历史替换分别可操作、同步中与暂停的按钮状态、明说只同步阅读事件、状态未读到时不显示假零值。
- `apps/web/test/cloud-controller.test.ts` 新增 3 项：未领取时不给入口、领取后刷新能看到本机副本、未登录不生成深链。
- `apps/web/test/cloud-sync.test.ts` 扩充双设备用例：B 应用远端变更后，仓库里的存档能被 `bridge` + `projectSession` 直接投影（不只是字节一致）。
- `apps/web/e2e/cloud.spec.ts` 新增 1 项（桌面/移动各一遍）：没有本机云副本时深链如实说明、给出回云端页的链接、**不新建空存档**、游客阅读不受影响。
- 一处变异验证：去掉「本机安装记录」门控 → 对应用例立即变红。
- 全量：`pnpm typecheck` 全仓 0 错误；`pnpm test` **690 项**（api 199、content 107、lab 99、esl 99、web 98、director 45、learning 18、world 12、player 10、desktop 3）；`pnpm build` 通过；构建后 `pnpm test:e2e` **44 项**通过。

仍不成立的部分：

- **没有对真实云 API 的双设备浏览器流程**：现有浏览器用例只覆盖「不可达」与「没有副本」两条降级路径；cookie 往返、导入→领取→阅读→同步全链路仍未在真服务上验收。
- 元数据命令通道与冲突「保留为独立分支」仍未实现（分叉流注册已在 §9.5 补上）。
- 阅读器里没有「应用云端变更」的手动入口以外的可视化（只在打开与提交后自动同步，可手动点「立即同步」）。
- 没做 10k 事件级别的性能验证；事件正文存 PG jsonb，未接对象存储。

### 9.5 C3 第三轮：本机新建分支的云流注册

第一轮把「本机新建分支」当成未注册的流：推送排不上、事件留在队列里。这一轮补上注册。

- 迁移 `0006_sync_forks.sql`（水位 6）：`sync_streams` 增加 `parent_stream_id` 与 `fork_at_seq`，成对约束（只有其一即拒绝）、禁止自引、复用父流外键。分叉流与父流共享前缀成员关系，事件正文仍只在 `event_objects` 存一份。
- `POST /sync/streams`：只接受「父流 + 分叉点」。服务端校验父流存在、分叉点不超过父流已有的云端历史；先建空流头再复制 `stream_events` 前缀（外键要求这个顺序），最后把流头推进到分叉点。同 `streamId` 重复注册幂等；参数不同直接 400，不静默改绑。
- 客户端驱动（`apps/web/src/cloud/sync.ts`）：推送前先把「有待推送事件但没有云端绑定」的流按本机分支的 `parentBranchId` + `forkAtEventCount` 注册；父流前缀还没推完就**不发注册请求**，等下一轮；没有父流记录的根分支不注册，也不编造前缀。注册成功把绑定写回同步状态，本轮紧接着推送分叉点之后的事件。
- 有事件排不上时不再只留一个待推送数字：结果里写明「另有分支还没有云端事件流（父流前缀未推完或缺少父流记录），事件已保留」。

验证：

- `apps/api/test/cloud/sync.test.ts` 新增 5 项：注册复制前缀成员关系且不复制正文（`stream_events` 1 行、`event_objects` 仍 2 行）、重复注册幂等与改绑拒绝、分叉点超出父流与父流不存在、分叉点 0 作为独立根流、跨账号不能注册到别人的工作区。
- `apps/web/test/cloud-sync.test.ts` 新增 3 项：分叉流先注册再推送、父流前缀未推完时不发注册请求且下一轮补上、无父流记录的分支不注册也不丢事件。
- 变异验证：去掉「父流前缀是否覆盖分叉点」的判断 → 对应用例立刻变红（`registerAttempts` 断言抓住了「发了但被拒」与「根本没发」的区别）。
- 云专项服务端 **99 项**（含同步 23 项）；Web **101 项**；全仓 typecheck 0 错误。

仍未成立：冲突「保留为独立分支」需要本地分支手术（新建分支承载本机历史、父分支回落到云端前缀、清掉旧流的待推送事件），这一轮没做，接口也仍然只接受 `discard`。

### 9.6 C3 第四轮：冲突独立保留、原子恢复与请求续接

本节更新前三轮中「保留为独立分支未实现」的历史边界，不代表 C3 全部完成。

已实现：

- 追加迁移 `0007_sync_conflict_preservation.sql`，运行水位为 **7**；不改写既有迁移、事件正文或导入原件。事件流与变更记录携带分支采用清单；冲突记录增加 `preserved` 状态与绑定请求摘要的持久回执。
- `POST /sync/conflicts/:id/resolve` 接受 `keep-branch` 和稳定的新 `brn_<uuid>`。服务端在账号 → 工作区的锁顺序下复制共同前缀的成员关系，将已记录的候选写入独立根流（`parentBranchId`/`forkAtEventCount` 均为 null），共同来源仅放在云 sidecar；绝不复用正文改写的分叉语义。新流、变更流、冲突状态和恢复回执在同一事务提交；同请求并发/重试返回相同结果，换请求则拒绝。同账号更换会话/设备后仍可取回原回执，跨账号仍拒绝。
- 本机先把完整工作区、事件身份和稳定请求保存到 `sync`，再发网络请求。结果未知期间冻结业务写入，也不允许把同一决策改成 `discard`；刷新后「立即同步」恢复原请求。明确的 `BAD_REQUEST`/`STORAGE_QUOTA` 拒绝表示该事务没有提交，此时将完整请求隔离留存并解除冻结；网络未知结果或本机提交失败不能这样解除。
- 验证回执的候选、采用关系、原始正文、摘要、可重放命令、共同前缀和内容/修订盖章后，在同一 IDB CAS 事务里恢复原分支、创建独立根分支、更新 sidecar/Outbox/流绑定并结束恢复请求。候选批次之外的本机事件仍在独立分支里保留，沿用原 eventId 继续排队。云端当前历史与本机历史不拼接；分支切换只属于本机界面状态。
- 云端页增加「保留为独立分支」和「下载本机完整冲突包」；阅读器可以选择已安装的独立分支。冲突包包含完整业务数据、隔离数据、带键的事件身份、Outbox 与同步/恢复请求，只是本机原始恢复包，不是云端导出服务，也没有自动导入/覆盖入口。
- 普通推送也先持久化完整批次，丢响应/刷新后沿用 batchId、事件身份和正文，确认回执后与 Outbox 一起清除。服务端对同一拒绝批次复用候选 ID，不因重试创建一串候选；单次仍最多 256 个事件、8 条流。
- 修复首次领取的引导：`bootstrap` 的当前头部仍用于状态读取，另给出不可变导入前缀的 `origin`；新安装副本从 `origin` 拉取导入后的变更，而不是从“现在”跳过已有云端阅读进度。引导读取锁住工作区，避免把不同提交时刻的头部拼成一份响应。既有异常同步状态不会因此被静默重置。

容量与兼容边界：

- 本轮仍是有界 `endless-workspace/1`：恢复历史最多 10,000 事件，单份服务端历史恢复包最多 2 MiB，分支总数最多 64；不以截断事件或删除旧分支通过。不可变生成依据仍引用本机分叉后的前缀时拒绝自动手术，保留完整冲突包，不能改写旧生成依据。长历史与新云外层契约的第一切片见 §10，C4 阶段出口未过。同步冲突恢复读取仍拒绝 10,000 以上的事件序号。
- 旧导入流缺少清单时，组合根可从原始导入对象重新验证并取回原清单，外部对象读取发生在数据库事务之外。旧的本机新建流如果既没有清单、也不在原始导入包内，返回 `UNSUPPORTED_CONTRACT`，不猜采用关系。没有执行生产库迁移或真实云对象操作。
- 共享网络契约新增清单、导入基线和恢复字段；旧严格客户端会拒绝未知响应，测试部署应先受控迁移并更新客户端，不能把旧客户端的拒绝当作可自动重置存档的理由。原 episode、选项、学习事件及既有历史含义不变。

验证覆盖：先用失败测试复现不支持保留与首次安装跳过云进度，再验证修复；真实 PostgreSQL 覆盖共同前缀共享、并发恢复幂等、异摘要拒绝、跨租户隔离、事务末端失败回滚、坏摘要无法经保留绕过校验；fake-indexeddb 覆盖完整历史、候选之外的尾部事件、刷新续接、配额故障原子回滚、确定拒绝/未知结果的区别、隔离包和推送丢回执。完整命令结果以本节后续记录为准。

下一轮仍需：元数据命令与显式并发冲突处理，以及浏览器连接真实云 API 的登录 → 导入 → 双设备领取/阅读 → 离线分叉 → 上线处理 → 刷新 → 再离线的完整旅程。本轮不把这些标为通过，也不实现 C4–C9、Edition 云同步或云生成。

本轮验证结果（2026-10-26）：

- `pnpm test`：全仓 **707 项**通过（API 206，其中云专项 101 / 同步 25；Web 108；其余工作区 393）。
- `pnpm typecheck`：全仓通过。
- `pnpm build`：通过，包括 PWA 清单与服务工作线程；原有大 chunk 警告仍在。
- 构建后以独立回环端口运行 `PLAYWRIGHT_PORT=43173 pnpm test:e2e`：桌面/移动 **44 项**通过。这是现有浏览器回归，不是尚缺的真实云 API 双设备成功旅程。
- `git diff --check`：通过。迁移仅运行在临时 PostgreSQL 测试集群；没有操作实际云库、真实对象存储、邮件供应商、模型或支付。

### 9.7 C3 任务对照与下一轮范围

| 计划任务 | 工程进度 | 仍需补齐或验收 |
| --- | --- | --- |
| C3-01 eventId sidecar | ENDLESS 事件身份与导入前缀映射已有实现和测试 | 不以正文摘要替代事件身份 |
| C3-02 两个本地仓库的事务 Outbox | ENDLESS IDB v2 已接入 | Edition 云同步未实现、未开放；原任务仍保留，不默认放行 |
| C3-03 push 幂等与原子提交 | 已实现；含持久批次、丢响应恢复与拒绝候选幂等 | 后续命令通道也必须维持同样纪律 |
| C3-04 change feed / 游标 / 引导 | 有序变更、分页、游标、新安装 origin 基线已有实现 | 游标过期后的完整快照重引导仍未闭环，不能覆盖本机待同步事件 |
| C3-05 分叉与元数据冲突 | 事件候选、显式保留独立分支及恢复已有实现 | 元数据命令与显式并发冲突未实现；discard 仍停在 needsRebase |
| C3-06 设备界面状态隔离 | current、字号和阅读分支选择不广播为学习事件 | 新功能不得把管理/UI 操作伪造成学习事件 |
| C3-07 恢复与可见状态 | 暂停、持久请求续接和状态入口已有实现 | 身份失效及双设备完整产品旅程仍需连接真实云 API 验收 |

下一轮先实现标题/标签/备注/回收站/归档/采用修订等元数据命令的稳定身份、前置版本、原子 Outbox、幂等回执与显式冲突处理，再补齐安全重引导与真实云 API 双设备浏览器旅程。不重做 C0/C1，不提前接支付，也不把本轮的 44 项浏览器回归替代 C3 阶段出口。C4 第一切片已另行记在 §10：它不补上这三项缺口，C3 与 C4 的阶段出口仍未通过。

## 10. C4 第一切片：共享重放与云历史契约（阶段出口未过）

用户在 C3 出口仍开放时授权先做这一切片。它不实现 §9.7 的元数据命令、游标过期安全重引导或真实双设备浏览器旅程，也不开始 C5 或支付。本切片基于 `5c5c78e`。

### 10.1 已落到代码

- 引用契约在 `packages/cloud-contracts`：`endless-cloud-workspace/1`、`cloud-generation-basis/1`、`cloud-event-segment/1`（每段最多 1000 个事件）、`cloud-adoption-manifest/1`（每页最多 500 条）、`cloud-content-revision/1`。段字段 `segmentHash` 是该段正文哈希；整段前缀哈希是 `history.eventHash`。未知版本拒绝写入。旧 `endless-workspace/1` 仍按原契约读取，不原地改写，也不经 `parseWorkspace` 当成云信封。
- 有界 JSONL 扫描、编码、解码和读取在 `history-jsonl.ts`。第一行必须是唯一的工作区信封；修订的 `plannedAt` 必须与其依据一致，`authoredAt` 可以不同。这不是 C8 导出产品：`capabilities.exports` 仍为 false，没有历史 HTTP 路由，也不新增能力标志。`contracts.workspace` 仍报告 `endless-workspace/1`。
- `packages/player` 用同一 reducer（`player-replay-1`，策略 S-B）。`projectSession` 委托 `replayEvents`；全量重放与前缀续接共用 `applyReplayEvent`。seen、证据连续状态、世界内部序号与顺序、答题去重可以往返。未知投影版本和旧的 `player-projection-1` 都拒绝续接。旧导出仍把 `seen` 与 streaks 留空，保持有损，以免既有云导入的字节比较失败。播放器包不依赖 `ts-fsrs`：桌面类型检查会沿导入跟踪播放器源码，卡片的 `due` 与 `last_review` 用结构冻结/解冻。
- `SessionSchema` 的事件上限仍是 10,000。同步冲突恢复读取在 `event_seq` 超过 10,000 时仍拒绝。检查点验证超过 100,000（`REPLAY_VERIFY_EVENT_LIMIT`）时返回 `UNSUPPORTED_CONTRACT`，不截断历史。
- 迁移 `0008_replay_checkpoints.sql`：FORCE RLS，只授予 SELECT 与 INSERT，投影版本限定 `player-replay-1`。API 双角色水位升到 8；邮件 Worker 仍是水位 2。`HistoryService.verifyStream` 按 1000 条一页重放库内正文，客户端快照不可信。谎报或重放失败返回 `CONTENT_REJECTED` 且不写行；旧投影或未知版本返回 `UNSUPPORTED_CONTRACT` 且不写行；省略声明时仍写入服务端快照；同一摘要幂等；不同摘要返回 `SYNC_CONFLICT`（409）。快照正文超过 2 MiB 时该列为空，摘要仍保存。没有公开 HTTP 路由，组合根也不引用该服务。段链由 `assertSegmentChain` 保持；这一轮按整条已存流重放，不按段向对象存储取正文。
- 本机 v4 生成在调用开始时记下的时刻上执行 `planAtFrozenTime(localVerifiedPrefix(...))`。旧信封的 `generatedAt` 仍表示用来重建学习计划的时间；创作时间是 `authoredAt`。`cloudVerifiedPrefix` 在 `completePrefix !== true` 时拒绝。旧的 `content.plan` 路径未改。云生成 Worker 仍属 C5，没有接线，因此没有排队任务在重启后的再编译。
- reducer 的 `EpisodeLoader.load` 对未访问的集不在启动时编译。云阅读目录见 §10.5：列表和来源查找不编译，但打开时仍会编译当前集和事件碰到的集。C4-05 和「数据库已分页、前端仍全载」这条出口都未满足。

### 10.2 明确不做

- 不抬高 `SessionSchema` 的 10,000 上限，也不抬高同步冲突恢复的 10,000 上限。
- 不改写既有 `endless-workspace/1`，也不把有损投影的 seen/streaks 填上。
- 不开放历史 HTTP、导出、云生成、额度、计费、支付或 Edition 云同步。
- 不把 C3 或 C4 标为阶段出口通过。
- 不记录首屏、恢复或生成上下文准备耗时，也不自定时间门槛。C4 的测试清单要求这些数来自目标设备实测；本切片只有下面这一次合成重放。验收矩阵 H01（任意分段与全量逐字段一致）不因这次计时而通过。

### 10.3 验证（2026-10-26）

- `pnpm test`：全仓 **723** 项通过。API 209（云专项由上一轮的 101 增至 104，其中历史检查点 3 项，同步仍为 25）；Web 108；其余 406（desktop 3、cloud-contracts 5、esl 99、world 12、learning 18、director 45、player 16、lab 99、content 109）。
- `pnpm typecheck`：全仓通过。
- `pnpm build`：通过，包括 API 类型检查、Web 生产构建、PWA 清单与服务工作线程。主包 `dist/assets/index-D-nWY8ti.js` 为 1,170.85 kB，大于 500 kB 的警告仍在。
- 本切片没有新页面，未重跑 `pnpm test:e2e`。§9.6 记录的 44 项是上一轮结果，不能算作本切片的浏览器验收。
- 10,001 个逻辑事件：`SessionSchema.safeParse` 失败，reducer 仍完成。这是合成夹具，不是 10,001 行的 PostgreSQL 插入。
- 100,000 个逻辑事件的合成 reducer 夹具（多集共享一份 AST，每集只推进一个场景）在这次全仓测试中打印 `{"replay100k":{"elapsedMs":1088,"heapDelta":183234640,"completed":100000}}`。183,234,640 字节约为 175 MiB 堆增量。这不是首屏、恢复或上下文准备测量，也不设通过时限。更早的孤立运行和失败那次全仓运行的数字不记入。
- PostgreSQL 只把已有流的 `event_seq` 改成 100,001，验证返回 `UNSUPPORTED_CONTRACT`，`stream_events` 仍为 3 行。没有插入 100,000 行。
- JSONL 读过 11 段 × 1,000 = 11,000 个事件，以及两页合计 501 条采用清单。
- 学习计划：第一次 Good 仍是 Learning；到期后再一次 Good 进入 Review。`planAtFrozenTime` 在到期前 1 秒的 brief 不含该项；到期后且曝光不少于 2 次时包含该项。伪造计时器设到 2030-01-01 时，冻结计划仍与到期前的 `planCreative` 一致。`completePrefix: false` 被拒绝。云信封交给 `parseWorkspace` 会因不是 `endless-workspace` 而拒绝。
- 迁移只在临时 PostgreSQL 测试集群运行。没有操作实际云库、真实对象存储、邮件供应商、模型或支付。

### 10.4 任务对照

| 计划任务 | 工程进度 | 仍缺 |
| --- | --- | --- |
| C4-01 云历史引用契约 | 五种契约与未知版本拒绝已有单测；旧工作区格式不改写 | 能力发现仍只通告 `endless-workspace/1` |
| C4-02 同一 reducer | 初始化、应用事件、完整状态导出/导入与前缀续接共用一套；播放器既有测试与新 reducer 测试已通过 | 续接权威仍只是 `player-replay-1`，旧有损导出不能当检查点 |
| C4-03 seen、连续状态、世界顺序、答题去重 | `player-replay-1` 往返 | 旧 `player-projection-1` 导出仍有损 |
| C4-04 段验证、服务端检查点、版本分派 | 库存正文重放后写检查点；谎报、旧投影、未知版本不写行；同摘要幂等，异摘要 409 | 无 HTTP 路由；不按段向对象存储取正文 |
| C4-05 按需加载与历史来源 | reducer 对未访问集懒加载已测；云目录的列表和来源查找不编译 | 当前集、事件碰到的集，以及校验所需的更早生成集仍会编译。IndexedDB 仍读出全部修订正文。本项不勾 |
| C4-06 本机/云已验证上下文 | 本机 v4 冻结计划时间；云适配器拒绝不完整前缀。创作政策未改 | 云 Worker 未接。本项不勾 |
| C4-07 有界 JSONL | 扫描、编码、解码、读取已测 | 不是导出产品，`exports` 仍为 false。本项不勾 |
| C4-08 越过 10,000 事件与 500 采用清单 | 合成夹具读过 11,000 事件与 501 条采用；10,001 时模式仍拒绝而 reducer 完成；超过 100,000 拒绝且不截断 | 冲突恢复路径仍是 10,000；PostgreSQL 未装入 10 万行 |
| C4-09 plannedAt 与旧 generatedAt | 适配器与本机 v4 冻结计划时间；到期边界上的复习 brief 已证明 | 没有云队列 Worker，未做重启后再编译 |

出口未过：完整历史的服务端检查点没有产品入口；播放过的集在打开云阅读时仍会编译；首屏、恢复和生成上下文准备耗时没有目标设备实测，也没有时间门槛。

### 10.5 云阅读目录不再编译未打开的后续集

`openCloudCatalog`（`packages/content/src/cloud-catalog.ts`）给出场景数和 `episodeId.sceneId` 叙述查找，这两步不调用 `createEpisode`。云阅读的玩法命令改走这份目录，不再为每次操作调用 `bridge()`。比当前集更晚、且没有事件的生成集保持未编译。当前集以及事件落到的集仍会编译，校验当前集时也会编译更早的生成集。IndexedDB 仍一次性读出全部修订正文。生成和归档里继续调用 `bridge()` 的路径仍会编译整库。因此 C4-05 仍不勾，阶段出口仍未过。

这项的测试是内容包 `cloud-catalog.test.ts` 2 项，加上内容包 111 项和 Web 108 项。没有重跑全仓 `pnpm test`、`pnpm build` 或 `pnpm test:e2e`。没有在浏览器里走通云阅读。
