/**
 * Edition Run：采用清单、真实事件、进度投影与独立复习段（设计文档 §11）。
 *
 * 三件事必须严格分开：
 * - 出版物的不可变修订（`IssueRelease` → 安装包）
 * - 这次阅读采用了哪些修订（`EditionRun.adoptedReleases`）
 * - 用户真正做了什么（追加事件，eventId 去重 + seq + 哈希链）
 *
 * 学习状态只能由真实事件重放得到；目录预览、生成、声明目标都不增加曝光。
 * 首版 Edition 的学习记录与 ENDLESS 隔离：算法共用，存档不合并。
 */
import {
  stableStringify, validateBatch,
  type Batch, type ValidationContext,
} from '@endless/esl';
import {
  createEpisode, getScenes, projectSession,
  type Episode, type Library, type PlayerSession, type PlayerView,
} from '@endless/player';
import { materialAssetCatalog, materialEntityExists, materialEntityRows } from '../materials.js';
import {
  EDITION_POLICY_VERSION, EDITION_POLICY_VERSION_V1, EDITION_REVIEW_CONSTRUCTOR_VERSION,
  eventHash, newEditionId, reviewDigest,
  type Cefr, type EditorialRevision, type EditionRun, type EvidenceAction, type EvidenceEvent,
  type IssueRelease, type ReviewBasis, type ReviewRevision,
} from './contract.js';
import { digestOf } from './digest.js';
import type { EditionPublicationPackage } from './release.js';
import type { LanguageEntry, LanguagePackRevision } from './language.js';

export interface EditionInstall {
  release: IssueRelease;
  package: EditionPublicationPackage;
}

const clone = <T,>(value: T): T => structuredClone(value);
const reviewUnitId = (reviewId: string) => `review:${reviewId}`;

/**
 * 安装单元与复习段共用的校验上下文：素材注册表 + 语言包形式。
 *
 * `oov: 'skip'` 用于已发布内容的运行时重建：OOV 是编辑期判定（依赖每单元
 * `allowedExtra`），运行时再判会把已批准的正文误判成错误。这里只关闭 OOV，
 * 素材、答案、`uses` 与场景结构仍然照常校验。
 */
export function packValidationContext(
  pack: LanguagePackRevision,
  extraItems: readonly string[] = [],
  options: { oov?: 'check' | 'skip' } = {},
): ValidationContext {
  const entries = new Map(pack.entries.map((entry) => [entry.item, entry]));
  const allowed = new Set<string>(pack.baselineForms);
  for (const item of extraItems) for (const form of entries.get(item)?.forms ?? []) allowed.add(form.toLowerCase());
  const skipOov = options.oov === 'skip';
  return {
    vocab: {
      allowedForms: allowed,
      oovWarn: skipOov ? 1 : pack.grammarPolicy.oovWarn,
      oovBlock: skipOov ? 1 : pack.grammarPolicy.oovBlock,
      maxWordsPerLine: skipOov ? 400 : pack.grammarPolicy.maxWordsPerLine,
    },
    lexicon: {
      formsOf: (item) => entries.get(item)?.forms,
      confusables: (item) => entries.get(item)?.confusables ?? [],
    },
    assets: materialAssetCatalog(),
    entities: { exists: materialEntityExists },
    predicates: new Map(),
    canonFacts: [],
    activeFacts: [],
    threads: new Map(),
    sceneCountPolicy: { min: 1, max: 24, includeExercises: true },
    channelIsImprov: true,
  };
}

export function unitEpisode(
  unit: { revisionId: string; title: string; subtitle: string; description: string; batch: Batch; sceneSources: Record<string, string> },
  label: string,
  pack: LanguagePackRevision,
): Episode {
  const items = [...new Set(unit.batch.scenes.flatMap((scene) => scene.uses ?? []))];
  return createEpisode(unit.batch, packValidationContext(pack, items, { oov: 'skip' }), {
    title: unit.title,
    subtitle: unit.subtitle,
    description: unit.description,
    presentation: { kind: 'edition', series: 'edition', label, sceneSources: unit.sceneSources },
  });
}

// ---------- 11.1 采用清单 ----------

