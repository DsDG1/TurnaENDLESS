# 实验 0 结果：离线导演循环

> 状态：**骨架（Day 8 试跑进行中）**。本文件按《实验 0 方案》第 9 节的判定标准组织；
> 标「待填」的格子会在对应运行结束后从 `runs/<run_id>/metrics.json` 与 `report.md` 抄入。
> 冻结纪律（方案第 8 节）：提示词当前版本见 `apps/lab/data/prompts/FROZEN`；任何提示词改动都要新版本 + 新 `run_id`。

## 1. 结论摘要

待 R0–R6 与人工评审完成后填写。格式：

- **判定**：进入 MVP / 调整方向 / 停止（三选一，定义见方案 9.2）
- **支撑证据**：最佳运行为 ___，达标 ___ 项 / 共 10 项；不达标项及调整方向见 §5
- **一句话结论**：___

## 2. 运行清单

### 2.1 内容运行（方案 7.1）

| 运行 | 导演 | 世界状态 | 梗台账 | 编码 | derive | 模型 | 批次 × 画像 | 状态 |
|---|---|---|---|---|---|---|---|---|
| R0 | 单段 | 无 | 无 | YAML | 关 | 快速档 | 60 × 3 | 待跑 |
| R1 | 单段 | 有 | 无 | YAML | 关 | 快速档 | 60 × 3 | 待跑 |
| R2 | 两段 | 有 | 无 | YAML | 关 | 快速档 | 60 × 3 | 待跑 |
| R3 | 两段 | 有 | 有 | YAML | 关 | 快速档 | 60 × 3 | 待跑 |
| R4 | 两段 | 有 | 有 | JSON | 关 | 快速档 | 60 × 3 | 待跑 |
| R5 | 两段 | 有 | 有 | R3/R4 胜者 | 开 | 快速档 | 60 × 3 | 待跑 |
| R6 | 两段 | 有 | 有 | 同 R5 | 开 | 编剧室高档 | 60 × 3 | 待跑 |

### 2.2 证据策略运行（不调 LLM，方案 7.2）

| 运行 | 策略 | 状态 | 结果位置 |
|---|---|---|---|
| S-A / S-B / S-C | 合成事件流 300 条目 × 60 日 × 3 画像 × 5 种子 | 已跑 | `pnpm lab srs-sim` 报告 |
| S-R | 在 R5 真实产出上回放三种策略 | 待 R5 完成 | — |

### 2.3 试跑（Day 8）

| 运行 | 用途 | 批次 | 配置 | 结果 |
|---|---|---|---|---|
| `smoke-real-01` | 真实模型连通性探针（单批跑通后即删产物重跑） | 1 | `config/run-smoke1.yaml` | 1/1 批通过，4 卡，3 次调用；提示词 v4 |
| `smoke-real-20d` | 真实模型生成冒烟（提示词 v7） | 20 | `config/run-smoke20.yaml` | 14/20 批通过，52 卡，78 次调用（§4.2） |
| `smoke-real-20e` | 同上，提示词 v8（生成后自检 + 批次级重写） | 20 | `config/run-smoke20e.yaml` | 15/20 批通过，52 卡，76 次调用（§4.2） |
| `smoke-real-20f` | v8 + `autoFixBatch`（机械修正错误声明） | 20 | `config/run-smoke20f.yaml` | 18/20 批通过，65 卡，72 次调用（§4.2） |
| `smoke-real-20g` | v8 + autofix + 分阶段输出上限修复后复跑 | 20 | `config/run-smoke20g.yaml` | 见 §4.2 |
| promptfoo 矩阵 | 2 模型 × 5 条样例，单次生成合规率（无修复循环） | 10 格 | `promptfoo/promptfooconfig.yaml` | 3/10 通过（§4.4） |

## 3. 阈值对照（方案 9.1）

