# ENDLESS 文档索引

ENDLESS 是一个以「无尽内容流」为形态的 AI 原生语言学习产品构想：AI 负责导演娱乐节目，学习系统负责控制节目里的语言，SRS 是唯一由算法而不是 AI 决定的部分。

| 文档 | 管什么 |
|---|---|
| [`../README.md`](../README.md) | 仓库实现状态：实验 0 建设（Day 1–7）完成 + Day 8 试跑完成（提示词 v16、20 批真实冒烟 90%），快速开始与偏差记录 |
| [`edition-design.md`](./edition-design.md) | Edition 有限专题出版物的目标设计与实施审计：M0 契约基线到 M5 第二等级的工程能力（含本机 SQLite 编纂、抓取安全设施、20×10 规模夹具）；阶段出口未全部达到，证据与遗漏见 §21 |
| [`research/oss-reuse.md`](./research/oss-reuse.md) | 可复用或借鉴的开源项目：取什么、不取什么、许可证、Web 到 React Native 的迁移成本 |
| [`../reference/ai-mini-app-research/`](../reference/ai-mini-app-research/README.md) | 竞品研究：AI 生成型小程序的形态、创作流程与实现约定（Sekai），含能力目录、可编辑清单与样本矩阵 |
| [`research/reference-borrowing-plan.md`](./research/reference-borrowing-plan.md) | 参考调研（ScrollToStudy 产品与无限机制、Sekai 小程序）与实验 0 的结合计划：借什么、改成什么样、怎么判断、什么时候做 |
| [`experiments/exp-00-director-loop.md`](./experiments/exp-00-director-loop.md) | 实验 0：离线导演循环。验证内容能否持续好看、世界是否一致、学习任务是否真实执行，含 ESL v0 规范 |

> **关于 `reference/` 的链接**：该目录是本地参考材料（三份竞品调研原文），已按 `.gitignore` 排除、**不入库**。clone 本仓库后，上表第 3 行与 `research/reference-borrowing-plan.md` 头部的 `reference/...` 链接会失效——这是预期行为，不是文档错误。调研要点已提炼进 `reference-borrowing-plan.md` 正文与溯源表（第 7 节），不依赖原文也能读。

技术栈：TypeScript。先做移动端 Web App（PWA），以后迁到 React Native；实验工具与 app 共用同一组核心包（`packages/` 下已实现：esl / world / learning / director）。
