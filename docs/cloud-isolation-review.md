# 云规划质量复核与隔离接入基线

日期：2026-10-27；同日续作完成 I-02–I-04，随后提交为 `7f21427`。核对基点：HEAD `5d63157`（2026-10-28 状态核对时）。本文是当前决策与执行顺序，历史工程证据仍见 `cloud-baseline.md`；桌面主计划保留为产品与 C0–C9 路线。首轮证据见 §6，续作以 §7 为准。

## 1. 结论与质量问题

现有方案可以继续作为云端独立开发的基础。账号、对象与同步已有实际实现；云生成、额度、支付尚未实现。当前已拆开游客/云仓库与阅读 Hook，默认本机与显式云研发构建分别输出并核验运行时模块。共享 workspace、依赖安装、类型检查与展示组件仍保留，这不是两套独立维护的产品，也不表示整个云商业方案完成。

| 优先级 | 复核发现 | 本轮处理／后续门槛 |
| --- | --- | --- |
| P1 | `@endless/content` 主入口曾直接导出云导入、快照重建、目录与正文叶适配，原生内容消费者会经过云协议依赖图 | 本轮改为显式 `@endless/content/cloud` 子入口；本机 API 与桌面服务的传递依赖不得进入云实现 |
| P1 | 仅以目录和 feature flag 表示隔离，无法防止后续反向 import | 本轮增加解析 TypeScript 源码及传递依赖的 `pnpm check:boundaries`，纳入 `pnpm test` |
| P1 | 原 `storage.ts` 和 `use-player.ts` 同时承担游客/云事务与阅读编排 | 续作完成 I-02/I-03：游客入口不依赖云解析，云仓库单独保留原子事务；两套 Hook 由不同 Scope 组件挂载，云阅读头不再断言成完整修订 |
| P1 | 规划的当前状态与历史段落混排；例如 §1.1 的“本机／单设备”描述易被读成整个仓库能力；§25.2 指向旧排期 | 增加当前状态入口、证据优先级和隔离任务；旧实施日志按日期保留 |
| P1 | C4 阅读叶切片原记录只跑内容、Web 与类型检查，尚无本轮完整生产浏览器证据 | 本轮补完整回归并如实记录结果；不据此勾选 C4-05/06/07 或 C3/C4 出口 |
| P1 | 真实 API 旅程复现：云草稿异步加载完成前已能输入，晚到的原稿覆盖用户修改，实际提交并采用了旧稿 | 本轮在读取完成前禁用编辑与提交，读取失败明确展示并拒绝提交；旅程增加预览标题断言 |
| P2 | 云组合根放在 `apps/api`，目前仍共享同一 package 的依赖安装与类型检查 | 接受当前模块化单体；进程／数据隔离成立不等于依赖安装／构建完全隔离。没有证据需要独立 app 时不批量搬目录 |
| P2 | C5 将来若直接 import 本机 `generate.ts`，会间接依赖本机 `jobs.ts` 和错误类型 | 新增云任务前先抽无副作用的生成执行端口。共享提示词与编译器，任务、预算与持久化由各自适配器提供 |

本轮为针对上述边界的代码审阅与回归，不是生产安全审计、容量验收、法律政策审核或供应商接入验收。没有发现并复现的问题不能写成“已修复漏洞”。

## 2. 允许的依赖方向

```text
本机 API／桌面服务 ───────────────→ @endless/content → player／learning／esl
                                           ↑
云 API／Worker → @endless/content/cloud ─────┘
       │                   │
       └─────────→ @endless/cloud-contracts → zod

Web 组合根 → 本机或云适配 → 各自存储／网络端口
```