export interface AdoptInput {
  editionId: string;
  editorialRevisionId: string;
  releases: readonly IssueRelease[];
  now?: Date;
}

export function createRun(input: AdoptInput): EditionRun {
  const now = (input.now ?? new Date()).toISOString();
  const seen = new Set<string>();
  const adopted = input.releases.map((release) => {
    if (seen.has(release.issueId)) throw new Error(`同一期只能采用一个版本：${release.issueId}`);
    seen.add(release.issueId);
    if (release.status !== 'published') throw new Error(`不能采用 ${release.status} 状态的发行`);
    return { issueId: release.issueId, releaseId: release.id, cefr: release.cefr, adoptedAt: now };
  });
  return {
    id: newEditionId('run'),
    editionId: input.editionId,
    editorialRevisionId: input.editorialRevisionId,
    adoptedReleases: adopted,
    levelSchedule: adopted.map((entry) => ({ issueId: entry.issueId, cefr: entry.cefr })),
    events: [],
    createdAt: now,
    revision: 0,
  };
}

function issueOfRevision(installs: readonly EditionInstall[], revisionId: string): IssueRelease | undefined {
  for (const install of installs) {
    if (install.release.orderedUnitRevisionIds.includes(revisionId)) return install.release;
  }
  return undefined;
}

/**
 * 未开始下一期时才能切换该期的等级；已发生事件的单元固定，
 * 不能替换文字后继续解释原答案。
 */
export function scheduleLevel(run: EditionRun, installs: readonly EditionInstall[], release: IssueRelease, cefr: Cefr): EditionRun {
  if (release.cefr !== cefr) throw new Error('目标等级与发行等级不一致');
  if (release.status !== 'published') throw new Error('只能采用已发布的发行');
  // 只能切到本机已安装的版本：没安装的发行切过去会得到读不了的目录
  if (!installs.some((install) => install.release.id === release.id)) {
    throw new Error('只能切换到已安装的发行版本');
  }
  const existing = run.adoptedReleases.find((entry) => entry.issueId === release.issueId);
  const revisions = new Set(release.orderedUnitRevisionIds);
  if (run.events.some((event) => revisions.has(event.revisionId))) {
    throw new Error('该期已有真实阅读记录，不能在原 Run 中换版本');
  }
  const next = clone(run);
  next.adoptedReleases = [
    ...next.adoptedReleases.filter((entry) => entry.issueId !== release.issueId),
    { issueId: release.issueId, releaseId: release.id, cefr: release.cefr, adoptedAt: new Date().toISOString() },
  ];
  next.levelSchedule = [
    ...next.levelSchedule.filter((entry) => entry.issueId !== release.issueId),
    { issueId: release.issueId, cefr },
  ];
  next.revision += 1;
  void existing;
  return next;
}

// ---------- 11.4 事件 ----------

export interface EventInput {
  /** 稳定 ID：同一命令重发在事务内按 eventId 去重。 */
  eventId?: string;
  revisionId: string;
  unitId: string;
  sceneId: string;
  action: EvidenceAction;
  payload?: { choice?: number; skip?: boolean };
  at?: string;
}

export interface AppendResult { run: EditionRun; event: EvidenceEvent; duplicate: boolean }

