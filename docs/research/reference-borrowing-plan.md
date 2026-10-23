# 参考调研的结合与借鉴计划

> 状态：**阶段 0 / 1 / 2 已实施（2026-10-23，见第 8 节）；阶段 1 的 LLM 验收门未跑（缺 API key）**，阶段 3 属实验 1。
> 用途：把 `reference/` 下三份竞品调研与实验 0 的现状逐条对齐，定出借什么、改成什么样、放在哪、怎么判断有效、什么时候做。
> 参考：[`scrolltostudy-research/`](../../reference/scrolltostudy-research/README.md)（ScrollToStudy 产品全貌）、[`scrolltostudy-infinite/`](../../reference/scrolltostudy-infinite/README.md)（无限滚动机制）、[`ai-mini-app-research/`](../../reference/ai-mini-app-research/README.md)（Sekai AI 小程序）。
> **`reference/` 不入库**（`.gitignore`）：那三份竞品调研是本地材料，clone 仓库后上面的链接会断。本文第 7 节的溯源表已把「借了哪一条、来自哪个文件」逐条列出，不依赖原文也能读。
> 项目侧以 [`../experiments/exp-00-director-loop.md`](../experiments/exp-00-director-loop.md)（下称「方案」）与 [`../experiments/exp-00-results.md`](../experiments/exp-00-results.md)（下称「结果」）为准。
> **纪律**：本计划不改变冻结纪律。凡是会改提示词、提示词变量或请求哈希的条目，都必须新版本 + 新 `run_id`，并且**不得混进 R0–R5 正式矩阵**（顺序见第 5 节）。

---

## 0. 结论速览

三份参考各教一件事：

| 参考 | 核心机制 | 在 ENDLESS 里对应的问题 |
|---|---|---|
| ScrollToStudy 无限机制 | 无限 = 同一份原料的**可控重采样**（焦点 × 题型 × 数量 × 措辞）+ 错题回插 + 把成本压到一次性 | 新颖度（F1）、K5 演绎倍数、K4 卡顿、R5 的 derive 维度 |
| ScrollToStudy 生成契约 | 契约写硬；只下禁令不够，要给模型**出路**；答案用**索引**；生成约束**反向对齐渲染能力**；失败分三类重试 | V2 卡在 90%，剩下的失败全是「编名字」 |
| Sekai | **目录即契约**（一项能力 = 给人看的标题 + 给模型看的片段 + 治理策略）；**编辑即数据**；版本与血缘 | 提示词示例与校验器规则分三处维护（结果 §5 #10、#11）；局部返修只能重跑模型 |

三条总体判断：

1. **参考里自带的「对 ENDLESS 的启示」要重新翻译一遍。** 那三篇（`scrolltostudy-research/06`、`scrolltostudy-infinite/08`、`ai-mini-app-research/05`）是按「通用刷题卡片」去想象 ENDLESS 的：用户上传材料、`source_ref` 指向 PDF、`E_TOPIC_CROSS_TYPE_DUP` 按「事实」去重。ENDLESS 的原料不是上传物，而是**词库 + 频道圣经 + 素材清单 + 世界状态**；检测单位是**词库条目 × 维度**，不是事实。大约三分之一的建议要么已经有了，要么不适用（第 2 节）。
2. **最值得借的，是能直接打到当前瓶颈的那几条。** 结果文档已经证明：提示词对「名字」无效，解码期约束在这个端点上也无效（结果 §7 第 9 条）。参考给的出路是**把名字从「生成」挪到「选择」**：编剧室声明需要什么，程序解析成合法名字，写手只从本批的短清单里引用（第 3 节 A2）。
3. **参考帮忙照出了两处现状风险**，应在 R0–R5 开跑前处理：
   - 任何 LLM 调用异常都记成 `E-INTERNAL` 批次失败（`apps/lab/src/pipeline.ts:525-544`）。17–26 小时的全量跑批里，一次网络抖动就会被算进 V2。ScrollToStudy 把「不完整 / 网络错 / 最终失败」分开重试（A4）。
   - 提示词目前不要求模型写 `derive`（结果 §7 第 8 条），R5 的「derive 开」实际只有「不剔除」的含义，和 R6 一样会产出一条复制品。ScrollToStudy 的「无限的不是内容，而是题目」给了 R5 一个真内容：程序从更早批次派生检测（B3）。

**优先做的五件事**

| # | 条目 | 来源 | 动哪个指标 | 是否影响 R0–R5 可比性 |
|---|---|---|---|---|
| 1 | A4 失败分类重试 + 跑批熔断 | ScrollToStudy 重试三分法；迁移方案「失败三次就停」 | V2 口径干净；全量跑批不被网络拖垮 | 否（在缓存外层，不改请求哈希） |
| 2 | C2 原料指纹 + 中间产物落盘 | ScrollToStudy `source_content` 持久化；Sekai 版本血缘 | 解决结果 §5 #8（无法离线重算）与 #9（变量混淆） | 否 |
| 3 | B3 程序派生的跨批检测 | ScrollToStudy 重采样 + 错题回插 | R5 有实义；K5 ↑；K4 ↓ | 只影响 R5，须在 R5 开跑前定 |
| 4 | A1 提示词示例自检 + 组件目录单一来源 | Sekai Toolbox 与能力目录 | V0 ↑（消灭 #10 类自相矛盾） | 自检不影响；目录渲染属于 v13 |
| 5 | A2 名字出路：需求清单 → 程序解析 → 本批短清单 + 别名表 | ScrollToStudy「给出路」「答案为索引」；Sekai `need` 清单 | V2 从 90% 到 97% 的最后一段 | 属于 v13，新 `run_id` |

---

## 1. 概念对齐：参考里的东西在 ENDLESS 里是什么

状态：✅ 已有　◐ 部分　✗ 缺失　— 不适用

