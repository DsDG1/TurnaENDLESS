# 实验 0：离线导演循环（Director Loop Lab）

> 状态：**实验建设完成**（2026-10-22）——方案第 8 节 Day 1–7 的全部交付物已实现并通过测试，
> 仓库根 [`README.md`](../../README.md) 记录实现状态与建设性偏差；Day 8 起（试跑、提示词冻结、R0–R6、评审）待执行。
> 开源依赖与借鉴来源见 [`../research/oss-reuse.md`](../research/oss-reuse.md)。
> 本文所有阈值都是**初始值**，在第 8 节规定的试跑之后、正式运行之前可以调整一次，调整必须记录理由。

---

## 0. 摘要

**本实验只回答一个问题：** 在不写任何界面的前提下，一个 AI 导演能不能连续产出 60 个批次、约 200 到 240 张卡的节目，并同时做到下面五件事：

1. 第 41 到 60 批仍然好看，不明显比前 20 批差；
2. 世界不自相矛盾，角色记得以前发生过的事；
3. 学习任务真的被执行了：到期复习的条目，都以可验证的方式被检测；
4. 产出能被程序编译和校验，不需要人工修；
5. 成本和生成延迟在可接受范围内。

**形式：** 一个 TypeScript 命令行工具 `apps/lab`（pnpm monorepo，核心逻辑在 `packages/` 下）。它用模拟学习者代替真人，产出批次文件、世界状态库和指标报告，再加上人工盲评。

**周期：** 约 3 周（第 8 节）。

**产出：**

- ESL v0 规范，及其解析器、校验器、编译器；
- 世界状态存储与 reducer；
- 学习规划器与证据策略；
- 一份指标报告，以及「进入 MVP / 调整方向 / 停止」的判定。

前三项都放在独立的纯 TypeScript 包里，不依赖 Node 专有 API。实验结束后，PWA 和以后的 React Native 版本都能直接引用。

---

## 1. 为什么先做这个实验

ENDLESS 成立的前提是**内容在第 200 张时仍然好看**。这个前提和界面无关，却决定了界面值不值得做。界面开发很贵，内容实验很便宜，所以先做内容实验。

这个产品已知的失败模式有七种。本实验覆盖前五种：

| # | 失败模式 | 本实验是否覆盖 |
|---|---|---|
| F1 | **同质化**：刷到后面全是同一类随机荒诞句子 | 覆盖，头号风险 |
| F2 | **长程矛盾**：角色身份、关系、已发生事件前后不一致 | 覆盖 |
| F3 | **学习任务失真**：要么变成换皮习题，要么被娱乐淹没，到期复习没被检测 | 覆盖 |
| F4 | **不可执行**：AI 产出引用不存在的素材、答案有歧义、分支走不通 | 覆盖 |
| F5 | **又贵又慢**：生成跟不上刷的速度，或单位成本过高 | 覆盖（时延用离线模拟估计） |
| F6 | 画面与手感不吸引人 | **不覆盖**，留给实验 1 |
| F7 | 真人是否真的学会了英语 | **不覆盖**。模拟器只能检验调度逻辑是否自洽，不能证明人学会了，留给实验 2 |

---

## 2. 研究问题与假设

| 编号 | 研究问题 | 假设 | 主要指标（第 6 节） |
|---|---|---|---|
| RQ1 | 新颖度能否持续 | **H1**：两段式导演加梗台账时，第 41–60 批的人工「想看下一张」均分，比第 1–20 批下降不超过 0.5 分（5 分制） | N1–N5 |
| RQ2 | 长程一致性 | **H2**：有世界状态（双时态事实 + 伏笔表）时，矛盾率 ≤ 2%；无世界状态的基线明显更高 | C1–C3 |
| RQ3 | 学习任务能否自然融入 | **H3**：到期复习条目中 ≥ 90% 被安排了合格的检索证据；人工「习题感」均分 ≤ 2.5（越低越好） | L1–L5 |
| RQ4 | 可执行性 | **H4**：首次通过率 ≥ 80%，修复后通过率 ≥ 97% | V1–V4 |
| RQ5 | 表层编码选哪种 | **H5**：无方向假设。比较 YAML 子集和 JSON Schema 模式的通过率、token 用量和台词质量 | V1、K1、人工评分 |
| RQ6 | 弱证据要不要推进 SRS | **H6**：「二选一也算一次复习」的策略，会让 FSRS 预测的回忆率系统性高于模拟器里的真实回忆率；「按证据分级」策略的校准误差更小 | L6、L7 |
| RQ7 | 生成速度够不够 | **H7**：缓冲 2 个批次时，快刷型用户遇到卡顿的概率 ≤ 5% | K3、K4 |

---

## 3. 范围与非目标

| 在范围内 | 不在范围内 |
|---|---|
| Node + TypeScript CLI，单机运行 | 任何界面（PWA 原型留给实验 1） |
| 2 个持续频道 + 1 个即兴池 | 更多频道 |
| 6 种场景类型 + 1 种编译器派生场景 | 复杂物理小游戏、语音输入 |
| A1–A2 约 300 个学习条目 | 更高级别、多语种 |
| 模拟学习者 3 种画像 | 真人用户行为数据 |
| 文本渲染器（Markdown，用 emoji 示意画面） | 真实 SVG 合成与动画 |
| 每次调用的真实 LLM 时延与 token 记录 | 端上部署、离线包体积 |
| 人工盲评 2–3 人 | 规模化用户研究 |

---

## 4. 系统总体结构

```
                     ┌────────────────┐
                     │ Lexicon 词库   │
                     └───────┬────────┘
                             ▼
┌──────────────┐   ┌──────────────────┐    LearningBrief
│ 学习者模拟器 │──▶│ 学习规划器       │──────────────────┐
│ (隐藏真值)   │   │(ts-fsrs+能力估计)│                  │
└──────▲───────┘   └──────────────────┘                  ▼
       │                                       ┌───────────────────┐  ESL 文本  ┌────────────┐
       │              DirectorContext          │ 导演               │──────────▶│ 编译器      │
       │      ┌───────────────────────────────▶│ ① Showrunner 编剧室│◀── 修复 ──│ + 校验器    │
       │      │                                │ ② Scene Writer    │   问题单   └─────┬──────┘
       │      │                                └───────────────────┘                  │ Runtime AST
       │ ┌────┴─────────┐                                                             ▼
       │ │ 上下文组装器 │◀── 世界状态库 ◀── reducer ◀──────────────────────── 交互模拟器
       │ │              │◀── 梗台账                                                   │
       │ │              │◀── 剧情日志 / 摘要                                           │
       │ └──────────────┘◀── 故事筛选（跨频道回调）                                    │
       └────────────────────────────── 反馈包 ◀──────────────────────────────────────┘

       离线：Critic（程序指标 + LLM 评审）读取全部产出，生成报告
```

### 4.1 单个批次的循环

1. **规划**：学习规划器读取 FSRS 状态、能力估计和曝光计数，产出本批的 `LearningBrief`。
2. **选频道**：频道调度器按兴趣权重、新近度和伏笔压力选出频道，或选即兴池。
3. **组装上下文**：上下文组装器按第 5.6 节的预算，拼出 `DirectorContext`。
4. **编剧室（Showrunner）**：产出梗概、3 到 4 个节拍、出场角色、伏笔操作和自报的梗标签。
5. **预检**：程序检查梗台账重复、场景序列重复、学习任务覆盖。不合格就重来，最多 2 次。
6. **分场编剧（Scene Writer）**：把节拍展开成 ESL。
7. **编译与校验**：解析、解析素材、词汇检查、证据检查、状态检查、ink 编译。有阻断级问题就进入修复循环，最多 2 轮。
8. **交互模拟**：模拟学习者逐场「观看」，产生停留时间、选择、正误。
9. **结算**：reducer 把用户选择对应的 `effects` 写入世界状态；合格证据写入 FSRS；所有交互写入事件日志。
10. **反馈**：生成反馈包，供后续批次使用。

### 4.2 反馈延迟

真实 app 里，用户刷第 N 批时，第 N+1 批通常已经生成好了，所以第 N 批的反馈最早影响第 N+2 批。实验必须模拟这一点：配置项 `feedback_lag` 默认取 2。也就是说，生成第 N 批时，导演只能看到第 N−2 批及以前的反馈和世界状态变化。

**例外：** 用户选择造成的世界状态变化会被 reducer 立即记录。如果已经生成好的第 N+1 批和新状态冲突，要重新校验第 N+1 批；只有它的状态检查失败时才重生成。实验要统计这种情况的发生率（指标 V5）。

---

## 5. 组件设计

### 5.1 词库（Lexicon）

**原则：学习条目来自固定词库，AI 不能发明条目 ID。** AI 生成的是语境，不是条目。

