# ENDLESS 开源复用清单

> 用途：列出 ENDLESS 可以复用或借鉴的开源项目，说明每一项取什么、不取什么、为什么。
> 实验方案见 [`../experiments/exp-00-director-loop.md`](../experiments/exp-00-director-loop.md)。
>
> 许可证与项目状态于 2026-10 通过各项目主页、GitHub 仓库与 npm 页面核实。**正式引入任何一项之前，必须再读一遍该项目当时的 LICENSE 文件**，本表不能替代许可证原文。

---

## 0. 结论速览

**技术栈：TypeScript。** 先做移动端适配的 Web App（PWA），以后再迁到 React Native。实验工具也用 TypeScript 写，所以 ESL 解析器、世界状态、学习规划器这些核心代码，实验结束后可以原样搬进 app。

选型原则有两条：

1. **核心逻辑只用纯 TypeScript 包。** 纯 TS 的包在浏览器、Node 和 React Native 里都能跑，迁移时不用重写。和平台绑定的部分（渲染、动画、存储驱动、语音）集中在薄薄的一层适配里。
2. **能借思想就不引框架。** ENDLESS 的竞争力在场景协议、学习数据和导演规则，这三样必须握在自己手里。

| 层 | 直接采用（进依赖） | 借鉴思想（不进依赖） | 明确不用 |
|---|---|---|---|
| 场景运行时 / 生成式 UI | **json-render**（同一份组件目录渲染到 React 和 React Native） | A2UI 协议 | 让 AI 直接写 UI 树 |
| 叙事与分支 | **inkjs**（ink 的 JS 移植，自带编译器） | Dramatron 的分层生成、story sifting、Felt | Yarn Spinner 的 JS 移植（成熟度不足） |
| 小游戏 | 普通组件 + 手势库；专门的游戏频道再用 **Phaser** 或 **KAPLAY** | 无 | 所有场景都跑游戏引擎 |
| SRS | **ts-fsrs** | Duolingo HLR、BKT 能力估计 | 无 |
| 记忆与存储 | **SQLite**（Node / WASM / expo-sqlite）+ **Drizzle ORM** | Generative Agents、Graphiti、Letta、Mem0、World Info | Letta / Mem0 / Graphiti / LangGraph 作为依赖 |
| 结构化输出与校验 | **Zod**、**Vercel AI SDK**、`yaml` | 无 | 无 |
| 素材 | **Fluent Emoji**、**Open Peeps**、**Kenney**、**DiceBear**（自建角色风格）、Lucide / Phosphor | 无 | OpenMoji 作主素材（CC BY-SA） |
| 动画 | **Rive**（常驻角色状态机）、**Lottie**（表情与转场） | 无 | 无 |
| 语音 | Web Speech API（基线）、**kokoro-js**（浏览器内离线 TTS 候选） | 无 | Piper 进 app（GPL-3.0） |
| 语言数据与质检 | **CEFR-J**、**Open English WordNet**、**compromise**、**Harper** | wordfreq 的频率分档 | Oxford 3000 / English Vocabulary Profile |
| 评测 | **promptfoo**、**transformers.js**（本地 embedding） | 同质化研究的多样性指标 | 无 |
| 应用壳 | Vite + **vite-plugin-pwa**；以后 Expo / React Native | 无 | 无 |

---

## 1. 评估标准

每个候选项目按五条标准判断：

1. **许可证**：宽松许可（MIT / BSD / Apache-2.0 / ISC / CC0 / CC-BY）可以进 app；Share-Alike（CC BY-SA）和强 copyleft（GPL / AGPL）只能用于离线工具链，或只借思想。
2. **TypeScript 可用性**：有维护中的 npm 包、自带类型定义的优先；只有 Python 或其他语言实现的，只借思想。
3. **Web → React Native 迁移成本**：纯 TS 包两端通用；有官方 RN 版本的可以接受；只能在浏览器 DOM 或 Canvas 里跑的，只用在可以替换的边缘位置。第 5 节有汇总表。
4. **契合度**：解决的问题是否和 ENDLESS 的问题同构。很多「AI 记忆框架」解决的是聊天助手的问题，和「多元宇宙世界状态」并不同构。
5. **维护状态与 API 稳定性**：迭代很快的项目要锁定版本；正在大改 API 的项目只借思想。