export function appendRunEvent(
  run: EditionRun,
  installs: readonly EditionInstall[],
  input: EventInput,
  reviews: readonly ReviewRevision[] = [],
): AppendResult {
  const eventId = input.eventId ?? newEditionId('evt');
  const payload = input.payload ?? {};
  const stream = (() => {
    if (input.unitId.startsWith('review:')) {
      const review = reviews.find((entry) => reviewUnitId(entry.id) === input.unitId);
      if (!review) throw new Error('复习段事件引用了不存在的复习修订');
      if (review.runId !== run.id) throw new Error('复习修订不属于该 Run');
      if (review.id !== input.revisionId) throw new Error('复习事件的修订绑定不一致');
      return `review:${review.id}`;
    }
    const release = issueOfRevision(installs, input.revisionId);
    if (!release) throw new Error('事件引用了未安装的修订');
    if (!run.adoptedReleases.some((entry) => entry.releaseId === release.id)) throw new Error('事件引用了该 Run 未采用的发行');
    const unit = installs.find((entry) => entry.release.id === release.id)?.package.units
      .find((entry) => entry.revisionId === input.revisionId);
    if (unit?.unitId !== input.unitId) throw new Error('事件的单元与修订绑定不一致');
    return `issue:${release.issueId}`;
  })();
  const existing = run.events.find((event) => event.eventId === eventId);
  if (existing) {
    const same = existing.streamId === stream && existing.revisionId === input.revisionId &&
      existing.sceneId === input.sceneId && existing.action === input.action &&
      stableStringify(existing.payload) === stableStringify(payload);
    if (!same) throw new Error('相同 eventId 携带了不同内容，拒绝写入');
    return { run, event: existing, duplicate: true };
  }
  const streamEvents = run.events.filter((event) => event.streamId === stream);
  const last = streamEvents.at(-1);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? 'genesis';
  // 时钟回拨不能重排历史：时间只做单调约束，顺序仍由 seq 决定
  const previousAt = run.events.at(-1)?.at;
  const requested = input.at ?? new Date().toISOString();
  const at = previousAt && new Date(requested).getTime() < new Date(previousAt).getTime() ? previousAt : requested;
  const body = {
    eventId, runId: run.id, streamId: stream, seq,
    revisionId: input.revisionId, unitId: input.unitId, sceneId: input.sceneId,
    action: input.action, payload, at, prevHash,
  };
  const event: EvidenceEvent = { ...body, hash: eventHash(body) };
  const next = clone(run);
  next.events = [...next.events, event];
  next.revision += 1;
  return { run: next, event, duplicate: false };
}

// ---------- 投影 ----------

/** Run 的运行时内容库：只包含本次真正采用的发行版本 + 已冻结的复习修订。 */
export function runLibrary(run: EditionRun, installs: readonly EditionInstall[], reviews: readonly ReviewRevision[] = []): Library {
  const episodes: Episode[] = [];
  const glossary: Library['glossary'] = {};
  for (const adopted of run.adoptedReleases) {
    const install = installs.find((entry) => entry.release.id === adopted.releaseId);
    if (!install) continue;
    for (const unit of install.package.units) {
      episodes.push(unitEpisode(unit, install.release.issueId, install.package.pack));
    }
    for (const entry of install.package.pack.entries) {
      glossary[entry.item] = { label: entry.forms[0] ?? entry.item, gloss: entry.glossZh, forms: entry.forms };
    }
  }
  for (const review of reviews.filter((entry) => entry.runId === run.id)) {
    const adopted = run.adoptedReleases.find((entry) => entry.issueId === review.issueId);
    const pack = installs.find((entry) => entry.release.id === adopted?.releaseId)?.package.pack;
    if (!pack) throw new Error('复习段缺少对应发行的语言包');
    const items = [...new Set(review.batch.scenes.flatMap((scene) => scene.uses ?? []))];
    episodes.push(createEpisode(review.batch, packValidationContext(pack, items), {
      title: '复习',
      subtitle: review.issueId,
      description: '独立复习段',
      presentation: { kind: 'review', series: 'edition', label: '复习' },
    }));
  }
  return { version: `edition-${run.id}`, episodes, glossary, entities: [...materialEntityRows], predicates: [] };
}

export interface UnitProgress {
  revisionId: string;
  unitId: string;
  issueId: string;
  scenes: number;
  completed: number;
  skipped: number;
  status: 'unread' | 'reading' | 'read' | 'finished_with_skips';
}

export interface RunProjection {
  view: PlayerView;
  units: UnitProgress[];
  completedScenes: number;
  skippedScenes: number;
  finishedWithSkips: boolean;
}