**规模：** 实验用 A1–A2 共约 300 条：

- 约 220 个**词义**（不是词，同一个词的不同词义是不同条目）；
- 约 50 个**词块**（`where is`、`next to`、`I'd like`）；
- 约 30 个**句型**（`there is / there are`、一般过去时的规则变化）。

**来源：** CEFR-J Wordlist 的 A1–A2 部分作为底表；词义参照 Open English WordNet；中文释义人工写。

**ID 规范：**

| 类型 | 格式 | 示例 |
|---|---|---|
| 词义 | `lx:<lemma>#<pos>.<sense>` | `lx:behind#prep.location`、`lx:borrow#v.take-temporarily` |
| 词块 | `ck:<slug>` | `ck:where-is`、`ck:next-to` |
| 句型 | `pt:<slug>` | `pt:there-is-are`、`pt:past-regular` |

**字段：**

| 字段 | 说明 |
|---|---|
| `id` | 稳定 ID，永不复用 |
| `kind` | `sense` / `chunk` / `pattern` |
| `lemma`、`pos` | 原形与词性 |
| `forms` | 全部屈折形式，例如 `borrow, borrows, borrowed, borrowing`。词块列出全部变体，例如 `ck:where-is` 包含 `where is, where's, where are, where was, where were`。先用 compromise 自动生成，再人工复核。**词汇检查完全依赖这个列表**，运行时不做词形还原 |
| `gloss_zh` | 中文释义 |
| `cefr` | `A1` / `A2` |
| `freq_band` | 频率档，1 最常用到 5 |
| `prereq` | 前置条目，例如 `pt:past-regular` 前置若干动词 |
| `confusables` | 易混条目，例如 `lx:behind` ↔ `lx:in-front-of`、`lx:under`。生成干扰项时优先使用 |
| `facets` | 允许检测的维度：`meaning`（看懂）/ `listening`（听懂）/ `form`（拼写产出）。实验只用前两种 |
| `example` | 一条人工例句，供校验参照，不给导演看 |

**功能词白名单：** 约 150 个冠词、代词、助动词、常见介词和连词，任何时候都允许出现。

**学习者的已知词集合** = 功能词白名单 + 能力估计 ≥ 0.6 的条目的全部形式 + 频道圣经声明的专名（角色名、地名）。

### 5.2 学习者模拟器

模拟器的作用是**提供确定的交互数据，检验调度与证据逻辑是否自洽**。它不能代表真人的兴趣，所以「好不好看」只靠人工评审。

#### 5.2.1 三种画像

| 画像 | 简称 | 行为特征 | 初始知识 |
|---|---|---|---|
| P1 快刷型 | Swiper | 简单卡平均停留 4 秒；长文本有 40% 概率直接跳过；分支选择接近随机 | A1 词义中约 30% 已掌握 |
| P2 认真型 | Diligent | 停留时间长；不跳过；分支选择偏向「帮助角色」 | 约 50% |
| P3 偏科型 | Uneven | 阅读强、听力弱（听力题正确率乘 0.7） | 约 50% |

#### 5.2.2 隐藏真值模型

每个（画像，条目，维度）有一个对规划器不可见的真实记忆强度 `S_true`（单位：天）。真实回忆概率：

$$R_{true}(\Delta t) = \exp(-\Delta t / S_{true})$$

**故意选用和 FSRS 不同的遗忘曲线形式**。如果真值模型就是 FSRS，那么「FSRS 预测得准」是循环论证。

更新规则：

| 事件 | 更新 |
|---|---|
| 被动曝光（看到但未被测试） | $S_{true} \leftarrow \min(S_{true} \cdot 1.05,\ S_{cap})$ |
| 检索成功 | $S_{true} \leftarrow S_{true} \cdot (1 + a)$，$a \in [1.0, 2.0]$，按条目难度取值 |
| 检索失败 | $S_{true} \leftarrow \max(S_{true} \cdot 0.4,\ S_{min})$ |
| 同批内先看到、再被测试（被启动） | 视为短时记忆，答对概率 +0.3，**不更新** $S_{true}$ |

作答概率，其中 `g` 是该证据类型的猜对率（第 5.3 节）：

$$P(\text{correct}) = R_{true} + (1 - R_{true}) \cdot g$$

#### 5.2.3 时间模型

- **世界时钟**用累计卡片序号 `card`，世界状态里的时间全部以它为单位。
- **学习时钟**用模拟日期：每 60 张卡算一次学习时段，时段之间按 `[1, 1, 2, 1, 3, 1, 1, 4, ...]` 天推进。这样到期复习才会真正出现。
- 每张卡的停留时间按场景类型和文本长度，从对数正态分布抽样，参数由画像决定。

#### 5.2.4 分支选择

分支选项按画像偏好打分后随机抽样，种子固定，保证可复现。

### 5.3 学习规划器与证据策略

#### 5.3.1 LearningBrief 示例

```yaml
brief: lb-0042
level: A1+
introduce: []                     # 本批不引入新条目
expose:                           # 只需出现，不检测
  - {item: lx:behind#prep.location, exposures_so_far: 1, need: 1}
review:                           # 到期复习，必须有合格检索证据
  - {item: lx:under#prep.location, facet: meaning, min_evidence: recognition-4}
  - {item: ck:where-is,           facet: meaning, min_evidence: recognition-4}
vocab:
  allowed_extra: [hat, sofa, table, moon, sleep, find, steal]   # 实际由程序生成，这里只示意
  max_words_per_line: 12
  oov_budget: 0.02
avoid_before_test: ["under", "where is"]   # 在检测之前，本批不得出现这些形式
```

#### 5.3.2 规划规则

| 规则 | 内容 |
|---|---|
| R1 新条目节奏 | 每批最多引入 1 个新条目；到期复习为空时最多 2 个。新条目在被**首次检测前**，必须已累计曝光至少 2 次（可以跨批） |
| R2 复习上限 | 每批最多 3 个到期复习。优先级 = 逾期比例 × (1 − 预测回忆率) |
| R3 证据下限 | 每个到期复习必须对应至少一个合格证据，类型不低于 `min_evidence` |
| R4 防启动 | 到期复习条目在本批被检测之前，不得以任何形式出现（`avoid_before_test`）。否则检测的是短时记忆，不是间隔回忆 |
| R5 词汇预算 | 未知词（OOV）占比 ≤ 2%（不计专名和本批目标）；A1 每句 ≤ 12 词，A2 ≤ 16 词 |
| R6 干扰项 | 条目有 `confusables` 时，干扰项优先从中选 |
| R7 冲突裁决 | 学习任务和娱乐冲突时，学习任务优先，但导演可以换一种娱乐形式完成它 |

#### 5.3.3 证据类型与更新

| 证据类型 | 典型场景 | 猜对率 g | 是否写入 FSRS | 是否更新能力估计 |
|---|---|---|---|---|
| `exposure` | 台词里出现目标词 | 不适用 | 否 | 只加曝光计数 |
| `comprehension` | 看图理解剧情 | 不适用 | 否 | 弱更新 |
| `recognition-2` | 二选一、左右滑 | 0.5 | **取决于策略**（第 5.3.4 节） | 按 BKT 更新，猜对率 0.5 |
| `recognition-4` | 四选一、无提示的找东西 | 0.25 | 是：对 → Good，错 → Again | 按 BKT 更新 |
| `listening-4` | 听音频四选一 | 0.25 | 是，写入 `listening` 维度 | 按 BKT 更新 |
| `production` | 输入单词（实验阶段不生成，只预留） | ≈ 0.02 | 是：对 → Good，有拼写小错 → Hard | 按 BKT 更新 |
| `retry` | 答错后立即重试 | 不适用 | 否（该条目已记 Again） | 弱更新 |
| `practice` | 同一批内目标词已出现过，之后再被检测（包括指向本批内容的 `derive`） | 按选项数 | 否（属于短时记忆） | 弱更新 |

**FSRS 卡片的粒度是（条目，维度）。** 写入 ts-fsrs 的评分只用 Again、Hard、Good 三档，不用 Easy：单次选择题区分不出「容易」和「正常」。证据合格才产生评分，不合格的只进能力估计器。

**能力估计器**用单技能 BKT，四个参数：初始掌握 `p_init`、学会率 `p_learn`、猜对率 `p_guess`（取证据类型的 g）、失误率 `p_slip = 0.1`。它的输出用于决定「已知词集合」和新条目的引入时机，不影响 FSRS 的调度。

#### 5.3.4 证据策略对照（RQ6）

| 策略 | 规则 |
|---|---|
| S-A 宽松 | `recognition-2` 也写入 FSRS，对 → Good，错 → Again |
| S-B 分级（默认） | 按上表，`recognition-2` 不写入 FSRS |
| S-C 合并 | 同一条目连续两次 `recognition-2` 都答对，合并为一次 Good；任一次答错记 Again |