| 参考中的机制 | ENDLESS 中的对应物 | 状态 | 说明 |
|---|---|---|---|
| `source_content` 持久化，续批不重抽 | 词库、频道圣经、素材清单、谓词、梗分类（`apps/lab/data/`）+ `world.sqlite` | ◐ | 原料都在，但运行产物只记提示词哈希（`prompts.json`），**不记数据指纹**。20o 与 20n 之间夹着词库扩容（结果 §5 #9），这类混淆只能靠人记 |
| 一次请求产出多形态，顶层 key 恒存在 | 一批 3–4 个场景 + `derive` | ✅ | ESL 的场景表本身就是多形态容器，不需要「空数组」约定 |
| 焦点轴（definition / reasoning / terminology） | 检测角度：词义辨认 / 语境推断 / 易混辨析；维度 `meaning` / `listening` | ✗ | 规划器只决定「测哪个条目、最低证据档」，不决定「从哪个角度测」 |
| 题型按强度分工 | 频道圣经的 `scene_affinity`、`language_affinity` | ◐ | 只给模型看，不进校验、不进调度 |
| 同一事实不跨题型重复 | 同批第二次检测同一条目 = `practice`，不写 FSRS | ✅ | 语义层已有，不要再加按「事实」去重的码 |
| 内容不足就少给，不硬凑 | 无 | ✗ | 模型缺名字时没有合法出路，只能编（结果 §4.2 失败谱） |
| 答案为索引，判分零抖动 | 选项上标 `correct: true` | ✅ | 判分已经是结构化的；但**名字引用不是索引**，仍是自由文本 |
| 视觉无关：只渲染文字就不许出「如图所示」 | `E-ASSET-MISSING`；spots 查背景位置表 | ◐ | 校验器对齐了素材清单，**频道圣经没有对齐**：`duck_detective` 的 premise 写着 `Apartment 7`，6 个背景里没有 apartment，而 20g、20m、20n、20o 都出现过 `@tag:apartment` |
| `card_order` + 游标 + 边缘补货 + `maxPages` | 生成领先播放 `feedback_lag` 批 + `buffer-sim` | ◐ | 实验期够用；app 阶段缺播放队列的数据模型 |
| 错题优先队列 | FSRS + BKT + 规划器 R2 优先级 | ✅（更强） | 缺「刚答错的很快再见」这一层投影 |
| 追问解释（点灯泡才生成） | `on_wrong` 一句反馈 | ◐ | 无按需解释；词库已有 `gloss_zh`、`example`、`confusables`，可以程序生成 |
| 「不完整 / 网络错 / 最终失败」分开重试 | 任何异常 → `E-INTERNAL` 批次失败 | ✗ | 见 A4 |
| 周配额、Premium 闸门 | `budget.yaml` 只有 `per_100_cards` | — | 产品期再议；实验期只借「成本大头压到一次性」 |
| 可编辑清单 `window.sekaiEditable` | 无 | ✗ | 改一个素材名也只能重跑模型 |
| 能力目录（标题 + 模型片段 + `planner` 开关） | 提示词里的清单、校验器白名单、Zod 正则，三处分别维护 | ◐ | 结果 §5 #10、#11 的根源 |
| 调用治理 `budget / memo / trailing / min_interval` | 请求哈希缓存（相当于 `memo`） | ◐ | 无调用频率上限、无跑批熔断 |
| 版本 + remix 血缘 | `run_id`、`FROZEN`、AST 内容哈希、`firstDraftIssues` | ◐ | 批次版本链（首版 → autofix → 重写 → 最终）只有问题单，没有内容哈希链 |
| 设计 agent → 预算内的构建简报 → 构建 agent | 编剧室 → 预检 → 分场编剧；上下文块预算（方案 §5.6） | ✅ | 工作区里进行中的 `sessionWindow` 已经把**校验后的批次**作为 assistant 轮写回会话历史，相当于 Sekai 的 `System Event: build success` 闭环 |
| `agent-arena` 双版本对比 | 人工 5 分制盲评 | ✗ | 2–3 个评审人时统计力弱（方案 §10），成对比较更灵敏 |
| 推荐预测分 + 推荐理由 | 频道调度权重（兴趣 × 新近度 × 伏笔压力） | ◐ | 不记录「为什么这批选这个频道、这条回调」 |
| 信息流生命周期 `preheat / enter / exit / freeze / thaw` | 无 | — | 实验 1 的场景组件直接照搬 |

---

## 2. 不照搬，以及对参考建议的修正

| 参考里的建议 | 处理 | 理由 |
|---|---|---|
| `E_TOPIC_CROSS_TYPE_DUP` / `E_FACT_DUP_IN_BATCH` / `E_FACT_PARAPHRASE_DUP` | **不加** | ENDLESS 的检测单位是条目 × 维度，「同批重复检测」已经按 `practice` 处理；按「事实」去重在娱乐剧情里没有可判定的定义 |
| 每张卡独立成文件 + `index.yaml` | **不做** | 批次已是独立文件，场景有 `id`，AST 节点有 `id` 与内容哈希，已经可寻址；再拆只增加 I/O |
| `source_ref` 指向 PDF / ASR 抽取结果 | **改写**为「原料指纹」（C2） | 实验 0 没有用户上传 |
| 字符级硬上限做成阻断码（题干 ≤ 100、选项 ≤ 30） | **降级**为建议级，留到实验 1 按真实版式定（D5） | 已有按词数的句长预算；字符上限服务的是 UI，没有界面之前定死只是猜 |
| 「数量 N 是硬要求，不许少给」 | **取反** | 这句和「内容不足就少给」在原产品里本来就互相拉扯；ENDLESS 取后者：缺合法名字时宁可少一个道具，也不能编 |
| 单文件 HTML 产物、提示词放进产物、提示词随包分发、弱 SRS、只靠行为信号排序 | **不做** | 两份参考自己也这样判断；与冻结纪律、AST 级测量、「SRS 是唯一由算法决定的部分」冲突 |
| 解码期结构化约束 | **不重提** | 已证伪：这个端点静默忽略 `response_format`（结果 §7 第 9 条） |
| 无限模式做成付费能力 | **不适用** | ENDLESS 的「无尽」是产品本体，不是升级项；成本护栏是 K2 |