- `@endless/content`：原生内容、创作规则、完整工作区、学习证据、生成计划时间及独立 Edition 命名空间；不导入云适配、云协议或 `apps/*`。
- `@endless/content/cloud`：导入校验、云历史适配、快照原生重建、阅读目录与叶验证；只向原生核心及纯协议依赖，不持有 HTTP、IDB、数据库、秘密或进程生命周期。
- `@endless/cloud-contracts`：纯网络信封及限额，外部依赖仅 `zod`；不依赖 content、应用、Node 内置模块或云 SDK。财务与账号不能渗入播放器类型。
- `@endless/generation`：v4 创作执行端口（提示词、计量、失败分类、整稿修复循环）；只依赖 content／esl／player，不依赖 director、本机 jobs、HTTP、数据库或进程生命周期。本机与未来云端 Worker 都直接用它，各自在外层实现任务持久化与错误映射。
- `apps/api/src/cloud`：云组合根和服务端适配；不得 import 同 app 中的本机入口、文件任务库、Edition SQLite 或 provider 配置。云配置从专用环境加载，不自动读取本机 `.env`。
- 本机 API／桌面服务不得通过直接 import、barrel、动态 import、类型 import 或包内相对路径进入云目录／cloud-contracts。测试夹具可显式使用双方协议，不是运行时依赖豁免。
- Web 是允许接线双方的应用组合层，显式云 profile 接入双方；默认本机 profile 只接游客 Hook 和本机 API。共享 UI 的 `Player` 联合仅为 type import，运行时图与产物模块另行检查；不能把展示类型联合当作原生核心反向依赖的豁免。

自动检查覆盖八类源依赖图：原有五类，加游客 Web 存储/Hook/写入协调层（含类型）、默认 Web 运行时图、云 Hook 禁止本机 API/仓库/Hook 的图。检查跟随 workspace exports、相对引用、重新导出与字面量动态加载；无法解析的内部路径或非字面量模块加载拒绝通过。只有 Web 运行时检查略过完整的 `import type`/`export type`；原生核心和游客 Hook 检查仍含类型，带内联 `type` 的普通 import 保守计入运行时。内容、播放器及其原生依赖的外部模块使用现有纯库白名单，拒绝引入 `pg`、Node 内置模块或云 SDK。Vite 另外核对实际输出模块，本机产物若包含云实现/契约/适配直接构建失败，模块证据保存为各产物中的 `runtime-modules.json`（仓库相对路径）。这些证据不代替第三方依赖审计、秘密扫描或运行时测试。

## 3. 暂时隔离开发的运行与数据规则

| 维度 | 本机主线 | 云研发线 | 接入要求 |
| --- | --- | --- | --- |
| 启动 | 原 `pnpm dev`（Web 5173）／`preview`（4173）；桌面固定 4175 | `pnpm dev:cloud`（Web 5178、Cloud API 4178）；`worker:cloud` 单独启动，云预览 4183 | 本机启动不连 PostgreSQL、不跑 migration、不启动 Worker |
| 网络 | 本机回环 API、Host/Origin/capability；页面 Key 只到本机提交 | `/api/cloud/v1`、同源 Cookie、Origin/CSRF、拒绝本机 Key | 路由代理不能当身份或授权；未来正式域名由部署组合根注入 |
| 数据 | 游客 `endless-workspace`、独立 Edition IDB、本机 jobs/SQLite | 独立 PG／对象桶；IDB `endless-cloud:<deployment>:<account>:<workspace>` | 不清空、不双写、不自动迁移游客历史；云激活必须显式 |
| 配置／秘密 | 原本机配置和页面内存 Key | `ENDLESS_CLOUD_*` 及独立秘密注入 | 不从实验配置推定云价格，不向浏览器导出服务端配置 |
| 能力 | 本机原有离线阅读与显式续写 | 服务端实际挂载能力；generation/billing/payments/exports 继续关闭 | 未实现能力返回不可用；不以 stub 或 UI 按钮替代服务 |
| 研发环境 | 不要求云库可用 | 可丢弃 PG 与回环 SMTP/S3 夹具 | 可保留同仓库和同锁文件；不要求另建整套项目来实现进程隔离 |

默认 `pnpm build` 输出本机 `apps/web/dist`；显式 `pnpm build:cloud` 输出 `apps/web/dist-cloud`，互不覆盖。默认本机页面没有云入口，旧云深链只说明当前版本范围，不访问云 API 或打开云 IDB；已有云库和未知记录原样保留。云研发版保留现有完整云 UI 与显式领取路径。两个 profile 的 PWA id/scope 不变，因此不得同时部署在同一来源；不据构建 profile 自动迁移账号库、复制 Cookie 或转换本机票据。桌面打包只接受标记为 local 的构建。