export function projectRun(
  run: EditionRun,
  installs: readonly EditionInstall[],
  reviews: readonly ReviewRevision[] = [],
): RunProjection {
  const library = runLibrary(run, installs, reviews);
  const first = library.episodes[0];
  if (!first) {
    const view = projectSession(
      { version: 1, catalog: 'empty', revision: 0, current: '', largeText: false, events: [] },
      { version: 'empty', episodes: [], glossary: {}, entities: [], predicates: [] },
    );
    return { view, units: [], completedScenes: 0, skippedScenes: 0, finishedWithSkips: false };
  }
  const session: PlayerSession = {
    version: 1, catalog: library.version, revision: run.revision, current: first.id, largeText: false,
    events: run.events.map((event) => ({
      type: event.action,
      episode: event.revisionId,
      scene: event.sceneId,
      at: event.at,
      ...(event.action === 'answer' ? { choice: event.payload.choice ?? 0 } : {}),
      ...(event.action === 'advance' ? { skip: event.payload.skip === true } : {}),
    })) as PlayerSession['events'],
  };
  const view = projectSession(session, library);
  const units: UnitProgress[] = [];
  for (const adopted of run.adoptedReleases) {
    const install = installs.find((entry) => entry.release.id === adopted.releaseId);
    if (!install) continue;
    for (const unit of install.package.units) {
      const episode = library.episodes.find((entry) => entry.id === unit.revisionId);
      const scenes = episode ? getScenes(episode) : [];
      const progress = view.episodes[unit.revisionId];
      let completed = 0;
      let skipped = 0;
      for (const scene of scenes) {
        const state = progress?.scenes[scene.id];
        if (state?.completed) completed += 1;
        else if (state?.skipped) skipped += 1;
      }
      const status: UnitProgress['status'] = completed + skipped === 0
        ? 'unread'
        : completed === scenes.length ? 'read'
          : completed + skipped === scenes.length ? 'finished_with_skips' : 'reading';
      units.push({ revisionId: unit.revisionId, unitId: unit.unitId, issueId: adopted.issueId, scenes: scenes.length, completed, skipped, status });
    }
  }
  const completedScenes = units.reduce((sum, unit) => sum + unit.completed, 0);
  const skippedScenes = units.reduce((sum, unit) => sum + unit.skipped, 0);
  return {
    view, units, completedScenes, skippedScenes,
    finishedWithSkips: skippedScenes > 0 && units.every((unit) => unit.status !== 'reading'),
  };
}

/**
 * 每个条目的真实曝光次数：只统计「明确 advance 且未跳过」的正文场景。
 * 声明目标、目录预览、生成正文都不增加计数。
 */
export function runExposureCounts(
  run: EditionRun,
  installs: readonly EditionInstall[],
  reviews: readonly ReviewRevision[] = [],
  policyVersion: string = EDITION_POLICY_VERSION,
): Map<string, number> {
  const projection = projectRun(run, installs, reviews);
  const library = runLibrary(run, installs, reviews);
  // v1 复核路径按原语义计次（同场景两处出现计两次）；当前版本同场景去重。
  const legacy = policyVersion === EDITION_POLICY_VERSION_V1;
  const counts = new Map<string, number>();
  for (const episode of library.episodes) {
    for (const scene of getScenes(episode)) {
      if (!projection.view.episodes[episode.id]?.scenes[scene.id]?.completed) continue;
      const items = legacy
        ? episode.ast.targets.filter((entry) => entry.sceneId === scene.id).map((entry) => entry.itemId)
        : [...new Set(episode.ast.targets.filter((entry) => entry.sceneId === scene.id).map((entry) => entry.itemId))];
      for (const itemId of items) counts.set(itemId, (counts.get(itemId) ?? 0) + 1);
    }
  }
  return counts;
}

export interface CompletionStatus {
  publication: { complete: boolean; issues: { issueId: string; state: 'published' | 'missing' }[] };
  reading: { complete: boolean; unitsRead: number; unitsTotal: number; finishedWithSkips: boolean };
  /**
   * 目标达成只统计随发行冻结的教学目标清单（`InstalledUnit.goalItems`）。
   * 旧安装包没有这份清单时 `unavailable` 为真——报告不可用，不伪造 0/0。
   */
  goals: {
    unavailable: boolean; achieved: number; total: number;
    items: { item: string; evidence: 'exposure' | 'practice' | 'retrieval' | 'none' }[];
  };
}