---

## 2. 分层清单

### 2.1 场景运行时与生成式 UI

ENDLESS 的核心是 **ESL（Endless Scene Language）**：AI 写场景描述，编译器把它编译成严格的运行时组件树。换到 TypeScript 之后，这一层有了一个可以直接用的项目。

#### json-render（重点推荐，直接采用）

- 仓库：`github.com/vercel-labs/json-render`，Vercel Labs。
- 许可证：Apache-2.0。
- 状态：2026 年 1 月发布，迭代非常快（数月内已有约 200 个版本）。**必须锁定版本**，升级前看变更记录。
- 是什么：一个「受约束的生成式 UI」框架。用 `defineCatalog` 声明 AI 可以使用的组件和动作，每个组件的 props 用 **Zod schema** 描述；不符合 schema 的输出在校验阶段就失败，不会被渲染。**同一份组件目录可以渲染到 React、Vue、Svelte、Solid 和 React Native。**另外支持自定义指令（`defineDirective`，如 `$format`、`$math` 在渲染时求值）和 `watch`（值变化时触发动作）。
- **怎么用：AI 不直接写 json-render 的 spec，而是写 ESL；ESL 编译器产出 json-render spec，渲染交给 json-render。**
  - 组件目录里放的是**节目粒度**的组件：`ComicScene`、`ChatScene`、`SwipeScene`、`PickScene`、`HiddenObjectScene`、`StoryScene`。它们由我们自己实现，json-render 负责校验、分发和跨端渲染。
  - 这样做的好处是：PWA 阶段用 React 渲染器，迁到 React Native 时换成 RN 渲染器，**组件目录、schema 和编译器都不用改**，只重写每个场景组件的视图部分。
  - 为什么不让 AI 直接写 spec：spec 描述的是 UI 树，不懂学习证据、防启动规则和世界状态副作用。这些约束必须在 ESL 编译阶段检查。
- 取其精华的另外两点：
  - **自定义指令**：数量、价格、找零这类可计算内容，应该由指令求值，而不是让 AI 写死结果。否则「不可能商店」频道的算术错误会变成英语题的错误答案。ESL v0 先不做，列为 v1 候选。
  - **Zod 作为唯一真源**：组件 props 的 Zod schema 同时用于校验 AI 输出、生成给 LLM 的 JSON Schema（Zod 4 原生支持 `z.toJSONSchema`）、以及 TypeScript 类型推导。schema 只写一份，不会漂移。

#### A2UI（Agent-to-UI 协议，借鉴思想）

- 主页 `a2ui.org`，仓库 `github.com/google/A2UI`，Google 发起，Apache-2.0。官方渲染器有 React、Lit（Web Components）、Angular，以及 Flutter；Web 端的通用逻辑在 `@a2ui/web_core`。
- **取其精华**（这几条都写进了 ESL v0 规范）：
  - **组件目录（catalog）**：AI 只能引用目录里声明过的组件。
  - **结构与数据分离**：组件树和数据可以分别更新。对应到 ESL：场景骨架和台词可以分开生成、分开修复。
  - **扁平邻接表**：组件用 `id` 加子节点 id 列表表示，不做深度嵌套。LLM 生成扁平结构更不容易出错，也方便局部更新。
  - **缓冲后再渲染**：收到 `beginRendering` 才开始渲染。对应到 ESL：一个批次必须完整通过校验才能进入播放缓冲区。
