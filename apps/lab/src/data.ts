/**
 * 实验数据加载：词库、频道圣经、素材清单、角色规格、谓词、梗分类、故事筛选、提示词。
 * `lab check` 会全量校验这些文件（Day 1–2 完成标志）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AssetCatalog, ValidationContext } from '@endless/esl';
import type { Lexicon, LexiconIssue } from '@endless/learning';
import { loadLexicon } from '@endless/learning';
import type { SiftingPatternConfig } from '@endless/world';
import type { PromptTemplates } from '@endless/director';

export const ChannelBible = z.object({
  id: z.string(),
  title: z.string(),
  premise: z.string(),
  tone: z.string(),
  humor_rules: z.array(z.string()).default([]),
  cast: z
    .array(z.object({ id: z.string(), role: z.string(), canon: z.array(z.string()).default([]), traits: z.array(z.string()).default([]) }))
    .default([]),
  locations: z.array(z.string()).default([]),
  set_pieces: z.array(z.string()).default([]),
  language_affinity: z.array(z.string()).default([]),
  scene_affinity: z.record(z.string(), z.enum(['low', 'medium', 'high'])).default({}),
  escalation: z.string().nullable().optional(),
  canon_locked: z.array(z.string()).default([]),
  taboo: z.array(z.string()).default([]),
});
export type ChannelBible = z.infer<typeof ChannelBible>;

export interface BackgroundSpec {
  tag: string;
  emoji: string;
  description: string;
  spots: string[];
}

export interface LabData {
  dataDir: string;
  lexicon: Lexicon;
  lexiconIssues: LexiconIssue[];
  channels: Map<string, ChannelBible>;
  /** emoji 名 → 字形（渲染用） */
  glyphs: Map<string, string>;
  /** 标签 → emoji 名列表（@tag 确定性挑选用） */
  tagIndex: Map<string, string[]>;
  backgrounds: Map<string, BackgroundSpec>;
  charSpecs: Map<string, { base: string; expr: string[]; hat: string[]; props_allowed: string[] }>;
  predicates: Map<string, { cardinality: 'single' | 'multi' }>;
  tropes: string[];
  punchlineTypes: string[];
  sifting: SiftingPatternConfig[];
  prompts: PromptTemplates;
  /** @tag 引用的全部标签（校验器 E-ASSET-MISSING 用） */
  assetTags: Set<string>;
  assetCatalog: AssetCatalog;
}

async function readYaml(path: string): Promise<unknown> {
  return parseYaml(await readFile(path, 'utf8'));
}

export async function loadLabData(dataDir: string): Promise<LabData> {
  const lex = await loadLexicon(await readFile(join(dataDir, 'lexicon', 'a1_a2.yaml'), 'utf8'));
  if (!lex.lexicon) throw new Error(`词库加载失败：\n${lex.issues.map((i) => `- ${i.item ?? ''} ${i.message}`).join('\n')}`);

  const channels = new Map<string, ChannelBible>();
  for (const id of ['duck_detective', 'impossible_store', 'improv']) {
    const raw = await readYaml(join(dataDir, 'channels', `${id}.yaml`));
    const parsed = ChannelBible.parse(raw);
    channels.set(parsed.id, parsed);
  }

  const manifest = z
    .object({
      emojis: z.array(z.object({ name: z.string(), glyph: z.string(), tags: z.array(z.string()) })),
      backgrounds: z.array(
        z.object({ tag: z.string(), emoji: z.string(), description: z.string(), spots: z.array(z.string()) }),
      ),
    })
    .parse(await readYaml(join(dataDir, 'assets', 'manifest.yaml')));
  const glyphs = new Map(manifest.emojis.map((e) => [e.name, e.glyph]));
  const tagIndex = new Map<string, string[]>();
  for (const e of manifest.emojis) {
    for (const t of e.tags) {
      const list = tagIndex.get(t) ?? [];
      list.push(e.name);
      tagIndex.set(t, list);
    }
  }
  const backgrounds = new Map(manifest.backgrounds.map((b) => [b.tag, b]));

  const charRaw = z
    .record(
      z.string(),
      z.object({ base: z.string(), expr: z.array(z.string()), hat: z.array(z.string()), props_allowed: z.array(z.string()) }),
    )
    .parse(await readYaml(join(dataDir, 'assets', 'characters.yaml')));

  const predRaw = z
    .object({ predicates: z.array(z.object({ name: z.string(), cardinality: z.enum(['single', 'multi']) })) })
    .parse(await readYaml(join(dataDir, 'predicates.yaml')));
  const predicates = new Map(predRaw.predicates.map((p) => [p.name, { cardinality: p.cardinality }]));

  const tropesRaw = z
    .object({ tropes: z.array(z.object({ id: z.string() })), punchline_types: z.array(z.string()).default([]) })
    .parse(await readYaml(join(dataDir, 'tropes.yaml')));

  const siftingRaw = z
    .object({ patterns: z.array(z.object({ id: z.string(), enabled: z.boolean().optional(), params: z.record(z.string(), z.number()).optional() })) })
    .parse(await readYaml(join(dataDir, 'sifting_patterns.yaml')));

  const prompts: PromptTemplates = {
    system: await readFile(join(dataDir, 'prompts', 'system.md'), 'utf8').catch(() => 'You are the ENDLESS director.'),
    showrunner: await readFile(join(dataDir, 'prompts', 'showrunner.md'), 'utf8'),
    writer: await readFile(join(dataDir, 'prompts', 'writer.md'), 'utf8'),
    single: await readFile(join(dataDir, 'prompts', 'single.md'), 'utf8'),
    repair: await readFile(join(dataDir, 'prompts', 'repair.md'), 'utf8'),
    judge: await readFile(join(dataDir, 'prompts', 'judge.md'), 'utf8'),
  };

  const assetTags = new Set<string>([...tagIndex.keys(), ...backgrounds.keys()]);
  const assetCatalog: AssetCatalog = {
    emojis: new Set(glyphs.keys()),
    tags: assetTags,
    chars: new Map(Object.entries(charRaw)),
  };

  return {
    dataDir,
    lexicon: lex.lexicon,
    lexiconIssues: lex.issues,
    channels,
    glyphs,
    tagIndex,
    backgrounds,
    charSpecs: new Map(Object.entries(charRaw)),
    predicates,
    tropes: tropesRaw.tropes.map((t) => t.id),
    punchlineTypes: tropesRaw.punchline_types,
    sifting: siftingRaw.patterns.map((p) => ({ id: p.id, enabled: p.enabled, params: p.params })),
    prompts,
    assetTags,
    assetCatalog,
  };
}