/** 三种完成口径必须分开：出版完成 ≠ 阅读完成 ≠ 目标达成。 */
export function runCompletion(
  run: EditionRun,
  installs: readonly EditionInstall[],
  editorial: EditorialRevision,
  reviews: readonly ReviewRevision[] = [],
): CompletionStatus {
  const projection = projectRun(run, installs, reviews);
  const issues = editorial.issues.map((issue) => {
    const adopted = run.adoptedReleases.find((entry) => entry.issueId === issue.id);
    const install = adopted && installs.find((entry) => entry.release.id === adopted.releaseId);
    return { issueId: issue.id, state: install ? 'published' as const : 'missing' as const };
  });
  // 分母只取随发行冻结的教学目标清单；语言包其余词条与正文额外出现词不进入目标分母。
  const goalItems = new Set<string>();
  let goalsUnavailable = false;
  for (const adopted of run.adoptedReleases) {
    const install = installs.find((entry) => entry.release.id === adopted.releaseId);
    if (!install) continue;
    for (const unit of install.package.units) {
      if (unit.goalItems === undefined) goalsUnavailable = true;
      else for (const item of unit.goalItems) goalItems.add(item);
    }
  }
  const counts = new Map<string, { exposure: number; practice: number; retrieval: number }>();
  for (const item of goalItems) counts.set(item, { exposure: 0, practice: 0, retrieval: 0 });
  for (const item of projection.view.exposed) {
    const bucket = counts.get(item);
    if (bucket) bucket.exposure += 1;
  }
  for (const answer of projection.view.answers) {
    if (!answer.item) continue;
    const bucket = counts.get(answer.item);
    if (!bucket) continue;
    if (answer.grade) bucket.retrieval += 1;
    else bucket.practice += 1;
  }
  const targets = [...counts.entries()].map(([item, value]) => ({
    item,
    evidence: value.retrieval > 0 ? 'retrieval' as const
      : value.practice > 0 ? 'practice' as const
        : value.exposure > 0 ? 'exposure' as const
          : 'none' as const,
  }));
  const achieved = targets.filter((entry) => entry.evidence !== 'none').length;
  const readingComplete = projection.units.length > 0 && projection.units.every((unit) => unit.status === 'read');
  return {
    publication: { complete: issues.every((issue) => issue.state === 'published'), issues },
    reading: {
      complete: readingComplete,
      unitsRead: projection.units.filter((unit) => unit.status === 'read').length,
      unitsTotal: projection.units.length,
      finishedWithSkips: projection.finishedWithSkips,
    },
    goals: goalsUnavailable
      ? { unavailable: true, achieved: 0, total: 0, items: [] }
      : { unavailable: false, achieved, total: targets.length, items: targets },
  };
}

// ---------- 11.3 独立复习轨 ----------

export function eventPrefixHash(run: EditionRun): string {
  return digestOf(run.events.map((event) => event.hash));
}

/**
 * 进入复习前冻结依据：事件前缀、到期状态、取材行与构造器版本。
 * 之后继续阅读不改变这次复习的取材范围。
 */
export function buildReviewBasis(
  run: EditionRun,
  installs: readonly EditionInstall[],
  pack: LanguagePackRevision,
  issueId: string,
  now = new Date(),
  reviews: readonly ReviewRevision[] = [],
  policyVersion: string = EDITION_POLICY_VERSION,
): ReviewBasis {
  const projection = projectRun(run, installs, reviews);
  const cards = new Map(projection.view.srs.allCards().map((entry) => [entry.key, entry.card]));
  const exposures = runExposureCounts(run, installs, reviews, policyVersion);
  const dueItems: ReviewBasis['dueItems'] = [];
  for (const entry of pack.entries) {
    const count = exposures.get(entry.item) ?? 0;
    if (count < 1) continue;
    const card = cards.get(`${entry.item}#meaning`);
    dueItems.push({ item: entry.item, exposures: count, dueAt: card ? card.due.toISOString() : null });
  }
  const sourceRefs: ReviewBasis['sourceRefs'] = [];
  for (const adopted of run.adoptedReleases.filter((entry) => entry.issueId === issueId)) {
    const install = installs.find((entry) => entry.release.id === adopted.releaseId);
    if (!install) continue;
    for (const unit of install.package.units) {
      for (const scene of unit.batch.scenes) {
        if (scene.type !== 'comic') continue;
        const read = run.events.some((event) => event.revisionId === unit.revisionId && event.sceneId === scene.id
          && event.action === 'advance' && event.payload.skip === false);
        if (!read) continue;
        for (const panel of scene.panels) {
          if (panel.caption) sourceRefs.push({ reference: `${unit.revisionId}.${scene.id}`, text: panel.caption, hash: digestOf(panel.caption) });
        }
      }
    }
  }
  return {
    runId: run.id,
    issueId,
    cefr: run.adoptedReleases.find((entry) => entry.issueId === issueId)?.cefr ?? 'A2',
    eventCount: run.events.length,
    eventHash: eventPrefixHash(run),
    dueItems: dueItems.slice(0, 40),
    sourceRefs: sourceRefs.slice(0, 40),
    constructorVersion: EDITION_REVIEW_CONSTRUCTOR_VERSION,
    policyVersion,
    createdAt: now.toISOString(),
  };
}