这组对照**不需要调用 LLM**：用规划器 + 抽象场景（只有证据类型，没有文本）生成合成事件流，跑 300 个条目 × 60 个模拟日。另外再在 R5 的真实产出上回放一次，作为交叉验证。

### 5.4 频道圣经（Channel Bible）

频道是一套生成规则，不是模板。每个频道一份 YAML：

```yaml
id: duck_detective
title: Duck Detective
premise: >
  A very serious duck runs a detective agency in Apartment 7.
  The cases are absurd, but the duck treats every clue with total seriousness.
tone: deadpan
humor_rules:
  - The duck never laughs. Comedy comes from taking nonsense seriously.
  - Every case has exactly one physical clue the user can find.
  - Witnesses are unreliable in a specific, consistent way.
cast:
  - {id: duck, role: detective, canon: [is_a_duck, owns_agency]}
  - {id: cat,  role: neighbour, traits: [nervous, lies_badly]}
  - {id: moon, role: client,    traits: [vain, owns_many_hats]}
locations: [agency_office, living_room, rooftop]
set_pieces: [interrogation, clue_search, accusation, false_ending]
language_affinity: [spatial_prepositions, where_questions, past_simple, because]
scene_affinity: {comic: high, hidden_object: high, story: high, chat: medium, swipe: low, pick: medium}
escalation: Every 5th batch of this channel ends with a twist that changes a fact.
canon_locked:                      # 不可变事实，reducer 拒绝改写
  - duck is_a duck
taboo: [violence_detail, real_politics, real_brands]
```

实验做两个持续频道：`duck_detective`（侦探剧，长线）和 `impossible_store`（不可能商店，物品、数量、价格、交易对话）；再加一个**即兴池**：一次性笑话、模拟 App、荒诞短篇。即兴内容不写世界状态，最多产生一个可被以后引用的「种子事件」。

**频道调度：** 默认比例为侦探剧 50%、商店 30%、即兴 20%。权重按以下因素动态调整：模拟兴趣、距该频道上次出场的卡数、该频道开放伏笔的压力。**跨频道回调只能经第 5.5.4 节的故事筛选产生**，导演不能自行发明。

### 5.5 世界状态

#### 5.5.1 表结构（SQLite）

实验里用 better-sqlite3。表结构最终用 Drizzle 定义一份，实验 CLI、PWA 和 React Native 共用，下面先用 SQL 表示。

```sql
-- 实体：角色、地点、物品、组织
CREATE TABLE entities (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  home_channel TEXT, created_card INTEGER NOT NULL, bible_ref TEXT
);

-- 事实：双时态。过时的事实被标记结束，不删除
CREATE TABLE facts (
  id INTEGER PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
  valid_from_card INTEGER NOT NULL,   -- 在世界里从哪张卡开始成立
  valid_to_card   INTEGER,            -- NULL 表示当前仍成立
  recorded_card   INTEGER NOT NULL,   -- 被记录的时间
  source_batch TEXT NOT NULL, source_scene TEXT NOT NULL,
  standing TEXT NOT NULL              -- canon / stated / rumor
);

-- 事件：不可变历史
CREATE TABLE events (
  id INTEGER PRIMARY KEY, card INTEGER NOT NULL, batch TEXT NOT NULL, channel TEXT NOT NULL,
  type TEXT NOT NULL, actors TEXT NOT NULL,          -- JSON 数组
  summary_en TEXT NOT NULL, user_choice TEXT, tags TEXT
);

-- 伏笔与故事线
CREATE TABLE threads (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,  -- open / advanced / resolved / abandoned
  owner_channel TEXT NOT NULL, opened_card INTEGER NOT NULL, last_touched_card INTEGER NOT NULL,
  priority INTEGER NOT NULL, setup TEXT NOT NULL, payoff_hint TEXT, expires_after_cards INTEGER
);

-- 关于用户的事实：用户拒绝了谁、帮助了谁
CREATE TABLE user_facts (
  id INTEGER PRIMARY KEY, predicate TEXT NOT NULL, object TEXT NOT NULL,
  card INTEGER NOT NULL, batch TEXT NOT NULL
);

-- 滚动摘要（反思）
CREATE TABLE episode_summaries (
  channel TEXT NOT NULL, from_card INTEGER NOT NULL, to_card INTEGER NOT NULL, text TEXT NOT NULL
);
```

#### 5.5.2 谓词表

谓词必须预先声明，AI 不能发明。每个谓词声明基数：

| 谓词 | 基数 | 说明 |
|---|---|---|
| `role` | 单值 | 身份：detective、president、shop_clerk |
| `location` | 单值 | 当前所在地 |
| `status` | 单值 | alive、missing、in_jail |
| `owes` | 多值 | 欠谁什么 |
| `relationship` | 多值，带对象 | friend、rival、ex |
| `suspect_status` | 单值 | none、suspect、prime_suspect、cleared |
| `owns` | 多值 | 拥有物 |

**单值谓词写入新值时，reducer 自动结束旧值。** 例如写入 `duck role shop_clerk`，会把 `duck role president` 的 `valid_to_card` 设为当前卡号。这就是 Graphiti 的「失效而不删除」，正好解决「鸭子当过总统、后来被弹劾、又成了便利店老板」的问题。

#### 5.5.3 写入纪律

- **只有 reducer 能写世界状态**，且只接受 ESL 里声明的 `effects`。
- effect 类型：`set_fact`、`end_fact`、`open_thread`、`advance_thread`、`resolve_thread`、`user_fact`。事件由 reducer 自动记录，不需要声明。
- 挂在选项上的 effect，只在模拟用户选了该选项时才执行。
- `canon_locked` 事实不能被结束或覆盖，违反即阻断。

#### 5.5.4 检索与故事筛选

| 检索内容 | 方法 |
|---|---|
| 出场角色的当前事实 | 直接查询 `valid_to_card IS NULL` |
| 出场角色的「曾经是」 | 查询最近 2 条已结束的单值事实，供台词用过去时提及 |
| 开放伏笔 | 打分 = 优先级 × 陈旧度加成 × 频道匹配，取前 3 |
| 相关历史事件 | 仿 Generative Agents：新近度衰减 + 重要度（事件类型定义）+ 相关度（与出场角色、本批目标的关键词重合），取前 5 |
| 跨频道回调候选 | **故事筛选模式**（下表），每批最多 1 个 |

故事筛选模式是一批预先写好的确定性查询。示例：

| 模式 | 查询条件 | 回调用法 |
|---|---|---|
| `rejected_returns` | `user_facts` 中有 `rejected X`，且 X 已经至少 50 张卡未出场 | X 在别的频道以新身份出现 |
| `debt_unpaid` | 存在 `owes` 事实，且已持续至少 80 张卡 | 债主在别的频道追债 |
| `missing_object` | 有物品 `status missing`，且对应伏笔已过期 | 物品出现在商店频道的货架上 |
| `role_change_echo` | 某角色单值 `role` 在最近 30 张卡内变化 | 新闻频道报道这次变化 |

**每 10 批对每个频道做一次反思：** 把这段时间的事件压缩成不超过 120 词的剧情摘要，写入 `episode_summaries`。

### 5.6 导演上下文与预算

借鉴 Letta 的「常驻记忆块」：每一块有固定的 token 上限，超出就按规则截断，而不是让上下文无限增长。

| 块 | 内容 | 上限（token） | 是否每批变化 |
|---|---|---|---|
| 系统规则 | 角色定位、ESL 规范摘要、组件目录、禁则 | 约 1500 | 否（放在前缀，便于供应商前缀缓存） |
| 频道圣经 | 第 5.4 节的 YAML | 400 | 换频道时变化 |
| 学习者画像 | 水平、偏好、最近弱项；去重、按类限量、总长度硬截断 | 150 | 慢变 |
| LearningBrief | 第 5.3.1 节 | 200 | 是 |
| 出场角色当前事实 | 第 5.5.4 节查询结果 | 300 | 是 |
| 开放伏笔 | 前 3 条 | 200 | 是 |
| 最近剧情摘要 | 本频道最新摘要 + 最近 3 批的事件一句话 | 250 | 是 |
| 跨频道回调候选 | 0 或 1 条 | 100 | 是 |
| 梗台账 | 最近 20 批用过的梗、结构和笑点类型，**明确标为禁止复用** | 200 | 是 |
| 反馈摘要 | 按 `feedback_lag` 能看到的最近反馈 | 150 | 是 |
| **合计** | | **约 3450** | |

基线 R0 不用世界状态，用「最近 3 批的 ESL 原文摘要」代替上表的事实、伏笔、摘要三块，总长度相当。

