/**
 * 分级语言资产与难度政策（设计文档 §8）。
 *
 * 三条纪律：
 * 1. `baselineForms` 只表示「该等级允许使用」，不代表学习者已掌握；绝不写进
 *    用户 known/exposed，也不增加 BKT 概率。
 * 2. 阈值、分词器、统计口径一起版本化；中文署名/题目/反馈与英文正文分开统计，
 *    不能用一个分母稀释 OOV。
 * 3. 低级版本无法忠实表达某概念时缩小细节或标注等级，不编错事实。
 */
import { batchTextUnits, locateForm, tokenize, type Batch } from '@endless/esl';
import { z } from 'zod';
import type { Lexicon } from '@endless/learning';
import { digestOf, normalizeForDigest } from './digest.js';
import {
  CEFR_RANK, CefrSchema, EditionRefSchema, DigestSchema, OPEN_CEFR_LEVELS,
  type Cefr, type UnitLevelPlan,
} from './contract.js';

export const LANGUAGE_POLICY_VERSION = 'edition-language-1' as const;

export const LanguageEntrySchema = z.object({
  item: z.string().min(1).max(80),
  kind: z.enum(['sense', 'chunk', 'pattern']),
  /** 句型可能没有可定位模板：首版只展示，不能当作可检测目标。 */
  forms: z.array(z.string().min(1)).max(6),
  glossZh: z.string().min(1).max(120),
  example: z.string().max(400).nullable(),
  cefr: CefrSchema,
  pos: z.string().max(20).nullable(),
  freqBand: z.number().int().min(1).max(5),
  confusables: z.array(z.string().min(1).max(80)).max(8),
  /** 词形/词义/例句的来源：本地词库条目、专有名词表或人工补录，不能由模型自证。 */
  sourceRef: z.string().min(1).max(200),
});
export type LanguageEntry = z.infer<typeof LanguageEntrySchema>;

export const LanguagePackRevisionSchema = z.object({
  id: EditionRefSchema,
  revisionId: z.string().min(1).max(80),
  cefr: CefrSchema,
  frozenAt: z.string().datetime(),
  /** 该等级允许出现的基础形式：功能词 + 已审核条目形式。 */
  baselineForms: z.array(z.string().min(1)).max(4000),
  functionWords: z.array(z.string().min(1)).max(600),
  entries: z.array(LanguageEntrySchema).max(1200),
  properNouns: z.array(z.string().min(1).max(40)).max(60),
  grammarPolicy: z.object({
    policyVersion: z.literal(LANGUAGE_POLICY_VERSION),
    maxWordsPerLine: z.number().int().min(6).max(30),
    maxSentenceWords: z.number().int().min(6).max(60),
    oovWarn: z.number().min(0).max(0.5),
    oovBlock: z.number().min(0).max(1),
    tokenizerVersion: z.string().min(1).max(40),
  }),
  /** 词库与 CEFR 参考资料的许可分别核验；没有权利依据的包不能进入发布。 */
  rights: z.object({
    basis: z.string().min(1).max(200),
    decisionId: EditionRefSchema.nullable(),
    note: z.string().max(400),
  }),
  digest: DigestSchema,
});
export type LanguagePackRevision = z.infer<typeof LanguagePackRevisionSchema>;

export function languagePackDigest(pack: Omit<LanguagePackRevision, 'digest'>): string {
  return digestOf({
    revisionId: pack.revisionId, cefr: pack.cefr, frozenAt: pack.frozenAt,
    baselineForms: pack.baselineForms, functionWords: pack.functionWords, entries: pack.entries,
    properNouns: pack.properNouns, grammarPolicy: pack.grammarPolicy, rights: pack.rights,
  });
}

export function isOpenLevel(cefr: Cefr): boolean {
  return OPEN_CEFR_LEVELS.includes(cefr);
}

export function levelRank(cefr: Cefr): number {
  return CEFR_RANK[cefr];
}

/** 等级比较必须用显式 rank，不做字符串比较，也不改原 A1/A2 枚举。 */
export function isAtOrBelow(cefr: Cefr, ceiling: Cefr): boolean {
  return levelRank(cefr) <= levelRank(ceiling);
}

export interface PackBuildInput {
  id: string;
  revisionId: string;
  cefr: Cefr;
  frozenAt: string;
  entries: LanguageEntry[];
  functionWords: readonly string[];
  properNouns?: readonly string[];
  maxWordsPerLine?: number;
  rights: LanguagePackRevision['rights'];
}