## 4. 以后接入依靠端口，不依靠共享可变状态

现有 `CloudApiPort`、`CloudRepository`、`SyncRepository` 和控制器依赖注入继续作为接缝；不要另造一套同义接口。后续接口在有第二个实际消费者时提炼，避免空包和通用仓库框架。

| 接缝 | 输入与输出 | 权威与不可分割点 |
| --- | --- | --- |
| 阅读准备 | 明确的完整 Workspace 或独立 ReadingView → 原生校验后的 session/library | 不通过类型断言把缺正文视图当 Workspace；引用、字节摘要、plannedAt、来源和生成前缀均验证 |
| 玩法提交 | 原生命令 + CAS 版本／读取集 → 新状态及提交回执 | 分支、义务、eventId、Outbox 与阅读目录必须在同一 IDB 事务；不能拆成多个仓库先后写 |
| 同步／恢复 | 稳定 commandId/batchId + 原始前置条件 → 可验证不可变回执 | 网络在事务外；完整读取集比较后原子提交；未知结果沿用原请求，拒绝清队列或自动换账号重放 |
| 生成执行（C5 前置） | 已验证冻结前缀 + plannedAt + 显式预算／attempt 端口 → 保存结果或安全失败 | 原生创作规则共享；本机 jobs 与云持久任务分别实现；未知外部调用不重放 |
| 支付／额度（C6/C7） | 固定商品／报价版本、渠道事实及业务幂等 ID | 支付事实、额度和 provider 成本各自记账；只由云服务端结算，不写入阅读内容契约 |
| Edition | 独立模式契约及适配器 | 不复用 ENDLESS 事件/修订/义务；只按已批准设计共享基础设施 |

网络端口只接受协议类型；SDK client、HTTP Request/Response、PG transaction、IDB transaction、React setter 不进入内容核心。原生规则只有一份；云适配不得复制或放宽创作、证据、来源与重放校验。

## 5. 接下来按这个顺序优化

| 编号 | 工作及范围 | 退出证据 |
| --- | --- | --- |
| I-01 | 核心与云子入口拆分，迁移全部仓库消费者，补自动依赖检查 | 本轮实施；检查、类型、原有内容与云测试均通过 |
| I-02 | 已拆：`storage.ts` 游客适配与 `cloud/repository.ts` 云适配，共享 `storage/{database,records,commit-policy}.ts` | 共用原生 CAS/票据规则仍在各自事务内执行；游客不解析 sidecar，遇到未知附加行拒绝且保留；云业务/身份/Outbox/目录仍在同事务 |
| I-03 | 已拆：`use-player.ts` 与 `cloud/use-player.ts`，不同 Scope 组件在命名空间改变时重建 | 游客 Hook 依赖图包含类型也不进入云；云 Hook 不 import 本机 API 或游客仓库；ReadingRuntime 只表达实际已验证的阅读数据，不伪造完整 save |
| I-04 | 已拆：默认 local 与显式 cloud 构建/预览/测试目录，实际模块守卫 | 本机构建拒绝云运行模块；本机深链不打开云库；云构建必须在模块证据中包含实际客户端、仓库与 Hook；PWA id/scope 保持 |
| I-05 | 已做（2026-10-28）：`@endless/generation` 承接 v4 执行端口，本机只留适配器；C6/C7 再按此接额度与渠道 | 提示词字节 golden 2 项、冻结计划时间与 attempt 记录、传输失败不重试、失败分类不含 HTTP 语义；端口只认结构 LLM 接口，不 import director/本机 jobs。没有真实调用，不声称 provider 已验收 |

I-02–I-04 的代码和证据属于 2026-10-27 同日续作，已随 `7f21427` 提交并推送；I-05 于 2026-10-28 落地为 `@endless/generation`，证据见 `cloud-baseline.md` §10.10。两者都不是凭 I-01 推定完成。当前不新增 `apps/cloud-api`／支付空包，不搬迁历史数据，也不改变已有持久化协议或 schema 水位。I-05 只抽执行端口，不顺带实现云生成、账本或支付。