- **为什么不直接用它**：json-render 和 A2UI 解决的是同一类问题。json-render 有官方 React Native 渲染器，且用 Zod 描述 schema，和我们的 TS 栈更贴合；A2UI 的官方渲染器列表里没有 React Native。

### 2.2 叙事、对话与分支

#### ink + inkjs（重点推荐，直接采用）

- ink：inkle 的互动叙事脚本语言，MIT，`github.com/inkle/ink`。
- **inkjs**：`github.com/y-lohse/inkjs`，ink 的 JavaScript 移植，MIT。**自带编译器**（`inkjs-compiler`），可以在 Node 和浏览器里直接把 ink 源码编译成可运行的故事，不需要 C# 工具链。纯 JS，React Native 里也能用。
- 为什么重要：**AI 不需要发明分支对话语言。** ink 是纯文本，形如剧本，主流大模型见过大量 ink 脚本。让 AI 写一个受限的 ink 子集，再由 inkjs 编译：
  - 编译失败就是阻断级错误，直接进入修复循环；
  - ink 的**标签**（`# effect:accuse_cat`）映射到 ESL 的 effect，世界状态统一由 reducer 写入；
  - ink 的**访问计数**（`{knot_name}` 在条件里返回该节点被访问过几次）天然支持「如果你之前见过鸭子」这类条件；
  - ink 的 knot / stitch / weave 结构很适合「一个节目一个 knot，内部短分支很快汇合」，正好对应 3 到 4 张卡一批、分支不能无限发散的要求。
- 子集规则见实验方案第 5.8.4 节：禁止 `VAR` 和 `~` 赋值，世界状态只能通过标签声明的 effect 改变。

#### Yarn Spinner（不采用）

- Yarn Spinner 本体是 C# / Unity，MIT。JavaScript 侧只有社区移植，成熟度和维护状态都不如 inkjs。在 TS 栈里选 ink。

#### Dramatron（DeepMind，借鉴思想）

- `github.com/google-deepmind/dramatron`，代码 Apache-2.0。
- 取其精华：**分层生成**。从一句梗概出发，依次生成角色、情节点、地点、对话，每一层都可以单独重生成或人工修改。对应到 ENDLESS 的两段式导演：
  1. **编剧室（Showrunner）**：只产出本批的梗概、节拍、出场角色和伏笔操作，几百 token；
  2. **分场编剧（Scene Writer）**：按节拍逐场写 ESL。
  新颖度和一致性检查可以在便宜的第一步完成，不合格就重来。实验方案把「单段 vs 两段」作为一个对照因子。

#### Story sifting 与 Felt（Max Kreminski 等）

- **story sifting（故事筛选）**是从大量事件日志里，用模式查询「筛」出值得讲的故事片段。这正是「宇宙频道之间互相污染」的实现方法：
  - 世界事件日志不可变；
  - 预先写一批筛选模式，例如「用户拒绝了某角色，且该角色之后至少 50 张卡没出场」；
  - 模式命中时，把这个事件作为**跨频道回调候选**交给导演。
  回调由确定性查询发现，不靠 LLM 在长上下文里自己想起来，因此可靠、可测。
- **Felt**：`github.com/mkremins/felt`，作者的 JavaScript 故事筛选器，基于 DataScript（一个支持 Datalog 查询的内存数据库）写筛选模式。
- 结论：实验阶段筛选模式直接写成 SQL 查询，模式数量少，SQL 足够。Felt 的模式写法作为参考；模式超过几十条、需要多事件的复杂时序匹配时，再评估是否直接引入 Felt。**引入前需确认 Felt 和 DataScript 的许可证。**

### 2.3 小游戏

**多数「游戏」不需要游戏引擎。** 找东西、拖动、左右滑、点选，本质上是带手势的普通组件：Web 端用 React 加手势和动画库（如 Motion、`@use-gesture`），React Native 端用 `react-native-gesture-handler` 加 `react-native-reanimated`。这样它们也能作为 json-render 目录里的普通组件，两端各写一份视图即可。

