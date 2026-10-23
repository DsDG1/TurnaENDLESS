/**
 * A2 名字的出路：需求清单 → 程序解析 → 本批短清单 + 别名表。
 *
 * 结果 §4.2/§4.5 的结论是「剩下的失败全是编名字」，而提示词对名字无效（§5 #11）。
 * 这条出路的四件事各有判据，这里逐条钉住：
 *   1. **解析**：`apartment` / `hat` / `mouse` 这类人话名字能按人事先声明的别名表解析成合法名字；
 *      表里没有的一律解析不了（绝不臆造），由预检退回编剧室。
 *   2. **预检**：解析不了的 needs 出现在预检失败原因里，而不是等写手写完再整批失败。
 *   3. **autofix**：只按别名表替换，命中单独计数；**V0 口径不变** —— 替换前那版仍然判为不合规。
 *   4. **短清单**：写手看到的是解析结果（十几行），不是两百多个 `asset_tags`。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  autoFixBatch,
  parseBatch,
  validateBatch,
  type ValidationContext,
} from '@endless/esl';
import { DirectorService, TropeLedger, precheckPlan, type DirectorDeps, type LlmClient } from '@endless/director';
import type { LearningBrief } from '@endless/learning';
import { buildValidationContext, loadLabData, renderCatalogEffects, renderCatalogScenes, type LabData } from '../src/data.js';
import { resolveName } from '../src/resolve.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');

/** 内容级预算不在这里判：这里只关心名字能不能解析、替换对不对。 */
function ctxFor(data: LabData, channel = 'duck_detective'): ValidationContext {
  const properNouns = [...data.channels.values()].flatMap((b) => [...b.cast.map((c) => c.id), ...b.locations]);
  const knownForms = new Set<string>(data.lexicon.functionWords);
  for (const forms of data.lexicon.forms.values()) for (const f of forms) knownForms.add(f);
  return buildValidationContext(data, {
    knownForms,
    allowedExtra: [],
    entitiesExists: (id) => data.charSpecs.has(id) || properNouns.includes(id),
    canonFacts: [],
    activeFacts: [],
    threads: new Map(),
    channelIsImprov: channel === 'improv',
    maxWordsPerLine: 999,
    oovWarn: 1,
    oovBlock: 1,
  });
}

/** 20o 失败谱的复刻：`@tag:apartment`、`@char:mouse`、说话者 `mouse`、`@emoji:hat`。 */
const BATCH_WITH_ALIASES = `
batch: n-0001
channel: duck_detective
brief: lb-0001
cast: [duck, cat]
hook_out: "The apartment is empty."
scenes:
  - id: s1
    type: comic
    setting: "@tag:apartment"
    cast: [duck, cat]
    uses: ["lx:behind#prep.location"]
    panels:
      - shot: wide
        actors: ["@char:duck{expr=suspicious}", "@char:mouse"]
        props: ["@emoji:hat"]
        caption: "Monday. No cases."
        bubbles:
          - {speaker: mouse, text: "Is it behind the door?"}
  - id: s2
    type: pick
    question: "Where is the key?"
    cast: [duck]
    uses: ["lx:under#prep.location"]
    evidence: {item: "lx:under#prep.location", type: recognition-2}
    options:
      - {label: "under the box", asset: "@emoji:box", correct: true}
      - {label: "behind the door", asset: "@emoji:door"}
    feedback: {on_correct: "Right. Under the box.", on_wrong: "No. Look again."}
  - id: s3
    type: chat
    skin: messenger
    cast: [duck]
    uses: ["lx:under#prep.location"]
    messages:
      - {from: duck, text: "The key is not here."}
    reply:
      options:
        - {label: "under the box", correct: true}
        - {label: "behind the door"}
      on_correct: {from: duck, text: "Yes. Under the box."}
      on_wrong: {from: duck, text: "No. Look again."}
`;

const BRIEF: LearningBrief = {
  brief: 'lb-0001',
  level: 'A1+',
  introduce: [],
  expose: [{ item: 'lx:behind#prep.location', exposures_so_far: 0, need: 2 }],
  review: [{ item: 'lx:under#prep.location', facet: 'meaning', min_evidence: 'recognition-4' }],
  vocab: { allowed_extra: ['hat', 'table'], max_words_per_line: 999, oov_budget: 1 },
  avoid_before_test: [],
};

describe('A2 名字解析（纯查表，不猜）', () => {
  it('三条人话名字按别名表解析到合法名字', async () => {
    const data = await loadLabData(DATA_DIR);
    expect(resolveName(data, 'background', 'apartment')).toMatchObject({ ok: true, value: '@tag:living_room', via: 'alias' });
    expect(resolveName(data, 'prop', 'hat')).toMatchObject({ ok: true, value: '@emoji:top_hat', via: 'alias' });
    expect(resolveName(data, 'cast', 'mouse')).toMatchObject({ ok: true, value: 'delivery_mouse', via: 'alias' });
  });

  it('本来就合法的名字走 legit，不记别名命中', async () => {
    const data = await loadLabData(DATA_DIR);
    expect(resolveName(data, 'background', 'living_room')).toMatchObject({ ok: true, via: 'legit' });
    expect(resolveName(data, 'cast', 'duck')).toMatchObject({ ok: true, via: 'legit' });
  });

  it('别名表里没有的名字解析不了，并给出合法清单（绝不臆造）', async () => {
    const data = await loadLabData(DATA_DIR);
    const r = resolveName(data, 'background', 'spaceship');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('spaceship');
      expect(r.reason).toContain('living_room');
    }
  });
});