| 指标 | 阈值 | R0 | R1 | R2 | R3 | R4 | R5 | R6 | 判定 |
|---|---|---|---|---|---|---|---|---|---|
| V2 修复后通过率 | ≥ 97% | 待填 | | | | | | | |
| C1 矛盾率 | ≤ 2% | 待填 | | | | | | | |
| L1 brief 覆盖率 | ≥ 90% | 待填 | | | | | | | |
| L4 歧义率 | ≤ 3% | 待填 | | | | | | | |
| 人工「想看下一张」（41–60 批） | ≥ 3.5 | 待填 | | | | | | | |
| N5 疲劳差 | ≥ −0.5 | 待填 | | | | | | | |
| N2 梗复用率（21–60 批） | ≤ 20% | 待填 | | | | | | | |
| L5 习题感 | ≤ 2.5 | 待填 | | | | | | | |
| K4 卡顿概率（P1，缓冲 2 批） | ≤ 5% | 待填 | | | | | | | |
| K2 每 100 张卡成本 | ≤ `config/budget.yaml`（0.5 美元） | 待填 | | | | | | | |

> K2 依赖 `config/prices.yaml` 的单价。单价未填时 `lab metrics` 会输出「单价未配置」并把该行判为不可判定（不算达标，也不算不达标）。

## 4. 试跑观察（Day 8）

### 4.1 供应商与模型

- 供应商：OpenAI 兼容端点 `https://api.minimax.cn/v1`（写在 `config/models.yaml`）；key 只从环境变量 `ENDLESS_API_KEY` 读取，不写入任何运行文件。
- 快速档 `MiniMax-M3.1-Flash` / 高档 `MiniMax-M3`。该系列是推理模型：响应用 `reasoning_tokens` 单列思考量，**思考也计入 `max_tokens`**。
- `models.yaml` 因此显式设 `reasoning_effort: low` 与 `timeout_ms: 300000`。同一提示词下，`low` 把思考 token 从约 330 降到约 115（单次探针）；不提速时单次调用可到 80–100 秒。

### 4.2 真实生成冒烟

**20 批冒烟 `smoke-real-20d`（提示词 v7）**

| 指标 | 值 | 方案阈值 | 判定 |
|---|---|---|---|
| 批次数 / 卡数 | 20 批 / 52 卡 | — | — |
| V1 首轮通过率 | 25.0% | — | — |
| V2 修复后通过率 | **70.0%**（14/20） | ≥ 97% | ❌ |
| V3 平均修复轮数 | 1.10 | — | — |
| V4 场景丢弃率 | 1.9% | — | — |
| L1 brief 覆盖率 | 100% | ≥ 90% | ✅（样本小） |
| L2 合格证据占比 | 83.3% | — | — |
| L3 OOV 中位 / P95 | 16.8% / 24.4% | — | 阈值已放宽（偏差 #6） |
| C1 矛盾率（程序部分） | 0.0%（103 次事实引用） | ≤ 2% | ✅（程序部分） |
| N4 distinct-2 | 0.72 / 0.81 | — | — |
| K1 每批 token | 输入 6 895 / 输出 3 083 | — | — |
| K3 批时延 P50 / P95 | 56.0s / 108.2s | H7 待算 | — |
| K2 每 100 卡成本 | 不可判定 | ≤ $0.5 | — |
| LLM 调用总数 | 78 次 | — | — |

失败批次的 6 条原因（每批只差一项，说明约束之间是「并联」而不是「串联」的）：

| 批次 | 阻断原因 |
|---|---|
| 2 | comic 一格 3 个气泡（schema 上限 2） |
| 5 | 新条目 `lx:close#v.shut` 曝光 0 次就被检测 |
| 6 | 具名 effect 声明后无人引用 |
| 7 | 同一批同时有 OOV 与 brief 覆盖缺口 |
| 12 | pick 缺 `feedback` |
| 18 | chat 声明 evidence 但没有 reply |

> 这 6 条里有 4 条是 v7 之前就存在的模式，v7 的解析重写只救回了一部分；它们更适合用「生成后自检」而不是继续加提示词规则来解决——见 §7 后续工作。

