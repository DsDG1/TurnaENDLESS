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
  /** 人事先声明的别名（A2）：`apartment → living_room`。只用于解析与 autofix，不是合法名字。 */
  aliases: string[];
}

/** 别名表项：口语名字 → 合法名字（A2）。 */
export interface AliasEntry {
  kind: 'background' | 'emoji' | 'char';
  target: string;
}

/** 组件目录（A1 第 2 步）：场景类型 / effect 操作 / 素材类别的单一来源。 */
export interface CatalogScene {
  id: string;
  title: string;
  writer_selectable: boolean;
  required: string[];
  note: string;
  example?: string;
}
export interface CatalogEffect {
  id: string;
  fields: string[];
  note: string;
  example: string;
}
export interface CatalogAsset {
  id: string;
  ref: string;
  note: string;
}
export interface Catalog {
  scenes: CatalogScene[];
  effects: CatalogEffect[];
  assets: CatalogAsset[];
}

/**
 * 渲染给模型看的场景目录：可选的逐条一行（必填字段 + 一条约束），不可选的并成一句。
 * 例子不在这里展开 —— 完整 YAML 示例留在提示词正文（`writer.md` 开头那句「下面这个例子就是规范本身」）。
 */
export function renderCatalogScenes(catalog: Catalog): string {
  const lines = catalog.scenes
    .filter((s) => s.writer_selectable)
    .map((s) => `- **${s.id}**（${s.title}）必填：${s.required.join(' / ')}；${s.note}`);
  const blocked = catalog.scenes.filter((s) => !s.writer_selectable);
  if (blocked.length > 0) {
    lines.push(`- 写手不可选：${blocked.map((s) => `${s.id}（${s.note}）`).join('；')}`);
  }
  return lines.join('\n');
}

/** 渲染 effect 目录：字段表 + 一行合法示例（字段混用是 E-SCHEMA 的头号来源）。 */
export function renderCatalogEffects(catalog: Catalog): string {
  return catalog.effects
    .map((e) => `- **${e.id}**：字段 ${e.fields.join(' / ')}；${e.note}\n  例：\`${e.example}\``)
    .join('\n');
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
  /** 梗族（B1 采样轴）：梗 id → 族；`families` 是去重后的族列表 */
  tropeFamilies: Map<string, string>;
  families: string[];
  punchlineTypes: string[];
  sifting: SiftingPatternConfig[];
  prompts: PromptTemplates;
  /** @tag 引用的全部标签（校验器 E-ASSET-MISSING 用） */
  assetTags: Set<string>;
  assetCatalog: AssetCatalog;
  /** 别名表（小写名字 → 合法目标）；与「合法名字」分开，校验器不认别名（A2） */
  aliases: Map<string, AliasEntry>;
  /** 组件目录（A1）：提示词里的场景/effect 说明由它渲染，测试按它跑示例自检 */
  catalog: Catalog;
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
      emojis: z.array(
        z.object({ name: z.string(), glyph: z.string(), tags: z.array(z.string()), aliases: z.array(z.string()).default([]) }),
      ),
      backgrounds: z.array(
        z.object({
          tag: z.string(),
          emoji: z.string(),
          description: z.string(),
          spots: z.array(z.string()),
          aliases: z.array(z.string()).default([]),
        }),
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
      z.object({
        base: z.string(),
        expr: z.array(z.string()),
        hat: z.array(z.string()),
        props_allowed: z.array(z.string()),
        aliases: z.array(z.string()).default([]),
      }),
    )
    .parse(await readYaml(join(dataDir, 'assets', 'characters.yaml')));

  // 别名表（A2）：只登记「人事先声明的等价关系」。同名的合法目标优先，别名的别名不再展开。
  const aliases = new Map<string, AliasEntry>();
  const registerAlias = (name: string, entry: AliasEntry) => {
    const key = name.toLowerCase();
    if (!key || aliases.has(key)) return;
    aliases.set(key, entry);
  };
  for (const b of manifest.backgrounds) for (const a of b.aliases) registerAlias(a, { kind: 'background', target: b.tag });
  for (const e of manifest.emojis) for (const a of e.aliases) registerAlias(a, { kind: 'emoji', target: e.name });
  for (const [id, spec] of Object.entries(charRaw)) for (const a of spec.aliases) registerAlias(a, { kind: 'char', target: id });

  const predRaw = z
    .object({ predicates: z.array(z.object({ name: z.string(), cardinality: z.enum(['single', 'multi']) })) })
    .parse(await readYaml(join(dataDir, 'predicates.yaml')));
  const predicates = new Map(predRaw.predicates.map((p) => [p.name, { cardinality: p.cardinality }]));

  const tropesRaw = z
    .object({
      tropes: z.array(z.object({ id: z.string(), family: z.string().optional(), zh: z.string().optional() })),
      punchline_types: z.array(z.string()).default([]),
    })
    .parse(await readYaml(join(dataDir, 'tropes.yaml')));
  const tropeFamilies = new Map<string, string>();
  for (const t of tropesRaw.tropes) if (t.family) tropeFamilies.set(t.id, t.family);

  const siftingRaw = z
    .object({ patterns: z.array(z.object({ id: z.string(), enabled: z.boolean().optional(), params: z.record(z.string(), z.number()).optional() })) })
    .parse(await readYaml(join(dataDir, 'sifting_patterns.yaml')));

  const catalog: Catalog = z
    .object({
      scenes: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          writer_selectable: z.boolean(),
          required: z.array(z.string()).default([]),
          note: z.string().default(''),
          example: z.string().optional(),
        }),
      ),
      effects: z.array(z.object({ id: z.string(), fields: z.array(z.string()), note: z.string().default(''), example: z.string() })),
      assets: z.array(z.object({ id: z.string(), ref: z.string(), note: z.string().default('') })).default([]),
    })
    .parse(await readYaml(join(dataDir, 'catalog.yaml')));

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
    backgroundSpots: new Map(manifest.backgrounds.map((b) => [b.tag, b.spots])),
    // 别名表只给 autofix 用：校验器认的合法名字集合保持不变（V0 口径）
    aliases: new Map([...aliases.entries()].map(([k, v]) => [k, { kind: v.kind, target: v.target }])),
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
    tropeFamilies,
    families: [...new Set(tropeFamilies.values())].sort(),
    punchlineTypes: tropesRaw.punchline_types,
    sifting: siftingRaw.patterns.map((p) => ({ id: p.id, enabled: p.enabled, params: p.params })),
    prompts,
    assetTags,
    assetCatalog,
    aliases,
    catalog,
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