---

## 3. 借鉴项

每一项写清：来源、现状、做法、落点、判据、对冻结与可比性的影响。

### A. 可执行性：V2 从 90% 到 97% 的最后一段

#### A1　提示词示例自检 + 组件目录单一来源

- **来源**：Sekai 的 Toolbox「每项能力 = 给用户看的标题 + 给模型看的 prompt 片段」，能力目录带 `planner` 开关（`materials/capability-catalog.json`）；ScrollToStudy「契约越硬，采样空间越可控」。
- **现状**：同一条规则散在三处：提示词正文与示例（`apps/lab/data/prompts/*.md`）、校验器（`packages/esl/src/validate.ts`）、Zod 模型（`packages/esl/src/model.ts`）。结果 §5 #10 记录了两次「示例自己违反规则」：3 个选项标 `recognition-4`；`open_thread` 只写过 `set_fact` 的字段。那一条写下的检验方式是「校验器规则必须能在提示词示例里逐条找到」，目前靠人查。
- **做法**（两步）：
  1. **自检测试（不改提示词）**：从 `writer.md` / `single.md` / `repair.md` 里抽出 YAML 代码块，用 lab 数据组装的校验上下文跑 `validateBatch`，要求 0 个阻断问题；再反向检查：六种 effect、六种场景、证据推导的几条规则（选项数、`hint` 降档、`spots` 数），在示例里至少各出现一次。
  2. **目录文件（属于 v13）**：新增 `apps/lab/data/catalog.yaml`，每个场景类型、effect 操作、素材类别一条：`id`、给模型看的一段说明、必填字段、一个合法示例、`writer_selectable`（借 Sekai 的 `planner` 开关：例如 `derive` 与 `production` 证据不让写手选）。提示词里的组件说明改由 `{{catalog_scenes}}`、`{{catalog_effects}}` 渲染；第 1 步的测试改为对目录跑。
- **落点**：`apps/lab/test/`（新测试）、`apps/lab/data/catalog.yaml`、`apps/lab/src/data.ts`（加载与渲染）、`packages/director/src/prompts.ts`（占位符）。
- **判据**：第 1 步合入后，把示例故意改回「3 个选项 + `recognition-4`」，测试必须失败。第 2 步之后，promptfoo 矩阵的单次合规率不低于 v12 的 8/10。
- **影响**：第 1 步只加测试，不动请求哈希；第 2 步改提示词，走 v13（第 5 节）。

#### A2　名字的出路：需求清单 → 程序解析 → 本批短清单 + 别名表

- **来源**：ScrollToStudy 的「超长了就缩短答案或改写题干」（不只下禁令，还给出路）和「答案为索引」；Sekai 的能力 `need` 清单（编排段声明需要什么，执行段只消费）。
- **现状**：剩下的失败全是「编名字」（结果 §1、§4.2、§4.5）：不存在的背景标签、自造实体（用 `mouse` 指代 `delivery_mouse`）、非法条目 id。提示词里列反例会把名字喂给模型（结果 §5 #11），删掉反例模型照样写；重写能救「结构」，救不了「名字」。
- **做法**：
  1. **编剧室声明需求**：计划里加 `needs`，用自然词写本批想要的背景、道具、配角：

     ```yaml
     needs:
       background: apartment
       props: [hat, ladder]
       cast: [mouse]
     ```

  2. **程序解析**：预检阶段（方案 §5.7.2，纯程序）按 `manifest.yaml` 的标签检索和**别名表**，把每项解析成合法名字；解析不了的项作为预检失败原因退回编剧室。这一步便宜，正符合两段式「问题在第一步就拦下」的设计初衷。
  3. **写手只看短清单**：分场编剧收到 `[本批可用名字]`，只列解析结果（通常 ≤ 15 个），替代现在两百多个 `asset_tags`。同时给一条合法出路：「需要清单外的东西时，删掉这个道具或改写这句台词，不要新造名字」。
  4. **别名表**：`manifest.yaml` 的背景与 emoji、`characters.yaml` 的角色各加 `aliases`（例如 `apartment → living_room`、`hat → top_hat`、`mouse → delivery_mouse`）。autofix 加第六类：**只按人写的别名表替换**，命中就打 `[autofix] alias …` 日志。
- **为什么别名替换不越过 autofix 的边界**：结果 §7 第 4 条把边界定为「修复后不改变故事语义」，并把「猜背景、补角色、猜素材」划给修复循环。别名表不是猜：等价关系是人事先声明的数据，程序只查表。查不到的照旧走修复循环。
- **落点**：`packages/director/src/showrunner.ts`（`ShowrunnerPlan` 加 `needs`，预检加解析）、`apps/lab/src/data.ts`（别名加载、需求解析）、`packages/esl/src/autofix.ts`（别名类）、`apps/lab/data/prompts/showrunner.md` 与 `writer.md`。
- **判据**：以 20o 的失败谱为靶子（`@tag:apartment`、自造 cast）。v13 在 2 次 20 批采样里不再出现名字类阻断，V2 ≥ 97%。V0 按「别名命中前」的口径单列，不让别名替换把 V0 抬虚（与偏差 #7 的处理一致）。
- **影响**：改提示词与计划 schema，走 v13。

#### A3　频道圣经与素材清单对齐检查

