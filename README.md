# ENDLESS · 实验 0（离线导演循环）实现

## 应用（PWA + 本机生成 API）

本仓库同时承载一个可玩的本地应用：三个预置鸭侦探剧集 + AI 创作续写。

```bash
pnpm install
pnpm dev        # web 5173 + 本机 AI API 4174（仅回环）
pnpm test       # 全部单元测试
pnpm build && pnpm preview   # 生产预览 4173 + API 4174（离线/PWA 用 preview 验证）
pnpm test:e2e  # 构建云研发版并测试两个生产 profile；先完成上面的本机构建
```

默认 Web/桌面使用本机版本（`apps/web/dist`），不打包云客户端、账号协议、同步仓库或控制器，也不代理云 API。云研发需显式运行 `pnpm dev:cloud`（Web 5178、Cloud API 4178，先配置独立云环境）；邮件 Worker 仍单独启动。`pnpm build:cloud` 写入 `apps/web/dist-cloud`，`pnpm -C apps/web preview:cloud` 在 4183 预览。两种 profile 不应同时部署到同一来源，现有 PWA id/scope 和存档协议保持原义。隔离边界与验证见 [云隔离基线](docs/cloud-isolation-review.md)。云生成与付费仍未开放。

- AI 不再输出可执行 JSON：应用生成使用 ENDLESS-DRAFT/1 紧凑创作草稿（learningVersion 4）——模型只写形态、系列与组件正文，程序编译、校验并保存。
- 四个内容形态（story / daily / social / knowledge）与八个系列（鸭侦探事务所、不可能商店、暖心烘焙坊、海港旧驿站、日常一刻、花房小记、小小留言板、表达小窗口）；组件自由组合，没有固定开场/词卡/收尾套路或题型配额。
- 视觉素材为本作原创矢量小插画（12 角色 / 12 背景 / 40 道具，绿与奶油色语言，全部离线打包）；知识方向仅取本地词库的词义与例句，并在界面标注来源。不生成任意 UI 代码或音频。
- 存档是 `endless-workspace`（内容条目 / 修订 / 进度分支 / 归档卷 / 检查点 / 生成任务）。旧的 `endless-player` 1–2 版存档不迁移、不读取，读到会明确报格式不支持并原样保留；三集试播作为新工作区的初始内容随包提供。生成仍是手动触发、不自动连播；不设调用/额度上限，连续相同失败即停。失败保留安全原因。工作流与安全边界见 AGENTS.md。

## 实验 0（研究底座，已被应用沿用）

ENDLESS 是「无尽内容流」形态的 AI 原生英语学习产品构想。本仓库是
[实验 0 方案](docs/experiments/exp-00-director-loop.md)（离线导演循环）的实现：
验证「AI 导演能否持续产出好看、一致、学习任务真实被执行的节目」，不写任何界面。

**建设状态**（对应方案第 8 节时间表的 Day 1–7）：✅ 完成。