describe('A2 预检：解析不了的 needs 退回编剧室', () => {
  const plan = (needs: { background?: string; props?: string[]; cast?: string[] }) => ({
    // zod 的 default([]) 在这个手写对象上不生效，这里显式给全字段

    logline: 'L',
    channel: 'duck_detective',
    cast: ['duck'],
    beats: [
      { n: 1, scene: 'comic' as const, gist: 'Duck looks behind the door.' },
      { n: 2, scene: 'pick' as const, gist: 'A where-question.' },
      { n: 3, scene: 'chat' as const, gist: 'Chat.' },
    ],
    learning_placement: [
      { item: 'lx:behind#prep.location', beat: 1, as: 'exposure' },
      { item: 'lx:under#prep.location', beat: 2, as: 'recognition-4' },
    ],
    tropes: ['literal_interpretation'],
    needs: { ...needs, props: needs.props ?? [], cast: needs.cast ?? [] },
  });

  it('可解析的 needs 通过预检', async () => {
    const data = await loadLabData(DATA_DIR);
    const check = precheckPlan({
      plan: plan({ background: 'apartment', props: ['hat'], cast: ['mouse'] }),
      brief: BRIEF,
      ledger: new TropeLedger(),
      entityExists: (id) => id === 'duck',
      formsOf: () => [],
      resolveNeed: (kind, asked) => {
        const r = resolveName(data, kind, asked);
        return r.ok ? { ok: true, value: r.value } : { ok: false, reason: r.reason };
      },
    });
    expect(check.failures).toHaveLength(0);
    expect(check.ok).toBe(true);
  });

  it('清单外的名字作为预检失败原因被退回（此时还没花写手的 token）', async () => {
    const data = await loadLabData(DATA_DIR);
    const check = precheckPlan({
      plan: plan({ background: 'spaceship', props: ['jetpack'] }),
      brief: BRIEF,
      ledger: new TropeLedger(),
      entityExists: (id) => id === 'duck',
      formsOf: () => [],
      resolveNeed: (kind, asked) => {
        const r = resolveName(data, kind, asked);
        return r.ok ? { ok: true, value: r.value } : { ok: false, reason: r.reason };
      },
    });
    expect(check.ok).toBe(false);
    expect(check.failures.join('\n')).toContain('spaceship');
    expect(check.failures.join('\n')).toContain('jetpack');
  });
});

describe('A2 autofix：只按别名表替换，且不抬高 V0', () => {
  it('apartment / mouse / hat 都被替换，命中单独计数', async () => {
    const data = await loadLabData(DATA_DIR);
    const ctx = ctxFor(data);
    const parsed = parseBatch(BATCH_WITH_ALIASES, 'yaml');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const fixed = autoFixBatch(parsed.batch, ctx);
    const text = JSON.stringify(fixed.batch);
    expect(text).toContain('@tag:living_room');
    expect(text).not.toContain('@tag:apartment');
    expect(text).toContain('@emoji:top_hat');
    expect(text).toContain('delivery_mouse');
    // 说话者、@char 引用、道具、背景 —— 四处都应命中
    expect(fixed.aliasHits.length).toBeGreaterThanOrEqual(4);
    expect(fixed.fixes.every((f) => f.includes('按别名表'))).toBe(true);
  });

  it('替换前的首版仍然不合规 —— V0 口径不因别名替换变好看', async () => {
    const data = await loadLabData(DATA_DIR);
    const ctx = ctxFor(data);
    const parsed = parseBatch(BATCH_WITH_ALIASES, 'yaml');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const raw = validateBatch(parsed.batch, ctx);
    expect(raw.ok).toBe(false);
    const codes = raw.issues.filter((i) => i.level === 'error').map((i) => i.code);
    expect(codes).toContain('E-ASSET-MISSING'); // @tag:apartment / @emoji:hat
    expect(codes).toContain('E-ENTITY-UNKNOWN'); // @char:mouse / 说话者 mouse

    // 修完才通过：这就是「V0 低、V2 高」里 autofix 贡献的那一段
    const fixed = autoFixBatch(parsed.batch, ctx);
    expect(validateBatch(fixed.batch, ctx).ok).toBe(true);
  });

  it('校验器不认别名：合法名字集合保持原样', async () => {
    const data = await loadLabData(DATA_DIR);
    expect(data.assetCatalog.tags.has('apartment')).toBe(false);
    expect(data.aliases.get('apartment')).toEqual({ kind: 'background', target: 'living_room' });
  });
});

