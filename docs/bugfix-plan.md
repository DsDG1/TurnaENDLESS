# TurnaENDLESS Bug 修复与代码质量优化实施计划

- **版本**：v3（代码核验后修订，2026-10-25）
- **目标仓库**：`D:\program\Turna\TurnaENDLESS`
- **基线（实测）**：以当前工作区（含已有未提交修改）为准；`pnpm typecheck` 通过（`9 of 10 workspace projects`，全部 Done）；`pnpm test` 共 **620 项通过**（其中 apps/web 39、apps/api 101）；15 个已修改的跟踪文件，另有本计划文档未跟踪。
- **核验范围**：逐节对照代码，并用内存 SQLite、样刊数据和无头 Edge 做定向复现；本轮未运行完整 `pnpm build` / `pnpm test:e2e`，未调用真实供应商、未使用真实 Key。文中「拟新增验证」不等于已经执行。
- **修订状态**：多数问题有依据，但 v2 仍有错误补丁、过度推断和历史兼容缺口；本稿修正这些内容。涉及学习/编译契约的项目必须先通过 §2.0 的兼容决策，不能把示意片段直接当作可独立合并的补丁。修订沿革见 §6。

实施原则：

1. 严格遵守 `AGENTS.md` 的契约边界（`learningVersion: 4` 与 `edition-draft-v1` 隔离、证据策略 S-B、IndexedDB CAS 原子提交、API Key 仅驻留页面内存）。
2. 按 **P0 阻断 → P1 契约与并发 → P2 边界收敛 → P3 体验与整洁** 推进，每项自带可独立验证的回归测试。
3. 优先级以「用户可感知的阻断」和「数据正确性」排序，不以代码手法是否精巧排序。**代码整洁项不进 P1/P2**。
4. 区分「已复现缺陷」「静态代码依据」「防御性加固」「尚未启用的能力」。每个修复用例先证明修改前会失败；已经通过的互斥、CAS、Edition 文案等用例只能作为不退化验证。
5. 不原地重解释已有批次、冻结复习依据或已发行 Release。不能通过更新旧 hash/digest、清空存档、放松校验来消除兼容失败。

---

## 目录