| 引擎 | 许可证 | 用法 |
|---|---|---|
| **Phaser**（`phaser.io`） | MIT | 将来做专门的游戏频道（需要物理、碰撞、关卡）时使用。React Native 中只能放进 WebView，所以只用于边缘频道 |
| **KAPLAY**（`kaplayjs.com`，原 Kaboom.js 社区续作） | MIT | 比 Phaser 轻，API 简单，适合快速做小游戏原型 |
| **Kenney 素材**（`kenney.nl`） | CC0 | 小游戏的精灵、道具、UI 音效（Interface Sounds 等） |

### 2.4 SRS 与学习者模型

#### ts-fsrs（直接采用）

- `github.com/open-spaced-repetition/ts-fsrs`，MIT，同时支持 ES Module、CommonJS 和 UMD，浏览器、Node 和 React Native 通用。
- 用法：**直接用它做调度**。ENDLESS 只需要在它前面加一层「学习证据 → 评分」的映射，详见实验方案第 5.3 节。
- 参数训练：官方的 `@open-spaced-repetition/binding` 可以从复习日志训练个性化参数。实验阶段用默认参数，MVP 之后再接训练。

#### Duolingo Half-Life Regression（HLR，借鉴思想）

- `github.com/duolingo/halflife-regression`，MIT，Python 研究代码与数据集。
- 取其精华：HLR 用「见过几次、答对几次、答错几次」和词素特征预测记忆半衰期。ENDLESS 的**隐式曝光**（看到但没被测试）不能推进 FSRS，但可以作为独立能力估计器的特征。需要时用 TS 重写，模型很简单。

#### BKT（Bayesian Knowledge Tracing，借鉴思想）

- 经典的四参数知识追踪模型：初始掌握、学会率、猜对率、失误率。pyBKT（Python）和 pyKT（深度知识追踪基准库，MIT）可作研究参考。
- 取其精华：**BKT 的「猜对率」参数正好解决左右滑的弱证据问题。** 二选一题瞎猜有 50% 正确率，BKT 会自动打折。单技能 BKT 的更新公式只有几行，用 TS 写。

### 2.5 长期记忆与存储

结论：**不引入任何记忆框架作为依赖**。Letta、Mem0、Graphiti 都是服务端系统，面向的是聊天助手的「记住用户说过什么」，抽象和 ENDLESS 的四类记忆（学习、世界、兴趣、情节）不同构。ENDLESS 的记忆必须在本地、离线可用、能被确定性代码校验。Graphiti 已有社区的 TypeScript 重写（如 `aexy-io/graphzep`），但同样只作参考。

| 项目 | 许可证 | 取其精华 | 映射到 ENDLESS |
|---|---|---|---|
| **Generative Agents**（Stanford，`joonspk-research/generative_agents`） | Apache-2.0 | **记忆流**：观察按时间入流；检索打分 = 新近度 + 重要度 + 相关度；定期**反思**，把多条记忆归纳成高层结论 | 情节日志的检索打分；每 N 批对一条故事线做一次剧情摘要 |
| **Graphiti**（Zep，`getzep/graphiti`） | Apache-2.0 | **双时态事实**：每条事实有「在世界中何时成立」和「何时被记录」两条时间线；过时事实**标记失效而不删除** | 世界状态的 `facts` 表。正好解决「鸭子当过总统、后来被弹劾」的问题 |
| **Letta**（原 MemGPT，`letta-ai/letta`） | Apache-2.0 | **常驻记忆块**：少量固定大小、始终放进上下文的记忆，加上按需检索的归档记忆 | 导演上下文里固定的「当前宇宙状态」「学习者画像」，每块有 token 上限 |
| **Mem0**（`mem0ai/mem0`） | Apache-2.0 | 抽取式记忆：从交互里**抽取**事实再存，不存原文 | 反馈包先被规则抽取成结构化事件，导演看到的是事件，不是原始点击流 |
| **SillyTavern World Info** | AGPL-3.0（**只借思想，不看不抄代码**） | 关键词触发注入：条目在关键词命中时才进上下文，带 token 预算 | 角色与地点设定：出场角色命中时注入其设定，按预算截断 |
| **AI Town**（a16z，`a16z-infra/ai-town`） | MIT，TypeScript | 多角色在同一世界中的状态与对话调度 | 参考角色「下线」后如何保持状态 |