### 5.7 两段式导演

借鉴 Dramatron 的分层生成，把「想点子」和「写细节」拆开。新颖度和一致性的问题，大多在便宜的第一步就能发现。

#### 5.7.1 第一步：编剧室（Showrunner）

输出约 300 到 500 token：

```yaml
logline: "The moon hires the duck because her favourite hat is missing."
channel: duck_detective
cast: [duck, cat, moon]
beats:
  - {n: 1, scene: comic,         gist: "The moon arrives. The cat acts strangely."}
  - {n: 2, scene: hidden_object, gist: "User searches the room for the hat."}
  - {n: 3, scene: chat,          gist: "Duck asks user what to ask the moon."}
  - {n: 4, scene: story,         gist: "Accusation. User chooses who to accuse."}
thread_ops:
  - {op: open, id: cat_alibi, title: "Was the cat really asleep?"}
callback: null
tropes: [unreliable_witness, absurd_client, literal_interpretation]
punchline: deadpan_escalation
learning_placement:
  - {item: lx:behind#prep.location, beat: 1, as: exposure}
  - {item: lx:under#prep.location,  beat: 2, as: recognition-4}
  - {item: ck:where-is,             beat: 3, as: recognition-4}
hook_out: "Who stole the moon's hat?"
```

#### 5.7.2 预检（纯程序，不调用 LLM）

| 检查 | 不合格条件 |
|---|---|
| 梗重复 | `tropes` 与梗台账最近 20 批的重合率 > 1/3 |
| 结构重复 | `beats` 的场景类型序列，和最近 5 批中任一批完全相同 |
| 学习覆盖 | `learning_placement` 没有覆盖 brief 里全部的 `review` 和 `expose` |
| 防启动 | 某到期复习条目所在的节拍，排在一个会说出该词的节拍之后（按 gist 粗查，最终由校验器精查） |
| 角色合法 | `cast` 里有未知实体，且没有声明新建 |

不合格时把原因附上重新请求，最多 2 次；仍不合格就记一次「预检失败」，用最后一次结果继续。

#### 5.7.3 第二步：分场编剧（Scene Writer）

输入 = 系统规则 + 编剧室输出 + 本批涉及的角色事实 + brief 的词汇约束。输出 = 完整 ESL 批次。

#### 5.7.4 单段基线

一个提示词包含两步的全部要求，直接输出 ESL，用于 R0 和 R1。

### 5.8 ESL v0 规范

#### 5.8.1 设计原则

1. **AI 只描述创意和必要参数。** 版式、站位、气泡位置、动画、点击判定全部由运行时负责。
2. **只能引用组件目录里的东西。** 场景类型、素材、实体、谓词、ink 标签都有白名单（借鉴 A2UI 的 catalog）。
3. **世界状态的改变必须声明。** 所有改变都写在 `effects` 里，由 reducer 执行。台词本身不改变世界。
4. **学习证据必须声明。** 每个可检测的交互都带 `evidence`，编译器据此判断它是否合格。
5. **规范模型和表层编码分离。** 编译器只认规范模型，表层可以是 YAML 子集，也可以是 JSON（RQ5 的对照）。

#### 5.8.2 批次头

| 字段 | 必填 | 说明 |
|---|---|---|
| `batch` | 是 | 批次 ID，如 `dd-0042` |
| `channel` | 是 | 频道 ID 或 `improv` |
| `brief` | 是 | 对应的 LearningBrief ID |
| `cast` | 是 | 本批出场实体 ID 列表 |
| `new_entities` | 否 | 本批新建实体，需给出 `kind` 和 `name` |
| `hook_out` | 否 | 结尾悬念，一句英文 |
| `scenes` | 是 | 3 到 4 个场景（派生场景不计入上限） |

#### 5.8.3 场景通用字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 批次内唯一，如 `s1` |
| `type` | 是 | `comic` / `chat` / `swipe` / `pick` / `hidden_object` / `story` / `derive` |
| `cast` | 否 | 本场出场实体，必须是批次 `cast` 的子集 |
| `uses` | 否 | 本场**有意使用**的学习条目 ID。编译器按词库的 `forms` 在文本中定位，找不到就报错 |
| `evidence` | 否 | `{item, type}`，type 见第 5.3.3 节 |
| `effects` | 否 | 具名 effect 表，`名字: [effect, ...]`，由选项或 ink 标签引用 |

**素材引用语法：**

| 语法 | 含义 | 示例 |
|---|---|---|
| `@emoji:<name>` | 主素材库中的单个 emoji | `@emoji:top_hat` |
| `@tag:<tag>` | 按标签检索，由编译器选出具体素材 | `@tag:living_room` |
| `@char:<entity>{k=v,...}` | 组合角色：实体 + 表情 + 配件 | `@char:duck{expr=suspicious, hat=detective}` |

组合角色的可用键和值由角色规格表定义（第 5.9.3 节），例如 `expr ∈ {neutral, happy, suspicious, smug, nervous, sweating, shocked}`。

#### 5.8.4 场景类型（六种 + 派生）

**1. `comic` 多格漫画**

| 字段 | 约束 |
|---|---|
| `setting` | 素材引用 |
| `panels` | 1 到 4 格 |
| `panels[].shot` | `wide` / `medium` / `close` |
| `panels[].actors` | `@char:` 引用列表，最多 3 个 |
| `panels[].props` | 素材引用，最多 3 个 |
| `panels[].caption` | 可选旁白，≤ 12 词 |
| `panels[].bubbles` | 每格最多 2 个，`{speaker, text}`，text ≤ 12 词（A2 为 16） |

**2. `chat` 模拟聊天 App**

| 字段 | 约束 |
|---|---|
| `skin` | `messenger` / `dating` / `forum` / `news_comments` |
| `messages` | 最多 8 条，`{from, text}` |
| `reply` | 可选。用户回复选项：`options` 2 到 4 个，至多一个 `correct: true`；`on_correct` / `on_wrong` 各一条回应；每个选项可带 `effect` |
| `ink` | 可选，需要多轮分支时用，规则同 `story` |

**3. `swipe` 左右滑**

| 字段 | 约束 |
|---|---|
| `prompt` | 一句话，≤ 12 词 |
| `cards` | 2 到 6 张，`{asset, caption, side}`，`side ∈ {left, right}` 表示正确方向 |
| `mode` | `judge`（有对错，证据为 `recognition-2`）或 `preference`（表达喜好，无证据，只产生兴趣信号） |

**4. `pick` 选择**

| 字段 | 约束 |
|---|---|
| `question` | ≤ 16 词 |
| `options` | 2 到 4 个，`{label, asset?}`，恰好一个 `correct: true` |
| `hint` | 可选。**有提示时证据类型自动降一档** |
| `feedback` | `on_correct` / `on_wrong` 各一句 |

证据类型由编译器根据选项数和有无提示推导：4 个选项且无提示为 `recognition-4`，否则为 `recognition-2`。AI 声明的类型高于推导结果时，报阻断错误。

**5. `hidden_object` 找东西**

| 字段 | 约束 |
|---|---|
| `background` | 素材引用 |
| `spots` | 3 到 6 个具名位置，来自该背景的位置表（如 `sofa_behind`、`table_under`），**位置名不显示给用户** |
| `objects` | `{asset, spot, target?}`，恰好一个 `target: true`，其余是干扰物 |
| `instruction` | 一句话，必须包含目标条目的某个形式，例如 `"The hat is under something."` |
| 证据推导 | `spots` ≥ 4 时为 `recognition-4`，否则为 `recognition-2` |

**6. `story` 互动短篇（ink 子集）**

| 字段 | 约束 |
|---|---|
| `ink` | ink 脚本，最多 4 个 knot，每处选择最多 3 个选项 |
| `effects` | ink 标签 `# effect:名字` 引用的 effect 表 |

ink 子集规则：

| 允许 | 禁止 |
|---|---|
| 开头一行 `-> 入口knot`；`=== 名字 ===` knot 与 `= 名字` stitch | `INCLUDE`、`EXTERNAL` 外部函数 |
| `角色名: 台词` 形式的正文行 | `VAR` / `CONST` / `~` 赋值与临时变量：世界状态只能通过 effect 标签改变 |
| `*` / `+` 选项，选项文字写在 `[ ]` 里 | 隧道 `->->` 与线程 `<-` |
| `-` 汇合点（gather） | 指向本场景之外的 divert |
| `-> knot` 跳转，以及 `-> END` / `-> DONE` | 随机序列 `{~ ...}`（破坏可复现性） |
| 访问计数条件：`{knot名: ...}` | 不在白名单里的标签前缀 |
| 标签白名单：`# effect:名字`、`# expr:实体:表情`、`# show:素材`、`# sfx:名字`，写在正文行末尾 | |
**7. `derive` 派生场景（由编译器生成，不由 AI 写内容）**