- **来源**：ScrollToStudy「生成约束反向对齐渲染能力」：界面只渲染文字，就在契约里禁止依赖图的题。
- **现状**：校验器对齐了素材清单，频道圣经没有。`apps/lab/data/channels/duck_detective.yaml:5` 写着 `A very serious duck runs a detective agency in Apartment 7.`，而这个频道的背景只有 `agency_office / living_room / rooftop`。模型反复写 `@tag:apartment`，很可能就是被这句 premise 带出来的；结果 §5 #11 把它归因于模型自己的「公寓」先验，而这份先验正是频道圣经递过去的。
- **做法**：`lab check` 加一条建议级规则：圣经的 `premise`、`locations`、`set_pieces` 中出现的地点与物品名词，必须能在背景标签、emoji 名、标签或别名表中解析到，否则报出来。处理方式二选一，都是数据改动：给 `living_room` 加别名 `apartment`，或把 premise 改写成清单里有的地点。
- **落点**：`apps/lab/src/cli.ts` 的 `check` 子命令、`apps/lab/src/data.ts`。
- **判据**：对现有数据跑一次，至少报出 `Apartment 7`；修数据之后，用下一次 20 批里 `@tag:apartment` 的出现次数作对照。
- **影响**：检查本身不影响；修数据会改变提示词变量与请求哈希，和 A2 一起进 v13。

#### A4　失败分三类重试 + 跑批熔断

- **来源**：ScrollToStudy 的 `Incomplete response, retrying in …` / `Network error, retrying in …` / `AI request failed`，三类都带延迟；迁移方案 §3.3「批次失败三次就停：无限流最危险的不是成本，是坏数据进入队列」。
- **现状**：`AiSdkLlmClient` 只有超时，没有重试；`runExperiment` 把任何异常记成 `E-INTERNAL` 批次失败后继续跑。R0–R5 全量约 17–26 小时 API 时间，网络抖动、429、5xx 会直接进 V2 的分母，而 V2 要衡量的是「ESL 好不好写」。
- **做法**：
  1. **分类**：传输类（网络错误、超时、429、5xx）用指数退避 + 抖动重试，最多 N 次，429 优先读 `Retry-After`；请求类（400 等）立即失败；不完整（`finish=length`、空正文）沿用现有解析重写路径，单独计数。
  2. **包装位置**：新增 `RetryingLlmClient`，包在 `CachingLlmClient` 内层，**不改请求哈希**，回放与缓存不受影响。
  3. **口径**：`calls.jsonl` 每条加 `transportRetries` 与错误类别。传输重试耗尽的批次记成 `E-TRANSPORT`，不计入 V2，在报告里单列「传输失败率」，并在续跑时补齐。
  4. **熔断**：连续 3 批传输失败就停止跑批并打印续跑命令。续跑依赖现有请求哈希缓存：同配置重跑时，已完成的调用全部命中缓存。上线前先验证一次「同 `run_id` 重跑命中率 100%」。
- **落点**：`packages/director/src/llm.ts`、`apps/lab/src/pipeline.ts`、`apps/lab/src/critic/metrics.ts`。
- **判据**：单测用一个「前两次抛网络错、第三次成功」的假客户端，断言批次通过、`transportRetries=2`、V2 不变；用「一直返回 429」的假客户端断言熔断生效。
- **影响**：不改提示词与请求哈希，应在 R0–R5 开跑前合入。

#### A5　允许词表改短：按需取列

- **来源**：ScrollToStudy 列表页只取需要的列，大字段只在详情页拉；Sekai 构建简报有总词数预算，单条工具结果截断。
- **现状**：结果 §4.6 的结论是「L3 的瓶颈是能力门 + 写手对允许词表的遵守度」。`allowed_words` 含 321 个功能词 + 全部已知形式，模型读不动这么长的表；写手输入 token 也因此从约 3.7k 涨到约 5.4–5.9k。
- **做法**：写手提示词里不再列功能词，改成一句「冠词、代词、助动词、常见介词与连词总是允许」；只列本批相关的内容词：本批目标条目的形式 + 按频道 `language_affinity` 与本批节拍挑出的前 K 个已知内容词（K 先取 60）。校验器的真实允许集合不变。和进行中的 `sessionWindow` 配合：会话首轮发短表，后续轮只发增量（`buildFollowupPrompt` 已有「本批新增允许词」的增量机制）。
- **落点**：`apps/lab/src/pipeline.ts`（`allowed_words` 的组装，约 370 行）、`apps/lab/data/prompts/writer.md`。
- **判据**：L3 中位低于 9.7%（20o 读数），写手输入 token 低于 5.4k，V2 不下降。
- **影响**：改提示词变量，走 v13。

### B. 新颖度与「无限」引擎

#### B1　采样轴显式化（焦点轴的 ENDLESS 版本）

- **来源**：ScrollToStudy 的四维重采样「焦点 × 题型 × 数量 × 措辞」：不是把内容做多，而是把采样参数做多。
- **现状**：梗台账只负责「禁止复用」（方案 §5.10），新东西全靠编剧室自己发明。方案 §9.2 已经写好新颖度不达标时的调整方向：「人工编写的梗种子库和半预制剧情骨架」。
- **做法**：定义 ENDLESS 的采样轴：频道 × `set_piece` × 场景类型序列 × 梗族（梗分类表上一级） × 检测角度（词义辨认 / 语境推断 / 易混辨析）。每批由程序挑一个「最冷的组合」（最近 W 批用得最少），作为**指定项**写进编剧室上下文；梗台账继续负责禁止项：

  ```yaml
  assigned:
    set_piece: false_ending
    trope_family: escalation
    test_angle: confusable_contrast
  ```

  这相当于方案 §9.2 那条调整方向的轻量预演。
- **落点**：`packages/director/src/ledger.ts`（冷格查询）、`apps/lab/data/tropes.yaml`（加梗族）、`apps/lab/data/prompts/showrunner.md`。
- **判据**：作为额外一行运行（例如 `R3s`），对照 R3 看第 21–60 批的 N1–N3 曲线与人工「想看下一张」。只新增一行，不替换 R3。
- **影响**：改提示词，单独 `run_id`。

#### B2　覆盖矩阵

