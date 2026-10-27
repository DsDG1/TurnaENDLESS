# ENDLESS 文档体系与全局索引

ENDLESS 是一个以「无尽内容流」为形态的 AI 原生语言学习产品构想：AI 负责导演娱乐节目，学习系统负责控制节目里的语言，SRS 是唯一由算法而不是 AI 决定的部分。

---

## 1. 核心架构与隔离基线（当前活跃规范）

| 文档 | 作用与管辖范围 |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | Agent 行为准则与核心红线：Key 内存安全、契约互斥隔离、单事务提交 CAS、双 Profile 构建与运行速查。 |
| [`cloud-isolation-review.md`](./cloud-isolation-review.md) | 依赖方向与运行时模块隔离基线（I-01～I-04）：原生核心解耦、游客与云端 Hook/仓库拆分、静态架构图守卫与模块证据。 |
| [`cloud-baseline.md`](./cloud-baseline.md) | 云端全量工程存证与演进基线：覆盖 C0～C4 各分轮切片（事件身份、Outbox、冲突保留、修订采用、快照恢复与真实 API 验收旅程）。 |
| [`edition-design.md`](./edition-design.md) | Edition 有限专题出版物子系统规范：M0 契约基线到 M5 第二等级工程能力、独立 SQLite 编纂流水线、安全抓取器与版权规则。 |

---

## 2. 调研与参考（机制与开源借鉴）

| 文档 | 作用与管辖范围 |
|---|---|
| [`research/reference-borrowing-plan.md`](./research/reference-borrowing-plan.md) | 竞品（ScrollToStudy、Sekai）机制提炼与落地结合计划。 |
| [`research/oss-reuse.md`](./research/oss-reuse.md) | 开源项目借鉴分析：许可证、复用边界与移动端迁移考量。 |
| [`../reference/`](../reference/) | （本地参考材料目录，按 `.gitignore` 排除不入库，要点已在上述调研中提炼）。 |

---

## 3. 历史与归档区（Archive）

| 目录/文件 | 说明 |
|---|---|
| [`archive/2026-10-25-bugfix-plan.md`](./archive/2026-10-25-bugfix-plan.md) | 2026-10-25 缺陷修复与代码质量实施计划（P0~P3 项已全部修复并通过自动化测试闭环）。 |
| [`archive/experiments/`](./archive/experiments/) | 早期实验 0（Day 1~8 离线导演循环与批量提示词验证）的过程记录、验收审计与结果报告。 |