export function buildLanguagePack(input: PackBuildInput): LanguagePackRevision {
  const baseline = new Set<string>();
  for (const word of input.functionWords) baseline.add(word.toLowerCase());
  for (const entry of input.entries) for (const form of entry.forms) baseline.add(form.toLowerCase());
  const pack: Omit<LanguagePackRevision, 'digest'> = {
    id: input.id,
    revisionId: input.revisionId,
    cefr: input.cefr,
    frozenAt: input.frozenAt,
    baselineForms: [...baseline].sort(),
    functionWords: [...new Set(input.functionWords.map((word) => word.toLowerCase()))].sort(),
    entries: input.entries,
    properNouns: [...new Set((input.properNouns ?? []).map((word) => word.toLowerCase()))].sort(),
    grammarPolicy: {
      policyVersion: LANGUAGE_POLICY_VERSION,
      maxWordsPerLine: input.maxWordsPerLine ?? 16,
      maxSentenceWords: input.cefr === 'A1' ? 10 : input.cefr === 'A2' ? 14 : 20,
      oovWarn: 0.02,
      oovBlock: 0.05,
      tokenizerVersion: 'tokenize-1',
    },
    rights: input.rights,
  };
  return { ...pack, digest: languagePackDigest(pack) };
}

/**
 * 从本地词库派生一个等级的允许形式集合。词库里没有的等级不能凭空“提升”，
 * 首版只允许把 A1/A2 条目装入 A2 包；更高等级需要另行审核数据。
 */
export function packEntriesFromLexicon(lexicon: Lexicon, cefr: Cefr): LanguageEntry[] {
  const entries: LanguageEntry[] = [];
  for (const [item, entry] of lexicon.entries) {
    const levelRank = CEFR_RANK[entry.cefr as Cefr] ?? 1;
    if (levelRank > CEFR_RANK[cefr]) continue;
    const forms = lexicon.forms.get(item) ?? entry.forms;
    // 例句必须真的出现该条目：不能用不匹配的例句当 @example 素材
    const usableExample = entry.example && forms.some((form) => locateForm(entry.example ?? '', form).length)
      ? entry.example : null;
    entries.push({
      item,
      kind: entry.kind,
      forms,
      glossZh: entry.gloss_zh,
      example: usableExample,
      cefr: entry.cefr as Cefr,
      pos: entry.pos ?? null,
      freqBand: entry.freq_band,
      confusables: entry.confusables ?? [],
      sourceRef: `lexicon:${item}`,
    });
  }
  return entries.sort((a, b) => a.item.localeCompare(b.item));
}

export function packEntryMap(pack: LanguagePackRevision): Map<string, LanguageEntry> {
  return new Map(pack.entries.map((entry) => [entry.item, entry]));
}

/** 允许形式：基础形式 + 教学目标形式 + 计划内显式补录（带理由）+ 专有名词。 */
export function allowedFormsFor(pack: LanguagePackRevision, plan: UnitLevelPlan, targetItems: readonly string[]): Set<string> {
  const allowed = new Set<string>(pack.baselineForms);
  const entries = packEntryMap(pack);
  for (const item of targetItems) for (const form of entries.get(item)?.forms ?? []) allowed.add(form.toLowerCase());
  for (const extra of plan.allowedExtra) allowed.add(extra.form.toLowerCase());
  for (const noun of pack.properNouns) allowed.add(noun.toLowerCase());
  return allowed;
}

export interface DifficultyMetrics {
  policyVersion: string;
  totalTokens: number;
  oovTokens: number;
  oovRatio: number;
  longestSentenceWords: number;
  longestLineWords: number;
  status: 'ok' | 'warn' | 'blocked';
  oovForms: string[];
}