- **来源**：迁移方案 §3.2 的 `topic × type` 覆盖矩阵：「续批优先补空格，让无限从随机碰运气变成有序填空」。
- **做法**：两张表，都从已落盘的批次算出：
  - **学习侧**：条目 × 维度 × 证据类型 × 场景类型。用途：报告里看某个条目是不是永远只在 `hidden_object` 里被测（记忆可能绑定在场景形态上）；规划器可以据此在 brief 里加一条软提示「本次换一种场景形态检测」。
  - **内容侧**：频道 × `set_piece` × 梗族。用途：给 B1 提供冷格。
- **落点**：`apps/lab/src/critic/metrics.ts`（报告）、`packages/learning/src/planner.ts`（软提示，可选）。
- **判据**：报告能直接回答「60 批之后哪些格子还是空的」。第一版只做报告，不改调度。
- **影响**：只做报告时不影响任何运行。

#### B3　程序派生的跨批检测（R5 的真内容，也是本地补货）

- **来源**：ScrollToStudy 的核心结论「无限的不是内容，而是题目」与错题回插；`demo-pipeline.html` 的补货模拟器（新题 + 旧错题回插，填进被消费掉的空隙）。
- **现状**：`derive` 的编译与证据语义已经实现，跨批来源也计作检索证据（结果 §5 #13 第 ⑨ 条）；但提示词不要求模型写 `derive`，所以 R5 的「derive 开」目前只有「不剔除」的含义（结果 §7 第 8 条）。
- **做法**：在流水线里加一个**派生器**，不调 LLM。对本批 brief 的到期复习条目，如果它的某个形式出现在更早已播放批次的台词里（`priorTexts` 已在 `pipeline.ts` 里维护），就生成一个 `derive` 场景（`kind: cloze_pick`，干扰项取 `confusables`）。规则：
  - 只从**更早批次**取材，保持 R4 防启动；本批在检测之前不得出现该条目；
  - 上限：每批最多 1 个，派生卡不超过全部卡片的 25%，防止 L5 习题感上升；
  - 「最近答错」的条目优先（错题回插）；写进 FSRS 的仍然只是证据结果，不改 SRS 的调度。SRS 是真相，派生只是投影。

  同一个派生器还有第二个用途：`buffer-sim` 里生成跟不上消费时，用派生卡填空，量它能把 K4 卡顿概率压下多少。
- **落点**：`apps/lab/src/pipeline.ts`（派生器）、`apps/lab/src/buffersim.ts`（派生填空参数）。`packages/esl/src/compile.ts` 已有 `priorTexts` 路径，不需要改。
- **判据**：R5 的 K5 演绎倍数明显高于 R3/R4；派生检测的 L4 歧义率 ≤ 3%；L5 人工习题感不比 R3 高 0.5 分以上。
- **影响**：只改 R5 的含义，R0–R4 不受影响。**必须在 R5 开跑前定**，否则 R5 会像 R6 一样成为复制品。

#### B4　两套知识边界 + 按需解释

- **来源**：ScrollToStudy「出题锁死在材料内，解释允许材料外」；灯泡入口按需生成解释，单独记账；解释要说明「最像的错项为什么错」。
- **做法**：检测内容继续受允许词表约束。答错后的解释改为**程序生成**：词库已有 `gloss_zh`、`example`、`confusables`，模板形如「正确：under（在……下面）。你选的 behind 是『在……后面』」。不调 LLM，K2 不变。到实验 1 再考虑真人点开时调用 LLM，并按 `knowledge_scope: source_plus_general` 单独记账。
- **落点**：`packages/esl/src/compile.ts`（给 AST 检测节点挂解释）或渲染层 `apps/lab/src/render.ts`。
- **判据**：评审稿里每个检测场景都带解释；实验 1 量点开率。

### C. 编辑、版本与血缘

#### C1　批次补丁：改值，不重新生成

- **来源**：Sekai 的可编辑清单与快速编辑：二创和轻编辑都是「改值」，平台只按 `id` 找条目、按三种绑定方式之一落值；`ai-mini-app-research/05` 建议用 `locked` 类型保护测量口径。
- **做法**：定义 ESL 补丁格式（路径 + 新值），字段分三类：
  - `asset`：素材引用、表情、配件，可改；
  - `text`：台词、旁白，可改，但改完必须重跑词汇检查（会影响 OOV 与 `uses` 定位）；
  - `locked`：`evidence`、`uses`、条目 id、`effects`、`correct`，不可改，改了就是另一个检测。

  `lab patch <batch> <patch.yaml>`：套补丁 → 重新校验 → 写新版本，带 `parent_hash`。A2 的别名替换在内部就是一条补丁，日志格式统一。
- **口径**：人工补丁属于人工干预，**不计入 V2**，单列。
- **落点**：`packages/esl/src/`（新补丁模块）、`apps/lab/src/cli.ts`。
- **判据**：对 20o 的失败批次 `b-0008` 写一条补丁（`@tag:apartment → @tag:living_room`、`mouse → delivery_mouse`），重新校验通过；针对 `locked` 字段的补丁被拒绝。

#### C2　原料指纹 + 中间产物落盘

- **来源**：ScrollToStudy 把 `source_content` 与产物同表持久化，续批不重传、不重抽；Sekai 每个版本有 id、父版本与根版本。
- **现状**：
  - （**已修，2026-10-23**）运行只记提示词哈希，不记数据指纹；
  - （**已修，2026-10-23**）`lab metrics` 只能重跑流水线读缓存，因为 N2/N3 依赖的 `ledgerEntries`、L1 依赖的逐批 `briefs` 只在内存里（结果 §5 #8）。1080 批跑完以后，只要指标代码一改，就没法离线重算。
    → 现在运行结束写 `artifacts/metrics-input.json`，`lab metrics` 优先离线重算；下面「做法」两条都已落地，见第 8 节的 C2 行。