- [阶段一（P0）：阻断级交互缺陷](#阶段一p0阻断级交互缺陷)
- [阶段二（P1）：契约、证据与并发安全](#阶段二p1契约证据与并发安全)
- [阶段三（P2）：边界条件与状态完整](#阶段三p2边界条件与状态完整)
- [阶段四（P3）：UI 细节与代码整洁](#阶段四p3ui-细节与代码整洁)
- [§5 全量验证清单](#5-全量验证清单)
- [§6 修订记录（v1 → v2 → v3）](#6-修订记录v1--v2--v3)

---

## 阶段一（P0）：阻断级交互缺陷

### 1.1 首页卡片 `<button>` 嵌套 `<EntryMenu>` 与 `<Dialog>` 事件冒泡跳转

> **v3 更正**：保留为 P0 交互问题，但删除「每次保存都会跳转」「三条链路完全不可用」的绝对化结论。Edge 实测点击弹窗输入框会跳到 `#watch`；不点击输入框、直接填值并保存则可留在 `#home`，且展示名称已落库。首页不显示改名是另一个问题，见 §3.2。

**证据**

- `apps/web/src/App.tsx:110`：`.episode-card` 是 `<button onClick={() => onSelect(episode)} disabled={busy}>`。
- `apps/web/src/App.tsx:112`：该 `<button>` 内部渲染 `<EntryMenu entry={e} player={player} />`。
- `apps/web/src/components/library.tsx:76-95`：`EntryMenu` 内部有 `<button>`、`.entry-menu-list`，以及 `DisplayEditor` / `DraftEditor` / `<Dialog>`（含 `<input>`、`<textarea>`、`<dialog>`）。
- `apps/web/src/components/library.tsx:16-17`：`<dialog>` 只做 `if (event.target === event.currentTarget) onClose()`，**未 `stopPropagation`**。

**根因**

1. 按钮嵌套按钮，违反 HTML 内容模型（React 用 `createElement` 构造 DOM，不会像 HTML 解析器那样自动闭合，非法结构真实存在）。
2. `<dialog>` 即使进入浏览器 top layer，仍是卡片 React 子树的一部分。点击输入框会冒泡到卡片 `onClick`，触发选择与导航，导致弹窗卸载。
3. 不能推断每个按钮都必然导航：保存操作会先进入 `manage()` 的同步 `pending` 锁，冒泡后的 `dispatch()` 可能被拒绝。管理页回收站的弹窗也不位于首页卡片按钮之内，不能一概称为不可用。

**改法**

1. `apps/web/src/components/library.tsx:16-22`：

```diff
   return <dialog ref={ref} className="install-dialog library-dialog" onClose={onClose}
-    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
+    onKeyDown={(event) => event.stopPropagation()}
+    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
```

2. `apps/web/src/App.tsx:110-113`：优先拆成非交互卡片容器，主打开按钮与管理菜单互为兄弟，避免用包含其他按钮的 `role="button"` 容器代替原生按钮。

```text
非交互 episode-card 容器
├─ 原生主按钮：打开内容，保留 disabled、可访问名称和键盘行为
└─ EntryMenu：独立管理按钮、菜单及弹窗
```

3. `apps/web/src/styles.css:129-130`：随结构调整布局和 hover 条件；原来的容器 `:disabled` 不再有效，应依据主按钮的真实禁用状态控制效果，并保留焦点样式。

4. `EntryMenu` 的触发按钮与菜单项补充 `disabled={player.busy}`（并入 4.3，不单独排期）。

**回归测试**（`apps/web/e2e/app.spec.ts`）

1. 已生成内容的卡片 → 打开管理菜单 → 点击输入框、编辑、点击保存 → 全程无 `#watch` 导航；展示名称已落库，刷新后仍在。该输入框点击用例必须先在修复前失败。
2. 弹窗内点击关闭、点击背景、按 Escape 均不触发卡片导航；主打开按钮仍支持鼠标、Enter、Space。
3. 首页显示新标题由 §3.2 单独验收；只修冒泡不能声称已解决展示标题问题。

---

### 1.2 Edition 复习模式选项禁用死锁

**证据**

- `apps/web/src/edition/page.tsx:266`：`review={!!review || !!state.answer}`。
- `apps/web/src/components/scenes.tsx:51`：`const showSolution = !!answer || review;`
- `apps/web/src/components/scenes.tsx:139`：`disabled={busy || showSolution}`。
- `apps/web/src/edition/page.tsx:278`：下一题 `disabled={local.busy || (getOptions(scene).length > 0 && !state.answer)}`。

**根因**

`SceneRenderer` 的 `review: boolean` 语义是「只读回看模式」。`EditionPage` 把「当前正在复习」这个业务概念塞进了该参数，作答前 `showSolution` 即为真 → 选项全禁用；「下一题」又要求 `state.answer` 存在 → 无法正常作答推进。跳过按钮仍可用，因此不是所有离开路径都被锁死。

**改法**

`apps/web/src/edition/page.tsx:266`：

```diff
-          readingItems={[]} busy={local.busy} review={!!review || !!state.answer}
+          readingItems={[]} busy={local.busy} review={false}
```

**为什么不破坏其它行为**：复习批次只由 `buildReviewBatch`（`packages/content/src/edition/run.ts:515-551`）与 `practiceOnlyScene`（`:566-576`）生成，场景类型全是 `quiz/meaning`，不含 `card`，因此 `review={false}` 不会让词卡停在未翻面状态；作答后 `state.answer` 存在，`showSolution` 自动为真，解析与正确项照常展示；`!review && entry` 的提示按钮在复习里本来就该隐藏（看过提示只算练习），此改动后需要额外用 `presentation.kind === 'review'` 兜住，见下方补充。

```diff
-        </div> : !review && entry && <div className="hint-area">
+        </div> : !review && presentation?.kind !== 'review' && entry && <div className="hint-area">
```

**回归测试**（`apps/web/e2e/edition.spec.ts`）

用已读 Run 准备可进入复习的页面状态 → 「进入复习」→ 作答前选项可用、正确项未提前标出、无提示按钮 → 点选项 → 选项锁定并显示解析、「下一题」解除禁用 → 推进到复习结束。另验证 ENDLESS 只读回看仍不显示提示按钮；不要假设首次读完任一单元后页面必然停在「进入复习」按钮处。

---

### 1.3 Edition 书架页在存在复习事件时整页崩溃

> **v2 更正**：v1 写的抛出信息 `Unknown episode: rvr_...` 有误，实际是 `存档场景顺序无效`；且不是组件级崩溃，而是落到全页错误兜底。

**证据**

- `apps/web/src/edition/page.tsx:187-189`（书架视图）：

```ts
const done = existing
  ? edition.projectRun(existing, installs, reviews).units.filter(...)
  : [];
```

- `apps/web/src/edition/page.tsx:37-39`：`reviews` 只保留 `entry.runId === run?.id`，书架态 `run === null` → `reviews` 恒为 `[]`。
- `packages/content/src/edition/run.ts:241-252`：`runLibrary` 只为传入的 `reviews` 建复习 episode；`reviews=[]` 时库里没有 `rvr_*`。
- `packages/player/src/index.ts:174`：`if (!episode || !progress || !scene || scene.id !== event.scene) throw new Error('存档场景顺序无效');`
- `apps/web/src/main.tsx:6-13`：`AppBoundary` 兜底 → 显示「页面出错了。」，整个应用 UI 不可用（数据无损）。

**触发条件**：机上有做过复习的 Run，且**刷新/重开页面后直接进 Edition 书架**（读完返回书架时 `run` 仍在 state 中，不会触发）。

**派生问题（非崩溃，是定位错误）**

- `page.tsx:202`：`const progress = done[index]` 用下标对齐 `pkg.units`。当前单一发行下顺序一致，属健壮性隐患，应按 `revisionId` 匹配。
- `page.tsx:299-307`：`firstUnread` 内层 `projectRun(run, [{release, package}], 无 reviews)` + `try/catch` → 抛错后静默返回 `0`，**不会崩**，但每次重进都会把用户丢回第 1 单元。

**改法**

1. 书架对每个 `existing` Run，从 `local.store.reviews` 按该 Run 的 ID 取完整复习修订；不能复用依赖当前阅读器 `run` 的过滤结果。
2. `startReading` / `firstUnread` 同样接收该 Run 所需的完整 installs 和 reviews，再按当前包的 `revisionId` 清单筛选；单元状态用 `revisionId` 匹配，不用数组下标。
3. 将投影结果与失败状态显式分开。投影失败时显示局部可操作错误，不把失败伪装成空进度/全部未读，也不静默跳回 0；保留存档，不进入错误的阅读位置。
4. Edition 局部错误不能把整个 ENDLESS 应用交给全页 `AppBoundary`。书架条目和 Edition 入口应有局部错误显示/兜底，原有 ENDLESS 离线播放仍可使用。

**回归测试**

1. 单元测试（扩展现有 `packages/content/test/edition-reader.test.ts`，或新增针对性测试）：构造含 `review:*` 事件的 Run，用 `reviews=[]` 调 `projectRun` 断言抛 `存档场景顺序无效`；用正确 reviews 调断言成功。此行为已定向复现。
2. E2E：读完 → 复习 → 刷新页面 → 直接进书架，断言书架正常渲染且「继续阅读」定位到正确单元。
3. 真正缺少/损坏复习修订时显示 Edition 局部错误，不能显示伪造的未读状态；ENDLESS 仍可打开，原始数据不被重置。

---

## 阶段二（P1）：契约、证据与并发安全

### 2.0 前置门禁：学习计数与确定性编译的历史兼容决策

**状态：实施前置，尚未完成。** 本节规定方案必须满足的条件，不代表已批准具体 schema 变更或数据迁移。§2.1、§2.2、§3.3、§3.4 的语义变更不得先行合并。

**已核实的影响**

- `buildReviewBasis` 把 `runExposureCounts` 的次数写入冻结的 `dueItems.exposures`（`packages/content/src/edition/run.ts:435-443`）；加载时 `assertReaderState` 重新计算并逐项比较（`reader-state.ts:137-152`）。
- 样刊第一单元相同阅读前缀下，`hot` 当前为 5 次，按场景去重后为 4 次；原地切换算法会使旧复习依据校验失败，进而阻断相关 Edition 存档加载。这不是只改统计数字。
- `validateEditionUnit` 重编译后比较批次与 creation（`validate.ts:206-229`）；去除 fact 原句、改变 uses 或 find 选项会使受影响的旧草稿/成稿不再按原版本复核通过。

**兼容决策要求**

1. 固化修改前的已读 Run、复习修订、安装包与受影响草稿作为不可变回归夹具；不在修复后用新算法重新生成这些夹具来代替旧数据。
2. 为新编译/学习策略明确版本和分派边界。优先保留旧 Run/旧修订的原版本复核与重放语义，新 Run/新修订才采用修正策略；必须决定 Run 如何绑定策略、旧数据缺版本时如何明确识别，以及备份格式如何兼容。不能仅全局修改常量后拒绝所有旧记录。
3. 旧策略兼容只服务于原有冻结数据，不得继续用旧校验为新内容绕过教学约束；已有评分不能因升级、刷新或重新导入而自动增加或减少。
4. 若要升级旧 Run，必须另立显式、可回退的迁移/新分支方案并获得确认；不改旧事件、复习正文、选项和 digest，不把旧 Release 原地变成新版。更正内容创建新修订/新 Release，并保留旧版引用。
5. §3.3 所需冻结教学目标清单及旧包的「目标信息不可用」展示也纳入本次契约决策。未知版本保持原始数据并报告不支持，不能重置，更不能影响 `endless-workspace`。

**退出条件（拟新增验证）**

- 旧版固定夹具升级后仍可加载、继续阅读、恢复复习和备份往返；已存在的事件、复习依据、评分及 Release 内容不变。
- 新版本分别通过 fact 语境、narrative uses、同场景去重和 find 确定性选项测试；旧版/新版重编译按各自版本执行。
- 当前样刊旧曝光 5 / 新曝光 4 的用例同时存在，证明版本分派有效，而不是放松复习依据比较。

### 2.1 Edition 编译中 `@fact` 的词义串混入 `narrative` 原句池

**证据**：`packages/content/src/edition/compile.ts:484`

```ts
narrative.push({ sceneId: id, text: `${form} — ${entry.glossZh}`, kind: 'comic', reference: entry.sourceRef });
```

**根因**：`@fact` 的合成串 `"form — glossZh"` 进入了「本单元叙述行」池，造成两个后果：

1. `@card`（`compile.ts:453`）会把它当成英文原句取材，词卡正面变成「单词 — 中文释义」。
2. 教学覆盖校验（`compile.ts:539-567`）把它计入 `contextScenes` 的 `fingerprints`，于是「两处语义不同的真实语境」只要 1 处真实正文 + 1 处合成词义就能通过。

**改法**：先通过 §2.0；在新编译策略中删除该行。`@fact` 已通过 `scene.uses` 与 `sources(field:'gloss')` 绑定目标词，不依赖 narrative 池。保留旧编译器对既有冻结修订的复核路径，不重写旧批次。

**验证**（`packages/content/test/edition-core.test.ts`）

- `@fact t1` + 1 处 `@reading` 语境 → 编译必须报「需要两处语义不同的真实正文语境」。
- 两处真实语境已齐备，且 `@fact t1` 排在 `@card t1` 之前 → `@card` 正面必须取真实英文原句，不得取词义串；如果 card 之前只有 fact、没有真实原句，应明确拒绝编译。现状已定向复现出 `hot — 热的` 卡面。

---

### 2.2 `scene.uses` 误收题干/干扰项；`runExposureCounts` 同场景重复计数

> **v2 更正**：**`card` 不在删除范围内**。`packages/esl/src/text.ts:67-68` 把 `card.front` 的 role 定义为 `narrative`，删掉会与 ENDLESS 侧（`packages/content/src/creative.ts:764-771` 按 `role === 'narrative'` 统计）口径相反。

**证据**

- `packages/content/src/edition/compile.ts:575-599`：`texts` 收集了 `chat.reply.options/prompt`（`:586-589`）、`pick.question + options`（`:590`）、`quiz.prompt`（`:591`）。按 `esl/text.ts:36-40 / 46-51 / 61-65`，这些是 `prompt / option / feedback`，不是 `narrative`。
- `packages/content/src/edition/run.ts:345-347`：按 `ast.targets` 逐条累加，同一 item 在同一场景出现两次（两处气泡）会 +2。

**改法（仅适用于 §2.0 批准后的新策略；不是无版本全局替换）**

```diff
     } else if (scene.type === 'chat') {
       for (const message of scene.messages) texts.push(message.text);
-      if (scene.reply) {
-        texts.push(...scene.reply.options.map((option) => option.label));
-        if (scene.reply.prompt) texts.push(scene.reply.prompt);
-      }
-    } else if (scene.type === 'pick') texts.push(scene.question, ...scene.options.map((option) => option.label));
-    else if (scene.type === 'quiz') texts.push(scene.prompt);
-    else if (scene.type === 'card') texts.push(scene.front);
+    }
+    // 只统计叙述单元：题干、干扰项、反馈里出现目标词不等于「在正文里读过」。
+    // card.front 保持计入（esl/text.ts 把它定义为 narrative）。
+    else if (scene.type === 'card') texts.push(scene.front);
```

```diff
-      for (const target of episode.ast.targets.filter((entry) => entry.sceneId === scene.id)) {
-        counts.set(target.itemId, (counts.get(target.itemId) ?? 0) + 1);
-      }
+      const items = new Set(episode.ast.targets
+        .filter((entry) => entry.sceneId === scene.id).map((entry) => entry.itemId));
+      for (const itemId of items) counts.set(itemId, (counts.get(itemId) ?? 0) + 1);
```

**验证**

- `pick`/`quiz`/`chat.reply` 题干含目标词、正文不含 → 该场景 `uses` 不得包含该词。
- 同一场景两处正文含同一目标词且完成阅读 → `runExposureCounts` 对该词 +1（不是 +2）。
- 旧 Run 中已冻结复习依据仍使用其原策略；新策略不改变旧复习资格、正文或评分。夹具与升级测试见 §2.0。

---

### 2.3 `autoFixBatch` 误删 `pick` 场景被引用的 `effects`

> **v2 更正**：v1 把 `cast` 去重列为同一缺陷。`packages/esl/src/validate.ts:156-161` 并**不**禁止 `cast` 重复，重复 `cast` 没有可观察故障（UI 角色栏取的是 `creativeSeries[...].cast`，不是批次 cast），只是数据洁癖 → 降级到 4.5。

**证据**

- `packages/esl/src/model.ts:159-170`：`PickScene.options` 有 `effect?: string`。
- `packages/esl/src/autofix.ts:212-234`：`referenced` 只从 `chat.reply.options`（`:216-221`）与 ink 标签（`:222-226`）收集。

**后果**：模型给 `pick` 选项写了 `effect`，并声明了同名 `scene.effects`，`autoFixBatch` 判定「没人引用」→ 删除 `effects` → 该选项 `effect` 变成悬空引用，进入 `E-EFFECT-INVALID` 或世界状态静默丢失。

**改法**

```diff
     if (scene.type === 'chat' && scene.reply) {
       for (const o of scene.reply.options) {
         const eff = (o as { effect?: string }).effect;
         if (eff) referenced.add(eff);
       }
     }
+    if (scene.type === 'pick') {
+      for (const o of scene.options) {
+        const eff = (o as { effect?: string }).effect;
+        if (eff) referenced.add(eff);
+      }
+    }
```

**验证**（`packages/esl/test/autofix.test.ts`）：`pick` 选项引用 `e1`、场景声明 `effects: { e1 }` → autofix 后 `e1` 仍在；未被任何选项/ink 引用的 `e2` 仍被删除。

---

### 2.4 统一修订的「计划时间」，并修正预览取修订的来源

> **v2 重大更正**：v1 提议把 `revisionToDocument` / `basisPrefix` 的 `generatedAt` 从 `revision.plannedAt` 改成 `revision.basis.plannedAt`。**方向错误，会伤存量数据**，见下。

**事实链**

| 位置 | 值 | 含义 |
|---|---|---|
| `apps/api/src/generate.ts:53-54` | `generatedAt = now()`，随后 `planCreative(..., generatedAt)` | **真实计划时间** |
| `packages/content/src/workspace.ts:447` | `plannedAt: document.generatedAt` | 修订的 `plannedAt` **等于**真实计划时间 |
| `packages/content/src/workspace.ts:373` | `ticket.basis.plannedAt = reserveTicket(now)` | **预留票据时间**，早于生成 |
| `packages/content/src/index.ts:369 / 478` | `planCreative(..., new Date(document.generatedAt))` | 复核时按真实计划时间重算 brief |

所以 `revision.plannedAt` 才是复现学习任务的正解；`basis.plannedAt` 是票据预留时刻，两者可能跨过 FSRS 到期边界（`Planner.nextBrief(now)` 依赖 `now` 选 due 复习词）。

**需要处理的事项**

1. `packages/content/src/revision.ts:61` 与 `:66` 用 `head.basis.plannedAt` 重建任务与预览文档；而 `:86` 落库的 `plannedAt` 是 `head.plannedAt`。→ 预览按 A 时刻编译、采用后 `bridge()` 按 B 时刻复核，跨到期边界时「预览通过、采用即报错」。
2. `packages/content/src/revision.ts:51` 与 `apps/web/src/components/library.tsx:43-46`：预览函数和编辑器草稿初始化都取 `entry.headRevisionId`，而不是当前分支实际采用的修订。必须两侧一起修，不能让编辑器显示 A 分支草稿、预览却按 B 分支依据编译。
3. `packages/content/src/workspace.ts:339`（`forkForRevision`）改写原生成依据的 `branchId`。新分支复制相同前缀时未必立即造成 hash 失配，因此不能称为已复现的数据损坏；仍应保留原溯源，并验证分叉前缀与依据一致。

**改法**

```diff
@@ revision.ts:56-62 previewRevision
-    const head = workspace.revisions.find((r) => r.id === entry.headRevisionId);
+    const active = workspace.branches.find((b) => b.id === workspace.activeBranchId);
+    const adoptedId = active?.adopted.find((a) => a.contentId === entry.id)?.revisionId;
+    const head = workspace.revisions.find((r) => r.id === adoptedId);
...
-  // 复现学习任务必须用生成当时的计划时间（basis.plannedAt），不是文档生成时间
-  const task = content.planCreative(prefix.session, prefix.library, new Date(head.basis.plannedAt));
+  // 复现学习任务必须用生成当时的计划时间：修订的 plannedAt 就是生成时的 document.generatedAt。
+  // basis.plannedAt 是票据预留时刻，跨过 FSRS 到期边界会算出不同 brief。
+  const task = content.planCreative(prefix.session, prefix.library, new Date(head.plannedAt));

@@ revision.ts:65-67 预览文档
-    version: 1, generatedAt: head.basis.plannedAt,
+    version: 1, generatedAt: head.plannedAt,

@@ workspace.ts:335-340 forkForRevision
-    basis: { ...revision.basis, branchId },
+    basis: { ...revision.basis },
```

`revisionToDocument`（`workspace.ts:38`）与 `basisPrefix`（`revision.ts:27`）**保持 `revision.plannedAt` 不变**。

上述查找应抽成共享的当前分支修订解析逻辑，同时供 `DraftEditor` 的草稿初始化、已交互判定和 `previewRevision` 使用；当前分支未采用该内容时禁用正文编辑并说明原因，不回退到其他分支的全局 head。弹窗期间分支/采用修订发生变化时，废弃旧预览并提示重新打开或解决冲突，不能静默覆盖用户已编辑的草稿。

**遗留清理（可选，不做也不影响正确性）**：`GenerationBasis.plannedAt` 在 2.4 之后不再参与任何计划计算，建议加注释说明它为「票据预留时刻」，或后续版本弃用。

**验证**（扩展现有 `packages/content/test/workspace.test.ts`，或拟新增 `revision.test.ts`）

- 构造 `head.plannedAt` 与 `head.basis.plannedAt` 跨过某词 FSRS 到期时刻的修订 → `previewRevision` 通过后 `adopt` + `bridge()` 必须仍然通过。
- 在 `activeBranchId` 指向分支 B、`entry.headRevisionId` 指向分支 A 且两份 draft 不同时，编辑框必须显示 B 的 draft，预览与采用都以 B 的 adopted 为基准；切分支后旧预览不能继续采用。
- `forkForRevision` 后 `registered.basis.branchId` 必须等于原修订的 `basis.branchId`。

---

### 2.5 `use-player.ts` 中 `resume` 恒真、票据恢复与合并提交

**证据（`apps/web/src/use-player.ts`）**

- `:187` 与 `:195` 都写 `currentTicket.current = ticket`，`:197` 却用 `!!currentTicket.current` 作 `resume` → 恒为 `true`。
- `resume` 的唯一用途是 `apps/web/src/api.ts:33`：`if (!apiKey && !status.configured && !resume) throw`。恒真 → 这条前置校验永久失效（服务端仍会按 `auth` 失败，只是错误文案从「请先输入 Key」变成「模型认证失败」）。
- 恢复 `reserved` 票据的分支（`:190-194`）没有先流转 `submitted`；`markTicketSubmitted`（`workspace.ts:381-390`）会拒绝非 `reserved` 状态，因此只能在 `reserved` 时调用。
- `:215` 与 `:221` 分两次 `commit`（先落结果、再落 select），中间失败会留下「已采用但未选中」的中间态。
- `:288` `importBackup` 只有 `if (!repo) return false`，未与 `pending.current` / `currentTicket.current` 互斥。

**改法**

```diff
     try {
+      const isResume = !!currentTicket.current;
       let ticket = currentTicket.current;
...
-        const submitted = markTicketSubmitted(committed, ticket.id);
-        if (!(await commit(submitted))) return false;
       } else { ... }
+      if (ticket.status === 'reserved') {
+        const submitted = markTicketSubmitted(current.current!, ticket.id);
+        if (!(await commit(submitted))) return false;
+        ticket = current.current!.tickets.find((t) => t.id === ticket!.id)!;
+      }
       currentTicket.current = ticket;
-      const result = await generateEpisode(request, setPhase, abort.signal, apiKey, !!currentTicket.current);
+      const result = await generateEpisode(request, setPhase, abort.signal, apiKey, isResume);
...
-      if (!(await commit(next, { closingTicketId: ticket.id }))) return false;
-      currentTicket.current = null;
-      // 选中新内容
       const adopted = next.branches.find((b) => b.id === next.activeBranchId)!;
       const episodeId = next.revisions.find((r) => r.id === adopted.adopted.at(-1)!.revisionId)!.episodeId;
       const selected = applyPlayerCommand(content, next, { type: 'select', episode: episodeId });
-      await commit(selected);
+      if (!(await commit(selected, { closingTicketId: ticket.id }))) return false;
+      currentTicket.current = null;
```

`importBackup` 增加互斥：

```diff
-    if (!repo) return false;
+    if (!repo || pending.current || currentTicket.current) return false;
+    pending.current = true;
+    setSaving(true);
...
     } finally {
       await repo.clearStaging().catch(() => {});
+      pending.current = false;
+      setSaving(false);
     }
```

**验证**：拟新增 hook/客户端集成测试（如 `apps/web/test/use-player.test.tsx`）；事务部分补 storage 测试，但仅测 storage 不能证明 resume 参数或 HTTP 提交行为正确。

- 首次生成无 Key 且服务端未配置 → 报「请先在网页输入自己的 API Key」，不发送生成 POST；`apiStatus()` 的配置检查请求仍可能发生。已有服务端任务无 Key 可恢复轮询，不能因修正首次提交检查而破坏恢复路径。
- 落库为 `reserved` 的票据恢复生成 → 提交后被 `markTicketSubmitted` 流转，最终只有一次 `commit` 关闭票据。
- 导入备份期间触发生成 → 生成被拒绝且不产生半份数据。

---

### 2.6 `WorkspaceRepository.commit` 落实验证 `options.closingTicketId` 写锁

> **v2 更正**：v1 补丁引用了不存在的类型 `ObjectRow`，且按 `o.data.status` 读取状态；本仓库的行形状是 `{ kind: 'ticket', ...ticket }`（`storage.ts:45-49`），状态在 `o.status`。照抄无法编译。

**证据**：`apps/web/src/storage.ts:106-149`——`commit(next, options)` 声明了 `options: { closingTicketId?: string }`，函数体内**从未引用**。`storage.ts` 文件头注释（`:9`）承诺「进行中生成任务冻结其它写入口」，实际只有内存侧检查 `openTickets.length > 1`（`:128-133`）。

**后果**：另一个标签页/并发路径可以把库内 `reserved` 票据直接覆盖掉而不传 `closingTicketId`——票据凭空消失，服务端任务失去本地锚点，用户也失去「取消/重试」入口。

**v3 更正**：v2 补丁仍残留 `status === 'committed'`，会产生 TS2367，绕过类型后也会拒绝正常成功收尾；同时 `stillOpen` 就放行整个 workspace，不能实现任务冻结。因此删除这份不完整补丁，改为先定义并测试事务内的允许转换。

**改法**

1. 在同一 IndexedDB readwrite 事务中读取已保存的 meta、票据及必要的工作区对象，先检查 CAS，再对比已保存状态与拟写入状态；校验成功后才执行 clear/put。不能只查 `next.tickets`。
2. 票据状态只使用 `reserved | submitted | succeeded | failed | cancelled`（`application-contract.ts:386`）。成功终态判定必须包含 `succeeded`，不存在 `committed`。
3. 明确允许转换及写入范围：

| 库内状态 | 拟提交 | 条件 |
|---|---|---|
| 无进行中票据 | 普通命令或预留一个新票据 | 保留原有契约校验、CAS 与单任务限制 |
| `reserved` | 同一票据变 `submitted` | 仅允许提交状态转换；生成依据、分支历史及其他内容不变 |
| `reserved/submitted` | 同一票据变 `succeeded` | `closingTicketId` 精确匹配，结果/修订/条目/采用关系绑定该票据并原子提交；包括 §2.5 的结果选择 |
| `reserved/submitted` | 同一票据变 `failed/cancelled` | `closingTicketId` 精确匹配，保留票据记录，不能夹带无关内容或事件变更 |
| `reserved/submitted` | 删除/替换票据、改依据，或保持开票但更新事件/管理内容/导入 | 拒绝；票据还存在不代表其他写入已获许可 |

4. `closingTicketId` 只是合法转换的标识，不是标签页所有权凭证；不要声称仅检查该 ID 就能识别任务拥有者。其他标签页不能借保留票据来写入；恢复/取消同一任务应是显式用户操作。若需要严格区分拥有者与接管者，必须先设计额外的所有权/接管协议。
5. 同步调整调用方与现有 storage 测试：当前取消用例未传 `closingTicketId`，落实新校验后必须显式传入，而不是放松校验维持旧测试。

**验证**（`apps/web/test/storage.test.ts`）

- 库内存在 `reserved` 票据 → 提交一份把该票据删掉的 workspace，且不传 `closingTicketId` → 必须 `reject`，库内容不变。
- 传 `closingTicketId` 且票据变为 `succeeded`/`cancelled`/`failed` → 允许提交。
- 正确的 `reserved → submitted` 转换可提交；同一票据仍保持开票但新增事件、改名或导入工作区时拒绝。
- 错误的 `closingTicketId`、偷偷改生成依据、替换为另一个开票任务均拒绝；正常成功收尾与结果选择在一次事务中完成。

---

### 2.7 消除 `EditionPage` 本地 `run`/`review` 快照与跨标签页刷新失步

**证据**

- `apps/web/src/edition/page.tsx:26-27`：`useState<edition.EditionRun | null>` / `<edition.ReviewRevision | null>`。
- `apps/web/src/edition/use-edition.ts:32-35`：`watchEditionChanges` 触发 `reload()` 只会更新 `store`。
- `apps/web/src/edition/page.tsx:126-135`：`appendRunEvent(run, ...)` 用的是旧快照。

**缓解因素**：`apps/web/src/edition/storage.ts:244/263` 有 CAS，`:246` 及事务内还有事件前缀扩展检查。旧版本提交会报「请刷新」；即使 store 已刷新、版本号变新，旧 Run 仍会被前缀检查拒绝，不能归功于 CAS 单独保护。现状不会静默覆盖，主要是状态失步和保存被拒。

**改法**：`run`/`review` 只存 ID，从 `local.store` 派生。

```ts
const [runId, setRunId] = useState<string | null>(null);
const [reviewId, setReviewId] = useState<string | null>(null);
const run = useMemo(() => local.store?.runs.find((e) => e.id === runId) ?? null, [local.store?.runs, runId]);
const review = useMemo(() => local.store?.reviews.find((e) => e.id === reviewId) ?? null, [local.store?.reviews, reviewId]);
```

所有赋值同步替换：`setRun(x)` → `setRunId(x.id)`，`setReview(x)` / `setReview(null)` → `setReviewId(x?.id ?? null)` / `setReviewId(null)`；`finishUnit` 与返回书架也必须清理 review ID，不能保留已删除的 setter。

**验证**：E2E 双标签页——B 已打开同一 Run 阅读器，A 推进后等待 B 收到 store 变更通知；**不手动刷新 B 页面**，其进度和当前场景应同步，下一次操作以最新 Run 为基准。真正同时写入的冲突仍可被 CAS 拒绝并提供恢复提示，不能宣称消除所有并发冲突。

---

### 2.8 `EditionJobManager` 执行失败覆盖取消态；保持现有执行槽互斥

> **v3 更正**：删除 v2 的同进程提交竞态论证。`EditionJobManager.submit → start → execute → gate.acquire` 在取得槽位前没有 `await`，SQLite 操作同步；第二个普通请求不能插入这段同步链。定向实测第二次提交返回 `429 / E-JOB-BUSY`，库内只有一条任务，没有第二条 failed 任务。

**证据**

- `apps/api/src/edition/jobs.ts:220/239-258`：后台 `execute()` 在首次异步让出前已取得执行槽；不能因 `busy()` 与 `acquire()` 分处两个函数就认定存在竞态。
- `:277-309` 的 `getJob`、`reserveAttempt`、`markAttempt` 和状态更新是同步操作，正常 HTTP 取消也不能在其间交错。用同一份旧 `current` 增加条件判断，既不能证明修复了竞态，也不需要作为本轮补丁。
- `:333-338`：`runner` 抛错 → `this.fail(id, code)` → `:353-367` 无条件写 `status: 'failed'`，把 `cancel_requested` 覆盖。
- `apps/api/src/jobs.ts:173` 有 apiKey 回显检查，`edition/jobs.ts` 的 `execute` 没有对 `result.body` 做同等检查。
- 定向复现：挂起 runner，调用 `cancel` 后让 runner reject，终态由 `cancel_requested` 变为 `failed`；这是本节需要修复的实际路径。

**改法**

1. 保留现有提交前 busy 检查与执行槽仲裁，不为未复现的竞态增加 `running.size` 修补。将现有互斥行为纳入不退化测试；将来若增加槽位获取前的异步步骤，应重新审查这条不变量。
2. `fail()` 按持久化的最新状态决定终态：`cancel_requested` 收敛为 `cancelled`，一般执行失败才写 `failed`；不要改写已有终态。正常路径与存储异常兜底都必须遵守这一规则。
3. attempt 可保留执行失败分类，但用户任务终态/安全说明要反映取消请求，不能由 runner 抛错覆盖取消；已保存的前序单元保留，后续单元不启动，不保证供应商中止或退费。
4. `execute` 在任何对象写入之前检查实际临时 apiKey 是否出现在结果的待持久化字段中，命中则安全失败且对象不落库；不能只检查 body 而忽略可能被污染的结果元数据。使用合成 Key 测试，不读取真实密钥。页面写入护栏另见 §2.11。

**同时记录（低危，可选项，不进本阶段）**：`apps/api/src/jobs.ts:170-172` 的 `onPhase` 未检查任务是否仍为 `running`。`sweep()` 只淘汰 `succeeded/failed`（`:142-147`），运行中的记录不会被淘汰，`JobManager` 也没有取消路径，因此当前不存在现实触发条件——保留为已知瑕疵。

**验证**（`apps/api/test/edition-jobs.test.ts`）

- 互斥不退化：挂起首个 runner 再提交第二个请求，断言第二次 429、任务表仍只有一条；此用例当前已经通过，不能作为新修复的红灯测试。
- 修复用例：runner 挂起 → `cancel` → runner reject，终态必须为 `cancelled`；当前为 `failed`。另测 runner resolve 时取消态仍保留、已存结果可用且不开始下一单元。
- `runner` 返回含 apiKey 的 body → 任务失败且对象未落库。

---

### 2.9 抓取器 HTML 实体越界、编码白名单与 IPv6 规范化

> **v2 更正**：`String.fromCodePoint` 对孤立代理码点（`0xd800..0xdfff`）**不会抛**，只对 `> 0x10FFFF`、负数、`NaN` 抛 `RangeError`。抓取器真实漏洞是「越界数字实体」与「十六进制实体未支持」，代理对属于潜在脏数据而非崩溃。

**证据（`apps/api/src/edition/fetch-source.ts`）**

- `:100`：`String.fromCodePoint(Number(code))`，`&#99999999999;` 直接抛 `RangeError`；`extractText` 在 `:211` 被调用且**不在 try 内** → 异常穿出 `fetchSource`，违反「失败一律返回安全错误码」。
- 无十六进制实体（`&#x27;` 会原样留在正文里）。
- `:108-115` `decodeBody`：未知/多重 `content-encoding`（如 `gzip, br`）原样返回压缩字节 → 被当 utf8 解码成乱码正文。
- `:168-174`：`SizeError`（`apps/api/src/edition/node-fetch.ts:78` 抛出）落到 `E-FETCH-NETWORK`，用户看到的是「网络失败」而不是「响应过大」。
- `:153-157`：限流时间戳在 `await sleep()` **之后**写入，并发同主机请求都能穿过。

`packages/content/src/edition/sources.ts:159-200` `isBlockedIpv6` 是纯字符串前缀匹配：

- `0:0:0:0:0:0:0:1`（回环）→ 不匹配任何前缀 → **放行**。
- `0:0:0:0:0:ffff:127.0.0.1`（映射 IPv4）→ 不以 `::ffff:` 开头 → **放行**。
- `0064:ff9b::1`（NAT64）→ 不以 `64:ff9b` 开头 → 放行。

> 可达性说明：这些地址来自 `deps.lookup(host)` 的解析结果，常见解析器返回 RFC 5952 规范形式，因此现实攻击面有限（属纵深防御）。但 `lookup` 是可注入依赖，测试与自定义解析器都能触发。

**改法**

1. 实体解码做码点范围检查，支持十六进制；非法数字实体替换为 `\uFFFD`，不要吞掉整个提取流程的未知异常。`fetchSource` 的提取边界仍应把意外转换为安全错误，而不是泄漏原始异常：

```ts
const safeCodePoint = (cp: number) =>
  Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
    ? String.fromCodePoint(cp) : '\uFFFD';
text = text
  .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(Number.parseInt(h, 16)));
```

2. `decodeBody`：保留已有 gzip/x-gzip、deflate、br 的有界解压；仅无编码或 identity 原样返回。未知/多重编码返回明确的 `E-FETCH-ENCODING`，同步调整结果错误码与测试；不要误报体积错误，也不把压缩字节当正文。
3. `catch` 中识别 `name === 'SizeError'` → `E-FETCH-SIZE`。
4. 用每主机串行调度或原子预约的 `nextAvailableAt` 约束发出时刻。不能只把 `hostLastHit.set(host, now())` 移到 sleep 前：B、C 仍可能都等待两秒并同时发出。调度设计需覆盖取消、sleep 晚醒和失败后的队列释放，确保同主机真实请求间隔不小于 `hostIntervalMs`；不同主机互不阻塞。
5. `isBlockedIpv6` 入口先剥离 `%zone`，再规范化：

```ts
const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
let canonical: string;
try { canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1); }
catch { return true; } // 解析不了就拦截
```

随后所有前缀判断改用 `canonical`。

**验证**（`apps/api/test/edition-fetch.test.ts`、`packages/content/test/edition-sources.test.ts`）

- `&#99999999;` / `&#x110000;` / `&#xd800;` → 不抛，替换为 `\uFFFD`；`&#x27;` → `'`。
- `content-encoding: gzip, br` 或未知编码 → 返回 `E-FETCH-ENCODING`，不得返回乱码正文；合法压缩体超限仍返回 `E-FETCH-SIZE`。
- `request` 抛 `SizeError` → `E-FETCH-SIZE`。
- `0:0:0:0:0:0:0:1`、`0:0:0:0:0:ffff:127.0.0.1`、`0064:ff9b::1`、`fe80::1%eth0` → 全部拦截；`2606:4700::1111` → 放行。
- 用假时钟同时启动至少三个同主机请求，记录实际 `request()` 调用时刻，间隔均不少于两秒；晚醒、取消和失败不造成后续扎堆或队列挂死，不同主机可独立发出。只断言 sleep 被调用不能证明限流有效。

---

### 2.10 补齐 Edition 路由与发布复核的契约校验

**证据**

- `packages/content/src/edition/contract.ts:254-259` 定义 `assertEditorialRevision`（含 `E-PLAN-DIGEST` 自校验），全仓库唯一调用点是 `packages/content/src/edition/project.ts:416`；`apps/api/src/edition/runner.ts` 全文未调用。
- `verifyPublishedUnit` → `validateEditionUnit`（`packages/content/src/edition/validate.ts:196-252`）只校验引用链（`basisIssues`）与 `corpusClosureIssues`，**不校验** `corpus.digest === corpusDigest(corpus)`，也不校验目录摘要自洽。
- `apps/api/src/edition/routes.ts:189-192`：`unitIds` 只查「1–20 个字符串」，无逐项 `isEditionRef`、无去重。
- `apps/api/src/edition/routes.ts:266-288`（approvals）：只 `store.getEdition(editionId)`，缺 `isEditionRef`。
- `apps/api/src/edition/routes.ts:370-385`（export）：`store.getUnitsByIds(unitIds)` 返回数量不校验，缺单元会静默导出残缺项目。

**改法**

1. 在共享的 Edition 依据验收边界统一校验 `assertEditorialRevision(input.editorial)` 和 `input.corpus.digest === corpusDigest(input.corpus)`，将异常转换为结构化校验问题；使草稿登记、确定性编译和发布复核都生效。不要只在一个 runner 内加检查而漏掉其他入口。若在 API 包装，执行器使用 `record.context`、发布函数使用 `draft.context`，不能把同名 `record` 片段照抄到不同作用域；错误映射到安全的 content 分类。

2. `POST /api/editions/:id/jobs`：`unitIds.every(isEditionRef)` 且 `new Set(unitIds).size === unitIds.length`。
3. `POST /api/editions/:id/approvals`：补 `isEditionRef(editionId)`（`targetId` 同理）。
4. `GET /api/editions/:id/export`：`if (units.length !== unitIds.length) throw new EditionJobError(409, '存在缺失的已发行单元对象，拒绝导出不完整项目');`

**验证**（`apps/api/test/edition-runner.test.ts` / `edition-routes.test.ts`）

- 篡改 `corpus` 内容但保留旧 `digest` → 编译任务必须失败。
- 目录 `digest` 与内容不符 → 发布复核失败。
- `unitIds` 含重复项或非法 ID → 400。
- 删掉一个已发行单元对象后导出 → 409。

---

### 2.11 将当前页面 Key 的护栏前移到持久化之前

> 从 v2 的 §4.3 提升到 P1。秘密不落库是契约要求，不是菜单整洁。此处只处理当前页已知临时 Key，不承诺识别任意「形似 Key」的字符串。

**证据**

- `apps/web/src/use-player.ts:144-158` 的 `manage()` 未调用 `assertNoSecrets`；只有 `backup()`（`:274-284`）在导出前拦截。因此把当前页 Key 粘进备注可能先落库，等到导出才报错。
- `packages/content/src/application-contract.ts:642-647` 只检查传入、长度至少 8 的 secret 是否为序列化值的子串，不使用 Key 外形正则；没有传入的字符串不在该护栏能力范围内。

**改法**

1. 管理命令只执行一次得到 `next`，在任何持久化前对 `next` 执行 `assertNoSecrets(next, [apiKey])`，通过后再提交；不要为了检查和保存重复执行 `fn`。
2. 同时梳理统一提交和备份导入路径：含已知 Key 的对象进入 staging 也属于落库，必须在 `repo.stage()` 前拒绝，不能只在最终 commit 或导出前检查。
3. API 结果写盘的保护见 §2.8。禁止将 Key 加入持久化的审计、拒绝原因、票据或日志；页面 Key 的清除与运行中任务相互独立。
4. 保留该工具的能力边界说明；短于现有扫描阈值的输入策略需另行决定，不宣称本项已经覆盖任意短串或未知密钥，不为扫描创建持久化 Key 注册表。

**验证（仅用合成 Key）**

- 页面设置一段至少 8 字符的合成 Key，再把**同一完整值**粘进备注 → 保存拒绝，meta/revisions/branches/objects/staging 均不包含该值，错误不回显 Key。
- 导入容器含当前已知合成 Key → staging 写入之前拒绝，原存档不变。
- 普通备注正常保存；任意「形似 Key」但不等于当前已知值的字符串不是该子串扫描的必拒用例，不能拿它作为修复验收。

---

## 阶段三（P2）：边界条件与状态完整

### 3.1 `DraftEditor` 改草稿后不清空旧 `preview`

**证据**：`apps/web/src/components/library.tsx:52`，`onChange` 只 `setDraft`。

**后果**：改完草稿但没重新编译，仍可点「采用此修订」，落库的是上一版编译结果，与编辑框内容不一致。

**改法**

```diff
-    <textarea className="draft-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows={16} spellCheck={false} />
+    <textarea className="draft-editor" value={draft}
+      onChange={(e) => { setDraft(e.target.value); setPreview(null); }} rows={16} spellCheck={false} />
```

**验证**：编译通过 → 再改一个字符 → 「采用」按钮消失，`preview` 提示区不残留上一次的「校验通过」。

---

### 3.2 分开展示信息渲染与修订元数据同步

**证据**

- `packages/content/src/workspace.ts:490`（`adoptRevisionInPlace`）与 `:358`（`forkForRevision`）：只更新 `revisionIds` / `headRevisionId` / `updatedAt`。
- `ContentEntry.kind` / `.series` / `.label` / `.display.title` 仍是旧值。
- 首页 `App.tsx:110-112` 渲染 `episode.title/subtitle/description`，不读取对应的 `entry.display`；`seriesOf`（`:14-15`）与卡片形态取自 `episode.presentation`，不是 `ContentEntry.kind/series`。

**真实影响**：修改展示名称可成功落库，但首页仍显示正文标题，Edge 定向复现为「display 已改、卡片仍为旧标题」。条目元数据不同步也需要处理，但不能据此推断首页仍用旧 kind/series 渲染；只更新 entry 字段不会修好首页的展示覆盖。

**改法**

1. 首页的标题、摘要、副标题及可访问名称使用明确的展示模型，关联 `entry.display`；正文内容、插图形态、系列和证据仍来自当前分支实际采用的 revision/episode，不用全局 entry 元数据覆盖旧分支的正文语义。
2. 两处采用修订时同步 entry 的 head 元数据；分开展示覆盖与正文标题。示意如下（省略的 revisionIds 等保留原更新逻辑）：

```ts
const customLabel = e.display.title !== e.label;
const updatedEntry = {
  ...e,
  headRevisionId: revision.id,
  updatedAt: time,
  kind: revision.creation?.kind ?? e.kind,
  series: revision.creation?.series ?? e.series,
  label: revision.title,
  display: { ...e.display, title: customLabel ? e.display.title : revision.title },
};
```

3. subtitle/description 的自动同步与自定义覆盖也需要明确规则，不能只把所有 display 字段无条件覆盖；全局展示信息与分支正文的差异应保持可解释。不要为了展示修改持久化批次标题或 creation。

**验证**

- 仅编辑展示名称后：首页标题和主按钮可访问名称更新，刷新仍在；正文 batch/hash/creation 与已有答案不变。该用例当前失败，与 §1.1 弹窗点击用例分别建立。
- 未自定义标题时采用新标题，entry.label 和 display.title 都同步；自定义标题时只更新 label，display.title 保留。
- `story → knowledge` 新修订后 head 元数据一致；切回采用旧 story 修订的分支，正文与插图仍按该分支的 episode 呈现。

---

### 3.3 `runCompletion` 的 `goals.achieved === goals.total` 恒成立

**证据**：`packages/content/src/edition/run.ts:392-399` 先用 `exposure + practice + retrieval > 0` 过滤，然后 `:409-413` 用同一个数组算 `achieved` 与 `total`。

**计数范围说明**：`:378-380` 遍历的 `view.exposed` 是 Set，所以内部 exposure 值至多为 1；但 `CompletionStatus.goals.items` 只输出证据类别，不输出次数，不能单凭此点称用户可见次数错误。只有确实需要次数的逻辑才应调用版本化的 `runExposureCounts`。

**改法**

1. **先完成 §2.0 的目标清单契约决策。** `InstalledUnit`（`release.ts:243-252`）只有 batch 等字段、没有 `ast`。v2 的 `unit.ast?.targets` 会类型报错，绕过类型后得到空集；样刊实测为 0，而其已配置的不同教学目标为 4。
2. 分母应来自随发行冻结的教学目标清单，与已采用单元、CEFR 和发行摘要绑定；当前安装包没有这份显式清单，需先决定如何从已批准计划携带目标，以及旧包如何展示「目标信息不可用」。不能把运行时 AST 的出现词或整个语言包替代为计划目标，也不能静默改旧包。
3. 移除以 `pack.entries` 初始化全部 counts 的做法（当前样刊词包有 143 个词条）。仅为计划目标初始化零证据项，再汇入这些目标的真实曝光/练习/检索证据；额外出现词可另列，但不进入目标分母。
4. `items` 包含全部计划目标，无证据者为 `'none'`；`total` 是计划目标数，`achieved` 仅计这些目标中有实际证据者。这里表示证据覆盖，不宣称有一次曝光就已掌握。

**验证**

- 新版本一期两个单元合计 5 个不同计划目标，仅其中 3 个有真实阅读或作答证据 → `total=5`、`achieved=3`，另两项为 `'none'`；未展示、跳过与仅生成不计证据。
- 语言包还含大量非计划词条、正文额外出现其他词时，分母仍为 5；同一目标跨单元只计一个目标。
- 旧版安装包缺目标清单时按评审后的兼容协议显示「目标信息不可用」，不显示伪造的 0/0 完成率；保留旧包与学习记录。

---

### 3.4 `@quiz find` 干扰项硬编码；双 `correct` 判定改为按索引

> **v2 更正**：v1 称「标签重名导致双 `correct: true`」是当前重现的缺陷。实测 `distractorGlosses`（`compile.ts:152-162`）与 `distractorForms`（`:163-176`）都排除目标自身词形/词义并去重，`materials.ts` 的道具 label 也无重复，所以**当前不会重现**——属防御性加固。真正影响体验的是干扰项固定。

**证据**

- `packages/content/src/edition/compile.ts:420`：`materialProps.filter((p) => p.id !== prop).slice(0, 3)` → 每道 `find` 题的三个干扰图都相同，两题之后就能靠排除法蒙对。
- `packages/content/src/edition/compile.ts:398-401` 与 `packages/content/src/creative.ts:614`：`...(label === correct ? { correct: true } : {})`，按标签而非位置标记正确项。
- 对照组：`packages/content/src/creative.ts:310-320` 已用 `fnv1a32` 做确定性抽样，edition 侧没有跟进。

**改法（先通过 §2.0 的编译器版本决策）**

1. 干扰项用与 ENDLESS 相同的确定性抽样，并排除与正确答案同名的道具：

```diff
-      const others = materialProps.filter((prop2) => prop2.id !== prop).slice(0, 3);
+      const others = materialProps
+        .filter((prop2) => prop2.id !== prop && prop2.label !== target.entry.glossZh)
+        .map((prop2) => ({ prop2, key: fnv1a32(`${input.seed}:${id}:${target.item}:${prop2.id}`) }))
+        .sort((a, b) => a.key - b.key || a.prop2.id.localeCompare(b.prop2.id))
+        .slice(0, 3)
+        .map((entry) => entry.prop2);
```

复用 `edition/compile.ts:86-93` 已有的局部 `fnv1a32`；`./draft.js` 没有该导出，`creative.ts` 的函数也未导出，无需新增错误 import 或复制第三份实现。

2. 正确项按位置标记：两处的 `*(label === correct ? { correct: true } : {})` → `*(index === correctIndex ? { correct: true } : {})`（`compile.ts:400` 的 `index` 由 `ordered.map` 提供；`creative.ts:614` 用 `oi === correctIndex`）。

**验证**

- 固定一组已知会产生不同集合的 seed/scene/item，断言精确选项与素材；同一输入重复编译结果相同。不同题可以偶然抽到同一集合，不能把「任意两题都不同」当作算法保证。
- 构造同名干扰项时验证候选过滤和单一正确位置；仍须保留共享校验器拒绝重复选项的要求，不能只剩一个 correct 就放行歧义标签。
- 旧版本 find 修订仍由旧编译器复核；新选项不能覆盖同 ID 的既有成稿/Release。

---

### 3.5 补齐 IndexedDB 辅助事务的 `tx.onabort` 与关闭后的缓存清理

> **v2 删除**：v1 的「`EditionRepository.load` 按 `chunk.index` 排序」不是缺陷。`getAll()` 按主键升序返回，而主键是 `runId:000123`（`apps/web/src/edition/storage.ts:43` 六位补零），顺序已经确定。加显式排序无害，但不作为修复项排期。

**证据**

- `apps/web/src/storage.ts:155-168`（`rawSnapshot`）、`:176-184`（`stage`）、`:186-194`（`staged`）、`:196-204`（`clearStaging`）：只有 `oncomplete` / `onerror`，无 `onabort`。没有经过现有 error 处理的显式 abort 路径可能使 Promise 悬挂；配额等请求错误可能已触发 onerror，不能声称所有失败都悬挂。
- `apps/web/src/storage.ts:30-32` 与 `:206-208`：`onversionchange` 与 `close()` 都只关闭连接，`this.database` 仍指向已关闭的 `IDBDatabase`，后续操作抛 `InvalidStateError`。
- `apps/web/src/edition/storage.ts:379-413`：同样的 `stage` / `staged` / `clearStaging` 缺 `onabort`。

**改法**

1. 四个辅助事务统一补 `tx.onabort = () => reject(new Error('...已中止，数据未被修改'));`。
2. 明确连接生命周期：`close()` 后原 repository 应明确拒绝使用，或通过保留 factory 的受控 reopen 方法打开同版库；不留下指向已关闭连接的成功 Promise。
3. `onversionchange` 关闭连接并标记需重新加载。当前固定打开版本 1，新版库出现后重新 `open(..., 1)` 会得到 `VersionError`，不能承诺自动重开成功；报告版本不支持并保留数据，不删库、不默默重建、不在未知结构上继续写。

**验证**（扩展两套 storage 测试）：在请求成功后、事务完成前显式 abort，`stage/staged/clearStaging/rawSnapshot` 必须 settle 为 reject，不悬挂；普通请求错误仍正确 reject。同版新 repository 可重新加载；外部升级库版本后，旧实例停止写入且给出可操作的版本提示，原库内容不变。

---

### 3.6 `useEditionStore.run` 缺同步重入锁

**证据**：`apps/web/src/edition/use-edition.ts:37-52`，只有 `setBusy(true)`（异步 state，下一次渲染才生效），同帧内两次点击都能进入 `work()`。

**影响边界**：缺少的是 hook 入口互斥。现有 repository CAS 已阻止两次相同预期版本的提交都成功；实测并发两次 `commitRun` 为一成功、一拒绝，只有一条复习修订。因此不能声称当前会正常落库两条重复修订。

**改法**

```diff
+  const pending = useRef(false);
   const run = useCallback(async (work, message = '') => {
+    if (pending.current) return null;
+    pending.current = true;
     setBusy(true);
     ...
     } finally {
+      pending.current = false;
       setBusy(false);
     }
   }, []);
```

**验证**：hook 级挂起第一次 `work`，同一渲染帧连续调用两次 `run`，断言 work/仓库写入入口只调用一次、busy 直到首个任务结束才清除、没有第二次 CAS 错误通知；结束后可再次调用，失败时锁也释放。「最终只有一条 rvr」只能作存储层不退化测试，不能单独证明重入锁修复。

---

### 3.7 checkpoint：记录缺口，不纳入本轮 P2 实施

> **v2 重大更正**：v1 的两个子项都不成立——`PlayerView` **没有** `seen` 字段（`packages/player/src/index.ts:125-134`；`seen` 是 `projectSession` 内部 `Map`，`:168`），`session.view.seen` 不存在；`assertWorkspace` 的 checkpoint 校验**已存在**（`packages/content/src/application-contract.ts:566-578`：分支存在性 + 前缀长度上限 + 前缀哈希）。

**实际状况（降级为「未启用功能的正确性」）**

- `packages/player/src/checkpoint.ts:51` `streaks: []`、`:57` `seen: []` 恒为空；`importProjection`（`:65-87`）丢弃二者（`processor` 建了又 `void` 掉，`:77-79`）。
- `verifyCheckpoint`（`:90-101`）用 `exportProjection` 的产物做双向比较，两边 `seen/streaks` 都是空数组 → **验证通过也证明不了这两项被正确恢复**。
- `workspace.checkpoints` 全仓库没有任何写入点（`workspace.ts:123` 初始化为 `[]`，`backup.ts` 只统计数量），`exportProjection/importProjection/verifyCheckpoint` 仅被测试调用 → 这是未启用的能力，不是运行中的 bug。

**本轮处理**：保持未启用，不为这次修复扩大 `PlayerView` 公共接口，也不增加 checkpoint 落库。完整导出/继续重放属于后续能力任务，不列为 P2 退出条件。

**后续启用的前置条件**

1. 当前 `projectSession(session, library)` 只从事件完整重放，没有接收导入投影后继续应用后缀的接口；先设计共享 reducer 与可恢复状态，再设计 export/import，不能只把 processor 挂到 view 就称为可继续重放。
2. `seen` 在 `index.ts:189/230-237` 按 episode 隔离，来自完成阅读的目标曝光，不是全局「答过的词」。v2 的「A 集答过、B 集因 seen 丢失重复计分」归因错误。
3. 未来分别验证：同一 episode 中先完成目标曝光、检查点后再答题的 priming；以及跨 episode 的 EvidenceProcessor streak 延续。连同 FSRS/BKT/world/游标一起与完整重放对比，并证明故意丢掉 seen 或 streak 时各自测试会失败。
4. 启用前明确 ProjectionState 与 `PROJECTOR_VERSION` 的版本、完整性验证、未知版本保留策略；不得自动信任本就丢弃字段的旧检查点。

---

## 阶段四（P3）：UI 细节与代码整洁

### 4.1 移动端底部导航缺 `#edition`、`document.title` 缺分支

**证据**：`apps/web/src/App.tsx:172`（title 只处理 watch/progress/settings），`:266`（移动导航只有 home/library/progress/settings）。侧边栏 `:217` 已有 edition 入口 → 移动端无法到达 Edition。

**改法**

```diff
-    document.title = `${page === 'watch' ? episode.title : page === 'progress' ? '阅读记录' : page === 'settings' ? '偏好设置' : '故事频道'} · ENDLESS`;
+    document.title = `${page === 'watch' ? episode.title : page === 'library' ? '内容管理' : page === 'edition' ? 'Edition 专题' : page === 'progress' ? '阅读记录' : page === 'settings' ? '偏好设置' : '故事频道'} · ENDLESS`;
```

```diff
-{([['home','discover','发现'],['library','book','管理'],['progress','progress','足迹'],['settings','settings','设置']] as const).map(...)}
+{([['home','discover','发现'],['library','book','管理'],['edition','spark','专题'],['progress','progress','足迹'],['settings','settings','设置']] as const).map(...)}
```

**验证**：移动端视口下 5 个入口均可点，`#edition` 高亮 `aria-current="page"`；各页 `document.title` 正确。覆盖 320/360/393px 宽度并确认不横向溢出：当前 `.mobile-nav a` 最小宽度 65px，加上容器边距后五项不适配最窄屏，需要一并调整布局。

---

### 4.2 两处文案不一致

**证据**：`apps/web/src/components/scenes.tsx:62`；`apps/web/src/App.tsx:244`。

**改法**

```diff
-      <div className="scene-intro"><h2>{!presentation || presentation.legacy ? '每个小谜题都从一句话开始。' : body === '正文' ? '这一段正文从一句话开始。' : '这一段内容从一句话开始。'}</h2><p>...
+      <div className="scene-intro"><h2>{!presentation || presentation.legacy ? '每个小谜题都从一句话开始。' : `这一段${body}从一句话开始。`}</h2><p>...
```

```diff
-{scene.type === 'comic' ? '故事正在发生' : ...}
+{scene.type === 'comic' ? (episode.presentation && episode.presentation.kind !== 'story' ? '内容正在展开' : '故事正在发生') : ...}
```

**验证**：非 legacy 的 story 漫画介绍从当前错误的「这一段内容……」改为「这一段故事……」；daily/social/knowledge 仍用「内容」，知识类阅读头部显示「内容正在展开」。Edition 当前已用「这一段正文从一句话开始。」，只能作不退化验证，不能把它当作修改前会失败的用例。

---

### 4.3 `EntryMenu` / `LibraryPage` 的禁用态、回收站按钮与外部点击

**证据**

- `apps/web/src/components/library.tsx:81`：`<button onClick={() => player.trash(entry)}>移入回收站</button>` 无条件渲染，`lifecycle === 'trashed'` 时也会显示（对已删除内容再"移入回收站"是无意义操作）。
- `:77`：触发按钮无 `aria-expanded` / `aria-haspopup`；菜单打开后无外部点击 / Escape 关闭。
- `:79-87`、`:122-135` 的按钮均无 `disabled={player.busy}`。

**改法**

1. `entry.lifecycle !== 'trashed'` 才渲染「移入回收站」。
2. 触发按钮补 `aria-expanded={open}` `aria-haspopup="menu"`；`open` 为真时挂 `pointerdown`（判断 `event.target` 不在 `.entry-menu` 内）与 `Escape` 监听。
3. 变更类按钮绑定 `disabled={player.busy}`。

Key 持久化防护已拆到 P1 的 §2.11，本节只处理菜单体验，不再以 P3 优先级承载秘密保护。

**验证**

- 播放/保存中打开菜单 → 各操作按钮禁用。
- 回收站条目的菜单里没有「移入回收站」，有「恢复 / 彻底删除」。
- Key 用例按 §2.11 使用页面当前已知的完整合成 Key，不要求本节识别任意形似 Key 的字符串。

---

### 4.4 SQL 同毫秒排序确定性 + 错误分类的 `TypeError` 判定

> **v2 更正**：v1 列的四个排序点里，`objectsById` 与 `latestApproval` 本来就是确定的。

**核对结果（`apps/api/src/edition/store.ts`）**

| 查询 | 现状 | 是否缺陷 |
|---|---|---|
| `objectsById`（`:236` / `:242` / `:257`） | `ORDER BY created_at, digest` | 否，已有确定性次键 |
| `latestApproval`（`:471`） | `ORDER BY seq DESC LIMIT 1` | 否，`seq` 唯一 |
| `listReleases`（`:456`） | `ORDER BY published_at DESC` | **是**，同毫秒顺序不定 |
| `listJobs`（`:362`） | `ORDER BY created_at DESC` | **是** |
| `listEditions`（`:302`） | `ORDER BY updated_at DESC` | **是**（v1 漏列） |

**改法**：三处补 `rowid` 次键（`ORDER BY ... DESC, rowid DESC`）。

**错误分类**（`apps/api/src/jobs.ts:186`、`apps/api/src/edition/jobs.ts:75`）：`chain.some((e) => e.name === 'TypeError' || e.name === 'FetchError')` → 任何 `TypeError` 都被归到 `network`，内部空指针也会被报成「连接模型供应商失败」。改为：

```ts
const network = chain.some((e) => e.name === 'FetchError' ||
  (e.name === 'TypeError' && /fetch|network|socket/i.test((e as { message?: string }).message ?? '')));
```

**验证**：同毫秒插入两条 release → 顺序稳定（按 `rowid`）；抛出一个 `new TypeError('x is not a function')` → 分类为 `unknown`，不是 `network`。

---

### 4.5 `autoFixBatch` 的 `cast` 去重（代码整洁，非缺陷）

**证据**：`packages/esl/src/autofix.ts:167-172`（`scene.cast`）与 `:174`（`next.cast`）在别名替换后未去重。

**判定**：`packages/esl/src/validate.ts:156-161` 不禁止重复 `cast`，重复项没有可观察故障。此项仅为数据整洁，顺带做即可：

```diff
-      scene.cast = scene.cast.map((id) => aliasEntity(id) ?? id);
+      scene.cast = [...new Set(scene.cast.map((id) => aliasEntity(id) ?? id))];
```

---

## §5 全量验证清单

```powershell
pnpm typecheck                       # 9 个子工程，全部 Done
pnpm test                            # 核验基线 620 项；新增修复用例后数量相应增加
pnpm build                           # 含 PWA manifest 与 service worker
$env:PLAYWRIGHT_CHANNEL = "msedge"; pnpm test:e2e
```

各阶段结束时应新增/更新的回归点：

| 阶段 | 必测项 |
|---|---|
| P0 | 首页卡片弹窗不跳转；复习选项可点；刷新后书架不崩且定位正确 |
| P1 前置 | 固定旧 Run/复习/安装包/草稿夹具；批准版本分派与目标清单兼容决策；旧记录加载、评分和备份往返不变 |
| P1 修复 | 新策略下 fact/uses/曝光去重正确；pick effects 保留；编辑器/预览/采用共用当前分支修订与计划时间；票据转换和无关写入冻结；store 通知同步 Run；cancel 后 runner reject 仍为 cancelled；安全抓取与并发限流；目录/语料摘要校验；已知合成 Key 在 staging/正式写盘前被拒绝 |
| P2 | 草稿变化清空预览；展示名称真的更新首页且不改正文；head 元数据与分支呈现分离；目标分母只取冻结计划清单；新版 find 确定性采样；辅助事务 abort settle；未知库版本不重置；hook 重入时 work 仅调用一次 |
| P3 | 窄屏五项导航无溢出；story/非故事文案区分；菜单禁用态与外部点击；SQL 排序稳定；TypeError 不误报为网络 |
| 不纳入本轮 | checkpoint 后缀重放与落库；§3.7 只记录前置条件，不作为已实施或阶段完成条件 |

**验收纪律**

- 新修复用例先在旧实现失败，修复后通过；区分新增红灯测试与现有不退化测试。提交互斥、CAS 不覆盖、Edition 现有正文称谓不能冒充新修复证明。
- 语义变更同时测试旧版固定夹具和新版输入；不能统一重生成所有期刊、复习依据或备份夹具来换取全绿。
- 本稿修订只验证文档一致性。上述 build/E2E 是后续实施完成后的全量验证要求；此前的 Edge 定向检查运行于开发页面，不能替代生产 preview 的 PWA/离线验收。

---

## §6 修订记录（v1 → v2 → v3）

> 证据列使用「相对仓库根的路径:行号」；个别省略了 `apps/…` / `packages/…` 前缀的同一文件，以正文对应小节的完整路径为准。

以下保留 v1/v2 沿革，但以 v3 最终结论为准，不继续保留已被核验推翻的说法。

| # | 早期判断 | 最终更正 | 依据 |
|---|---|---|---|
| 1 | 首页嵌套按钮导致每次保存都跳转、三条链路完全不可用 | 冒泡缺陷成立；实测点击输入框跳转，直接填值保存可留在首页。展示名称未用于首页渲染另列 §3.2 | `App.tsx:110/112`、`library.tsx:16`、Edge 定向复现 |
| 2 | 1.3 抛 `Unknown episode: rvr_...`、组件渲染崩溃 | 实际抛 **`存档场景顺序无效`**；由 `AppBoundary` 兜成整页错误页；`firstUnread` 有 try/catch **不崩**，只是定位错误 | `packages/player/src/index.ts:174`、`main.tsx:6-13`、`page.tsx:299-307` |
| 3 | 2.2 从 `uses` 派生中删掉 `card.front` | **不删**：`card.front` 在共享契约里是 `narrative` | `esl/text.ts:67-68`、`creative.ts:764-771` |
| 4 | 2.3 `pick` effects 与 `cast` 去重并列 | `pick` effects 是缺陷；`cast` 去重降级为 4.5 整洁项 | `model.ts:159-170`、`validate.ts:156-161` |
| 5 | 2.4 把 `revisionToDocument`/`basisPrefix` 改为 `basis.plannedAt` | **方向错误**：`basis.plannedAt` 是票据预留时间，会让存量修订按错误的时刻重算 brief。改为让 `previewRevision` 统一用 `head.plannedAt` | `workspace.ts:447`、`generate.ts:53`、`packages/content/src/index.ts:369/478` |
| 6 | 2.6 补丁用不存在的类型/字段，v2 仍残留 committed 且保留开票就放行写入 | 删除不完整补丁；成功终态为 succeeded；按事务内允许转换和差异范围冻结无关写入 | `storage.ts:45-49/106-149`、`application-contract.ts:386` |
| 7 | v2 称真正提交竞态只在 EditionJobManager | 当前同步链在首次 await 前已 acquire；实测第二次 429、只有一条任务。真实缺陷是取消后 runner reject 被 fail 覆盖 | `edition/jobs.ts:220/239-258/333-367`、内存 SQLite 定向复现 |
| 8 | 2.9 称代理对码点会抛 `RangeError` | 孤立代理**不抛**，只对 `>0x10FFFF` 抛；hex 实体未支持与编码白名单才是真问题 | `fetch-source.ts:100/108-115` |
| 9 | 3.5 要求 `EditionRepository.load` 按 `chunk.index` 排序 | 非缺陷：`getAll()` 按主键升序，主键是六位补零的 `runId:000123` | `edition/storage.ts:43` |
| 10 | 3.7 导出 `[...session.view.seen]`；`assertWorkspace` 缺 checkpoint 校验 | `PlayerView` 无 `seen`；`assertWorkspace` **已**校验分支存在性与前缀上限。真实缺口降级为「未启用功能的正确性」 | `packages/player/src/index.ts:125-134/168`、`application-contract.ts:566-578` |
| 11 | 3.4 称标签重名会导致双 `correct`（当前重现） | 当前词库与道具 label 均去重/唯一，**不会重现**；真实问题是 `find` 干扰项固定 | `compile.ts:152-176/420`、`materials.ts` |
| 12 | 3.3 用 unit.ast 取计划目标，并把全部 counts 留作分母 | InstalledUnit 无 ast；样刊该片段得到 0，整个词包却有 143 项、配置的不同目标为 4。先定义冻结目标清单，仅计计划目标；Set 至多 1 本身不构成对外次数错误 | `edition/release.ts:243-252`、`edition/run.ts:372-413`、样刊定向核验 |
| 13 | 4.4 列 `objectsById`/`latestApproval` 为排序缺陷 | 两者已有 `digest` / `seq` 次键；真正缺次键的是 `listReleases`/`listJobs`/`listEditions` | `store.ts:236/471/456/362/302` |
| 14 | 曝光去重和编译修正可直接全局替换 | 增加 §2.0 兼容门禁；样刊旧曝光 5、新曝光 4 会改变冻结复习依据。旧策略与新策略必须显式分派 | `edition/run.ts:435-443`、`edition/reader-state.ts:137-152` |
| 15 | 2.4 只修 previewRevision 的基准 | DraftEditor 草稿初始化仍用全局 head，必须与预览共享当前分支修订解析 | `components/library.tsx:43-46`、`revision.ts:51` |
| 16 | 限流只需将 lastHit 写入移到 sleep 前 | 仍可能让多个等待者同刻发出；改为每主机串行/预约调度，测试真实 request 间隔 | `edition/fetch-source.ts:153-157` |
| 17 | 只断言没有两条 rvr 就能证明 hook 锁修复 | CAS 当前已保证一成功一拒绝；hook 测试应断言 work 只进入一次，且 busy/错误提示正确 | `edition/use-edition.ts:37-52`、`edition/storage.ts:244/263` |
| 18 | checkpoint 已能 import 后继续重放；A 集答过影响 B 集 seen | 没有后缀重放接口；seen 按 episode 隔离且来自完成阅读，streak 需另测；本轮不启用 | `player/src/checkpoint.ts`、`player/src/index.ts:155/189/230-237` |
| 19 | 版本变更后数据库自动重开一定成功 | 当前固定打开 v1，新版库会 VersionError；明确停止写入和保留数据，不删库重建 | `apps/web/src/storage.ts:21/30-35` |
| 20 | P3 顺带拦截任意形似 Key 的字符串 | 已知页面 Key 的落库护栏提升到 §2.11；现有工具是至少 8 字符已知值的子串扫描，不是外形识别 | `application-contract.ts:642-647`、`use-player.ts:144-158/274-301` |
| 21 | Edition 正文文案可证明 4.2 修复；fnv 从 draft.js 导入 | Edition 当前文案已正确；新增失败用例应针对非 legacy story。Edition compile.ts 已有局部 fnv，无需错误 import | `components/scenes.tsx:62`、`edition/compile.ts:86-93` |