#### 存储：三端都用 SQLite

世界状态是关系型数据（实体、事实、事件、伏笔），用 SQLite 最合适，而且三端都有成熟实现：

| 环境 | 实现 | 说明 |
|---|---|---|
| 实验工具（Node） | `better-sqlite3`，或 Node 内置的 `node:sqlite` | 同步 API，最简单 |
| PWA（浏览器） | SQLite 官方 WASM 构建 + **OPFS** 持久化 | 官方文档说明 Safari 17 以下与 OPFS VFS 不兼容，需要备选方案。iOS Safari 是主要目标平台，**这一项必须实测** |
| React Native | `expo-sqlite` | |
| 统一访问层 | **Drizzle ORM** | 原生支持 expo-sqlite 和多种 Node 驱动。**浏览器 WASM 驱动的支持情况需要实测**，不行就在浏览器端写一层薄适配 |

schema 用 Drizzle 定义一份，三端共用。

### 2.6 视觉素材

**原则：只选一套风格统一的主素材，其他素材只做补充。** 从十几万个混合风格的图标里随意挑选，画面会显得拼凑。

| 素材 | 许可证 | 规模与特点 | 用法 |
|---|---|---|---|
| **Fluent Emoji**（`microsoft/fluentui-emoji`） | MIT | 每个 emoji 有 Color、Flat、High Contrast（SVG）和 3D（PNG）几种风格；每个 emoji 目录附带元数据（含关键词）；社区有现成的 npm 打包（如 `lobehub/fluent-emoji`） | **主素材**。元数据可以直接生成标签清单（字段需确认） |
| Noto Emoji（`googlefonts/noto-emoji`） | 图片资源 Apache-2.0，字体 OFL | 完整 Unicode 覆盖 | Fluent 缺字时的备选 |
| Twemoji（`jdecked/twemoji`，社区维护分支） | 代码 MIT，图形 CC-BY 4.0 | 扁平风格 | 备选；需署名 |
| OpenMoji（`hfg-gmuend/openmoji`） | **CC BY-SA 4.0** | 4000 多个，风格统一 | **不作主素材**：Share-Alike 要求改编作品同许可，和组合角色的二次创作冲突 |
| **Open Peeps**（Pablo Stanley） | CC0 | 手绘人物「拼装套件」：头、身体、发型、表情可自由组合 | 人类角色 |
| **DiceBear**（`dicebear/dicebear`） | 代码 MIT；**各风格的许可证不同**，部分为 CC0 | 用种子确定性地生成 SVG 头像；支持自建风格（官方提供 Figma 插件导出） | **直接采用 `@dicebear/core`，用它的风格格式自建常驻角色**（鸭子、猫、月亮），部件为表情、帽子、道具。官方风格只选 CC0 的 |
| **Kenney** | CC0 | 游戏精灵、UI、音效 | 小游戏与音效 |
| Lucide | ISC（部分图标 MIT） | 线性 UI 图标 | 应用界面图标 |
| Phosphor | MIT | 多粗细 UI 图标 | 备选 |
| Iconify | 框架 MIT；**图标的许可证按图标集各自计算** | 聚合 200 多个图标集，有 React 组件 | 检索与按需加载工具；具体图标集要单独核查 |

#### 动画运行时