AI 只写一行指令，编译器从已有内容自动生成一个检测场景。这是「一次生成、多种演绎」的最小实现，用于提高每次 LLM 调用产出的卡片数（指标 K5）。

```yaml
- id: s5
  type: derive
  from: s1.panels[1].bubbles[0]      # 取漫画第 2 格第 1 个气泡
  kind: cloze_pick                   # 把目标词挖空，做成四选一
  item: lx:behind#prep.location
  distractors: confusables           # 干扰项从词库的易混条目里选
```

注意：上例中 `behind` 刚在 s1 出现过，所以派生出的检测**属于练习，不算间隔回忆**。编译器会自动把证据类型标为 `practice`，不写入 FSRS（防启动规则 R4）。派生场景若要算作复习证据，`from` 必须指向**更早批次**的内容。

#### 5.8.5 完整示例（YAML 编码）

对应第 5.3.1 节的 brief：`behind` 只需曝光，`under` 和 `where is` 需要检测。

```yaml
batch: dd-0042
channel: duck_detective
brief: lb-0042
cast: [duck, cat, moon]
hook_out: "Who stole the moon's hat?"

scenes:
  - id: s1
    type: comic
    cast: [duck, cat, moon]
    uses: [lx:behind#prep.location]
    setting: "@tag:agency_office"
    panels:
      - shot: wide
        actors: ["@char:moon{expr=sad}", "@char:duck{expr=neutral, hat=detective}"]
        bubbles:
          - {speaker: moon, text: "My favourite hat is gone."}
      - shot: close
        actors: ["@char:cat{expr=sweating}"]
        bubbles:
          - {speaker: cat, text: "I was behind the door. I saw nothing!"}
      - shot: close
        actors: ["@char:duck{expr=suspicious, hat=detective}"]
        bubbles:
          - {speaker: duck, text: "Nobody asked you, cat."}

  - id: s2
    type: hidden_object
    uses: [lx:under#prep.location]
    evidence: {item: lx:under#prep.location, type: recognition-4}
    background: "@tag:living_room"
    instruction: "The hat is under something. Find it."
    spots: [sofa_behind, table_under, lamp_top, shelf_top]
    objects:
      - {asset: "@emoji:top_hat", spot: table_under, target: true}
      - {asset: "@emoji:sock",    spot: sofa_behind}
      - {asset: "@emoji:banana",  spot: lamp_top}
      - {asset: "@emoji:teapot",  spot: shelf_top}

  - id: s3
    type: chat
    skin: messenger
    cast: [duck]
    uses: [ck:where-is]
    evidence: {item: ck:where-is, type: recognition-4}
    messages:
      - {from: duck, text: "Good work. Now I must ask the moon one question."}
      - {from: duck, text: "What do I say?"}
    reply:
      options:
        - {label: "Where was your hat last night?", correct: true}
        - {label: "Who was your hat last night?"}
        - {label: "When was your hat last night?"}
        - {label: "How was your hat last night?"}
      on_correct: {from: duck, text: "Perfect. Very professional."}
      on_wrong:   {from: duck, text: "Hmm. The moon looks confused."}

  - id: s4
    type: story
    cast: [duck, cat, moon]
    effects:
      accuse_cat:
        - open_thread: {id: cat_alibi, title: "Was the cat really asleep?", priority: 2, expires_after_cards: 120}
        - set_fact: {subject: cat, predicate: suspect_status, object: prime_suspect}
      accuse_moon:
        - set_fact: {subject: moon, predicate: suspect_status, object: suspect}
        - user_fact: {predicate: accused, object: moon}
    ink: |
      -> accuse
      === accuse ===
      Duck: The hat was under the table. Someone put it there.
      Duck: Who do you think did it?
      * [The cat]
          Cat: Me? I was asleep behind the sofa! # expr:cat:shocked
          Duck: Interesting. Before, you were behind the door. # effect:accuse_cat
      * [The moon]
          Moon: I hid my own hat? Why would I do that? # expr:moon:shocked
          Duck: For attention. Classic moon. # effect:accuse_moon
      - -> END
```

这个示例同时展示了几条规则：

- **防启动**：`where` 在 s3 检测之前没有出现过。s1 的初稿里本来有一句 `"Where is my hat?"`，校验器会因为 R4 报错，所以改成了 `"My favourite hat is gone."`。
- **检测之后可以复用**：`under` 在 s2 检测之后，s4 里再次出现，这只算曝光，不影响证据。
- **伏笔来自台词矛盾**：猫先说在门后，后说在沙发后。这个矛盾是**故意的**，所以要用 `open_thread` 显式声明，否则一致性检查会把它当成错误。

#### 5.8.6 JSON 编码（RQ5 的对照组）

JSON 编码的字段和 YAML 完全一致。用 AI SDK 的 `generateObject` 加 Zod schema 约束输出（发给模型的 JSON Schema 由 `z.toJSONSchema` 生成）；供应商的端点不支持结构化输出时，退回普通文本输出，再用 Zod 解析。ink 脚本作为字符串字段放进去。

#### 5.8.7 Runtime AST

编译产物是一个扁平节点表（借鉴 A2UI 的邻接表），每个节点有 `id`、`type`、已解析的素材路径、已定位的目标词区间、证据记录、effect 列表。文本渲染器和将来的 app 运行时都只读 AST，不读 ESL。在 app 里，AST 再经一个映射层转成 json-render spec，渲染交给 json-render（见开源清单第 2.1 节）。AST 带内容哈希，便于缓存和回放。

### 5.9 编译器与校验器

#### 5.9.1 流程

1. **解析**：YAML 或 JSON 解析为规范模型。
2. **结构校验**：字段、类型、数量上限。
3. **素材解析**：`@emoji` / `@tag` / `@char` 查素材清单与角色规格表。
4. **实体与 effect 校验**：实体存在；谓词已声明；基数合法；`canon_locked` 不被触碰；每个 effect 都被引用，每个引用都存在。
5. **ink 编译**：用 inkjs 自带的编译器编译；检查标签白名单与子集禁则；再用 inkjs 运行时**穷举所有选项路径**（每场最多 4 个 knot、每处最多 3 个选项，路径数很小），确认每条路径都能到达 `END`，并收集每条路径触发的 effect。
6. **词汇检查**：分词，按词库 `forms` 归并；统计 OOV 比例与句长；定位 `uses` 中每个条目的出现位置。
7. **证据检查**：推导证据类型；答案唯一性；防启动；brief 覆盖。
8. **状态一致性检查**：台词与 effect 引用的事实和当前状态比对。
9. **生成 AST 与报告**。

#### 5.9.2 问题分级

采用两级制：**阻断级**表示内容坏了，必须修；**建议级**只记录，不阻止播放。

**阻断级：**

| 代码 | 含义 |
|---|---|
| `E-PARSE` | 无法解析 |
| `E-SCHEMA` | 字段缺失、类型错误、超出数量上限 |
| `E-ASSET-MISSING` | 素材引用找不到 |
| `E-CHAR-ATTR` | 组合角色的键或值不在规格表里 |
| `E-ENTITY-UNKNOWN` | 引用了未知实体，且未在 `new_entities` 声明 |
| `E-EFFECT-INVALID` | 谓词未声明、基数违规、引用的 effect 不存在、effect 未被引用 |
| `E-CANON` | 试图修改 `canon_locked` 事实 |
| `E-FACT-CONFLICT` | 以现在时陈述与当前事实相反的内容，且没有对应 effect 或伏笔 |
| `E-INK` | inkjs 编译失败、违反子集禁则、未知标签、knot 不可达、有路径无法到达 `END` |
| `E-ANSWER-COUNT` | 正确答案数不等于 1 |
| `E-ANSWER-DUP` | 选项重复，或干扰项与答案在词库里是同一条目的不同形式 |
| `E-EVIDENCE-OVERCLAIM` | 声明的证据类型高于推导结果 |
| `E-PRIMED` | 到期复习条目在本批被检测之前已经出现（R4） |
| `E-NEW-TESTED-EARLY` | 新条目曝光不足 2 次就被检测（R1） |
| `E-BRIEF-UNCOVERED` | brief 中某个 `review` 没有合格证据，或某个 `expose` 没有出现 |
| `E-USES-NOT-FOUND` | `uses` 声明的条目在文本中找不到 |
| `E-OOV-HIGH` | OOV 比例 > 5% |

**建议级：**