export interface ReviewConstruction {
  revision: ReviewRevision;
  /** 合格条目不足时明确显示练习，不凑 FSRS 成绩。 */
  hasGradedItems: boolean;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function placeCorrect<T>(correct: T, others: T[], seed: string): T[] {
  const options = [...others];
  options.splice(fnv1a32(seed) % (options.length + 1), 0, correct);
  return options;
}

function distractorGlosses(entry: LanguageEntry, entries: Map<string, LanguageEntry>): string[] {
  const pool: string[] = [];
  const push = (id: string) => {
    const gloss = entries.get(id)?.glossZh;
    if (gloss && gloss !== entry.glossZh && !pool.includes(gloss)) pool.push(gloss);
  };
  for (const id of entry.confusables) push(id);
  for (const candidate of [...entries.values()].sort((a, b) => a.freqBand - b.freqBand || a.item.localeCompare(b.item))) {
    push(candidate.item);
  }
  return pool;
}

/**
 * 构造规则：
 * - 只有「真实曝光 ≥ 2 且（没有卡片或已到期）」才进入评分轨，且必须是 4 选项；
 * - 其余一律降为明确练习；
 * - 复习不引用未读材料，不要求新的模型调用。
 */
function buildReviewBatch(basis: ReviewBasis, pack: LanguagePackRevision, batchId: string): {
  batch: Batch; graded: string[]; practice: string[];
} {
  const entries = new Map(pack.entries.map((entry) => [entry.item, entry]));
  const scenes: Batch['scenes'] = [];
  const graded: string[] = [];
  const practice: string[] = [];
  const now = new Date(basis.createdAt).getTime();
  for (const due of basis.dueItems.slice(0, 8)) {
    const entry = entries.get(due.item);
    if (!entry) continue;
    const eligible = due.exposures >= 2 && (due.dueAt === null || new Date(due.dueAt).getTime() <= now);
    const distractors = distractorGlosses(entry, entries);
    const sceneId = `s${scenes.length + 1}`;
    if (eligible && distractors.length >= 3) {
      const options = placeCorrect(entry.glossZh, distractors.slice(0, 3), `${basis.eventHash}:${entry.item}`);
      scenes.push({
        id: sceneId, type: 'quiz', kind: 'meaning', item: entry.item,
        prompt: `「${entry.forms[0]}」是什么意思？`,
        options: options.map((label) => ({ label, ...(label === entry.glossZh ? { correct: true } : {}) })),
        feedback: { on_correct: `答对了——「${entry.glossZh}」。`, on_wrong: `再想想——「${entry.forms[0]}」是「${entry.glossZh}」。` },
        evidence: { item: entry.item, type: 'recognition-4' },
      });
      graded.push(entry.item);
      continue;
    }
    if (!distractors.length) continue;
    const options = placeCorrect(entry.glossZh, distractors.slice(0, 1), `${basis.eventHash}:${entry.item}:practice`);
    scenes.push({
      id: sceneId, type: 'quiz', kind: 'meaning', item: entry.item,
      prompt: `（练习）「${entry.forms[0]}」是什么意思？`,
      options: options.map((label) => ({ label, ...(label === entry.glossZh ? { correct: true } : {}) })),
      feedback: { on_correct: `「${entry.glossZh}」——这次只记练习。`, on_wrong: `「${entry.forms[0]}」是「${entry.glossZh}」；这次只记练习。` },
      evidence: { item: entry.item, type: 'practice' },
    });
    practice.push(entry.item);
  }
  return {
    batch: {
      // episode id 必须等于复习修订 ID：事件按 revisionId 定位场景
      batch: batchId,
      channel: 'edition',
      brief: `review:${basis.issueId}`,
      cast: [materialEntityRows[0]?.id ?? 'guide'],
      scenes,
    },
    graded,
    practice,
  };
}

function practiceOnlyScene(pack: LanguagePackRevision): Batch['scenes'][number] {
  const entry = pack.entries[0]!;
  const other = pack.entries.find((candidate) => candidate.glossZh !== entry.glossZh) ?? entry;
  return {
    id: 's1', type: 'quiz', kind: 'meaning', item: entry.item,
    prompt: `（练习）「${entry.forms[0]}」是什么意思？`,
    options: [{ label: entry.glossZh, correct: true }, { label: other.glossZh === entry.glossZh ? '另一个释义' : other.glossZh }],
    feedback: { on_correct: '这次没有合格复习条目，只记练习。', on_wrong: '这次没有合格复习条目，只记练习。' },
    evidence: { item: entry.item, type: 'practice' },
  };
}

/** 程序构造复习段：不要求新的模型调用，不使用未读材料。 */
export function buildReviewRevision(
  basis: ReviewBasis,
  pack: LanguagePackRevision,
  reviewId = newEditionId('rvr'),
  now = new Date(),
): ReviewConstruction {
  const built = buildReviewBatch(basis, pack, reviewId);
  const scenes = built.batch.scenes.length ? built.batch.scenes : [practiceOnlyScene(pack)];
  const body = {
    runId: basis.runId, issueId: basis.issueId, basis,
    batch: { ...built.batch, scenes },
    gradedItems: built.graded, practiceItems: built.practice,
  };
  return {
    revision: { id: reviewId, ...body, digest: reviewDigest(body), createdAt: now.toISOString() },
    hasGradedItems: built.graded.length > 0,
  };
}

/** 复习段同样要经过结构与选项校验；不通过就不能进入评分轨。 */
export function reviewIssues(revision: ReviewRevision, pack: LanguagePackRevision): {
  code: string; level: 'error' | 'warning'; message: string; scene?: string;
}[] {
  const issues: { code: string; level: 'error' | 'warning'; message: string; scene?: string }[] = [];
  if (revision.digest !== reviewDigest(revision)) {
    issues.push({ code: 'E-REVIEW-DIGEST', level: 'error', message: '复习修订摘要不匹配' });
  }
  const items = [...new Set(revision.batch.scenes.flatMap((scene) => scene.evidence?.item ? [scene.evidence.item] : []))];
  const context = packValidationContext(pack, items);
  context.sceneCountPolicy = { min: 1, max: 12, includeExercises: true };
  issues.push(...validateBatch(revision.batch, context).issues.filter((issue) => issue.level === 'error'));
  for (const scene of revision.batch.scenes) {
    if (scene.evidence?.type === 'recognition-4' && !(scene.type === 'quiz' && scene.options.length === 4)) {
      issues.push({ code: 'E-REVIEW-EVIDENCE', level: 'error', message: `${scene.id} 的独立检索必须使用 4 个选项`, scene: scene.id });
    }
  }
  if (revision.gradedItems.some((item) => !revision.batch.scenes.some((scene) => scene.evidence?.item === item && scene.evidence.type === 'recognition-4'))) {
    issues.push({ code: 'E-REVIEW-GRADE', level: 'error', message: 'gradedItems 与实际评分场景不一致' });
  }
  return issues;
}

/** 复习取材必须来自真实读过的正文行（防止凭空捏造语境）。 */
export function reviewSourceIssues(revision: ReviewRevision, readLines: readonly string[]): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  const normalized = new Set(readLines.map((line) => line.replace(/\s+/g, ' ').trim()));
  for (const ref of revision.basis.sourceRefs) {
    if (!normalized.has(ref.text.replace(/\s+/g, ' ').trim())) {
      issues.push({ code: 'E-REVIEW-SOURCE', message: `复习取材行不在真实阅读记录中：${ref.reference}` });
    }
  }
  return issues;
}

export { getScenes };