describe('A2 写手短清单', () => {
  const SHOW_PLAN = `
logline: "The duck finds a hat in the flat."
channel: duck_detective
cast: [duck, cat]
beats:
  - {n: 1, scene: comic, gist: "Duck looks around the flat."}
  - {n: 2, scene: pick, gist: "User answers a where-question."}
  - {n: 3, scene: chat, gist: "Duck chats with user."}
tropes: [literal_interpretation]
learning_placement:
  - {item: "lx:behind#prep.location", beat: 1, as: exposure}
  - {item: "lx:under#prep.location", beat: 2, as: recognition-4}
needs:
  background: apartment
  props: [hat]
  cast: [mouse]
hook_out: "The hat is gone."
`;

  /** 只记录请求的假客户端：编剧室返回计划，写手返回批次（内容不重要，看的是提示词）。 */
  function captureWriterPrompt(): { llm: LlmClient; prompts: Record<string, string[]> } {
    const prompts: Record<string, string[]> = { showrunner: [], writer: [] };
    const llm: LlmClient = {
      async modelId() {
        return 'fake-model';
      },
      async complete(req) {
        (prompts[req.stage] ??= []).push(req.prompt);
        return {
          text: req.stage === 'showrunner' ? SHOW_PLAN : BATCH_WITH_ALIASES,
          usage: { inputTokens: 0, outputTokens: 0 },
          latencyMs: 0,
          cacheHit: false,
          requestHash: `h-${req.stage}-${(prompts[req.stage] ?? []).length}`,
        } as never;
      },
    };
    return { llm, prompts };
  }

  it('写手看到的只有解析结果与一小池道具，不是两百多个素材标签', async () => {
    const data = await loadLabData(DATA_DIR);
    const { llm, prompts } = captureWriterPrompt();
    const writerTemplate = await readFile(join(DATA_DIR, 'prompts', 'writer.md'), 'utf8');
    const deps: DirectorDeps = {
      llm,
      templates: {
        system: 'SYS',
        showrunner: await readFile(join(DATA_DIR, 'prompts', 'showrunner.md'), 'utf8'),
        writer: writerTemplate,
        single: writerTemplate,
        repair: 'REPAIR',
        judge: 'JUDGE',
      },
      validateEs: (text, enc) => {
        const parsed = parseBatch(text, enc);
        if (!parsed.ok) return { ok: false, issues: parsed.issues };
        const ctx = ctxFor(data);
        const fixed = autoFixBatch(parsed.batch, ctx);
        const report = validateBatch(fixed.batch, ctx);
        return { ok: report.ok, batch: fixed.batch, issues: report.issues };
      },
      entityExists: (id) => data.charSpecs.has(id),
      formsOf: (item) => data.lexicon.forms.get(item) ?? [],
      resolveNeed: (kind, asked) => {
        const r = resolveName(data, kind, asked);
        return r.ok ? { ok: true, value: r.value, via: r.via } : { ok: false, reason: r.reason };
      },
      charExists: (id) => data.charSpecs.has(id),
      namePools: {
        backgrounds: [...data.backgrounds.values()].map((b) => `@tag:${b.tag}`),
        props: ['@emoji:top_hat', '@emoji:key', '@emoji:box'],
        castOf: (channel) => (data.channels.get(channel)?.cast ?? []).map((c) => c.id),
      },
    };
    const director = new DirectorService(deps, { mode: 'two-stage', encoding: 'yaml', showrunnerTier: 'fast', maxPrecheckRetries: 1, maxRepairRounds: 1, maxRewrite: 0 } as never);
    const out = await director.generate({
      batchId: 'b-0001',
      channel: 'duck_detective',
      brief: BRIEF,
      ledger: new TropeLedger(),
      vars: {
        char_specs: 'duck: {}',
        backgrounds: '@tag:living_room（spots: sofa_behind / table_under）',
        allowed_words: 'behind, under, key, box',
        max_words_per_line: '12',
        catalog_scenes: renderCatalogScenes(data.catalog),
        catalog_effects: renderCatalogEffects(data.catalog),
      },
    });

    const writerPrompt = prompts.writer?.[0] ?? '';
    expect(writerPrompt).toContain('本批可用名字');
    // 解析结果：背景按别名到 living_room、道具到 top_hat、配角到 delivery_mouse
    expect(writerPrompt).toContain('@tag:living_room');
    expect(writerPrompt).toContain('@emoji:top_hat');
    expect(writerPrompt).toContain('@char:delivery_mouse');
    // 并且明确标出别名映射，模型下批不必再猜
    expect(writerPrompt).toContain('apartment → @tag:living_room');
    // 短清单要真的短：不该再把两百多个标签塞进去
    expect(writerPrompt).not.toContain('素材标签摘要');
    expect(writerPrompt.length).toBeLessThan(20_000);
    // 解析结果记在 outcome 里，供指标单列「needs 靠别名解析」
    expect(out.resolvedNeeds?.filter((r) => r.via === 'alias').length).toBe(3);
  });
});