- pnpm monorepo：四个纯 TS 核心包 + 实验 CLI（Day 0 脚手架）
- 词库 / 频道圣经 / 素材 / 谓词 / 梗分类 / 故事筛选 / 提示词 / 配置 全部落地并通过格式校验（Day 1–2）
- ESL v0：Zod 规范模型、YAML/JSON 双表层、17 种阻断码 + 12 种建议级码校验器、ink 子集编译与路径穷举、Runtime AST（Day 2–3，正反例测试全过）
- 世界状态：双时态事实表、reducer（单值谓词自动失效、canon 拒写、选项 effect 门控）、检索打分、故事筛选（Day 4）
- 学习系统：词库加载、ts-fsrs 封装（三档评分）、BKT 能力估计、规划器 R1–R7、证据策略 S-A/S-B/S-C（Day 5）
- 导演：上下文组装器（分块 token 预算）、梗台账、两段式/单段编排、修复循环、LLM 接入（AI SDK）+ 请求哈希缓存 + Stub 模式（Day 6）
- 实验 CLI：run / render / patch / metrics / replay / judge / review / srs-sim / buffer-sim / check / smoke / assert / freeze；学习者模拟器三画像；缓冲模拟；Critic 程序指标；5 批端到端冒烟通过（Day 7）
- 提示词冻结纪律落地：`lab freeze` 写 `data/prompts/FROZEN`，`lab check` 与 `lab run` 检测漂移（Day 8）
- 真实模型接入跑通：`MiniMax-M3.1-Flash` 两段式；20 批真实冒烟 v10/v11/v12 各一次（19/20、17/20、18/20，V2 合计 54/60 = 90%，阈值 97% 未达标），**模型原始首轮合规率从 0/20 提到 3/20**（V0），数据与失败清单见 [结果文档](docs/experiments/exp-00-results.md)（Day 8）
- 机械修正层 `autoFixBatch`：校验前先修五类「声明与实际不符」（`uses` 不在文本、无人引用的 `effect`、曝光不足就检测、角色属性越界、装饰位素材不存在），每次修正都打 `[autofix]` 日志；20k 触发 44 次、20l 33 次、20m 36 次、20n 38 次、20o 38 次（Day 8）
- **审计后完善（2026-10-23）**：把「世界状态层在真实产出上空转」「L1/L2 的 100% 是空心」两处结构性缺口补成显式读数 ——
  `world_change` 进编剧室方案并进预检、`W-NO-WORLD-CHANGE` / `W-NO-DETECTION` 两个建议级码、`metrics` 单列零 effect / 零检测批次占比、
  L1/L2 分母为 0 时输出「不可判定」而不是 1.0；补三个缺失工具：S-R 真实产出回放（`srs-sim --run-dir`）、
  L4 歧义率程序口径、人工评分聚合（`lab review`：Spearman ρ / Krippendorff α）；`buffer-sim --from-run` 改用实测时延分布。详见 [审计修复记录](docs/experiments/exp-00-audit-fixes.md)
- promptfoo 回归矩阵：2 模型 × 5 条样例，单次生成合规率 8/10（提示词 v12 重跑，见结果文档 §4.4；首轮 1/10 的根因是规范示例自身把 3 选项写成了 `recognition-4`），适配层两个坑（`reasoning_effort` 不透传、思考被内联进 `content`）已固化进自定义 provider；`render-vars.ts` 是矩阵变量的唯一来源（Day 8）

## 快速开始

```bash
pnpm install
pnpm test            # 全部 271 个测试（esl 99 / world 12 / learning 18 / director 43 / lab 99）
pnpm lab check       # 校验全部数据文件 + 提示词冻结漂移（Day 1–2 完成标志）
pnpm lab smoke       # Stub 导演 5 批端到端冒烟（无需 API key）
pnpm lab freeze      # 冻结当前提示词（默认 v1，之后版本自动递增）
pnpm lab srs-sim     # 证据策略对照 S-A/S-B/S-C（合成事件流，不调 LLM，产出 L6/L7 报告）
pnpm lab srs-sim --run-dir apps/lab/runs/<run_id>    # S-R 回放：在真实产出上重放三种策略
pnpm lab buffer-sim --from-run apps/lab/runs/<run_id> # K4 用实测时延分布（不传则退回 20s 假设值）
pnpm lab review --template --batches 60  # 导出人工评分表模板；填完用 --ratings 汇总 α/ρ
pnpm lab render apps/lab/runs/smoke/batches/0001.esl.yaml   # 渲染一个批次为 Markdown
```

真实跑批（R0–R5，需要 API key，只从环境变量读取）：