| 代码 | 含义 |
|---|---|
| `W-OOV` | OOV 比例在 2% 到 5% 之间 |
| `W-LINE-LONG` | 句子超出长度预算 |
| `W-TROPE-REPEAT` | 梗与台账重合（第 5.10 节） |
| `W-SEQUENCE-REPEAT` | 场景序列与最近 5 批之一相同 |
| `W-CAST-OVERUSE` | 同一角色在最近 10 批中出场 ≥ 8 次 |
| `W-TENSE-ENDED-FACT` | 以现在时提及已结束的事实（由评审模型标出，人工确认） |
| `W-GRAMMAR` | Harper 报告的语法问题 |
| `W-NO-HOOK` | 持续频道的批次没有 `hook_out` |
| `W-SENSE-UNSURE` | 目标词的出现可能不是声明的词义（例如 `behind` 用作「落后」），由评审模型标出 |

#### 5.9.3 素材清单与角色规格表

实验阶段不做真实画面合成，但素材引用必须真实可解析，否则实验结论无法迁移到 app。

- **素材清单**：从 Fluent Emoji 的 Flat 风格中选约 600 个，每个带 3 到 8 个英文标签。背景标签（如 `living_room`）对应一张背景描述和它的位置表。
- **角色规格表**：每个持续角色一份，声明底图 emoji、可用表情、可用配件。

```yaml
duck:
  base: "@emoji:duck"
  expr: [neutral, happy, suspicious, smug, nervous, shocked, sad]
  hat: [none, detective, crown, chef]
  props_allowed: [magnifying_glass, notebook, coffee]
```

#### 5.9.4 修复循环

1. 只把阻断问题和出问题的场景发回 AI，不重发整批（借鉴 A2UI 的结构与数据分离，局部更新）。
2. 最多 2 轮。
3. 仍失败时，丢弃该场景；如果丢弃后 brief 仍被覆盖，批次照常使用，记一次「场景丢弃」（V4）。
4. 否则整批失败，记一次「批次失败」。真实 app 中，这时会转而播放本地预制内容。

### 5.10 梗台账（Novelty Ledger）

LLM 的创意输出天然趋同，调高温度并不能解决（见开源清单第 2.9 节）。所以用确定性的台账去对抗。

**每批记录：**

- 梗标签：编剧室自报 + 评审模型从文本中抽取，统一映射到梗分类表；
- 梗概原文；
- 场景类型序列；
- 出场角色；
- 笑点类型；
- 地点。

**梗分类表**预置约 40 项，例如：字面理解、角色互换、荒诞官僚、外行误入、层层升级、旧梗回调、假结局、不可靠证人、物品拟人、规则漏洞、过度认真、错位比例、礼貌过头、误会连锁。分类表本身也是实验产物，跑完要根据评审抽取结果修订。

**使用方式：** 最近 20 批（窗口 W = 20）用过的梗和结构放进导演上下文，标为禁止复用；编剧室预检按第 5.7.2 节执行。

### 5.11 交互模拟与反馈包

```yaml
feedback: fb-0042
batch: dd-0042
persona: P1
cards: [1265, 1268]
scenes:
  - {id: s1, dwell_ms: 5200, completed: true}
  - {id: s2, dwell_ms: 9100, completed: true, evidence: {item: lx:under#prep.location, type: recognition-4, correct: true, attempts: 1}}
  - {id: s3, dwell_ms: 3900, completed: true, evidence: {item: ck:where-is, type: recognition-4, correct: false, attempts: 2}}
  - {id: s4, dwell_ms: 7400, completed: true, choice: accuse_cat}
applied_effects: [accuse_cat]
interest:                    # 由规则从停留与跳过行为中抽取，不是原始点击流
  liked_scene_types: [hidden_object, story]
  skipped_scene_types: []
summary_for_director: >
  User found the hat quickly, struggled with the where-question,
  and accused the cat.
```

反馈包借鉴 Mem0 的抽取式思路：导演看到的是抽取好的事件和兴趣信号，不是原始点击流。

### 5.12 Critic（评审）

两部分：

1. **程序指标**：第 6 节中能自动计算的全部指标。
2. **LLM 评审**：生成结束后离线运行。使用和导演不同档位的模型，温度设为 0。按评分表打分，并列出疑似矛盾。每条疑似矛盾必须引用具体事实 ID，便于人工核实。提示词见附录 D。

**评审模型需要先校准。** 在人工盲评的样本上，计算评审打分与人工打分的 Spearman 相关系数。主评分项的 ρ < 0.5 时，评审模型的打分只作参考，不参与判定。

### 5.13 时延与缓冲模拟

1. 记录每次 LLM 调用的首 token 时间、总时长、输入与输出 token 数。
2. 离散事件模拟：
   - 消费侧：按画像的停留时间分布逐卡消费；
   - 生成侧：用实测时延分布，分别模拟单任务串行（一次只跑一个生成任务）和两个任务并发；
   - 缓冲目标为 B 个批次，B 取 1、2、3；
   - 首屏条件：有 0、3、5 个预制批次。
3. 输出：卡顿概率、平均卡顿秒数、首屏等待时间。

---

## 6. 指标

### 6.1 新颖度

| 编号 | 指标 | 定义 |
|---|---|---|
| N1 | 梗概新颖度 | $1 - \max_{j \in \text{最近 } W \text{ 批}} \cos(\text{tfidf}_i, \text{tfidf}_j)$，在梗概与节拍文本上计算。另用 transformers.js 在本地计算 `all-MiniLM-L6-v2` 句向量的余弦相似度作对照。两者都不依赖外部 embedding 服务 |
| N2 | 梗复用率 | 本批梗标签中，出现在最近 W 批里的比例 |
| N3 | 结构重复率 | 场景类型序列与最近 5 批之一相同的批次占比 |
| N4 | distinct-2 | 每 10 批为一桶，英文台词中不同二元词组数 / 二元词组总数 |
| N5 | 疲劳差 | 人工「想看下一张」：第 41–60 批均分减去第 1–20 批均分 |

N1 到 N4 都按批次序号画曲线，**看趋势比看均值重要**：新颖度在第 30 批之后是否持续下滑。

### 6.2 一致性

| 编号 | 指标 | 定义 |
|---|---|---|
| C1 | 矛盾率 | 经人工确认的矛盾数 / 事实引用总数。事实引用 = ESL 中对实体当前属性的陈述数，由校验器统计；矛盾来源 = 校验器 `E-FACT-CONFLICT` + 评审模型标出并经人工确认的部分 |
| C2 | 伏笔卫生 | 已开放的伏笔中，在 `expires_after_cards` 内被推进或解决的比例；以及孤儿伏笔（开放后从未被提及）的比例 |
| C3 | 回调正确率 | 跨频道回调中，所引事件存在且描述与事件日志一致的比例，人工全量核查 |

### 6.3 学习

| 编号 | 指标 | 定义 |
|---|---|---|
| L1 | brief 覆盖率 | 有合格证据的到期复习数 / brief 中的到期复习总数（以最终播放的批次计） |
| L2 | 合格证据占比 | 所有「类似检测」的交互中，证据合格的比例 |
| L3 | OOV 分布 | 每批 OOV 比例的中位数与 P95 |
| L4 | 歧义率 | 有不止一个合理答案的检测场景占比。程序检查 + 评审模型 + 人工抽查 |
| L5 | 习题感 | 人工评分，越低越好 |
| L6 | SRS 校准 | 每次合格复习时，FSRS 预测回忆率与模拟器真实回忆率之间的 Brier 分数和 ECE（10 档） |
| L7 | 模拟保持率与效率 | 第 60 个模拟日时，所有已学条目的平均 $R_{true}$；以及每条目平均复习次数 |

### 6.4 可执行性

| 编号 | 指标 | 定义 |
|---|---|---|
| V1 | 首次通过率 | 未经修复即无阻断问题的批次占比 |
| V2 | 修复后通过率 | 修复循环结束后可播放的批次占比（含丢弃场景后仍可用的） |
| V3 | 平均修复轮数 | |
| V4 | 场景丢弃率 | |
| V5 | 状态失效重校验率 | 因反馈延迟导致已生成批次与新世界状态冲突、需要重新校验的比例；以及其中需要重生成的比例 |

### 6.5 成本与延迟

| 编号 | 指标 | 定义 |
|---|---|---|
| K1 | token 用量 | 每批、每卡的输入与输出 token，按阶段拆分（编剧室 / 分场 / 修复 / 评审） |
| K2 | 单位成本 | 每 100 张卡的费用。单价写在 `config/prices.yaml`，**文档和代码里不写死价格** |
| K3 | 生成时延 | 每阶段与每批的 P50 / P95 |
| K4 | 卡顿概率 | 第 5.13 节模拟结果 |
| K5 | 演绎倍数 | 用户可见卡片数 / LLM 调用次数（不含评审） |

### 6.6 人工评分项

5 分制，1 最差，5 最好；「习题感」反向（1 表示完全感觉不到在做题）：