**20 批冒烟 `smoke-real-20e`（提示词 v8，生成后自检 + 批次级重写）**

| 指标 | 值 | 方案阈值 | 判定 |
|---|---|---|---|
| 批次数 / 卡数 | 20 批 / 52 卡 | — | — |
| V1 首轮通过率 | 20.0% | — | — |
| V2 修复后通过率 | **75.0%**（15/20） | ≥ 97% | ❌ |
| V3 平均修复轮数 | 1.25 | — | — |
| V4 场景丢弃率 | 3.8% | — | — |
| L3 OOV 中位 / P95 | 14.3% / 22.2% | — | 阈值已放宽（偏差 #6） |
| N3 台词语义重复率 | 6.7% | — | — |
| K1 每批 token | 输入 7 152 / 输出 2 956 | — | — |
| K3 批时延 P50 / P95 | 52.9s / 111.7s | — | — |
| K5 缓存命中占比 | 0.68 | — | — |
| LLM 调用总数 | 76 次 | — | — |

v8 把批次级问题从「整批放弃」改成「整批重写一次」，但 20e 仍有 5 批失败，而且失败原因高度集中——三类**机械可判**的问题：

| 批次 | 阻断原因 |
|---|---|
| 3 | `E-USES-NOT-FOUND@s2` + `E-NEW-TESTED-EARLY` |
| 7 | `E-EFFECT-INVALID@s4` + `E-NEW-TESTED-EARLY` |
| 11 | `E-EFFECT-INVALID@s3` |
| 12 | `E-ENTITY-UNKNOWN@s1:messages[0]` + `E-NEW-TESTED-EARLY` |
| 20 | `E-NEW-TESTED-EARLY` + `W-OOV` + `W-CAST-OVERUSE` |

这 5 批的共同点是：**错误本身是「声明与实际不符」，不需要模型重新创作，删掉错误声明即可**。于是加了 `autoFixBatch`（`packages/esl/src/autofix.ts`）：在校验前做三件纯机械的事——(1) 去掉 `uses` 里在该场文本中根本没出现的条目；(2) 删掉没有任何选项/ink 标签引用的具名 `effect`；(3) 新条目累计曝光不足 2 次时去掉它的 `evidence`（只曝光不检测）。每条修正都会打一行 `[autofix] …` 到 stderr，运行结束后可核对。

**20 批冒烟 `smoke-real-20f`（提示词 v8 + autofix）**

| 指标 | 值 | 方案阈值 | 判定 |
|---|---|---|---|
| 批次数 / 卡数 | 20 批 / 65 卡 | — | — |
| V1 首轮通过率 | 20.0% | — | — |
| V2 修复后通过率 | **90.0%**（18/20） | ≥ 97% | ❌ |
| V3 平均修复轮数 | 0.95 | — | — |
| V4 场景丢弃率 | 1.5% | — | — |
| L1 brief 覆盖率 | 100% | ≥ 90% | ✅（样本小） |
| L3 OOV 中位 / P95 | 15.4% / 23.1% | — | 阈值已放宽（偏差 #6） |
| C1 矛盾率（程序部分） | 0.0%（139 次事实引用） | ≤ 2% | ✅（程序部分） |
| N1 目标词复现曲线 | 1.00 → 0.64 | — | — |
| N3 台词语义重复率 | 0.0% | — | — |
| N4 distinct-2 | 0.73 / 0.74 | — | — |
| K1 每批 token | 输入 9 349 / 输出 3 880 | — | — |
| K1 每卡 token | 输入 2 877 / 输出 1 194 | — | — |
| K3 批时延 P50 / P95 | 51.5s / 122.5s | — | — |
| K5 缓存命中占比 | 0.90 | — | — |
| LLM 调用总数 | 72 次 | — | — |