```bash
# 1. 在 apps/lab/config/models.yaml 配置供应商与模型（base_url + 环境变量名）
# 2. 在 apps/lab/config/prices.yaml 填单价（未填时 K2 显示「单价未配置」，判为不可判定）
# 3. 准备运行配置（模板：apps/lab/config/run-example.yaml；真实冒烟：run-smoke20o.yaml = 20 批 v12 + 143 条词库）
$env:ENDLESS_API_KEY = "..."        # 变量名以 models.yaml 的 api_key_env 为准
pnpm lab freeze                     # 跑批前先冻结提示词，否则 run 会记录哈希并警告
# run_id 只从配置文件读（CLI 没有 --run-id 覆盖）。同一 run_id 换提示词或换数据会被 C2 指纹检查拒绝，
# 所以新版本要复制一份配置改 run_id：run-smoke20o.yaml 的 run_id 是 smoke-real-20o（v12 时期），
# 现在提示词已是 v16，直接跑它会红。
cp apps/lab/config/run-smoke20o.yaml apps/lab/config/run-smoke20p.yaml   # 改 run_id 为 smoke-real-20p
pnpm lab run --config apps/lab/config/run-smoke20p.yaml
pnpm lab judge  apps/lab/runs/<run_id>    # LLM 评审（先校准，见方案 5.12）
```

> `metrics.json` / `report.md` 由 `lab run` 在结束的同一进程里算出，与当次运行必然一致。
> `lab metrics <run_id>` **优先读 `artifacts/metrics-input.json` 离线重算**（records / briefs / feedbacks / 台账 / 伏笔卫生快照全在盘上），
> 代码改过也能复算；只有旧运行（没有该产物）才退回「重放流水线读响应缓存」，那种情况下请求哈希不匹配就会全部未命中（CLI 会拒绝覆盖已有的 `metrics.json`）。

`lab run` 会在 `runs/<run_id>/` 写 `config.yaml`（本次参数）、`prompts.json`（提示词哈希与冻结版本）、
`calls.jsonl`（每次 LLM 调用的阶段、token、时延）与 `cache/`（按请求哈希存原始响应，可回放）。
提示词与 `FROZEN` 不一致时 `lab run` 直接拒绝执行：改提示词必须先 `lab freeze` 出新版本并换新 `run_id`。

## 目录结构

```
packages/            # 纯 TypeScript，不依赖 Node 专有 API（PWA/RN 直接复用）
  esl/               # ESL v0：规范模型、解析、校验（阻断/建议两级）、ink 编译、Runtime AST
  world/             # 世界状态：DDL、存储接口（内存实现）、reducer、检索、故事筛选
  learning/          # 词库、ts-fsrs 封装、BKT、规划器（R1–R7）、证据策略
  director/          # 上下文组装器、梗台账、两段式导演、修复循环、LLM 接入与缓存、Stub
apps/lab/            # 实验 CLI（tsx + vitest + node:sqlite）
  data/              # 词库 / 频道圣经 / 素材清单 / 角色规格 / 谓词 / 梗 / 筛选 / 提示词
  config/            # models / prices / budget / 运行配置模板
  promptfoo/         # 提示词回归矩阵骨架（Day 8）
  runs/              # 运行产物（git 忽略）
docs/                # 实验方案与开源调研（唯一的规范来源）
```

## 与方案的建设性偏差（诚实记录）