const ASCII_WORD = /^[a-z][a-z'-]*$/;

/** 只统计英文词元：中文署名、题干与反馈不进入 OOV 分母，避免稀释。 */
function englishTokens(text: string): string[] {
  return tokenize(text).filter((token) => ASCII_WORD.test(token));
}

function sentences(text: string): string[] {
  return normalizeForDigest(text).split(/(?<=[.!?])\s+/).filter(Boolean);
}

export function measureDifficulty(batch: Batch, allowed: ReadonlySet<string>, pack: LanguagePackRevision): DifficultyMetrics {
  let total = 0;
  let oov = 0;
  let longestSentence = 0;
  let longestLine = 0;
  const oovForms = new Set<string>();
  for (const unit of batchTextUnits(batch)) {
    const tokens = englishTokens(unit.text);
    if (!tokens.length) continue;
    total += tokens.length;
    longestLine = Math.max(longestLine, tokens.length);
    for (const sentence of sentences(unit.text)) {
      longestSentence = Math.max(longestSentence, englishTokens(sentence).length);
    }
    for (const token of tokens) {
      if (!allowed.has(token)) {
        oov++;
        oovForms.add(token);
      }
    }
  }
  const ratio = total ? oov / total : 0;
  const status: DifficultyMetrics['status'] = ratio > pack.grammarPolicy.oovBlock
    ? 'blocked' : ratio > pack.grammarPolicy.oovWarn ? 'warn' : 'ok';
  return {
    policyVersion: pack.grammarPolicy.policyVersion,
    totalTokens: total,
    oovTokens: oov,
    oovRatio: Number(ratio.toFixed(4)),
    longestSentenceWords: longestSentence,
    longestLineWords: longestLine,
    status,
    oovForms: [...oovForms].sort(),
  };
}

/** 难度问题：阻断项直接失败，告警项可见但不隐藏。 */
export function difficultyIssues(metrics: DifficultyMetrics, pack: LanguagePackRevision): { code: string; level: 'error' | 'warning'; message: string }[] {
  const issues: { code: string; level: 'error' | 'warning'; message: string }[] = [];
  if (metrics.status === 'blocked') {
    issues.push({
      code: 'E-EDITION-OOV', level: 'error',
      message: `超纲词占 ${(metrics.oovRatio * 100).toFixed(1)}%（上限 ${(pack.grammarPolicy.oovBlock * 100).toFixed(0)}%）：${metrics.oovForms.slice(0, 8).join(', ')}`,
    });
  } else if (metrics.status === 'warn') {
    issues.push({
      code: 'W-EDITION-OOV', level: 'warning',
      message: `超纲词占 ${(metrics.oovRatio * 100).toFixed(1)}%（告警线 ${(pack.grammarPolicy.oovWarn * 100).toFixed(0)}%）：${metrics.oovForms.slice(0, 8).join(', ')}`,
    });
  }
  if (metrics.longestLineWords > pack.grammarPolicy.maxWordsPerLine) {
    issues.push({
      code: 'W-EDITION-LINE-LONG', level: 'warning',
      message: `单行 ${metrics.longestLineWords} 词，超过本等级 ${pack.grammarPolicy.maxWordsPerLine} 词的建议上限`,
    });
  }
  if (metrics.longestSentenceWords > pack.grammarPolicy.maxSentenceWords) {
    issues.push({
      code: 'W-EDITION-SENTENCE-LONG', level: 'warning',
      message: `最长句 ${metrics.longestSentenceWords} 词，超过本等级 ${pack.grammarPolicy.maxSentenceWords} 词的句法上限`,
    });
  }
  return issues;
}

/** 语言包自检：摘要、等级、形式唯一性、词库条目的来源与例句一致性。 */
export function languagePackIssues(pack: LanguagePackRevision): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  if (pack.digest !== languagePackDigest(pack)) issues.push({ code: 'E-PACK-DIGEST', message: '语言包摘要不匹配' });
  if (!isOpenLevel(pack.cefr)) issues.push({ code: 'E-PACK-LEVEL', message: `${pack.cefr} 尚未开放，不能用于编纂` });
  const seen = new Set<string>();
  for (const entry of pack.entries) {
    if (seen.has(entry.item)) issues.push({ code: 'E-PACK-DUP', message: `语言包条目重复：${entry.item}` });
    seen.add(entry.item);
    if (!entry.forms.length && entry.kind !== 'pattern') issues.push({ code: 'E-PACK-FORMS', message: `${entry.item} 缺少词形` });
    if (entry.forms.length && entry.example && !entry.forms.some((form) => normalizeForDigest(entry.example ?? '').toLowerCase().includes(form.toLowerCase()))) {
      issues.push({ code: 'E-PACK-EXAMPLE', message: `${entry.item} 的例句不含该条目的任何词形` });
    }
  }
  if (!pack.baselineForms.length) issues.push({ code: 'E-PACK-BASELINE', message: '语言包没有基础允许形式，无法做 OOV 检查' });
  return issues;
}

export function assertLanguagePack(pack: LanguagePackRevision): LanguagePackRevision {
  const issues = languagePackIssues(pack);
  if (issues.length) throw new Error(issues.map((issue) => `${issue.code}：${issue.message}`).join('；'));
  return pack;
}
