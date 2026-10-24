/**
 * 分层校验与验收（设计文档 §10）。
 *
 * 顺序：引用闭包 → 权利准入 → 草稿重编译并逐项比较 → 结构与语言约束 →
 * 教学覆盖 → 全路径可玩性 → 时长/重复 → 人工审阅（不在本文件）。
 * 程序通过不自动等于「事实已核验」：`reports.validation` 只回报程序结论。
 */
import {
  stableStringify, validateBatch,
  type Batch, type ValidationContext, type ValidationIssue,
} from '@endless/esl';
import { createEpisode, getOptions, getScenes, projectSession, transition, type Library } from '@endless/player';
import { materialAssetCatalog, materialEntityExists, materialEntityRows } from '../materials.js';
import {
  EDITION_VALIDATION_POLICY_VERSION,
  unitRevisionDigest,
  type EditorialRevision,
  type UnitLevelPlan,
  type UnitRevision,
} from './contract.js';
import { canonicalJson } from './digest.js';
import { compileEditionDraft, type EditionCompileSuccess, type EditionPassage, type EditionPriorLine, type EditionTarget } from './compile.js';
import { allowedFormsFor, difficultyIssues, measureDifficulty, type DifficultyMetrics, type LanguagePackRevision } from './language.js';
import { corpusClosureIssues, type CorpusRevision, type PassageRevision, type RightsDecision } from './sources.js';

export interface EditionValidationInput {
  revision: UnitRevision;
  editorial: EditorialRevision;
  levelPlan: UnitLevelPlan;
  targets: EditionTarget[];
  pack: LanguagePackRevision;
  passages: EditionPassage[];
  corpus: CorpusRevision;
  /** 语料绑定的权利决策：没有批准记录就不能作为正式正文显示。 */
  rights: RightsDecision[];
  priorLines?: EditionPriorLine[];
  allowedCharacters?: readonly string[];
}

export interface EditionValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  difficulty: DifficultyMetrics | null;
  compiled: EditionCompileSuccess | null;
}