| 项 | 问题 |
|---|---|
| 想看下一张 | 看完这一批，你有多想看下一批？ |
| 有趣 | 好笑、意外，或者让人好奇 |
| 英语自然 | 母语者会不会这样说 |
| 习题感 | 有多明显地感觉到「这是在考我」 |
| 一致 | 角色和世界和你之前读到的一致吗 |
| 看得懂 | 站在 A2 学习者的角度，能看懂吗 |

另有三个是非标记：发现矛盾、发现歧义、内容不适当。

---

## 7. 实验矩阵

### 7.1 内容运行

| 运行 | 导演 | 世界状态 | 梗台账 | 编码 | derive | 模型 | 目的 |
|---|---|---|---|---|---|---|---|
| R0 | 单段 | 无（用最近 3 批摘要） | 无 | YAML | 关 | 快速档 | 基线 |
| R1 | 单段 | 有 | 无 | YAML | 关 | 快速档 | 世界状态的作用（RQ2） |
| R2 | 两段 | 有 | 无 | YAML | 关 | 快速档 | 两段式的作用（RQ1） |
| R3 | 两段 | 有 | 有 | YAML | 关 | 快速档 | 梗台账的作用（RQ1） |
| R4 | 两段 | 有 | 有 | JSON | 关 | 快速档 | 编码对照（RQ5） |
| R5 | 两段 | 有 | 有 | R3 / R4 中胜出者 | 开 | 快速档 | 派生场景的作用（K5） |
| R6 | 两段 | 有 | 有 | 同 R5 | 开 | 编剧室用高档，分场用快速档 | 模型档位的作用 |

- 「快速档」和「高档」指同一供应商的两档模型，具体型号写在 `config/models.yaml`。选型标准：快速档的单批 P95 时延要满足 H7，高档用于需要更强构思能力的编剧室。
- 每个运行 × 3 个画像 × 60 批。画像通过反馈和世界状态影响后续内容，所以三条序列的内容不同。
- 每个运行的随机种子、提示词哈希、模型 ID 写入 `config.yaml`。
- **精简档**：预算紧张时，R0 和 R1 只跑 P1 画像的 30 批。

### 7.2 证据策略运行（不调用 LLM）

| 运行 | 策略 | 数据 |
|---|---|---|
| S-A | 宽松 | 合成事件流：300 条目 × 60 模拟日 × 3 画像，各 5 个种子 |
| S-B | 分级 | 同上 |
| S-C | 合并 | 同上 |
| S-R | S-A / S-B / S-C | 在 R5 的真实产出上回放 |

### 7.3 用量估算

单批估算（两段式，按 30% 的批次需要修复计）：输入约 10k token、输出约 3k token，含评审。

| 项 | 批次数 | 输入 token | 输出 token |
|---|---|---|---|
| 试跑（第 8 节第 8 天） | 约 60 | 约 0.6M | 约 0.2M |
| R0–R6 全量 | 7 × 3 × 60 = 1260 | 约 12.6M | 约 3.8M |
| 合计 | 约 1320 | 约 13M | 约 4M |

费用 = 输入量 × 输入单价 + 输出量 × 输出单价。系统规则块固定在前缀，供应商支持前缀缓存时，输入成本会明显降低。

### 7.4 人工评审规程

- **评审人**：2 到 3 人。作者本人加上 1 到 2 位与目标用户画像相近的人。
- **抽样**：每个运行抽 15 批，只取 P1 画像：第 1–20 批、21–40 批、41–60 批各 5 批。去掉运行标签，打乱顺序。
- **呈现**：用文本渲染器输出的 Markdown，emoji 代替画面，气泡和选项照常显示，尽量接近最终观感。
- **连续阅读测试**：抽样评分发现不了疲劳感。每位评审人还要**连续**读完 R3 和 R5 的第 41–60 批，读完给一个总体「想继续」分数，并写下最先觉得腻的批次号。
- **一致性**：主评分项的 Krippendorff α 目标 ≥ 0.6。达不到时，先修订评分说明，再重评一轮。
- **工作量**：7 × 15 = 105 批，每批约 2 分钟，每人约 3.5 小时；连续阅读约 1 小时。

---

## 8. 流程与时间表

| 天 | 工作 | 完成标志 |
|---|---|---|
| 1–2 | 整理词库：CEFR-J A1–A2 子集约 300 条；用 compromise 生成 `forms` 后人工复核；补 `confusables`、中文释义。整理素材清单（Fluent Emoji Flat 约 600 个 + 标签）和 3 份角色规格表 | `data/lexicon/a1_a2.yaml`、`data/assets/manifest.yaml` 通过格式校验 |
| 2–3 | ESL v0 的 Zod 规范模型；YAML 与 JSON 解析；接入 inkjs 编译与路径穷举；校验器的阻断级规则 | 手写 10 个正例、20 个反例（每个阻断码至少 1 个），全部判对 |
| 4 | 世界状态库与 reducer；谓词表；学习规划器接入 ts-fsrs | reducer 单元测试：单值谓词自动失效、canon 拒写、选项 effect 只在被选时执行 |
| 5 | 学习者模拟器；证据策略；**跑 S-A / S-B / S-C** | 第一份结果：RQ6 的结论 |
| 6 | 2 份频道圣经；梗分类表；导演提示词 v1（单段、两段、修复） | |
| 7 | 上下文组装器；修复循环；文本渲染器；冒烟测试 5 批 | 5 批端到端跑通，可渲染 |
| 8 | **试跑与提示词迭代**：用 promptfoo 跑「提示词 × 模型」小矩阵，每格 20 批。**之后冻结提示词 v2**，并在这一天定下最终阈值 | 提示词哈希写入 `prompts/FROZEN` |
| 9–10 | 跑 R0–R4 | 全部 `runs/` 产出完整 |
| 11 | 跑 R5–R6；时延与缓冲模拟；S-R 回放 | |
| 12 | Critic：程序指标、LLM 评审、评审校准、报告生成 | 每个运行一份 `report.md` |
| 13–14 | 人工盲评与连续阅读测试 | 评分表回收，α 达标 |
| 15 | 汇总，按第 9 节判定，写结论 | `docs/experiments/exp-00-results.md` |

**冻结纪律：** 第 8 天之后任何提示词、阈值或规则的修改，都必须开一个新的运行 ID，不能覆盖已有结果。

---

## 9. 判定标准

### 9.1 指标阈值

| 指标 | 初始阈值 | 不达标意味着 |
|---|---|---|
| V2 修复后通过率 | ≥ 97% | ESL 太难写，或校验太严 |
| C1 矛盾率 | ≤ 2% | 世界记忆设计不够 |
| L1 brief 覆盖率 | ≥ 90% | 学习任务被娱乐挤掉 |
| L4 歧义率 | ≤ 3% | 检测场景不可靠，会污染 SRS 数据 |
| 人工「想看下一张」第 41–60 批均分 | ≥ 3.5 | 内容不够好看 |
| N5 疲劳差 | ≥ −0.5 | 内容会腻 |
| N2 梗复用率（第 21–60 批） | ≤ 20% | 同质化 |
| L5 习题感 | ≤ 2.5 | 变成了换皮习题 |
| K4 卡顿概率（P1，缓冲 2 批，3 个预制批） | ≤ 5% | 生成速度跟不上 |
| K2 每 100 张卡成本 | ≤ `config/budget.yaml` 中的预算 | 商业上不成立 |

### 9.2 三种结论

| 结论 | 条件 | 下一步 |
|---|---|---|
| **进入 MVP** | 最佳运行（通常是 R5 或 R6）全部达标 | 开始实验 1：真机内容流原型 |
| **调整方向** | 只有一两组指标不达标 | 按下表调整，再跑一轮针对性实验 |
| **停止** | 所有变体的人工「想看下一张」第 41–60 批均分都 < 3.0，且调整后仍无改善 | 重新审视产品前提 |

| 不达标的组 | 调整方向 |
|---|---|
| 新颖度 | 引入人工编写的「梗种子库」和半预制剧情骨架，AI 负责填充与变奏，而不是从零发明 |
| 一致性 | 缩小可变世界：减少单值谓词，增加 `canon_locked`，降低每批允许的 effect 数 |
| 学习 | 提高 `derive` 的比例，让检测由编译器生成，导演只负责剧情 |
| 速度或成本 | 增加预制批次；提高演绎倍数；编剧室换更便宜的模型 |

---