V2 从 75% → 90%，卡数 52 → 65（同样的 20 批，autofix 救回的批次不再被丢弃），V3 修复轮数 1.25 → 0.95，N3 台词语义重复 6.7% → 0.0%。

**这不是一次受控 A/B**：autofix 删掉错误声明后，`repair.md` 里嵌入的批次文本变了 → 请求哈希变 → 缓存失效（20f 只命中 2 次缓存），20f 实际上是 v8+autofix 的**独立样本**。同一提示词版本两次运行之间的波动（例如 b13/b17 这种随机截断）无法与 autofix 的收益严格分离，报告按「方向性证据」而非「因果效应」使用。

20f 剩下的 2 批失败与校验规则无关：

| 批次 | 现象 | 根因 | 处理 |
|---|---|---|---|
| 13 | writer 调用 `finish=length out=4096 think=3427`，YAML 截断 → 解析失败 → 重写也被截断 → 整批丢弃（**连失败报告都没写**） | `DirectorService` 没有把 `DEFAULT_DIRECTOR_CONFIG` 合并进传入的部分配置，`maxTokensByStage` 整体被替换成 `undefined`，`llm.ts` 退回 `?? 4096` | 构造函数改为按阶段深合并默认值（新增回归测试断言「只传部分配置时 showrunner 2048 / writer 8192」）；失败批次补写 `batches/NNNN.failed.json` |
| 17 | 同上（`out=4096 think=3249`） | 同上 | 同上 |


**探针 `smoke-real-01`（1 批，提示词 v6）**

| 项 | 值 |
|---|---|
| 批次 | 1/1 通过，3 张卡 |
| 调用 | showrunner 10.3s → writer 11.5s（共 2 次，首轮通过） |
| 说明 | 加学习任务清单后的单批验证；提示词改版后单批探针都换新的 run_id 或先删产物 |

**第一次跑批的失败模式（已修，记录在此以免重复踩坑）**

| 现象 | 根因 | 修法 |
|---|---|---|
| 3 次调用全是 0 字节输出，整批失败且**没有任何产物** | 推理模型的思考 token 吃满了默认 4096 输出上限；`AiSdkLlmClient` 既不记录 `finish_reason` 也不区分空串 | 按阶段下发 `maxTokens`（writer/single 8192）；记录 `finishReason` / `reasoningTokens` / `empty`；失败批次也写 `batches/NNNN.failed.json` 与 `calls.jsonl` |
| 改完输出上限仍命中旧缓存（还是空串） | 请求哈希只含 system/prompt/model/temperature | 哈希纳入 `maxTokens` 与推理强度（`hashSalt`） |
| 20 批跑到第 3 批整轮崩掉（`StoryException: ran out of content`） | 模型写的 ink 缺 `-> END`；inkjs 在运行时错误上直接抛异常，`validateBatch` 没接住 | `compileAndWalk` 捕获并转成 `E-INK`（走修复循环）；`generateSlot` 再包一层 try/catch，单批异常记为失败批次继续跑 |

**第二次失败模式：字段形状靠猜（提示词 v2 修复）**

第一次拿到非空输出后，14 条阻断级问题全是 schema 级：`effects` 写成数组（应为具名映射）、`comic` 缺 `setting`、`panels[].shot` 取值乱写、`swipe.mode` 缺失、`chat.skin` 不在枚举、`messages[].from` 缺失。提示词 v1 只有散文式规范，没有可照抄的样例。

v2 在 `writer.md` / `single.md` 里放了逐字段的完整 YAML 示例（六种场景 + ink 片段）并标明枚举取值。同一 brief 下，writer 输出从「14 条 schema 错误」降到「2 轮可修复的小问题」，批通过。

**第三、四次失败模式：证据语义与词汇预算（提示词 v3/v4 修复）**