| 运行时 | 许可证 | Web | React Native | 用法 |
|---|---|---|---|---|
| **Rive** | 运行时 MIT | `@rive-app/canvas` / `@rive-app/react-canvas` | `@rive-app/react-native`（官方推荐） | **常驻角色的状态机**：鸭子在 idle、suspicious、happy、shocked 之间按输入切换。ESL 里的 `expr=suspicious` 直接映射为状态机输入 |
| **Lottie** | 各包许可证使用前确认 | `lottie-web`、`@lottiefiles/dotlottie-react` | `lottie-react-native` | 一次性的反应、表情和转场 |

角色的分工是：**DiceBear 负责静态组合**（哪顶帽子、哪件道具），**Rive 负责动态状态**（表情和动作切换）。实验阶段两者都不用，只校验引用是否合法。

### 2.7 语音

| 方案 | 许可证 | 说明 | 结论 |
|---|---|---|---|
| Web Speech API | 浏览器内置 | 零成本，但各系统的声音质量和可选声音差别很大 | **PWA 基线** |
| **kokoro-js** | 库的许可证需确认；Kokoro-82M 权重 Apache-2.0 | 基于 transformers.js，在浏览器里本地运行 8200 万参数的 TTS 模型 | **角色配音候选**。需实测首次下载体积、手机上的生成速度和内存占用 |
| React Native 端 | 依具体包 | 系统 TTS 封装（如 `expo-speech`）作基线 | 迁移时再定 |
| 预生成音频 | 依所用模型 | 常用台词离线批量合成后缓存 | 成本最低、质量最稳的方案，适合固定台词 |
| Piper | 原仓库已迁到 `OHF-Voice/piper1-gpl`，**GPL-3.0**；各语音模型的许可证见其模型卡 | 质量好、速度快 | **不进 app**。只可用于离线批量预生成，且需逐个核对语音模型许可证 |

### 2.8 语言数据与内容质检

| 资源 | 许可证 | 用法 |
|---|---|---|
| **CEFR-J Wordlist**（东京外国语大学 投野由纪夫） | 研究与商业用途免费，**需引用** | 学习条目的 A1–B2 分级底表 |
| `openlanguageprofiles/olp-en-cefrj` | CEFR-J 部分同上；其中 Octanove C1/C2 部分为 CC BY-SA 4.0 | 整理好的机器可读版本；C1/C2 部分注意 SA |
| Words-CEFR-Dataset（`Maximax67`） | CC BY 4.0 | 补充分级 |
| **Open English WordNet**（`globalwordnet/english-wordnet`） | CC BY 4.0 | **词义 ID 的来源**：学习条目以「词 + 词义」为单位 |
| **compromise**（`spencermountain/compromise`） | MIT | 纯 JS 的轻量英语处理：分词、词性、动词变位、名词单复数。**用来自动生成词库的 `forms` 字段**（人工复核），以及校验器的分词与词形归并 |
| **Harper**（Automattic，`automattic/harper`） | Apache-2.0 | Rust 写的离线英语语法检查器，有 WASM 版本（harper.js），可以在 Node 和浏览器里本地运行。**作为语法检查首选** |
| LanguageTool | LGPL-2.1，可自托管 | Harper 覆盖不到时的补充，只以独立服务形式调用 |
| wordfreq（`rspeer/wordfreq`） | 代码 Apache-2.0；**数据 CC BY-SA 4.0** | 只在离线工具里用于频率分档，不把数据打进 app |
| Tatoeba | 句子默认 CC BY 2.0 FR，部分 CC0；音频许可证各异 | 只作人工参考与质检对照语料 |
| Oxford 3000 / English Vocabulary Profile | 非开放许可 | **不用** |

### 2.9 LLM 接入与结构化输出