export interface BuildContextOptions {
  brief?: ValidationContext['brief'];
  /** 已知词集合（功能词 + 能力达标条目形式 + 专名），knownWordSet 产出 */
  knownForms: Set<string>;
  /** 额外允许词（brief.vocab.allowed_extra 等） */
  allowedExtra: string[];
  entitiesExists: (id: string) => boolean;
  canonFacts: { subject: string; predicate: string; object: string }[];
  activeFacts: { subject: string; predicate: string; object: string; standing: string }[];
  threads: Map<string, { status: string }>;
  exposureCounts?: Map<string, number>;
  channelIsImprov?: boolean;
  recentSceneSequences?: string[][];
  recentCastCounts?: Map<string, number>;
  maxWordsPerLine?: number;
  /** OOV 告警/阻断阈值；种子词库阶段由运行配置放宽（默认 0.02 / 0.05） */
  oovWarn?: number;
  oovBlock?: number;
}

/** 组装校验器上下文（词表 = 已知词 ∪ 额外词 ∪ 本批目标条目形式）。 */
export function buildValidationContext(data: LabData, opts: BuildContextOptions): ValidationContext {
  const allowedForms = new Set(opts.knownForms);
  for (const w of opts.allowedExtra) allowedForms.add(w.toLowerCase());
  if (opts.brief) {
    const items = [
      ...opts.brief.review.map((r) => r.item),
      ...opts.brief.expose.map((e) => e.item),
      ...opts.brief.introduce,
    ];
    for (const item of items) {
      for (const f of data.lexicon.forms.get(item) ?? []) allowedForms.add(f);
    }
  }
  return {
    vocab: { allowedForms, oovWarn: opts.oovWarn ?? 0.02, oovBlock: opts.oovBlock ?? 0.05, maxWordsPerLine: opts.maxWordsPerLine ?? 12 },
    brief: opts.brief,
    lexicon: {
      formsOf: (item) => data.lexicon.forms.get(item),
      confusables: (item) => data.lexicon.entries.get(item)?.confusables ?? [],
    },
    assets: data.assetCatalog,
    entities: { exists: opts.entitiesExists },
    predicates: data.predicates,
    canonFacts: opts.canonFacts,
    activeFacts: opts.activeFacts,
    threads: opts.threads,
    exposureCounts: opts.exposureCounts,
    channelIsImprov: opts.channelIsImprov,
    recentSceneSequences: opts.recentSceneSequences,
    recentCastCounts: opts.recentCastCounts,
  };
}

/** @tag 的确定性挑选：按名字排序后用哈希取模（同一引用稳定）。 */
export function pickEmojiByTag(data: LabData, tag: string, salt: string): string | undefined {
  const names = (data.tagIndex.get(tag) ?? []).slice().sort();
  if (names.length === 0) return undefined;
  let h = 2166136261;
  const key = `${tag}:${salt}`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return names[h % names.length];
}

/** 频道圣经 canon_locked（"subject predicate object"）→ canon 事实。 */
export function canonFactsOfBible(bible: ChannelBible): { subject: string; predicate: string; object: string }[] {
  return [...bible.canon_locked, ...bible.cast.flatMap((c) => c.canon.map((k) => `${c.id} ${k.replace(/\s+/g, ' ')}`))]
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) return undefined;
      return { subject: parts[0]!, predicate: parts[1]!, object: parts.slice(2).join(' ') };
    })
    .filter((f): f is { subject: string; predicate: string; object: string } => f !== undefined);
}