| 方案 | 实现现状 | 说明 |
|---|---|---|
| 词库约 300 条（220 词义/50 词块/30 句型） | 143 条（106/22/15）+ 格式校验全过 | 第一版只有 62 条，之后按 20k–20n 的 411 个 OOV 生词逐批补（见结果文档 §4.6）；扩表是内容工作（CEFR-J 底表 + compromise 生成 forms + 人工复核），流程已在方案 Day 1–2 定义；`lab check` 保证增量合规 |
| 表结构「最终用 Drizzle 定义」 | DDL 与方案 SQL 一致，驱动经 `WorldStore` 接口注入 | Drizzle schema 留到 app 阶段（PWA/RN 驱动接入时一次定义三端共用），实验不受影响 |
| Fluent Emoji Flat 约 600 个 | 种子版 86 个（含字形与标签）+ 6 个背景位置表 | 从 fluentui-emoji 元数据批量生成在 oss-reuse 待核实项 1 完成后进行 |
| N1 的 MiniLM 句向量对照 | tfidf 版 N1 已实现 | transformers.js 属重依赖，对照版留到试跑阶段按需接入 |
| promptfoo 回归矩阵（Day 8） | 配置 + 断言脚本就绪（`promptfoo/esl-assert.js` 直接把模型输出交给 `lab assert`）；矩阵从 2 模型 × 5 批样例起 | 完整「每格 20 批」要真实调用量与 API 预算；配置里的 `prompts`/`tests` 是扩表入口，不改代码 |
| 频道调度权重动态调整 | 初始权重 × 新近度 × 伏笔压力，兴趣信号已入反馈包 | 兴趣→权重的完整闭环在试跑期标定 |

## 下一步（Day 8 起）

1. ~~填 `config/models.yaml`，冒烟 20 批真实生成~~（已做：20d–20o，见结果文档 §4.2）；`prices.yaml` 单价待供应商提供，K2 暂不可判定
2. ~~promptfoo 小矩阵~~（已做，v12 重跑 8/10，见 §4.4）；扩表入口在 `promptfoo/promptfooconfig.yaml`，变量由 `promptfoo/render-vars.ts` 生成
3. 跑 R0–R5（6 条 × 3 画像 × 60 批），S-R 回放——配置已就位，等 API 预算（约 17–26 小时）；R6 已删，见结果文档 §7 第 8 条
4. Critic：程序指标 + LLM 评审 + 评审校准；人工盲评与连续阅读（第 7.4 节）
5. ~~按第 9 节判定标准写结果文档~~（骨架与试跑数据已填，正式判定待 R0–R5）

## 当前已知短板

- **V2 90%（v10+v11+v12 合计 54/60），离 97% 阈值差 1–2 批**，且 n=20 上分不清版本差异（同一配置两次采样 20/20 vs 17/20）。
- **剩余失败都是「模型编名字」**：不存在的素材标签、词库条目 id、物体位置冲突。提示词教不动；列反例反而会把非法名字喂给模型（结果文档 §5 第 11 条）。20o 已经验证过这一点：把 `@tag:apartment` 从提示词里删掉之后，模型照样写出了它。**解码期约束这条路已经证伪**：这个端点的 `response_format`（含 `json_schema` + `strict`）静默失效，非法值照样输出，见结果文档 §7 第 9 条。
- **L3 OOV 中位 9.7%（20 批，修正口径）/ 9.8%（6 批探针；方案阈值 8%，已按偏差 #6 放宽并在配置里记录），瓶颈是能力门与写手对允许词表的遵守度，不是词库长度**：词库从 62 条扩到 143 条几乎没动中位数（13.5% → 约 10%，含口径修正），逐词回查见结果文档 §4.6。
- **`prices.yaml` 空**：K2 成本项不可判定。
- **思考关不掉**：`MiniMax-M3.1-Flash` 拒绝 `thinking.type=disabled`（HTTP 400），所以本实验只用这一个型号，由解析层的 `stripThinking()` 容忍内联思考（结果文档 §4.1）。**R6（编剧室高档）已从正式矩阵删除**：高档与快速档同型号，跑 R6 只会得到 R5 的复制品（结果文档 §7 第 8 条）。
- **只跑过 20 批单样本**；三画像（P1/P2/P3）与 R0–R5 全量都还没跑。
- **「重写是净收益还是净损失」只有 40 批的答案**：20o 首次出现「改坏 0」（首版带阻塞错误 7 批 → 救回 5 / 丢掉 2 / 改坏 0；`fd-probe6` 2/2/0、`lex6` 5/4/1、`lex6b` 1/0/1），丢掉的两批都是重写也修不了的名字错误，要等 60 批才有统计意义。