- **做法**：
  1. 在 `config.yaml` 旁写 `data-fingerprint.json`：词库、圣经、素材、角色规格、谓词、梗分类、故事筛选各一个内容哈希（`packages/esl/src/hash.ts` 的 `contentHash` 可直接用）。`lab run` 在 `run_id` 已有产物且指纹变化时拒绝覆盖；比较两次运行时自动列出「除提示词外还有哪些数据变了」。
  2. 每批落盘 `brief`、梗台账条目、编剧室计划。`lab metrics` 优先读落盘产物离线重算，读不到再回退到现在的回放。
  3. 批次版本链：首版 → autofix → 重写 → 最终，每一步记内容哈希（`firstDraftIssues` 已有，补哈希即可）。
- **落点**：`apps/lab/src/pipeline.ts`、`apps/lab/src/cli.ts`、`apps/lab/src/critic/metrics.ts`。
- **判据**：删掉 `cache/` 后，`lab metrics` 仍能算出和运行结束时一致的 `metrics.json`。
- **影响**：只增加产物，不改请求哈希。R0–R5 开跑前合入。

### D. 成本、治理与评测

#### D1　调用策略表

- **来源**：Sekai 宿主的四类策略：`budget`（时间窗配额）、`memo`（结果缓存）、`trailing`（合并写）、`min_interval`（最小间隔）。`ai-mini-app-research/05` §4 的 P0 建议正是把它写进 `budget.yaml`。
- **做法**：`budget.yaml` 增加 `llm.requests_per_minute`、`llm.max_tokens_per_batch`、`run.max_total_tokens`（触顶即停）、`run.max_consecutive_failures`（A4 的熔断阈值）。`memo` 就是现有请求哈希缓存；`trailing` 留给实验 1 的学习事件写入。`buffer-sim` 读同一份文件里的并发与速率。
- **落点**：`apps/lab/config/budget.yaml`、`apps/lab/src/config.ts`、`apps/lab/src/pipeline.ts`。
- **判据**：全量跑批中 429 为 0，或每次都在重试内恢复。

#### D2　成对盲评

- **来源**：Sekai `agent-arena`：同一次构建产出两个版本，由观众投票决定胜者。
- **现状**：评审人只有 2–3 人，方案 §10 自己写了统计力弱，只看 ≥ 0.5 分的大差异。
- **做法**：`lab render --pair <runA> <runB>` 为同一序号、同一画像的两批输出去标签、随机左右的对照稿；评审人只回答「哪一批更想看下一批」（允许平局），用符号检验或 Bradley–Terry 模型汇总。5 分制保留，成对结果作为 RQ1 的补充证据。
- **落点**：`apps/lab/src/render.ts`、`apps/lab/src/cli.ts`；方案 §7.4 的评审规程同步补一节。
- **判据**：R3 vs R5 抽 15 对，每人约 20 分钟。

#### D3　调度理由

- **来源**：Sekai 推荐的 `recall_sources` / `rec_reasons`：每次召回都写清为什么。
- **做法**：批次记录加 `schedule_reason`：频道权重的三项分量（兴趣、新近度、伏笔压力）、命中的故事筛选模式、选中的冷格（B1）。
- **用途**：N2 偏高或 C2 伏笔卫生差时，能分清是调度的问题还是写作的问题。

#### D4　选项长度泄露检查

- **来源**：ScrollToStudy 限制选项长度的理由之一：「短答案保证干扰项不泄露长度」。
- **现状**：猜对率 `g` 按选项数取值（`recognition-4` 为 0.25），前提是选项之间看不出哪个对。正确选项明显更长时，真实猜对率高于 0.25，BKT 与 FSRS 的输入都会偏。
- **做法**：校验器加建议级 `W-OPTION-LENGTH-LEAK`：正确选项的词数与干扰项均值之差超过阈值（先取 50%）时报出。
- **落点**：`packages/esl/src/validate.ts`、`packages/esl/src/model.ts` 的 `ISSUE_CODES`。
- **影响**：建议级不阻断，不改变通过率；提示词里是否加对应规则留给 v13。

#### D5　字符级版式预算（实验 1）

按 PWA 的实际版式给气泡、选项、旁白定字符上限，作为建议级检查。数值等实验 1 的界面定稿后再定。

### E. 实验 1（PWA）可以直接搬的产品与工程模式

| # | 模式 | 来源 | 在 ENDLESS 里的样子 |
|---|---|---|---|
| E1 | 播放队列：游标持久化、内存只留最近几页、接近末尾提前补货、补货有守卫（进行中 / 还有更多）与限速 | ScrollToStudy `card_order` / `current_card_id` / `maxPages` / `hasMore` / 补货限速 | 队列元素是 AST 节点；补货 = 请求下一批；生成跟不上时用 B3 的派生卡填空；断网时只播缓存与派生卡，不续批（「云端权威 + 本地兜底」的边界） |
| E2 | 端上再校验 + 本地预制兜底 | Sekai 运行时报错自修复；方案 §12 | 服务端返回的批次在端上再校验，失败就播预制批次并上报 |
| E3 | 重置与洗牌两个出口 | ScrollToStudy：重置清作答记录、归零游标；洗牌只重排 | 重置 = 游标归零 + 事件打 reset 标记，**不删事件**；FSRS 状态是否清零单独确认。「有终点 / 无终点」用同一个数据模型加一个开关 |
| E4 | 场景生命周期与音频解锁 | Sekai `preheat / enter / exit / freeze / thaw`；首次触摸时 resume `AudioContext` | json-render 场景组件预热下一张、冻结屏外卡片 |
| E5 | 分服务日志标签 + 错误三件套 | ScrollToStudy `[Gemini]`、`[FeedService]` 等标签；`Error message / details / stack` | `[director]`、`[validate]`、`[srs]`、`[queue]`，错误统一结构 |
| E6 | 提示词多语言 | ScrollToStudy 随界面语言切换提示词（反例） | 若要多语言释义，做「提示词 ID + 版本 + 语言」的组合，正文不进产物 |
| E7 | 评分请求只在真的用起来之后出现；付费墙展示记状态，防重复弹 | ScrollToStudy `RatingManager`、`paywall shown` 记录 | 产品期参考 |

---