| 项目 | 许可证 | 用法 |
|---|---|---|
| **Zod**（v4） | MIT | 所有结构的唯一真源：ESL 规范模型、组件 props、LearningBrief、反馈包。v4 原生支持 `z.toJSONSchema`，可直接生成给 LLM 的 JSON Schema |
| **Vercel AI SDK**（`vercel/ai`） | 使用前确认 | 统一的多供应商接口；`generateObject` / `streamObject` 按 Zod schema 约束输出。**注意**：社区反馈 OpenAI 兼容端点的结构化输出支持程度不一，实验里要实测；不支持时退回「`generateText` + Zod 解析 + 修复循环」 |
| `yaml`（npm） | ISC | 解析 ESL 的 YAML 编码 |

模型和供应商写在配置里，不绑定特定厂商。

### 2.10 评测

- **promptfoo**（`promptfoo/promptfoo`）：开源的 LLM 提示词评测与回归 CLI。项目主页说明它现已属于 OpenAI，开源仓库仍在。它支持 JavaScript 断言和自定义 JavaScript provider，所以**可以直接调用实验工具的整条流水线**，把「提示词 × 模型 × 温度」做成矩阵跑回归，并用 ESL 校验器作为断言。
- **transformers.js**（Hugging Face）+ `all-MiniLM-L6-v2` 的 ONNX 版本：在 Node 里本地计算句向量，用于新颖度指标，不需要额外的 embedding 服务。
- **同质化研究**：近年研究显示，LLM 的创意输出彼此相似度明显高于人类，规模越大差距越大；只调温度或提示词不能消除这种差距（例如 arXiv 2501.19361 *We're Different, We're the Same: Creative Homogeneity Across LLMs*）。这直接支持实验方案把**新颖度**列为头号风险，并用确定性的「梗台账」去对抗，而不是指望调高温度。

### 2.11 应用壳

| 阶段 | 选型 | 说明 |
|---|---|---|
| 实验 0 | Node + TypeScript CLI，pnpm monorepo | 核心逻辑放在独立的包里，CLI 只是一个调用者 |
| 实验 1 / MVP | Vite + React + **vite-plugin-pwa**（MIT） | 零配置 PWA，离线缓存和安装到主屏幕 |
| 迁移 | Expo / React Native | json-render 换 RN 渲染器；场景组件重写视图层；存储换 expo-sqlite |

---

## 3. 明确不采用的项目与理由

| 项目 | 不采用的理由 |
|---|---|
| flutter/genui、rfw、Stac、jenny、Flame、Dart 版 fsrs | 技术栈改为 TypeScript。其中 genui 背后的 A2UI 思想已经吸收进 ESL |
| Yarn Spinner 的 JS 移植 | 成熟度不如 inkjs |
| LangGraph / Temporal | 服务端工作流编排。实验和 MVP 阶段，一个本地任务队列就够 |
| Letta / Mem0 / Graphiti 作为依赖 | 服务端系统；抽象面向聊天记忆，和四类记忆不同构。只借思想 |
| 所有场景都跑 Phaser | 迁到 React Native 时只能用 WebView；多数小游戏用普通组件就能做 |
| LibreLingo | AGPL-3.0；课程制产品，和无尽流的模式不同 |
| Piper 进 app | GPL-3.0 |
| OpenMoji 作主素材 | CC BY-SA 4.0 与组合二创冲突 |

---

## 4. 许可证风险矩阵

| 风险等级 | 许可证 | 涉及项目 | 规则 |
|---|---|---|---|
| 无 | CC0 | Open Peeps、Kenney、部分 DiceBear 风格 | 可直接用，建议致谢 |
| 低 | MIT / BSD / Apache-2.0 / ISC | json-render、inkjs、ts-fsrs、Phaser、KAPLAY、Zod、compromise、Harper、Rive 运行时、Fluent Emoji、Noto Emoji 图片、Lucide、Phosphor、Kokoro 权重 | 保留版权与许可证声明；Apache-2.0 注意 NOTICE 文件 |
| 中 | CC BY 4.0 | Twemoji 图形、Open English WordNet、部分 DiceBear 风格 | **必须署名**；在应用内「致谢」页列出 |
| 中 | 需引用 | CEFR-J | 致谢页与文档引用 |
| 高 | CC BY-SA 4.0 | OpenMoji、wordfreq 数据、Octanove C1/C2 | 改编作品须同许可。只在离线工具里使用，不打进 app |
| 高 | LGPL-2.1 | LanguageTool | 只以独立服务形式调用 |
| 禁止进 app | GPL-3.0 / AGPL-3.0 | Piper、SillyTavern、LibreLingo | 不进 app；SillyTavern 和 LibreLingo 只借思想、不读代码 |