- v2 之后剩余的问题集中在语义层：把 `evidence` 写在 comic 等无交互场景上（E-EVIDENCE-OVERCLAIM）、chat 声明 evidence 却没有 reply、具名 effect 声明了却没人引用（E-EFFECT-INVALID）。v3 把这三条写成硬性规则后，schema 与证据类错误清零。
- 之后只剩 OOV 阻断（7–20%）。根因不在提示词：种子词库 62 条，学习者「已知词」只有功能词 + 本批目标词，方案默认 2%/5% 阈值下任何自然文本都超标。v4 把校验器真实的允许词表整体喂给模型，同时把每批允许额外词从 8 放宽到 60、OOV 阈值放宽到 8%/25%（均写入运行配置，见偏差表 #6）。

**质量观察（1 批样本，只作为迭代线索，不作结论）**

- 台词重复度高：同一句 `Can you help?` 在漫画格里出现 3 次，属于「满足了 uses 定位但没写内容」。
- `improv` 频道用了固定角色 duck/cat（该频道本应每批自选日常场景）——频道圣经对 cast 的约束还没进 precheck。
- `hidden_object` 的 `spots` 写了背景位置表里没有的 `under_moon`；校验器只按标识符正则检查，没查位置归属，所以放过了。

### 4.3 与 Stub 冒烟的差异

Stub 5 批（`pnpm lab smoke`）只能证明流水线接线正确：Stub 的 YAML 是人写的、必然合法。真实模型的差异集中在三处，且都在试跑第一小时内暴露：

1. **输出形状**：模型会发明字段。提示词里必须有可照抄的完整样例，散文式规范不够。
2. **输出预算**：推理模型的思考与正文共享上限，长输出任务必须单独放宽，否则表现为「空响应」而不是「截断报错」。
3. **修复循环的有效边界**：schema 级错误时解析不出批次，`badSceneIds` 为空，修复循环直接放弃（`repairRounds` 计数却已自增）。这解释了「记了 2 轮修复但一次 repair 调用都没有」的现象；提示词修好后修复轮次才真正用于语义级问题。

## 4.4 promptfoo 回归矩阵（2 模型 × 5 条样例）

矩阵的用途是把提示词迭代变成可对比的实验：固定 5 条样例（位置介词暴露、到期复习、价格词块、A2 复习、纯暴露），跑快速档与高档两个模型，**单次生成、不带修复循环**，判定直接用 `lab assert` 调真正的校验器（规则只在 `packages/esl` 一处实现）。

| 样例 | 快速档 `MiniMax-M3.1-Flash` | 高档 `MiniMax-M3` |
|---|---|---|
| duck_detective / A1 / 位置介词暴露 | ✅ | ❌ `E-USES-NOT-FOUND@s3` |
| duck_detective / A1 / 到期复习 | ❌ `E-EVIDENCE-OVERCLAIM@s2,s3` | ❌ 同左 |
| impossible_store / A1 / 价格词块 | ✅ | ❌ `E-EVIDENCE-OVERCLAIM@s2` + `E-OOV-HIGH 45.6%` |
| impossible_store / A2 / 到期复习 | ❌ `E-EVIDENCE-OVERCLAIM@s2,s3` + `E-USES-NOT-FOUND@s2` | ❌ `E-EVIDENCE-OVERCLAIM@s2` |
| improv / A1 / 纯暴露 | ✅ | ❌ `E-EVIDENCE-OVERCLAIM@s4` + `E-USES-NOT-FOUND@s3,s4` |

- 合计 **3/10 通过（30%）**，1 分 31 秒、36 369 token（并发 2）。
- 失败集中在两类**声明与实际不符**：把 3 选项的 pick/chat 标成 `recognition-4`（推导结果只有 `recognition-2`），以及 `uses` 声明的条目在该场文本里根本没出现。这两类正是 `autoFixBatch` 与修复循环在流水线里处理的，所以矩阵的 30% 与流水线的 V2 90% 不矛盾——矩阵量的是**首轮单次生成**，流水线量的是**修复之后**。
- 快速档 3/5、高档 0/5：高档这一行要打折看，见下条「M3 的思考必须整段关掉」。