## 10. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 人工评审只有 2 到 3 人，统计力弱 | 结论不稳 | 只看大差异（≥ 0.5 分）；以连续阅读测试作补充；结论里写明样本量 |
| 作者本人参与评审，带有偏向 | 高估 | 运行标签盲化；至少一位评审人不了解设计 |
| 模拟学习者和真人差距很大 | RQ6 结论不能直接迁移 | 只把 RQ6 当作调度逻辑的自洽检查；真人效果留给实验 2 |
| 评审模型与导演模型同源，互相「认可」 | 自动评分偏高 | 评审用不同档位模型；必须先校准；判定以人工为准 |
| LLM 输出不可复现 | 无法回放 | 每次调用按请求哈希缓存原始响应，回放读缓存 |
| `forms` 有遗漏，会产生假 OOV | L3 失真 | 第 1–2 天用 compromise 生成、再用词频表做覆盖检查；OOV 明细进报告，人工过目前 50 个 |
| 梗分类表本身不完善 | N2 失真 | 评审模型抽取时允许「其他」并给出自由文本，跑完后修订分类表 |
| API key 泄露 | 安全 | key 只从环境变量读取，不写入任何运行文件、日志或报告 |

---

## 11. 交付物与目录结构

```
endless/                          # pnpm workspace
  docs/experiments/
    exp-00-director-loop.md       # 本文
    exp-00-results.md             # 实验结束后写
  packages/                       # 纯 TypeScript，不得引用 Node 专有 API（fs、原生驱动）
    esl/                          # Zod 规范模型、YAML/JSON 解析、校验、编译、AST      → app 直接复用
    world/                        # Drizzle schema、存储接口、reducer、检索、故事筛选  → 复用
    learning/                     # 词库、规划器、证据策略、BKT、ts-fsrs 封装         → 复用
    director/                     # 上下文组装、两段式导演、修复循环、LLM 接入        → 复用（MVP 中放服务端）
  apps/
    lab/                          # 实验 CLI，用 tsx 运行，测试用 vitest
      src/cli.ts                  # 子命令：run / render / metrics / replay / srs-sim / buffer-sim
      src/storage/                # better-sqlite3 实现 world 包的存储接口
      src/sim/                    # 学习者模拟器、缓冲模拟（仅实验用）
      src/critic/                 # 程序指标、LLM 评审、报告（仅实验用）
      data/
        lexicon/a1_a2.yaml
        channels/duck_detective.yaml
        channels/impossible_store.yaml
        channels/improv.yaml
        assets/manifest.yaml
        assets/characters.yaml
        predicates.yaml
        tropes.yaml
        sifting_patterns.yaml
        prompts/showrunner.md, writer.md, single.md, repair.md, judge.md
      config/
        models.yaml, prices.yaml, budget.yaml
      promptfoo/                  # 提示词回归矩阵；断言直接调用 packages/esl 的校验器
      test/                       # 校验器正反例、reducer、规划器、模拟器
      runs/<run_id>/              # git 忽略
        config.yaml               # 种子、提示词哈希、模型 ID、开关
        batches/0001.esl.yaml
        batches/0001.ast.json
        batches/0001.report.json  # 校验问题、修复轮数、token、时延
        render/0001.md            # 给人工评审看的渲染稿
        world.sqlite
        feedback.jsonl
        calls.jsonl               # 每次 LLM 调用：阶段、请求哈希、token、时延
        cache/                    # 原始响应，按请求哈希存放
        metrics.json
        report.md
```

**包的边界：** `packages/` 下的四个包只依赖纯 TS 库（Zod、`yaml`、inkjs、ts-fsrs、compromise、Drizzle 查询层、AI SDK），存储驱动通过接口注入。这样 PWA（SQLite WASM）、React Native（expo-sqlite）和实验 CLI（better-sqlite3）各自提供驱动，核心代码不变。

**LLM 接入：** 用 Vercel AI SDK。JSON 编码走 `generateObject` + Zod schema；YAML 编码走 `generateText`，再用 `yaml` 解析、Zod 校验。供应商和模型写在 `config/models.yaml`，不绑定厂商。API key 只从环境变量读取。
---

## 12. 实验之后

**直接进 app 的代码：** `packages/esl`、`packages/world`、`packages/learning`、`packages/director` 原样引用。

**需要新写的：**

- `apps/web`：Vite + React + vite-plugin-pwa 的 PWA；
- 一份 json-render 组件目录，包含 6 种节目粒度的场景组件（`ComicScene`、`ChatScene` 等），props 的 Zod schema 直接复用 `packages/esl` 里的定义；
- 一个映射层，把 Runtime AST 转成 json-render spec；
- 竖向内容流和预取缓冲。

**部署上的变化：** 浏览器里不能存放 LLM 的 API key，所以 MVP 中 `packages/director` 跑在一个很薄的服务端（或边缘函数）上，只负责生成批次；世界状态、SRS、校验和播放都在端上。服务端返回的批次在端上**再校验一次**，不信任传输内容。

**迁到 React Native 时：** json-render 换 RN 渲染器，场景组件重写视图层，存储驱动换 expo-sqlite；`packages/` 下的代码和组件目录不变。

**后续实验：**

| 实验 | 问题 |
|---|---|
| 实验 1：PWA 内容流原型 | 画面与手感；首屏时间；iOS Safari 上的离线存储；真人 7 天内的留存与主动继续率 |
| 实验 2：小规模学习对照 | 学习时间大致相当时，ENDLESS 流与普通练习流的 7 天、30 天延迟记忆，测试材料不来自 AI 生成内容 |
---

## 附录 A：编剧室提示词骨架

```
[系统规则块：固定前缀]
你是 ENDLESS 的编剧室。你只负责构思，不写台词细节。
- 只能使用组件目录中的场景类型：comic, chat, swipe, pick, hidden_object, story。
- 只能使用 cast 中的实体；需要新角色时在 new_entities 中声明。
- 世界状态以 [当前事实] 为准，不要与之矛盾。已结束的事实只能用过去时提及。
- [梗台账] 中的梗和结构禁止复用。
- learning_placement 必须覆盖 [LearningBrief] 中的每个 review 和 expose。
- 到期复习条目在被检测之前不得出现。
- 输出且只输出 YAML，字段见示例。

[频道圣经] ...
[学习者画像] ...
[LearningBrief] ...
[当前事实] ...
[开放伏笔] ...
[最近剧情] ...
[回调候选] ...
[梗台账] ...
[反馈摘要] ...
[输出示例] ...
```

## 附录 B：分场编剧提示词骨架

```
[系统规则块：固定前缀，含 ESL v0 规范摘要与组件目录]
你是 ENDLESS 的分场编剧。把编剧室的节拍展开成 ESL 批次。
- 每句台词不超过 {max_words_per_line} 个词；除允许词表外尽量不用别的词。
- 每个可检测交互写明 evidence；有对错的选项恰好一个正确。
- 世界状态的任何改变都写进 effects，不要只写在台词里。
- 台词里的故意矛盾必须对应一个 open_thread。
- story 场景使用 ink 子集：只允许白名单标签，不允许 VAR 和 ~ 赋值。

[编剧室输出] ...
[本批角色事实] ...
[允许词表] ...
[角色规格表] ...
[素材标签摘要] ...
```

## 附录 C：修复提示词骨架

```
下列场景未通过校验。只修改列出的场景，其他场景保持不变。
逐条解决问题，不要引入新问题。只输出修改后的场景。

[问题单]
- s1 E-PRIMED: 到期复习条目 ck:where-is 在被检测（s3）之前，于 s1.panels[0].bubbles[0] 出现："Where is my hat?"
[原场景 s1] ...
[相关约束] avoid_before_test: ["under", "where is"]
```

## 附录 D：评审提示词与输出格式

```
你是内容评审。按评分表为这一批打分，并找出与世界事实的矛盾。
每条矛盾必须引用 [事实表] 中的 fact_id；引用不出来的不算矛盾。

[事实表] ...（含已结束事实，标明 valid_from_card / valid_to_card）
[梗分类表] ...
[批次渲染稿] ...
```

输出：

```json
{
  "scores": {"want_next": 4, "fun": 4, "natural_english": 5, "drill_feel": 2, "consistency": 5, "comprehensible": 4},
  "tropes": ["unreliable_witness", "absurd_client"],
  "tropes_other": [],
  "contradictions": [{"scene": "s4", "quote": "...", "fact_id": 118, "why": "..."}],
  "ambiguities": [{"scene": "s3", "why": "..."}],
  "sense_issues": [],
  "tense_issues": []
}
```

## 附录 E：人工评分表（每批一份）

| 项 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 想看下一张 | | | | | |
| 有趣 | | | | | |
| 英语自然 | | | | | |
| 习题感（1 = 完全感觉不到） | | | | | |
| 一致 | | | | | |
| 看得懂（A2 视角） | | | | | |

- [ ] 发现矛盾（写明场景与原因）
- [ ] 发现歧义（写明场景与原因）
- [ ] 内容不适当

备注：