接入放行同时要求：依赖方向检查、现有测试、生产 PWA 本机离线路径、实际云 API 双设备路径，以及新接缝的故障回滚证据。任何一个失败，保留原件和当前回执，修复后复核；通过关闭云写入停止影响，不删除 IDB、回退数据库历史或释放未知任务来“回滚”。独立发布和正式能力开放仍分别受 C0–C9 出口约束。

## 6. 首轮质量复核与 I-01 验证（历史记录）

本轮代码调整模块入口、共享生成计划逻辑的位置、消费者 import 与自动依赖检查，另修复实际复现的云草稿异步覆盖；开始本轮时已有的阅读切片修改保留。旧协议桩浏览器测试的直接 IDB 种子补入原生阅读目录，使其符合当前安装形态；没有放宽缺目录时的拒绝行为或业务断言。下表为本轮最终验证，失败试跑不计为通过。

| 验证 | 本轮结果与边界 |
| --- | --- |
| `pnpm check:boundaries` | 2 个检查器用例及五类源码依赖图通过；覆盖传递反向引用、子入口、深路径、循环、动态加载、未导出入口与服务端依赖注入 |
| `pnpm test` | 全仓通过，包含实际 PostgreSQL 的 API 264 项、Web 183 项；云草稿 UI 修复后单独重跑 Web 183 项通过。没有把前一次旧白名单导致的失败计为通过 |
| `pnpm typecheck` | 全 workspace 及独立真实 API 浏览器 harness 通过 |
| `pnpm build` | 通过；真实 API 旅程的公开命令再次构建通过，PWA manifest/SW 生成，主包 1,278.20 kB；既有大 chunk 警告仍存在，不据此声称构建已完全隔离或性能达标 |
| 生产浏览器回归 | 草稿 UI 修复后的最终生产包完整 54 项通过；`PLAYWRIGHT_PORT=43266 pnpm -C apps/web exec playwright test --output ../../out/isolation-e2e-20261027-final`（PowerShell 以环境变量单独赋值），独立输出目录，未放宽业务断言 |
| `pnpm -C apps/api test:cloud:browser` | 修复后公开命令 2 条真实 API + PostgreSQL 双设备旅程通过，包含已读修订丢响应恢复、预览新标题、原完成义务时间、归档、裁剪快照、新设备与账号隔离 |
| `git diff --check` | 通过；既有 CRLF/LF 提示不是验证错误 |

初次浏览器回归 46 过/8 失败来自直接 IDB 种子缺目录；修复后受影响 14 项及完整 54 项通过。首次真实旅程 2 项失败复现草稿覆盖，诊断试跑不计成功；修复后两条公开命令旅程均通过。只使用临时真实 PG 和回环 HTTPS/SMTP/S3 夹具，没有真实模型、邮件/存储供应商、支付或公网部署；本轮未重新打包桌面 exe。没有新迁移，API 水位 15、邮件 Worker 2，capabilities 和 C3/C4 出口不因本轮通过而放宽。

## 7. I-02–I-04 续作结果（2026-10-27，已提交 `7f21427`）

游客 `WorkspaceRepository` 只能打开 `endless-workspace`；`CloudWorkspaceRepository` 在打开 IDB 前验证云命名空间。两者共用 IDB v2 连接、原生行拆装和 CAS/票据校验；同步选项移入 `CloudCommitOptions`，原生 `SessionCommitter` 通过泛型接受各自选项，不依赖云契约。云事务逻辑保留在云适配内，未改成保存后再写 Outbox。游客提交只计数旧 v2 保留 store，发现非空附加记录便拒绝，不解析或删除其正文。首次提交遇到残存正文而缺 meta 也拒绝，防止初始化覆盖残件。

本机 Hook 保留本机 Key、生成票据、API 轮询、原生阅读及管理；云 Hook 只处理已安装副本的阅读/同步/管理，不导入本机 API 或游客仓库，也不持有页面 Key。路由组合根使用不同 Scope 组件，换命名空间时重建，避免在同一个 Hook 实例里切换模式。共享 UI 的 `Player` 联合只包含 type import；云阅读返回实际 ReadingRuntime，不再将修订头断言为 AnyRevision 或构造空 generated 的完整 save。下载工具独立于两种仓库。