**适配层的两个坑（都已固化进 `promptfoo/provider.js`）**

1. promptfoo 0.124 的 `openai:chat:` provider **不透传 `config.reasoning_effort`**（该参数只在 abliteration / openrouter 等少数 provider 里实现）。推理模型的思考与正文共享 `max_tokens`，结果 10 格全部 `finish_reason=length`、输出以 `Thinking:` 开头、`0 passed / 5 errors`，两次共烧掉约 10 万 completion token。改成 30 行自定义 provider（`file://provider.js`，自己 POST `reasoning_effort`）后一次通过解析。
2. `MiniMax-M3`（非 Flash）把思考**内联进 `content`**（`Thinking:…` 前缀，没有单独的 `reasoning_content` 字段）；`reasoning_effort: minimal` 与 `enable_thinking: false` 都无效，只有 `thinking: {type: disabled}` 能关掉（各做一次探针验证）。所以高档行测的是「关掉思考的 M3」，不代表它在编剧室阶段（思考开着、输出是计划而非批次文本）的真实水平。

**样例夹具的两个坑**：`char_specs` 必须带真实表情/配件表（否则模型写出 `expr=serious` 这类不在表里的表情 → `E-CHAR-ATTR`）；`asset_tags` 必须是 `data/assets/manifest.yaml` 里真实存在的背景标签与 emoji 名（背景只有 6 个，`@tag:street` 直接 `E-ASSET-MISSING`；`hat` 是 tag 不是 emoji 名）。另外 `lab assert` 新增 `--oov-warn` / `--oov-block` / `--allowed-extra`，矩阵按运行配置的 8%/25% 与用例词表判定，否则默认 2%/5% 会把「能过流水线」的批次判成失败。



| # | 偏差 | 原因 | 影响 | 处理 |
|---|---|---|---|---|
| 1 | 词库 62 条（方案要求约 300 条） | 扩表是内容工作（CEFR-J 底表 + 人工复核） | L3 OOV 指标噪声偏大 | 用 `lab check` 保证增量合规；结论里标注样本 |
| 2 | `config/prices.yaml` 单价未填 | 供应商单价未能从公开文档核实 | K2 不可判定 | 拿到单价后回填并重算 `lab metrics`；在此之前 K2 不计入达标项 |
| 3 | promptfoo 矩阵缩为 2 模型 × 5 条样例（单段提示词） | 真实调用每次 20–40 秒、每格 20 批约需一小时以上；矩阵的用途是提示词迭代，不产正式指标 | 覆盖面小于方案 7.1 | `promptfoo/promptfooconfig.yaml` 是扩表入口：加 `prompts`/`tests` 即可扩格；正式 R0–R6 由 `lab run` 跑 |
| 4 | 推理强度设为 `low` | 默认强度下长输出会被思考 token 吃光（§4.2） | 构思质量可能略低于默认强度 | 该参数写在 `models.yaml`，正式跑 R0–R6 前对 R6 单独评估是否调回默认 |
| 5 | 提示词迭代到 v8（v1→v2 补 YAML 样例；v3 补证据/effect 硬规则；v4 喂真实允许词表；v6 加学习任务清单；v7 加解析重写与字段必填；v8 加批次级重写与 repair 五条硬规则） | 真实模型的错误是一层层暴露的，每轮只修一类 | v1–v7 的跑批数据只作迭代记录 | `data/prompts/FROZEN` 记录 v8；各版本改动见提交历史 |
| 6 | 每批允许额外词 60 个（方案 R5 为 8 个）、OOV 告警/阻断 8%/25%（方案 2%/5%） | 种子词库 62 条 → 学习者「已知词」只有功能词 + 本批目标词，方案阈值下任何自然文本都会阻断（实测 7–20%） | L3 OOV 指标不能与方案阈值直接比较 | 阈值与词数都进了运行配置（`oov_warn`/`oov_block`）与 `Planner.allowedExtraCount`；词库扩到约 300 条后调回方案值并重跑 |
| 7 | 校验前对批次做机械修正（`autoFixBatch`：删掉找不到的 `uses`、没人引用的 `effect`、曝光不足的新条目 `evidence`） | 这三类错误是「声明与实际不符」，删声明即可，不需要模型重写；留在修复循环里只会烧调用 | V2 会被抬高：它量的是「修正后的批次」，不是「模型原样输出」 | 每处修正都打 `[autofix] …` 到 stderr 可核对；§4.4 的矩阵量的是未修正的首轮输出，两个数字要一起看 |