/** 供 `validateBatch` 使用的 Edition 上下文：注册素材、语言包形式、Edition 场景数口径。 */
export function editionValidationContext(pack: LanguagePackRevision, plan: UnitLevelPlan, targets: readonly EditionTarget[]): ValidationContext {
  const entries = new Map(pack.entries.map((entry) => [entry.item, entry]));
  return {
    vocab: {
      allowedForms: allowedFormsFor(pack, plan, targets.map((target) => target.item)),
      oovWarn: pack.grammarPolicy.oovWarn,
      oovBlock: pack.grammarPolicy.oovBlock,
      maxWordsPerLine: pack.grammarPolicy.maxWordsPerLine,
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
    // Unit 建议 10–20 场，但短单元（阅读 + 练习）也必须能通过；上限保持有限
    sceneCountPolicy: { min: 2, max: 24, includeExercises: true },
    channelIsImprov: true,
  };
}

/** 依据链：资料、编辑、分级计划、正文与语言包必须是同一条合法引用链。 */
function basisIssues(input: EditionValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { revision } = input;
  const err = (message: string) => issues.push({ code: 'E-EDITION-BASIS', level: 'error', message });
  if (revision.contract !== 'edition-draft-v1') err('不是 edition-draft-v1 契约');
  if (revision.basis.editorialRevisionId !== input.editorial.id) err('生成依据指向其他编辑修订');
  if (revision.basis.corpusRevisionId !== input.corpus.id) err('生成依据指向其他语料修订');
  if (revision.basis.languagePackRevisionId !== input.pack.id) err('生成依据指向其他语言包');
  if (revision.basis.unitPlanId !== input.levelPlan.unitId) err('生成依据与单元计划不一致');
  if (revision.basis.unitLevelPlanId !== input.levelPlan.id) err('生成依据与分级教学计划不一致');
  if (revision.basis.cefr !== revision.cefr || revision.cefr !== input.levelPlan.cefr) err('等级不一致');
  const passageIds = input.passages.map((passage) => passage.revision.id);
  if (canonicalJson([...revision.basis.passageRevisionIds].sort()) !== canonicalJson([...passageIds].sort())) {
    err('正文引用清单与依据不一致');
  }
  for (const passage of input.passages) {
    if (passage.revision.cefr !== revision.cefr) err(`正文 ${passage.revision.id} 属于 ${passage.revision.cefr}，不能用于 ${revision.cefr}`);
    if (passage.revision.languagePackRevisionId !== input.pack.id) err(`正文 ${passage.revision.id} 使用了其他语言包`);
  }
  const plan = input.editorial.units.find((unit) => unit.id === revision.unitId);
  if (!plan) err('单元不在编辑修订目录中');
  if (plan) {
    for (const claim of plan.claimRefs) {
      if (!input.corpus.claims.some((entry) => entry.id === claim)) err(`单元主张 ${claim} 不在冻结语料中`);
    }
  }
  return issues;
}

/** 已批准正文的显示绑定：面板 caption 拼接后必须等于被审阅的段落。 */
function passageBindingIssues(revision: UnitRevision, passages: readonly EditionPassage[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(passages.map((passage) => [passage.revision.id, passage.revision]));
  const grouped = new Map<string, { passage: PassageRevision; segment: number; captions: string[] }>();
  for (const binding of revision.creation.passageBindings) {
    const passage = byId.get(binding.passageRevisionId);
    if (!passage) {
      issues.push({ code: 'E-EDITION-PASSAGE', level: 'error', message: `正文绑定指向未批准的 ${binding.passageRevisionId}` });
      continue;
    }
    const scene = revision.batch.scenes.find((entry) => entry.id === binding.sceneId);
    if (!scene || scene.type !== 'comic') {
      issues.push({ code: 'E-EDITION-PASSAGE', level: 'error', message: `${binding.sceneId} 不是阅读场景` });
      continue;
    }
    if (scene.panels.some((panel) => panel.bubbles.length || panel.actors.length)) {
      issues.push({ code: 'E-EDITION-PASSAGE', level: 'error', message: `${binding.sceneId} 的阅读面板不能包含演员或对白`, scene: scene.id });
    }
    const key = `${binding.passageRevisionId}#${binding.segmentIndex}`;
    const bucket = grouped.get(key) ?? { passage, segment: binding.segmentIndex, captions: [] };
    for (const panel of scene.panels) if (panel.caption) bucket.captions.push(panel.caption);
    grouped.set(key, bucket);
  }
  for (const [key, bucket] of grouped) {
    const source = bucket.passage.textSegments[bucket.segment];
    if (!source) {
      issues.push({ code: 'E-EDITION-PASSAGE', level: 'error', message: `正文段 ${key} 不存在` });
      continue;
    }
    const shown = bucket.captions.join(' ').replace(/\s+/g, ' ').trim();
    const expected = source.text.replace(/\s+/g, ' ').trim();
    if (shown !== expected) {
      issues.push({ code: 'E-EDITION-PASSAGE', level: 'error', message: `正文段 ${key} 的显示文本与已审阅正文不一致，不能只改哈希` });
    }
  }
  const bound = new Set(grouped.keys());
  for (const passage of passages) {
    passage.revision.textSegments.forEach((_, index) => {
      if (!bound.has(`${passage.revision.id}#${index}`)) {
        issues.push({ code: 'E-EDITION-PASSAGE', level: 'error', message: `正文段 ${passage.revision.id}#${index} 未显示` });
      }
    });
  }
  return issues;
}

/** 全路径验收：答对、答错、跳过、重复命令都必须可推进；Edition 禁止剧情 effect。 */
export function validateEditionPaths(batch: Batch, context: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (batch.scenes.some((scene) => scene.effects && Object.keys(scene.effects).length)) {
    issues.push({ code: 'E-EDITION-EFFECTS', level: 'error', message: 'Edition 首版禁止剧情状态 effect；分支不能污染已编好的后文' });
    return issues;
  }
  const library: Library = {
    version: `edition-${batch.batch}`,
    episodes: [createEpisode(batch, context, { title: 'unit', subtitle: 'unit', description: 'unit' })],
    glossary: {},
    entities: [...materialEntityRows],
    predicates: [],
  };
  const episode = library.episodes[0]!;
  const base = { version: 1 as const, catalog: library.version, revision: 0, current: episode.id, largeText: false, events: [] };
  try {
    let prefix = transition(base, { type: 'select', episode: episode.id }, library, '2026-01-01T00:00:00.000Z');
    for (const scene of getScenes(episode)) {
      const options = getOptions(scene);
      for (let choice = 0; choice < options.length; choice++) {
        transition(prefix, { type: 'answer', scene: scene.id, choice }, library, '2026-01-01T00:00:00.000Z');
      }
      // 重复命令不得产生第二次答案
      if (options.length) {
        const answered = transition(prefix, { type: 'answer', scene: scene.id, choice: 0 }, library, '2026-01-01T00:00:00.000Z');
        if (answered.events.length !== prefix.events.length + 1) {
          issues.push({ code: 'E-EDITION-PATH', level: 'error', message: `${scene.id} 接受了重复答题`, scene: scene.id });
        }
      }
      const skipped = transition(prefix, { type: 'advance', scene: scene.id, skip: true }, library, '2026-01-01T00:00:00.000Z');
      projectSession(skipped, library);
      let working = prefix;
      if (scene.type === 'card') working = transition(working, { type: 'reveal', scene: scene.id }, library, '2026-01-01T00:00:00.000Z');
      const correct = options.findIndex((option) => option.correct === true);
      if (correct >= 0) working = transition(working, { type: 'answer', scene: scene.id, choice: correct }, library, '2026-01-01T00:00:00.000Z');
      prefix = transition(working, { type: 'advance', scene: scene.id, skip: false }, library, '2026-01-01T00:00:00.000Z');
    }
    projectSession(prefix, library);
  } catch (error) {
    issues.push({ code: 'E-EDITION-PATH', level: 'error', message: `路径验收失败：${(error as Error).message}` });
  }
  return issues;
}

/** 完整单元验收。返回编译产物，供调用方写回修订。 */
export function validateEditionUnit(input: EditionValidationInput): EditionValidationResult {
  const issues: ValidationIssue[] = [...basisIssues(input)];
  const push = (code: string, message: string, level: 'error' | 'warning' = 'error', scene?: string) =>
    issues.push({ code, level, message, ...(scene ? { scene } : {}) });

  for (const entry of corpusClosureIssues(input.corpus, input.rights)) push(entry.code, entry.message);
  if (input.revision.digest !== unitRevisionDigest(input.revision)) {
    push('E-EDITION-DIGEST', '单元修订摘要不匹配：正文、选项或来源被改动');
  }

  const compiled = compileEditionDraft(input.revision.draft, {
    seed: input.revision.id,
    batchId: input.revision.batch.batch,
    unitId: input.revision.unitId,
    cefr: input.revision.cefr,
    plan: input.levelPlan,
    pack: input.pack,
    passages: input.passages,
    targets: input.targets,
    priorLines: input.priorLines,
    allowedCharacters: input.allowedCharacters,
    validate: (batch) => validateBatch(batch, editionValidationContext(input.pack, input.levelPlan, input.targets)).issues,
  });
  if (!compiled.ok) {
    issues.push(...compiled.issues);
    return { ok: false, issues, difficulty: null, compiled: null };
  }

  // C01/C02/C03：重新编译后逐项比较，不只比顶层 hash
  if (stableStringify(compiled.batch) !== stableStringify(input.revision.batch)) {
    push('E-EDITION-RECOMPILE', '重新编译的批次与保存的批次不一致（正文、选项、顺序或来源被改动）');
  }
  if (stableStringify(compiled.creation) !== stableStringify(input.revision.creation)) {
    push('E-EDITION-RECOMPILE', '重新编译的创作绑定与保存值不一致（来源或呈现元数据被改动）');
  }
  if (compiled.title !== input.revision.title || compiled.subtitle !== input.revision.subtitle ||
    compiled.description !== input.revision.description) {
    push('E-EDITION-RECOMPILE', '标题/副标题/说明与草稿编译结果不一致');
  }
  issues.push(...passageBindingIssues(input.revision, input.passages));

  const allowed = allowedFormsFor(input.pack, input.levelPlan, input.targets.map((target) => target.item));
  const difficulty = measureDifficulty(input.revision.batch, allowed, input.pack);
  issues.push(...difficultyIssues(difficulty, input.pack).map((issue) => ({
    code: issue.code, level: issue.level, message: issue.message,
  })));

  if (compiled.teaching.narrativeWords > input.levelPlan.contextBudget.maxWords) {
    push('W-EDITION-BUDGET', `本单元正文 ${compiled.teaching.narrativeWords} 词，超出计划预算 ${input.levelPlan.contextBudget.maxWords} 词`, 'warning');
  }
  issues.push(...validateEditionPaths(input.revision.batch, editionValidationContext(input.pack, input.levelPlan, input.targets)));
  if (compiled.teaching.estimatedMinutes > 30) {
    push('W-EDITION-DURATION', `单元估计 ${compiled.teaching.estimatedMinutes} 分钟，超过 30 分钟建议拆分`, 'warning');
  }
  const ok = !issues.some((issue) => issue.level === 'error');
  return { ok, issues, difficulty, compiled };
}

/** 写回验收结论：只在通过时标记 validated，并冻结报告。 */
export function acceptEditionUnit(input: EditionValidationInput, now = new Date()): UnitRevision {
  const result = validateEditionUnit(input);
  if (!result.ok || !result.compiled) {
    throw new Error(`单元未通过验收：${result.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message).join('；')}`);
  }
  const { revision } = input;
  const body = {
    ...revision,
    title: result.compiled.title,
    subtitle: result.compiled.subtitle,
    description: result.compiled.description,
    status: 'validated' as const,
    reports: {
      validation: { ok: true, issues: result.issues.filter((issue) => issue.level === 'warning').map((issue) => ({
        code: issue.code, level: 'warning' as const, message: issue.message, ...(issue.scene ? { scene: issue.scene } : {}),
      })) },
      teaching: {
        contexts: result.compiled.teaching.contexts,
        practiceItems: result.compiled.teaching.practiceItems,
        estimatedMinutes: result.compiled.teaching.estimatedMinutes,
      },
    },
    authoredAt: now.toISOString(),
  };
  const { digest: _digest, ...rest } = body;
  return { ...body, digest: unitRevisionDigest(rest) };
}

/** 只读复核：不改变状态，用于恢复/导入时验证已发布单元仍能重放。 */
export function verifyPublishedUnit(input: EditionValidationInput): ValidationIssue[] {
  const result = validateEditionUnit(input);
  return result.issues;
}

export const EDITION_VALIDATION_POLICY = EDITION_VALIDATION_POLICY_VERSION;