---

## 5. Web → React Native 迁移对照

决定一个依赖能不能放进核心包，看它在 React Native 里能不能跑。**以下是按实现方式做的推断，尚未实测。**

| 分组 | 项目 | 迁移时怎么办 |
|---|---|---|
| 纯 TS / JS，两端通用 | inkjs、ts-fsrs、Zod、`yaml`、compromise、Drizzle 的查询层、json-render 核心、`@dicebear/core` | 不用改。**ESL、世界状态、学习规划器只能依赖这一组** |
| 有官方 RN 版本 | json-render（RN 渲染器）、Rive（`@rive-app/react-native`）、Lottie（`lottie-react-native`）、SQLite（`expo-sqlite`） | 换包，接口相近 |
| 需要验证 | Harper（WASM）、kokoro-js（依赖 onnxruntime 的 Web 版本）、transformers.js | 实验工具里只在 Node 端用，不影响 app；app 里要用时单独验证 |
| 只能在 Web 或 WebView 里跑 | Phaser、KAPLAY、Web Speech API、SQLite WASM + OPFS | 放在可替换的适配层；迁移时换实现 |

---

## 6. 待核实项

引入前必须逐条确认：

1. Fluent Emoji 每个 emoji 目录里元数据文件的确切字段，能否直接生成标签清单。
2. Vercel AI SDK、kokoro-js、Lottie 各包、Felt 与 DataScript 的许可证原文。
3. CEFR-J Wordlist 当前版本的引用格式与再分发条款（能否把整理后的子集打进 app）。
4. DiceBear 中拟采用的每个风格的单独许可证。
5. SQLite WASM + OPFS 在目标版本 iOS Safari 上的持久化表现，以及 Drizzle 对浏览器 WASM 驱动的支持。
6. 所选 LLM 供应商的 OpenAI 兼容端点对结构化输出（JSON Schema）的实际支持程度。
7. json-render 锁定版本的组件扩展能力：自定义节目粒度组件、动作回传、局部更新是否满足 ESL 运行时的需要。

---

## 附录：Turna 中可参考的已有实现

相邻的 Turna 工程（Flutter / Dart）里有几处实现，处理过 ENDLESS 也会遇到的问题。**它们不是 ENDLESS 的依赖，也不需要移植代码**，只在用 TypeScript 重写同类模块时作为行为参照：

| 位置 | 值得参照的行为 |
|---|---|
| `lib/application/ai/engine/ai_http_client.dart` | OpenAI 兼容客户端的流式输出、协作式取消、JSON Schema 被拒时自动降级为 `json_object`、有限次重试 |
| `lib/application/ai/practice/ai_practice_quality.dart` | 生成内容的两级质检：阻断级（内容坏了，修一次仍坏则失败）与建议级（只记录，不阻止使用） |
| `lib/application/ai/practice/ai_practice_job_queue.dart` | 生成任务队列：一次一个任务；进程被杀后把进行中的任务改记为「中断」；持久化写入串行化，防止迟到的进度写入覆盖终态 |
| `lib/application/ai/learner_ai_context.dart` | 把学习者状态压成提示词块：去重、按类限量、总长度硬截断 |
| `lib/core/fsrs_optimizer.dart` | 本地参数拟合与 fsrs 包逐公式镜像的纪律：升级算法包时必须同步核对公式 |