## 6. 复现

```bash
pnpm install
pnpm test                      # 141 个测试
pnpm lab check                 # 数据格式 + 提示词冻结漂移
pnpm lab smoke                 # Stub 5 批（无需 key）
$env:ENDLESS_API_KEY = "..."   # 只放在环境变量里
pnpm lab run --config apps/lab/config/run-smoke20.yaml
pnpm lab metrics apps/lab/runs/smoke-real-20d
pnpm lab judge   apps/lab/runs/smoke-real-20d

# promptfoo 回归矩阵（2 模型 × 5 条样例；--no-cache 必须带，否则会读到上次的响应缓存）
cd apps/lab/promptfoo
promptfoo eval --no-cache --max-concurrency 2 -o output/result.json
```

## 7. 后续工作（按优先级）

1. ~~**把「生成后自检」补进导演**~~（提示词 v8 已做）：逐场修复只能定位带 `scene` 的问题；brief 覆盖缺口、新条目提前检测这类批次级问题以前直接放弃。v8 起批次级问题整批重写一次（问题单回填给分场编剧，`maxRewrites` 默认 1），`repair.md` 补上五条硬规则（气泡上限、feedback/reply 必填、evidence 只标检测、effect 必须被引用、新条目只曝光不检测）。
2. **词库扩到约 300 条**，然后把 `oov_warn`/`oov_block`/`allowedExtraCount` 调回方案值重跑，L3 才有可比性。
3. **填 `prices.yaml`**，让 K2 从「不可判定」变成真数字；目前 20 批的 token 量（输入 6 895/批、输出 3 083/批）已经足够按单价直接算。
4. ~~**跑 promptfoo 矩阵**~~（已完成，见 §4.4）：2 模型 × 5 条样例已跑通并记录首轮合规率 3/10；扩格只需在 `promptfoo/promptfooconfig.yaml` 加 `prompts`/`tests`。下一步可把 §4.2 里反复出现的 `E-EVIDENCE-OVERCLAIM` 做成一条专门的样例，盯住「声明的证据等级不得超过选项数推导出的等级」。
5. **R0–R6 全量**（7 × 3 × 60 批）：配置已就位（`apps/lab/config/run-R0.yaml` … `run-R6.yaml`，60 批、P1），画像用 `--persona P2/P3` 覆盖同一个配置。按当前 P50 56s/批估算，单运行 60 批约 1 小时，全量约 20 小时 API 时间，需要分批跑并复用 `runs/<id>/cache` 回放：

   ```bash
   for r in R0 R1 R2 R3 R4 R5 R6; do
     for p in P1 P2 P3; do
       pnpm lab run --config apps/lab/config/run-$r.yaml --persona $p
       pnpm lab metrics apps/lab/runs/$(echo $r | tr 'A-Z' 'a-z')-60-$p
     done
   done
   ```

   已核对的开关语义：`world_state: false` 关掉事实/伏笔/摘要/回调四块上下文与 canon 锁定；`trope_ledger: false` 把台账换成「（梗台账关闭）」；`encoding: json` 走 JSON 批次；`showrunner_tier: premium` 只把编剧室换高档、分场仍是快速档；`derive: false` 在校验前剔掉 derive 场景（提示词目前不要求模型写 derive，所以这一项开与关的差别要等提示词加上派生规则后才显现——R5 暂时只有「不剔除」的含义）。