## 4. 指标映射

| 条目 | 主要指标 | 次要指标 | 不达预期时 |
|---|---|---|---|
| A1 | V0 | V1 | 保留自检测试，目录化推迟 |
| A2 | V2（目标 ≥ 97%）、名字类阻断数 | V0（别名命中前口径）、预检重试数 | 回到方案 §9.2：进一步缩小可写名字空间，让编剧室只能从清单里选 |
| A3 | `@tag:apartment` 出现次数 | — | — |
| A4 | V2 口径（剔除传输失败）、传输失败率 | K3 P95 | — |
| A5 | L3 中位与 P95、K1 写手输入 token | V2 | 回退到全表 |
| B1 | N1–N3（第 21–60 批）、人工「想看下一张」 | 预检失败率 | 只保留禁止项 |
| B2 | 覆盖率曲线 | — | — |
| B3 | K5、K4 | L4、L5 | 降低派生上限 |
| B4 | 评审稿解释覆盖率 | 实验 1 点开率 | — |
| C1 | 补丁后通过率（单列，不计入 V2） | — | — |
| C2 | 离线重算结果与运行时 `metrics.json` 一致 | — | — |
| D1 | 429 次数、全量 token 是否触顶 | — | — |
| D2 | 成对偏好率 | Krippendorff α | — |
| D4 | `W-OPTION-LENGTH-LEAK` 频率 | L4 | — |

---

## 5. 排期：与 R0–R5 正式矩阵的关系

冻结纪律要求 R0–R5 用同一个冻结提示词版本，所以按「动不动请求哈希」分阶段：

| 阶段 | 内容 | 是否改提示词或请求哈希 | 完成标志 |
|---|---|---|---|
| **0：R0–R5 开跑前必须做** | A4 失败分类与熔断；C2 原料指纹与中间产物落盘；A1 第 1 步示例自检；A3 检查规则（只报不改）；D4 建议级检查；**决定 R5 的含义**（采用 B3，或者像 R6 一样删掉） | 否 | `pnpm test` 全过；同 `run_id` 重跑缓存命中 100%；删掉 `cache/` 后 `lab metrics` 可离线重算 |
| **1：提示词 v13 候选** | A3 数据修正；A2 名字出路 + 别名表；A5 短允许词表；A1 第 2 步目录渲染 | 是：新版本 + 新 `run_id` | promptfoo 矩阵不低于 8/10；2 次 20 批冒烟 V2 ≥ 97% |
| **2：与 R0–R5 并行或之后** | B1 采样器（额外一行 `R3s`）、B2 覆盖矩阵报告、B3 派生器接入 `buffer-sim`、C1 补丁命令、D1 调用策略表、D2 成对盲评、D3 调度理由 | B1 改；其余不改 | 各自判据见第 3 节 |
| **3：实验 1** | B4 按需解释、D5 字符版式预算、E1–E7 | — | 进入实验 1 时再拆任务 |

**待定：R0–R5 用 v12 还是 v13 跑。**

- **建议先做阶段 0 和阶段 1，冻结 v13 之后再开 R0–R5。** V2 的阈值是 97%，v12 三次采样合计 90%。用一个已知不达标的版本跑 1080 批（约 17–26 小时 API 时间），V2 这一项的结论开跑前就知道了。R0–R5 本来就在等 API 预算，先花一两次 20 批冒烟验证 v13，是更省的顺序。
- **备选**：如果更看重尽快拿到 R0–R5 的相对比较（RQ1、RQ2、RQ5 比的是各行之间的差，不要求 V2 绝对达标），可以只做阶段 0 就用 v12 开跑，v13 作为 R0–R5 之后的第二轮。

阶段 1 内部按 A3 → A2 → A5 → A1 的顺序，每加一项跑一次 promptfoo，避免结果 §5 #9 那种「两个变量夹在一起」的混淆。

---

## 6. 风险

| 风险 | 应对 |
|---|---|
| 别名表把模型的弱点藏起来，V2 被抬虚 | V0 按「别名命中前」口径单列；别名命中次数进报告，和 autofix 一样逐条打日志 |
| 指定冷格（B1）限制了编剧室，反而不好看 | 只作为额外一行运行，由人工「想看下一张」裁决；不替换 R3 |
| 派生卡（B3）让习题感上升 | 每批最多 1 个、占比 ≤ 25%；L5 比 R3 高 0.5 分以上就降上限 |
| 重试（A4）掩盖供应商的真实不稳定 | 传输重试次数与耗时单列；K3 时延分「含重试」与「不含重试」两列 |
| 一次改多处，变量混在一起 | 阶段 1 逐项推进、逐项跑 promptfoo；C2 的数据指纹自动列出变化项 |
| 补丁（C1）被用来人工修数据 | 补丁批次单列，不计入 V2 |

---

## 7. 溯源：参考文档 → 本计划条目

| 参考文档 | 借用的条目 |
|---|---|
| `scrolltostudy-infinite/01-总机制.md`、`03-卡片队列模型.md`、`04-续批与无限查询.md`、`09-端到端-EdgeFunction与补货机制.md` | B3、C2、E1 |
| `scrolltostudy-infinite/02-生成契约.md`、`contract/prompt-contract.md`、`demo-pipeline.html` | A2、A3、B1、B4、D4、D5 |
| `scrolltostudy-infinite/05-错题加权.md` | B3、E3 |
| `scrolltostudy-infinite/06-无限的经济学.md` | B3、B4、D1 |
| `scrolltostudy-infinite/07-工程细节清单.md`、`scrolltostudy-research/05-details-and-optimizations.md` | A4、E5、E7 |
| `scrolltostudy-infinite/08-对ENDLESS的迁移方案.md`、`scrolltostudy-research/06-endless-takeaways.md` | A4（熔断）、B2、C2；第 2 节逐条修正 |
| `scrolltostudy-research/01–04` | 第 1 节概念对齐、E3 |
| `ai-mini-app-research/02-creation-pipeline.md` | A2（需求清单）；第 1 节「设计 agent → 构建简报」对照 |
| `ai-mini-app-research/03-app-contract.md`、`materials/editable-manifest.example.json` | C1 |
| `ai-mini-app-research/04-host-capabilities.md`、`materials/capability-catalog.json`、`materials/toolbox-capabilities.md` | A1、D1、E2、E4 |
| `ai-mini-app-research/01-product-overview.md`、`05-endless-takeaways.md` | C1、C2、D2、D3 |

