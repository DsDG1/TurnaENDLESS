# ENDLESS · 实验 0（离线导演循环）实现

ENDLESS 是「无尽内容流」形态的 AI 原生英语学习产品构想。本仓库是
[实验 0 方案](docs/experiments/exp-00-director-loop.md)（离线导演循环）的实现：
验证「AI 导演能否持续产出好看、一致、学习任务真实被执行的节目」，不写任何界面。

**建设状态**（对应方案第 8 节时间表的 Day 1–7）：✅ 完成。

- pnpm monorepo：四个纯 TS 核心包 + 实验 CLI（Day 0 脚手架）
- 词库 / 频道圣经 / 素材 / 谓词 / 梗分类 / 故事筛选 / 提示词 / 配置 全部落地并通过格式校验（Day 1–2）
- ESL v0：Zod 规范模型、YAML/JSON 双表层、17 种阻断码校验器、ink 子集编译与路径穷举、Runtime AST（Day 2–3，60 个正反例测试全过）
- 世界状态：双时态事实表、reducer（单值谓词自动失效、canon 拒写、选项 effect 门控）、检索打分、故事筛选（Day 4）
- 学习系统：词库加载、ts-fsrs 封装（三档评分）、BKT 能力估计、规划器 R1–R7、证据策略 S-A/S-B/S-C（Day 5）
- 导演：上下文组装器（分块 token 预算）、梗台账、两段式/单段编排、修复循环、LLM 接入（AI SDK）+ 请求哈希缓存 + Stub 模式（Day 6）
- 实验 CLI：run / render / metrics / replay / judge / srs-sim / buffer-sim / check / smoke / assert / freeze；学习者模拟器三画像；缓冲模拟；Critic 程序指标；5 批端到端冒烟通过（Day 7）
- 提示词冻结纪律落地：`lab freeze` 写 `data/prompts/FROZEN`，`lab check` 与 `lab run` 检测漂移（Day 8）
- 真实模型接入跑通：`MiniMax-M3.1-Flash` 两段式；20 批真实冒烟 18/20 通过（V2 90%，v8 + 生成后自检），数据与失败清单见 [结果文档](docs/experiments/exp-00-results.md)（Day 8）

## 快速开始

```bash
pnpm install
pnpm test            # 全部 141 个测试（esl 66 / world 12 / learning 18 / director 23 / lab 22）
pnpm lab check       # 校验全部数据文件 + 提示词冻结漂移（Day 1–2 完成标志）
pnpm lab smoke       # Stub 导演 5 批端到端冒烟（无需 API key）
pnpm lab freeze      # 冻结当前提示词（默认 v1，之后版本自动递增）
pnpm lab srs-sim     # 证据策略对照 S-A/S-B/S-C（不调 LLM，产出 L6/L7 报告）
pnpm lab buffer-sim  # 卡顿概率矩阵（K4 / H7）
pnpm lab render apps/lab/runs/smoke/batches/0001.esl.yaml   # 渲染一个批次为 Markdown
```

真实跑批（R0–R6，需要 API key，只从环境变量读取）：

```bash
# 1. 在 apps/lab/config/models.yaml 配置供应商与模型（base_url + 环境变量名）
# 2. 在 apps/lab/config/prices.yaml 填单价（未填时 K2 显示「单价未配置」，判为不可判定）
# 3. 准备运行配置（模板：apps/lab/config/run-example.yaml；冒烟：run-smoke1/20.yaml）
$env:ENDLESS_API_KEY = "..."        # 变量名以 models.yaml 的 api_key_env 为准
pnpm lab freeze                     # 跑批前先冻结提示词，否则 run 会记录哈希并警告
pnpm lab run --config apps/lab/config/run-smoke20.yaml
pnpm lab metrics apps/lab/runs/<run_id>   # 重算指标
pnpm lab judge  apps/lab/runs/<run_id>    # LLM 评审（先校准，见方案 5.12）
```

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
| 词库约 300 条（220 词义/50 词块/30 句型） | 种子版 62 条（37/15/10）+ 格式校验全过 | 扩表是内容工作（CEFR-J 底表 + compromise 生成 forms + 人工复核），流程已在方案 Day 1–2 定义；`lab check` 保证增量合规 |
| 表结构「最终用 Drizzle 定义」 | DDL 与方案 SQL 一致，驱动经 `WorldStore` 接口注入 | Drizzle schema 留到 app 阶段（PWA/RN 驱动接入时一次定义三端共用），实验不受影响 |
| Fluent Emoji Flat 约 600 个 | 种子版 86 个（含字形与标签）+ 6 个背景位置表 | 从 fluentui-emoji 元数据批量生成在 oss-reuse 待核实项 1 完成后进行 |
| N1 的 MiniLM 句向量对照 | tfidf 版 N1 已实现 | transformers.js 属重依赖，对照版留到试跑阶段按需接入 |
| promptfoo 回归矩阵（Day 8） | 配置 + 断言脚本就绪（`promptfoo/esl-assert.js` 直接把模型输出交给 `lab assert`）；矩阵从 2 模型 × 5 批样例起 | 完整「每格 20 批」要真实调用量与 API 预算；配置里的 `prompts`/`tests` 是扩表入口，不改代码 |
| 频道调度权重动态调整 | 初始权重 × 新近度 × 伏笔压力，兴趣信号已入反馈包 | 兴趣→权重的完整闭环在试跑期标定 |

## 下一步（Day 8 起）

1. 填 `config/models.yaml` 与 `prices.yaml`，冒烟一次 20 批真实生成（试跑）
2. promptfoo 小矩阵（提示词 × 模型 × 温度，每格 20 批），冻结提示词 v2（`prompts/FROZEN`）
3. 跑 R0–R6（每个运行 × 3 画像 × 60 批），S-R 回放
4. Critic：程序指标 + LLM 评审 + 评审校准；人工盲评与连续阅读（第 7.4 节）
5. 按第 9 节判定标准写 `docs/experiments/exp-00-results.md`
