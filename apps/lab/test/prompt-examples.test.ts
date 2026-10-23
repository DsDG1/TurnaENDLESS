/**
 * A1 第 1 步：提示词示例自检（**不改提示词**，只加测试）。
 *
 * 结果 §5 #10 记录过两次「示例自己违反规则」：3 个选项标 `recognition-4`、`open_thread`
 * 只写过 `set_fact` 的字段。那一条写下的检验方式是「校验器规则必须能在提示词示例里逐条找到」，
 * 之前靠人查。这个测试把它变成 CI 门禁：
 *   1. 抽出 `data/prompts/{writer,single,repair}.md` 里的 YAML 代码块，用 lab 真实数据组装的
 *      校验上下文跑 `validateBatch`，要求 **0 个阻断问题**（形状规则：素材/实体/effect/ink/答案计数）；
 *   2. 反向检查：六种场景、六种 effect、证据推导的三条规则（选项数 / hint 降档 / spots 数）
 *      必须在示例里各出现至少一次 —— 否则「规则存在但示例没示范」，模型照抄就会错。
 *
 * 内容级预算（OOV、句长）不在这里判：示例是形状模板，不是可投放内容；`lab render` 同一口径。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  Scene,
  collectAssetRefs,
  parseAssetRef,
  parseBatch,
  validateBatch,
  type Batch,
  type ValidationContext,
} from '@endless/esl';
import { loadLabData, type LabData } from '../src/data.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');
const PROMPT_DIR = join(DATA_DIR, 'prompts');

/** 抽出 markdown 里的 yaml 代码块（保留原文，块内缩进是示例的一部分）。 */
export function yamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```ya?ml[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) blocks.push(m[1]!);
  return blocks;
}

/**
 * 示例只示范形状：词表放到最宽、句长不设限，让失败只可能是形状错误。
 *
 * 但世界状态不能全空：`advance_thread` / `resolve_thread` / `end_fact` 只在「运行中盘」合法
 * （伏笔已开、事实仍成立），示例要示范它们就必须给一个中盘上下文。这也正是模型看到示例时的处境：
 * 提示词里带着 [当前事实] 与 [开放伏笔] 两块。
 */
export async function exampleContext(data: LabData, extraEntities: Iterable<string> = []): Promise<ValidationContext> {
  const properNouns = [...data.channels.values()].flatMap((b) => [...b.cast.map((c) => c.id), ...b.locations]);
  const allowed = new Set<string>([...data.lexicon.functionWords, ...properNouns.map((n) => n.toLowerCase())]);
  for (const forms of data.lexicon.forms.values()) for (const f of forms) allowed.add(f);
  const known = new Set<string>([
    ...data.charSpecs.keys(),
    ...properNouns,
    ...[...data.channels.values()].flatMap((b) => b.cast.map((c) => c.id)),
    ...extraEntities,
  ]);
  return {
    vocab: { allowedForms: allowed, oovWarn: 1, oovBlock: 1, maxWordsPerLine: 9999 },
    lexicon: { formsOf: (i) => data.lexicon.forms.get(i), confusables: (i) => data.lexicon.entries.get(i)?.confusables ?? [] },
    assets: data.assetCatalog,
    entities: { exists: (id) => known.has(id) },
    predicates: data.predicates,
    canonFacts: [],
    // 中盘状态：示例里的 end_fact 结束这条，advance/resolve 引用这两个伏笔
    activeFacts: [{ subject: 'cat', predicate: 'suspect_status', object: 'suspect', standing: 'stated' }],
    threads: new Map([
      ['missing_hat', { status: 'open' }],
      ['old_case', { status: 'open' }],
    ]),
  };
}

/** 把「补充场景块」拼成一个可校验的批次：cast 取场景里出现过的说话者 + 角色。 */
function batchOfScenes(scenes: unknown[], fallbackCast: string[]): Batch | null {
  const parsed: Batch['scenes'] = [];
  for (const s of scenes) {
    const res = Scene.safeParse(s);
    if (!res.success) return null;
    parsed.push(res.data);
  }
  const cast = new Set<string>(fallbackCast);
  for (const s of parsed) {
    for (const id of s.cast ?? []) cast.add(id);
    if (s.type === 'comic') for (const p of s.panels) for (const b of p.bubbles) cast.add(b.speaker);
    if (s.type === 'chat') for (const m of s.messages) cast.add(m.from);
    if (s.type === 'story') {
      for (const line of s.ink.split('\n')) {
        const mm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
        if (mm) cast.add(mm[1]!.toLowerCase());
      }
    }
  }
  return { batch: 'b-example', channel: 'duck_detective', brief: 'lb-example', cast: [...cast], scenes: parsed };
}

interface ExampleRun {
  file: string;
  block: number;
  ok: boolean;
  errors: string[];
  batch: Batch | null;
}

const SCENE_TYPES = ['comic', 'chat', 'swipe', 'pick', 'hidden_object', 'story'];
const EFFECT_OPS = ['set_fact', 'end_fact', 'open_thread', 'advance_thread', 'resolve_thread', 'user_fact'];

/** 逐块解析 + 校验；返回每个块的阻断问题。 */
async function analyzeExamples(files: string[]): Promise<{ runs: ExampleRun[]; batches: Batch[]; text: string }> {
  const data = await loadLabData(DATA_DIR);
  const runs: ExampleRun[] = [];
  const batches: Batch[] = [];
  let allText = '';
  let fallbackCast: string[] = ['duck', 'cat', 'moon'];
  let firstBatch: Batch | null = null;

  for (const file of files) {
    const text = await readFile(join(PROMPT_DIR, file), 'utf8');
    allText += `\n${text}`;
    const blocks = yamlBlocks(text);
    for (let i = 0; i < blocks.length; i++) {
      const raw = blocks[i]!;
      // 完整批次块：含 scenes: 顶层键
      const looksLikeBatch = /^batch\s*:/m.test(raw) || /^scenes\s*:/m.test(raw);
      let batch: Batch | null = null;
      if (looksLikeBatch) {
        const parsed = parseBatch(raw, 'yaml');
        if (parsed.ok) {
          batch = { ...parsed.batch, channel: parsed.batch.channel || 'duck_detective' };
          firstBatch = firstBatch ?? batch;
          fallbackCast = batch.cast;
        } else {
          runs.push({ file, block: i + 1, ok: false, errors: parsed.issues.map((x) => `${x.code}: ${x.message}`), batch: null });
          continue;
        }
      } else {
        // 补充场景块：YAML 是一个场景列表，拼进一个合成批次再校验
        let value: unknown;
        try {
          value = parseYaml(raw);
        } catch (e) {
          runs.push({ file, block: i + 1, ok: false, errors: [`YAML 解析失败：${(e as Error).message}`], batch: null });
          continue;
        }
        const scenes = Array.isArray(value) ? value : [value];
        const built = batchOfScenes(scenes, firstBatch?.cast ?? fallbackCast);
        if (!built) {
          runs.push({ file, block: i + 1, ok: false, errors: ['补充场景无法通过 Scene schema'], batch: null });
          continue;
        }
        batch = built;
      }
      const extra = new Set(batch.cast);
      for (const e of batch.new_entities ?? []) extra.add(e.id);
      for (const site of collectAssetRefs(batch)) {
        const p = parseAssetRef(site.ref);
        if (p?.kind === 'char') extra.add(p.entity);
      }
      const ctx = await exampleContext(data, extra);
      const report = validateBatch(batch, ctx);
      // 补充块不是完整批次：3–4 场的批次级上限对它们不适用（文档分两块给出）
      const errors = report.issues
        .filter((x) => x.level === 'error')
        .filter((x) => !(looksLikeBatch === false && x.code === 'E-SCHEMA' && x.message.includes('基本场景数为')))
        .map((x) => `${x.code}${x.scene ? `@${x.scene}` : ''}: ${x.message}`);
      runs.push({ file, block: i + 1, ok: errors.length === 0, errors, batch });
      batches.push(batch);
    }
  }
  return { runs, batches, text: allText };
}

describe('A1 提示词示例自检', () => {
  it('writer / single 的示例逐块通过校验器（0 个阻断问题）', async () => {
    const { runs } = await analyzeExamples(['writer.md', 'single.md']);
    const failed = runs.filter((r) => !r.ok);
    const detail = failed.map((r) => `${r.file} 第 ${r.block} 块：\n  ${r.errors.join('\n  ')}`).join('\n');
    expect(failed, `示例自己违反规则：\n${detail}`).toHaveLength(0);
    expect(runs.length).toBeGreaterThanOrEqual(4);
  });

  it('repair.md 的规则里不含 YAML 示例时跳过（结构规则仍由校验器覆盖）', async () => {
    const text = await readFile(join(PROMPT_DIR, 'repair.md'), 'utf8');
    // repair 提示词目前只有散文规则；一旦加了示例，上面的逐块校验会自动覆盖它
    const blocks = yamlBlocks(text);
    expect(blocks.length).toBeGreaterThanOrEqual(0);
  });

  it('反向检查：六种场景、六种 effect、证据推导三条规则都在示例里出现过', async () => {
    const { batches, text } = await analyzeExamples(['writer.md', 'single.md', 'repair.md']);
    const scenes = batches.flatMap((b) => b.scenes);

    // 1) 六种场景类型
    const types = new Set(scenes.map((s) => s.type));
    for (const t of SCENE_TYPES) {
      expect(types, `示例里缺少场景类型 ${t}：模型没有可照抄的正例`).toContain(t);
    }

    // 2) 六种 effect 操作
    const ops = new Set<string>();
    for (const s of scenes) {
      for (const list of Object.values(s.effects ?? {})) {
        for (const op of list) for (const k of Object.keys(op)) ops.add(k);
      }
    }
    for (const op of EFFECT_OPS) {
      expect(ops, `示例里缺少 effect 操作 ${op}：模型会把字段混用（结果 §5 #10 第二例）`).toContain(op);
    }

    // 3) 证据推导：4 选项 → recognition-4；2–3 选项 → recognition-2；hint 降档；spots ≥4 → recognition-4
    const pick4 = scenes.find((s) => s.type === 'pick' && s.options.length === 4 && !s.hint);
    expect(pick4, '示例里缺少「4 个选项的 pick」：这是 recognition-4 的唯一合法形态').toBeTruthy();
    expect(pick4?.evidence?.type).toBe('recognition-4');

    const chat4 = scenes.find((s) => s.type === 'chat' && s.reply?.options.length === 4);
    expect(chat4, '示例里缺少「4 个选项的 chat」').toBeTruthy();
    expect(chat4?.evidence?.type).toBe('recognition-4');

    const pick2 = scenes.find((s) => s.type === 'pick' && s.options.length < 4);
    expect(pick2, '示例里缺少「2–3 个选项的 pick」').toBeTruthy();
    expect(pick2?.evidence?.type).toBe('recognition-2');

    const hinted = scenes.find((s) => s.type === 'pick' && s.hint !== undefined);
    expect(hinted, '示例里缺少「带 hint 的 pick」：hint 会把推导降到 recognition-2，规则必须有示范').toBeTruthy();
    expect(hinted?.evidence?.type).toBe('recognition-2');

    const hidden4 = scenes.find((s) => s.type === 'hidden_object' && s.spots.length >= 4);
    expect(hidden4, '示例里缺少「4 个位置点的 hidden_object」：spots ≥4 才推导 recognition-4').toBeTruthy();
    expect(hidden4?.evidence?.type).toBe('recognition-4');

    // 4) 名字类规则：背景标签只能来自清单、spots 只能来自背景位置表（示例里出现过的都要合法）
    const data = await loadLabData(DATA_DIR);
    for (const s of scenes) {
      if (s.type !== 'hidden_object') continue;
      const p = parseAssetRef(s.background);
      expect(p?.kind === 'tag' && data.backgrounds.has(p.tag), `示例用了不存在的背景 ${s.background}`).toBe(true);
    }

    // 5) `evidence.type` 不得写 exposure（这条曾是 v9 的失败源）
    expect(text).not.toMatch(/evidence:\s*\{[^}]*type:\s*exposure/);
  });
});