---

## 8. 实施状态（2026-10-23）

阶段 0、1、2 的代码与测试已合入，提示词冻结为 **v16**（`apps/lab/data/prompts/FROZEN`，合并哈希 `7439ac2995cc662e`）。`pnpm typecheck`、`pnpm test`（271 项）、`pnpm lab check`、`pnpm lab smoke`（5/5 批、23 卡、V2 100%、K5 2.30）全过。

> 提示词版本说明：§5 排期里写的「提示词 v13」是计划写作时的预期版本号；实际在阶段 1 之后又走了两轮（v14 借鉴条目落地，v15/v16 是 2026-10-23 审计修复加的「每批至少一次世界状态改变 / 至少一个检测场景」两条硬规则），当前冻结版是 **v16**。版本号以 `FROZEN` 为准。

| 条目 | 落点 | 判据状态 |
|---|---|---|
| A1 示例自检 | `apps/lab/test/prompt-examples.test.ts` | ✅ 故意改回「3 选项 + recognition-4」会红（已实测） |
| A1 目录渲染 | `apps/lab/data/catalog.yaml`、`data.ts`（`renderCatalogScenes/Effects`）、`writer.md`/`single.md` 的 `{{catalog_scenes}}`/`{{catalog_effects}}`、`test/catalog.test.ts` | ✅ 逐场景示例过校验器；effect 示例字段不越界 |
| A2 名字出路 | `showrunner.ts`（`needs` + 预检解析）、`apps/lab/src/resolve.ts`、`aliases`（28 项）、`packages/esl/src/autofix.ts` 第 0 类、`director.ts`（`available_names` 短清单）、`metrics.ts` 的「名字出路」行 | ✅ 单测全覆盖；**待跑** 2×20 批 V2 ≥ 97% |
| A3 圣经对齐 | `apps/lab/src/bible-audit.ts`、`duck_detective.yaml` 的 premise 改写（`Apartment 7` → 客厅） | ✅ `lab check` 报 0 条；alias 兜底仍在 |
| A4 重试与熔断 | `packages/director/src/retry.ts`、`pipeline.ts`、`metrics.ts` | ✅ 单测（抖动不误熔断 / 429 熔断） |
| A5 短词表 | `apps/lab/src/allowed-words.ts`、`writer.md`/`single.md` | ✅ 单测钉住「表短了、判定集合没动」；**待跑** L3 与 token 读数 |
| B1 采样轴 | `apps/lab/src/sampler.ts`、`data/tropes.yaml` 的 `family`、`showrunner.md` 的 `[本批指定]`、`config/run-R3s.yaml`（`sampling: true`） | ✅ 单测（最冷格不重复、可复现、空格可枚举） |
| B2 覆盖矩阵 | `metrics.ts` 的 `coverage`（学习侧 + 内容侧）、`report.md` 的「覆盖矩阵」段 | ✅ 报告可直接回答哪些格子是空的 |
| B3 派生器 | `apps/lab/src/deriver.ts` + `pipeline.ts`（R5）；`buffersim.ts` 的 `derivePerBatch`（`--derive-fill N`） | ✅ 冒烟 23 卡 / K5 2.30；派生填空对 K4 的贡献已可量化 |
| C1 批补丁 | `packages/esl/src/patch.ts`、`lab patch`、`test/patch.test.ts` | ✅ 20o 失败谱补丁后通过；`locked` 字段被拒 |
| C2 指纹与产物 | `apps/lab/src/fingerprint.ts`、`artifacts.ts`、批次版本链 | ✅ 删 `cache/` 后 `lab metrics` 离线重算一致 |
| D1 调用策略 | `config/budget.yaml`（`requests_per_minute` / `max_tokens_per_batch` / `max_total_tokens` / `max_consecutive_failures` / `concurrency`）、`RetryingLlmClient.minIntervalMs`、`buffer-sim` 读并发 | ✅ 触顶即停；`buffer-sim` 与运行共用一份配置 |
| D2 成对盲评 | `lab render --pair <runA> <runB>`、`runs/pairs/pair-key.json` | ✅ 已能出稿；**待跑** R3 vs R5 抽 15 对 |
| D3 调度理由 | `pipeline.ts` 的 `scheduleReason`（频道三项分量 + 采样格）、`BatchRecord` | ✅ 进批次记录与 `report.json` |
| D4 长度泄露 | `validate.ts` 的 `W-OPTION-LENGTH-LEAK`（建议级） | ✅ 单测 |
| B4 / D5 / E1–E7 | — | 属实验 1，按第 5 节排期未动 |

### 与计划的偏差（3 条）

1. **A5 的「按频道 `language_affinity` 挑内容词」改为按字母序取固定前缀。** 词库没有这个维度的标注，硬做等于给每条词手写标签。字母序的好处是慢变、前缀缓存友好；K=60 不变。词库扩到方案规模（300 条）并补齐标注后应改回。
2. **D2 的命令写成 `lab render --pair`（而不是独立子命令）**，产物是 `runs/pairs/pair-*.md` + `pair-key.json`，键文件与稿件分离。
3. **阶段 1 的内部顺序（A3 → A2 → A5 → A1，每项跑一次 promptfoo）没有逐项跑**：本机没有 `ENDLESS_API_KEY`，promptfoo 与 20 批冒烟都跑不了。改动是按这个顺序做的，但**逐项验收门一次性留到有 key 之后**；如果那时读数不达标，按第 4 节的「不达预期时」列回退。