| 用途 | 命令／位置 | 实际边界 |
| --- | --- | --- |
| 默认本机开发 | `pnpm dev` | Web 5173 + 本机 API 4174，不启动云服务 |
| 默认本机生产构建/预览 | `pnpm build`；`pnpm preview` | `apps/web/dist`，Web 4173；模块守卫拒绝云实现/协议/适配；没有云 API 代理 |
| 显式云研发 | 配好独立 `ENDLESS_CLOUD_*` 后 `pnpm dev:cloud` | Web 5178 + Cloud API 4178；邮件 Worker 单独启动；不会自动启用对象、导入或同步能力 |
| 显式云生产构建/预览 | `pnpm build:cloud`；`pnpm -C apps/web preview:cloud` | `apps/web/dist-cloud`，预览 4183；云路由仍由原 Host/Origin/会话/能力规则保护；本机 API 不随这个预览命令启动 |
| 常规生产浏览器回归 | 本机构建后 `pnpm test:e2e` | 先构建 cloud，再分别测试 cloud 与 local 产物；不同预览进程，不复用已有服务器 |
| 实际云 API 验收 | `pnpm -C apps/api test:cloud:browser` | 公开命令构建 cloud，harness 核对 profile 后只取 `dist-cloud` 的固定字节快照 |
| 桌面构建 | `pnpm desktop:build` | `apps/desktop/build.mjs` 拒绝非 local 的 Web 构建；没有新增云凭据或迁移 |

两种输出目录互不覆盖；不允许在同一来源同时部署两个 profile。保留现有 PWA id、scope、SW 更新与安装语义；不自动切换旧安装的数据来源，不复制账号库或迁移用户数据。默认本机访问旧云深链只显示当前版本说明，不请求云 API、不打开云 IDB。共享源码类型检查、依赖安装、原生规则和展示组件仍然存在；隔离证据针对运行依赖、进程、命名空间与构建产物，不声称两套独立仓库或生产部署已经完成。

| 本轮验证 | 结果 |
| --- | --- |
| `pnpm test` | 全仓通过，包括 Web 186 项、API 264 项与实际 PG 同步；原票据/Outbox/CAS/恢复断言保留 |
| 新存储保护 | 3 项通过：错误命名空间在打开前拒绝；未知附加记录不解析、不删、不推进版本；缺 meta 残件不被初始化覆盖 |
| `pnpm check:boundaries` | 2 个检查器用例、8 类依赖图通过；原生 Hook 包含类型也不依赖云，UI 运行时与实际构建分别核验 |
| `pnpm typecheck`、`pnpm build` | 全仓类型及默认本机生产构建通过；另公开真实 API 命令内的 `build:cloud` 通过 |
| 本机生产浏览器 | 40 项通过；`PLAYWRIGHT_LOCAL_PORT=43273`，`out/isolation-local-20261027-1`；涵盖本机生成/Key、阅读、离线冷刷新、Edition，以及旧云深链不请求/不打开云库 |
| 云研发生产浏览器 | 56 项通过；`PLAYWRIGHT_PORT=43272`，`out/isolation-cloud-20261027-1`；保留完整云协议桩旅程，并核对产物包含实际组合根/仓库/客户端/Hook |
| 实际 API + PG | 2 条双设备完整旅程通过，显式 cloud 构建；原生已读义务、修订丢响应、归档、快照恢复和账号隔离不变 |
| 桌面 | `pnpm -C apps/desktop build` 通过，仅构建运行目录；未打包、启动或冒充已安装/签名版本 |

本机主包 1,104.62 kB，cloud 主包 1,282.41 kB；两者 PWA/SW 生成，既有大 chunk 警告仍在，数字不是目标设备性能结论。拆分中先后发现类型配置问题和 2 个合成存储错误文案回归，均修正后再跑完整单测；没有放宽事务回滚或恢复断言。没有新依赖、迁移、真实模型/供应商/支付/生产云操作，已提交并推送为 `7f21427`。I-05 与 C4 剩余工程/性能、Edition 云同步、C3/C4 总出口和 C5–C9 继续开放。
