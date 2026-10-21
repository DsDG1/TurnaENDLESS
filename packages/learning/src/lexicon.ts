/**
 * 词库（第 5.1 节）：学习条目来自固定词库，AI 不能发明条目 ID。
 * 包含条目 Zod 模型、YAML 加载、格式校验（Day 1–2 完成标志：`data/lexicon/a1_a2.yaml` 通过格式校验）、
 * 以及「学习者的已知词集合」计算。
 */
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

export const Facet = z.enum(['meaning', 'listening', 'form']);
export type Facet = z.infer<typeof Facet>;

export const LexiconEntry = z
  .object({
    id: z.string().regex(/^(lx:[^#\s]+#[\w-]+(\.[\w-]+)?|ck:[a-z0-9-]+|pt:[a-z0-9-]+)$/),
    kind: z.enum(['sense', 'chunk', 'pattern']),
    lemma: z.string().optional(),
    pos: z.string().optional(),
    /** 句型的 forms 允许为空（形式枚举留给 v1 的模板匹配）；词义与词块必须非空 */
    forms: z.array(z.string().min(1)),
    gloss_zh: z.string().min(1),
    cefr: z.enum(['A1', 'A2']),
    freq_band: z.number().int().min(1).max(5),
    prereq: z.array(z.string()).optional(),
    confusables: z.array(z.string()).optional(),
    facets: z.array(Facet).min(1),
    example: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.kind !== 'pattern' && e.forms.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['forms'], message: `${e.kind} 条目的 forms 不能为空` });
    }
  });
export type LexiconEntry = z.infer<typeof LexiconEntry>;

export const LexiconFile = z.object({
  entries: z.array(LexiconEntry).min(1),
  /** 功能词白名单：冠词、代词、助动词、常见介词连词，任何时候允许出现 */
  function_words: z.array(z.string().min(1)).default([]),
});
export type LexiconFile = z.infer<typeof LexiconFile>;

export interface Lexicon {
  entries: Map<string, LexiconEntry>;
  /** id → 全部小写形式 */
  forms: Map<string, string[]>;
  functionWords: Set<string>;
}

export interface LexiconIssue {
  item?: string;
  message: string;
}

/** 格式校验：ID 规范、形式非空、易混条目存在、句型前置存在。 */
export function validateLexicon(file: LexiconFile): LexiconIssue[] {
  const issues: LexiconIssue[] = [];
  const ids = new Set(file.entries.map((e) => e.id));
  for (const e of file.entries) {
    if (ids.size && e.id.startsWith('lx:') && !e.lemma) {
      issues.push({ item: e.id, message: 'sense 条目缺少 lemma' });
    }
    const formSet = new Set(e.forms.map((f) => f.toLowerCase()));
    if (formSet.size !== e.forms.length) issues.push({ item: e.id, message: 'forms 存在重复（大小写不敏感）' });
    for (const c of e.confusables ?? []) {
      if (!ids.has(c)) issues.push({ item: e.id, message: `confusables 引用的条目 ${c} 不存在` });
    }
    for (const p of e.prereq ?? []) {
      if (!ids.has(p)) issues.push({ item: e.id, message: `prereq 引用的条目 ${p} 不存在` });
    }
    if (e.kind === 'chunk' && !e.id.startsWith('ck:')) issues.push({ item: e.id, message: 'chunk 条目 ID 应以 ck: 开头' });
    if (e.kind === 'pattern' && !e.id.startsWith('pt:')) issues.push({ item: e.id, message: 'pattern 条目 ID 应以 pt: 开头' });
    if (e.kind === 'sense' && !e.id.startsWith('lx:')) issues.push({ item: e.id, message: 'sense 条目 ID 应以 lx: 开头' });
  }
  return issues;
}

export function loadLexicon(yamlText: string): { lexicon?: Lexicon; issues: LexiconIssue[] } {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return { issues: [{ message: `YAML 解析失败：${(e as Error).message}` }] };
  }
  const parsed = LexiconFile.safeParse(raw);
  if (!parsed.success) {
    return { issues: parsed.error.issues.map((i) => ({ message: `${i.path.map(String).join('.')}：${i.message}` })) };
  }
  const issues = validateLexicon(parsed.data);
  const entries = new Map(parsed.data.entries.map((e) => [e.id, e]));
  const forms = new Map(parsed.data.entries.map((e) => [e.id, e.forms.map((f) => f.toLowerCase())]));
  return {
    lexicon: { entries, forms, functionWords: new Set(parsed.data.function_words.map((w) => w.toLowerCase())) },
    issues,
  };
}

/**
 * 学习者的已知词集合（第 5.1 节）＝ 功能词白名单 ＋ 能力估计 ≥ 阈值的条目的全部形式 ＋ 频道圣经专名。
 * 返回小写形式集合，供校验器的 vocab.allowedForms 组装。
 */
export function knownWordSet(
  lexicon: Lexicon,
  opts: {
    /** 条目 → 能力估计（0–1）；缺省视为未知 */
    ability: (item: string) => number | undefined;
    threshold?: number;
    properNouns?: string[];
  },
): Set<string> {
  const threshold = opts.threshold ?? 0.6;
  const words = new Set<string>(lexicon.functionWords);
  for (const [id, forms] of lexicon.forms) {
    const a = opts.ability(id);
    if (a !== undefined && a >= threshold) for (const f of forms) words.add(f);
  }
  for (const n of opts.properNouns ?? []) words.add(n.toLowerCase());
  return words;
}
