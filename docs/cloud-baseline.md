# ENDLESS 云化基线记录（C0/C1 与 C2 进行切片）

日期：2026-10-25（初始切片）；2026-10-26（C1 补齐、C2 第一轮）；2026-10-26（C2 第二/三轮：导入闭环与浏览器最小入口）
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
| 能力发现 | `GET /api/cloud/v1/capabilities` 如实报告：sync/generation/billing 等恒为 false；objects/import 跟随实际挂载的路由（未挂载即 false，不会声明未实现的入口） | 已实现 |

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

C2 尚未整体完成：第一轮对象清单底座见 §7；第二轮服务端导入闭环与本地安装存储、第三轮浏览器最小入口与能力上报修正见 §8。仍未完成的是：浏览器对真实云 API 的完整旅程验收（cookie 往返、导入与领取）与云副本阅读器。C3–C9：同步 Outbox/事件 ID/冲突、长历史流式契约（C4）、jobs/attempts/Worker/计量（C5）、额度账本/报价/交付（C6）、支付/订阅/退款/对账（C7）、完整客户端/管理后台/运维（C8）、灰度上线（C9）均未实现。默认组合根未启用对象/导入时，capabilities 的 objects/import 仍为 false。

## 5. 待决策（计划 §24，未默认放行）

首发市场/主体、自动续费资格、定价/份数、体验额度（默认 0）、云空间配额、身份表 PII 静态加密口径，以及真实邮件服务商/发信域名/可达性。IP 计数已跨进程入库，但不采信请求自行传入的转发头；生产网关真实客户端 IP、入口风控和历史限流记录维护仍需部署设计。

C1 本轮通过的是代码与本地隔离验收，不是生产上线验收。真实 SMTP 凭据、公开域名/受信证书、生产数据库与秘密管理、实际邮件送达均未配置或验证，也没有真实邮件/模型/支付调用。完整登录页面、账号隔离阅读库和游客导入不在 C1 内，分别属于 C8/C2。

## 6. 运行方式（开发）

- 云脚本只接受显式注入的 `ENDLESS_CLOUD_*`，不自动读取本机 API `.env`。
- `bootstrap:cloud`：管理员 DSN + AUTH/APP_PASSWORD；`migrate:cloud`：MIGRATION_DSN + 必填 `ENV=development|test|staging|production`。已有环境绑定不允许被改写；当前 API 要求水位 4，须通过受控迁移追加 `0002_c1.sql`、`0003_objects.sql`、`0004_imports.sql`，不原地修改旧迁移。邮件 Worker 仍只依赖 C1 水位。
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
- `apps/web/src/cloud/page.tsx`：账号登录（邮箱 OTP）、设备列表、导入预览/确认、云端工作区与“领取到这台设备”。措辞边界：预览显示“仅预览，未写入云端”，领取后明确写“云库阅读入口尚未接线”“增量同步尚未实现”，不出现“已同步”。能力未开启时按钮直接禁用并说明。
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
