import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentHash, stableStringify, validateBatch } from '@endless/esl';
import { createEpisode, createSession, getOptions, getScenes, transition, type Library, type PlayerSession } from '@endless/player';
import { createContent, type GeneratedEpisode, type SavedPlayer } from '../src/index.js';
import { materialPictureOf } from '../src/materials.js';

const content = createContent(readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8'));
const at = '2026-10-23T08:00:00.000Z';

function completedPilot() {
  let session = createSession(content.pilot);
  for (const episode of content.pilot.episodes) {
    session = transition(session, { type: 'select', episode: episode.id }, content.pilot, at);
    for (const scene of getScenes(episode)) {
      const options = getOptions(scene);
      if (options.length) session = transition(session, { type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct) }, content.pilot, at);
      session = transition(session, { type: 'advance', scene: scene.id, skip: false }, content.pilot, at);
    }
  }
  return session;
}

type Task = ReturnType<typeof content.planCreative>;
const task = () => content.planCreative(completedPilot(), content.pilot, new Date(at));
const form = (t: Task, alias: string) => t.targets.find((x) => x.alias === alias)!.forms[0];

/** 与目标绑定的正确选项（包含目标形式）+ 三个独立干扰项。 */
const choiceBlock = (t: Task, alias: string, remember = false) =>
  `@choice ${alias}\n? What did you see?\n+ I see the ${form(t, alias)}.\n- I see nothing.\n- It is late.\n- Please wait.\n= 正确答案里出现了目标词。\n${remember ? '@remember\n' : ''}@end`;

const chunkOf = <T,>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** 覆盖本批全部新词的两个正文语境：comic（每块最多 4 格）与 chat（每块最多 8 条消息）。 */
function introContext(t: Task, a = 'duck', b = 'cat', bg = 'agency_office'): string[] {
  const intros = t.targets.filter((x) => t.brief.introduce.includes(x.item));
  const expose = t.targets.filter((x) => x.interaction === null);
  const comics = chunkOf(intros, 4).map((group, index) =>
    `@comic ${bg}\n${group.map((x, i) => `${i % 2 ? b : a}: The ${x.forms[0]} is here.`).join('\n')}\n${index === 0 ? 'prop: notebook\n' : ''}@end`);
  const chats = chunkOf(intros, 6).map((group, index) => {
    const lines = group.map((x, i) => `${i % 2 ? a : b}: It is a ${x.forms[0]}.`);
    if (index === 0) lines.push(`${b}: I see a ${expose.map((x) => x.forms[0]).join(', a ') || 'box'}.`);
    lines.push(`${a}: Good.`);
    return `@chat messenger\n${lines.join('\n')}\n@end`;
  });
  return [...comics, ...chats];
}

/** 场景数等于组件块数（comic/chat 整块各 1 场）；补中性块到下限 10。 */
function padBlocks(blocks: string[], filler: readonly string[], min = 10): string[] {
  for (const block of filler) {
    if (blocks.length >= min) break;
    blocks.push(block);
  }
  return blocks;
}

/** 与系列匹配的叙述填充块：不含检索目标形式，避免泄题。 */
const fillerBlocks = (a: string, b: string, bg: string, word: string) => [
  `@post ${b}\ntext: It is a ${word}.\n@end`,
  `@chat forum\n${b}: It is a ${word}.\n${a}: Good.\n@end`,
  `@comic ${bg}\n${a}: I see a ${word}.\n${b}: Good.\n@end`,
  `@post ${a}\ntext: Good.\n@end`,
  `@chat messenger\n${a}: Good.\n${b}: Good.\n@end`,
  `@post ${b}\ntext: Good.\n@end`,
  `@chat forum\n${a}: Good.\n${b}: Good.\n@end`,
  `@comic ${bg}\n${a}: Good.\n${b}: Good.\n@end`,
  `@post ${a}\ntext: It is a ${word}.\n@end`,
  `@chat messenger\n${b}: Good.\n${a}: Good.\n@end`,
  `@comic ${bg}\n${a}: The ${word} is here.\n${b}: Good.\n@end`,
  `@post ${b}\ntext: It is a ${word}.\n@end`,
  `@chat forum\n${a}: Good.\n${b}: Good.\n@end`,
  `@comic ${bg}\n${a}: Good.\n${b}: Good.\n@end`,
  `@post ${a}\ntext: Good.\n@end`,
  `@chat messenger\n${a}: Good.\n${b}: Good.\n@end`,
  `@comic ${bg}\n${a}: Good.\n${b}: Good.\n@end`,
  `@post ${b}\ntext: Good.\n@end`,
  `@chat forum\n${b}: Good.\n${a}: Good.\n@end`,
  `@comic ${bg}\n${b}: Good.\n${a}: Good.\n@end`,
  `@post ${a}\ntext: Good.\n@end`,
];

/** 只含通用台词的中性填充：不提供任何目标语境，也不泄题。 */
const fillerNeutral = (a: string, b: string, bg: string) => [
  `@post ${a}\ntext: Good.\n@end`,
  `@chat forum\n${a}: Good.\n${b}: Good.\n@end`,
  `@comic ${bg}\n${a}: Good.\n${b}: Good.\n@end`,
  `@post ${b}\ntext: Good.\n@end`,
  `@chat messenger\n${a}: Good.\n${b}: Good.\n@end`,
  `@comic ${bg}\n${a}: Good.\n${b}: Good.\n@end`,
  `@post ${a}\ntext: Good.\n@end`,
  `@chat forum\n${a}: Good.\n${b}: Good.\n@end`,
  `@comic ${bg}\n${a}: Good.\n${b}: Good.\n@end`,
  `@post ${b}\ntext: Good.\n@end`,
  `@chat messenger\n${a}: Good.\n${b}: Good.\n@end`,
  `@comic ${bg}\n${a}: Good.\n${b}: Good.\n@end`,
  `@post ${a}\ntext: Good.\n@end`,
  `@chat forum\n${a}: Good.\n${b}: Good.\n@end`,
  `@comic ${bg}\n${a}: Good.\n${b}: Good.\n@end`,
  `@post ${b}\ntext: Good.\n@end`,
  `@chat messenger\n${a}: Good.\n${b}: Good.\n@end`,
  `@comic ${bg}\n${a}: Good.\n${b}: Good.\n@end`,
  `@post ${a}\ntext: Good.\n@end`,
  `@chat forum\n${a}: Good.\n${b}: Good.\n@end`,
  `@comic ${bg}\n${a}: Good.\n${b}: Good.\n@end`,
];

/** 每个必需互动一个组件；新词在两个组件正文出现；expose 形式进入正文；叙述填充补足 10 场下限。 */
function draftFor(t: Task, options: { kind?: string; series?: string; cast?: readonly string[]; bg?: string } = {}) {
  const intro = t.targets.filter((x) => t.brief.introduce.includes(x.item));
  const required = t.targets.filter((x) => x.interaction !== null);
  const [a = 'duck', b = 'cat'] = options.cast ?? [];
  const bg = options.bg ?? 'agency_office';
  const head = `ENDLESS-DRAFT/1
@kind ${options.kind ?? 'story'}
@series ${options.series ?? 'duck_detective'}
@title 测试标题
@subtitle A test
@description 测试描述`;
  const blocks = [
    ...introContext(t, a, b, bg),
    ...required.map((target) => choiceBlock(t, target.alias)),
  ];
  padBlocks(blocks, fillerBlocks(a, b, bg, intro[0]?.forms[0] ?? 'key'));
  return [head, ...blocks].join('\n');
}

function documentFor(t: Task, draft: string, session: PlayerSession): GeneratedEpisode {
  const compiled = content.compileDraft(draft, t, content.pilot, 'ai-test');
  if (!compiled.ok) throw new Error(compiled.issues.map((i) => i.message).join('\n'));
  return {
    version: 1, generatedAt: at, basedOn: content.historyKey(session),
    title: compiled.title, subtitle: compiled.subtitle, description: compiled.description,
    batch: compiled.batch, hash: contentHash(compiled.batch), learningVersion: 4, creation: compiled.creation,
  };
}

const assertOk = (compiled: ReturnType<typeof content.compileDraft>) =>
  expect(compiled.ok, compiled.ok ? '' : compiled.issues.map((i) => `${i.code} ${i.message}`).join(';')).toBe(true);

describe('创作草稿编译器（ENDLESS-DRAFT/1）', () => {
  it('八种组件语法可编译，确定性一致，答案位置确定性且随批次变化', () => {
    const t = task();
    const replyTarget = t.targets.find((x) => x.interaction !== null)!;
    const intro = t.targets.find((x) => t.brief.introduce.includes(x.item))!;
    const draft = draftFor(t)
      .replace(new RegExp(`@choice ${replyTarget.alias}[\\s\\S]*?@end`), '')
      .replace('duck: Good.\n@end', `duck: Good.\n@reply ${replyTarget.alias}\n? What is it?\n+ It is the ${form(t, replyTarget.alias)}.\n- It is late.\n- I see nothing.\n- Please wait.\n= 正确回复包含目标词。\n@end`)
      + `\n@post cat\ntext: A note about the ${intro.forms[0]}.\n@end\n@card ${intro.alias}\n@end\n@quiz meaning ${intro.alias}\n@end`;
    const first = content.compileDraft(draft, t, content.pilot, 'ai-a');
    const second = content.compileDraft(draft, t, content.pilot, 'ai-a');
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(stableStringify(first.batch)).toBe(stableStringify(second.batch));
      // 答案位置 = FNV-1a32(batchId:场次:短名) % 选项数
      const fnv = (input: string) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return h;
      };
      const replyScene = first.batch.scenes.find((s) => s.type === 'chat' && s.reply !== undefined)!;
      const ordinal = first.batch.scenes.indexOf(replyScene) + 1;
      if (replyScene.type === 'chat') {
        const expected = fnv(`ai-a:${ordinal}:${replyTarget.alias}`) % replyScene.reply!.options.length;
        expect(replyScene.reply!.options.findIndex((o) => o.correct)).toBe(expected);
      }
      // 每个互动场景的正确槽位都精确等于 fnv(batchId:场次:短名) % 选项数
      const aliasOf = (item?: string) => t.targets.find((x) => x.item === item)?.alias;
      for (const [si, scene] of first.batch.scenes.entries()) {
        const options = scene.type === 'chat' ? scene.reply?.options
          : scene.type === 'pick' || scene.type === 'quiz' ? scene.options : undefined;
        if (!options?.length) continue;
        const alias = scene.type === 'chat' ? replyTarget.alias : aliasOf(scene.evidence?.item);
        expect(alias, `场景 ${scene.id} 应能映射到任务短名`).toBeTruthy();
        expect(options.findIndex((o) => o.correct)).toBe(fnv(`ai-a:${si + 1}:${alias}`) % options.length);
      }
      const chat = first.batch.scenes.find((s) => s.type === 'chat');
      expect(chat?.type === 'chat' ? chat.reply?.prompt : '').toBe('What is it?');
      expect(first.creation.protocol).toBe('endless-draft-v1');
      // 反馈同时用于答对/答错
      const pick = first.batch.scenes.find((s) => s.type === 'pick')!;
      expect(pick.type === 'pick' && pick.feedback.on_correct === pick.feedback.on_wrong).toBe(true);
    }
  });

  it('组件顺序自由、10–20 场有效（含边界），legacy 仍要求 3–4 基础场', () => {
    const t = task();
    const required = t.targets.filter((x) => x.interaction !== null);
    const head = 'ENDLESS-DRAFT/1\n@kind story\n@series duck_detective\n@title t\n@subtitle s\n@description d';
    // 场次边界与「本批几个新词」解耦：清空 introduce/expose 后正文不再需要覆盖新词
    const boundary = {
      ...t,
      brief: { ...t.brief, introduce: [], expose: [] },
      context: { ...t.context, brief: { ...t.context.brief, introduce: [], expose: [] } },
    } as typeof t;
    const narrative = '@comic agency_office\nduck: Good.\ncat: Good.\n@end\n@chat messenger\ncat: Good.\nduck: Good.\n@end';
    const one = '@post duck\ntext: Good.\n@end';
    const make = (n: number) => `${head}\n${narrative}\n${required.map((x) => choiceBlock(t, x.alias)).join('\n')}\n${Array<string>(Math.max(0, n - 2 - required.length)).fill(one).join('\n')}`;
    // 恰好 10 与 20 都有效；9 与 21 被拒绝
    for (const variant of [make(10), make(20)]) assertOk(content.compileDraft(variant, boundary, content.pilot, 'ai-b'));
    expect(content.compileDraft(make(9), boundary, content.pilot, 'ai-b').ok).toBe(false);
    expect(content.compileDraft(make(21), boundary, content.pilot, 'ai-b').ok).toBe(false);
    // 真实任务同样落在 10–20 场
    assertOk(content.compileDraft(draftFor(t), t, content.pilot, 'ai-b'));
    // 同一批次在 legacy（3–4 基础场）上下文下被拒绝
    const compiled = content.compileDraft(make(10), boundary, content.pilot, 'ai-b');
    if (compiled.ok) {
      const legacy = content.plan(completedPilot(), content.pilot, new Date(at), 3);
      const errors = validateBatch(compiled.batch, legacy.context).issues.filter((i) => i.level === 'error');
      expect(errors.some((i) => i.message.includes('3–4'))).toBe(true);
    }
  });

  it('四种形态与两个故事系列都可编译', () => {
    const t = task();
    for (const [kind, series, cast, bg] of [
      ['story', 'duck_detective', ['duck', 'cat'], 'agency_office'],
      ['story', 'impossible_store', ['shopkeeper', 'delivery_mouse'], 'shop_counter'],
      ['daily', 'daily_life', ['guide', 'delivery_mouse'], 'cafe'],
      ['social', 'tiny_posts', ['cat', 'guide'], 'living_room'],
    ] as const) {
      assertOk(content.compileDraft(draftFor(t, { kind, series, cast, bg }), t, content.pilot, `ai-${kind}`));
    }
  });

  it('quiz 四种构造：meaning/cloze/sentence/find；缺取材或不配对图片即明确报错', () => {
    const t = task();
    const intro = t.targets.find((x) => t.brief.introduce.includes(x.item))!;
    for (const kind of ['meaning', 'cloze', 'sentence', 'find'] as const) {
      const draft = draftFor(t) + `\n@quiz ${kind} ${intro.alias}\n@end`;
      const compiled = content.compileDraft(draft, t, content.pilot, 'ai-q');
      if (kind === 'find' && !materialPictureOf(intro.item)) {
        expect(compiled.ok).toBe(false);
      } else {
        assertOk(compiled);
        if (compiled.ok) {
          const scene = compiled.batch.scenes.find((s) => s.type === 'quiz' && s.kind === kind);
          expect(scene).toBeTruthy();
          if (kind === 'find' && scene?.type === 'quiz') {
            const correct = scene.options.find((o) => o.correct)!;
            expect(correct.asset).toBe(`@emoji:${materialPictureOf(intro.item)}`);
          }
        }
      }
    }
    // find 不能拿无关道具充当正确答案
    const noPic = t.targets.find((x) => !materialPictureOf(x.item));
    if (noPic) {
      const draft = draftFor(t) + `\n@quiz find ${noPic.alias}\n@end`;
      expect(content.compileDraft(draft, t, content.pilot, 'ai-q').ok).toBe(false);
    }
  });

  it('拒绝可执行 JSON、未知指令、粘连指令、缺 @end、未知素材、外系列角色、重复/迟到元数据、超长元数据、未闭合围栏、空消息回复', () => {
    const t = task();
    const cases = [
      '{batch: "x"}',
      'ENDLESS-DRAFT/1\n@kind story\n@series duck_detective\n@title t\n@subtitle s\n@description d\n@magic x\n@end',
      draftFor(t).replace('@series duck_detective', '@series moon_world'),
      draftFor(t).split('\n').slice(0, -1).join('\n'),
      draftFor(t).replace('prop: notebook', 'prop: dragon'),
      draftFor(t).replace('@comic agency_office', '@comic volcano'),
      draftFor(t).replace('cat: I see a', 'badger: I see a'),
      draftFor(t) + '\n@quiz meaning t1\nrogue line\n@end',
      draftFor(t) + '\n@choice t9\n? x\n+ a\n- b\n= c\n@end',
      draftFor(t).replace('@comic agency_office', '@comicagency_office'),
      draftFor(t).replace(choiceBlock(t, t.targets.find((x) => x.interaction !== null)!.alias), '@cardt1\n@end'),
      draftFor(t).replace('@title 测试标题', '@title 测试标题\n@title 又一次'),
      draftFor(t).replace('@comic agency_office', '@series daily_life\n@comic agency_office'),
      draftFor(t).replace('@title 测试标题', `@title ${'长'.repeat(101)}`),
      '```\n' + draftFor(t),
      'ENDLESS-DRAFT/1\n@kind story\n@series duck_detective\n@title t\n@subtitle s\n@description d\n@chat messenger\n@reply t1\n? x\n+ a\n- b\n= c\n@end',
    ];
    for (const draft of cases) {
      const compiled = content.compileDraft(draft, t, content.pilot, 'ai-c');
      expect(compiled.ok, `${JSON.stringify(draft.slice(0, 40))}`).toBe(false);
    }
  });

  it('目标绑定：通用 Yes/No 不能满足 practice 或独立检索', () => {
    const t = task();
    const head = (kind = 'story') => `ENDLESS-DRAFT/1\n@kind ${kind}\n@series duck_detective\n@title t\n@subtitle s\n@description d`;
    const intro = t.targets.find((x) => t.brief.introduce.includes(x.item))!;
    const generic = t.targets.filter((x) => x.interaction !== null).map((x) =>
      `@choice ${x.alias}\n? Which one?\n+ Yes.\n- No.\n- Maybe.\n- Hmm.\n= good\n@end`);
    const blocks = padBlocks([...introContext(t), ...generic], fillerNeutral('duck', 'cat', 'agency_office'));
    const compiled = content.compileDraft(`${head()}\n${blocks.join('\n')}`, t, content.pilot, 'ai-n');
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.issues.some((i) => i.message.includes('正确选项'))).toBe(true);
    // 中文正确项与词库词义完全一致也成立
    const zh = draftFor(t).replace(choiceBlock(t, intro.alias),
      `@choice ${intro.alias}\n? 哪一个对？\n+ ${content.lexicon.entries.get(intro.item)!.gloss_zh}\n- 完全无关\n- 都不对\n= 与词义一致。\n@end`);
    assertOk(content.compileDraft(zh, t, content.pilot, 'ai-n'));
  });

  it('knowledge：真实任务引入 lx:buy，fact+example→quiz/card 全链路验收；重复 fact 与不合规例句如实拒绝', () => {
    const session = completedPilot();
    const t = task();
    // 钉住生产选择：首个新词应为 lx:buy#v.purchase（例句「The moon buys a new hat.」全部在词表内），每批 2–5 个
    expect(t.brief.introduce.length).toBeGreaterThanOrEqual(2);
    expect(t.brief.introduce.length).toBeLessThanOrEqual(5);
    expect(t.brief.introduce[0]).toBe('lx:buy#v.purchase');
    const intros = t.targets.filter((x) => t.brief.introduce.includes(x.item));
    const intro = intros[0]!;
    expect(intro.item).toBe('lx:buy#v.purchase');
    const entry = content.lexicon.entries.get(intro.item)!;
    expect(intro.materials.example).toBe(true);
    const retrieval = t.targets.find((x) => x.interaction && x.interaction !== 'practice' && x.item !== intro.item);
    const expose = t.targets.filter((x) => x.interaction === null && !t.brief.introduce.includes(x.item));
    // knowledge 的语境是「一份 fact 词义 + 一份 example 原句」：每个新词都要成对出现，并各自有 practice
    const core = [
      ...(retrieval ? [`@quiz meaning ${retrieval.alias}\n@end`] : []),
      ...intros.flatMap((x) => [`@fact ${x.alias}\n@end`, `@example ${x.alias}\n@end`]),
      ...intros.map((x) => `@quiz meaning ${x.alias}\n@end`),
      ...expose.map((x) => `@fact ${x.alias}\n@end`),
      `@card ${intro.alias}\n@end`,
    ];
    const padCards = [intro, ...expose].flatMap((x) => [`@card ${x.alias}\n@end`, `@fact ${x.alias}\n@end`]);
    const draft = `ENDLESS-DRAFT/1\n@kind knowledge\n@series word_window\n@title 词义窗\n@subtitle Word window\n@description 本地词库的小窗口\n${padBlocks(core, padCards).join('\n')}`;
    const compiled = content.compileDraft(draft, t, content.pilot, 'ai-k');
    assertOk(compiled);
    if (!compiled.ok) return;
    const sources = compiled.creation.sources;
    expect(sources.find((s) => s.field === 'gloss')?.text).toBe(`${intro.forms[0]} — ${entry.gloss_zh}`);
    expect(sources.find((s) => s.field === 'example')?.text).toBe(entry.example);
    expect(compiled.sceneSources).toBeTruthy();
    const factScene = compiled.batch.scenes.find((s) => s.id === sources.find((x) => x.field === 'gloss')?.sceneId);
    expect(factScene?.type === 'card' && factScene.front.includes(entry.gloss_zh)).toBe(true);
    // 真任务 → 文档 → 验收 → 播放 → 快照 → 恢复
    const document = documentFor(t, draft, session);
    const accepted = content.accept(JSON.parse(JSON.stringify(document)), content.snapshot(session, []));
    const ep = accepted.library.episodes.at(-1)!;
    expect(ep.presentation?.label).toBe('表达小窗口');
    let played = transition(accepted.session, { type: 'select', episode: ep.id }, accepted.library, at);
    for (const scene of getScenes(ep)) {
      if (scene.type === 'card') played = transition(played, { type: 'reveal', scene: scene.id }, accepted.library, at);
      const options = getOptions(scene);
      if (options.length) played = transition(played, { type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct) }, accepted.library, at);
      played = transition(played, { type: 'advance', scene: scene.id, skip: false }, accepted.library, at);
    }
    const restored = content.restore(JSON.parse(JSON.stringify(content.snapshot(played, [document]))));
    expect(restored.library.episodes.at(-1)!.id).toBe('ai-test');
    // 两张 fact 不能冒充 fact+example；knowledge 不允许 choice
    expect(content.compileDraft(draft.replace(`@example ${intro.alias}`, `@fact ${intro.alias}`), t, content.pilot, 'ai-k').ok).toBe(false);
    expect(content.compileDraft(draft + `\n@choice ${intro.alias}\n? x\n+ ${intro.forms[0]}\n- b\n= c\n@end`, t, content.pilot, 'ai-k').ok).toBe(false);
    // 人为损坏的取材任务：例句超词表的词不能靠 @example 冒充可用素材（controlled negative）
    const badTarget = { alias: 't9', item: 'lx:answer#v.reply', forms: content.lexicon.forms.get('lx:answer#v.reply') ?? [], gloss: '回答', interaction: 'practice' as const, role: 'expose' as const, materials: { gloss: true, example: false, picture: false } };
    const badTask = { ...t, targets: [...t.targets, badTarget] };
    const badDraft = `ENDLESS-DRAFT/1\n@kind knowledge\n@series word_window\n@title t\n@subtitle s\n@description d\n${intros.flatMap((x) => [`@fact ${x.alias}\n@end`, `@example ${x.alias}\n@end`]).join('\n')}\n@example t9\n@end\n${expose.map((x) => `@fact ${x.alias}\n@end`).join('\n')}\n${intros.map((x) => `@quiz meaning ${x.alias}\n@end`).join('\n')}\n@quiz meaning t9\n@end`;
    const bad = content.compileDraft(badDraft, badTask, content.pilot, 'ai-k');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.some((i) => i.code === 'E-OOV-HIGH' || i.message.includes('example'))).toBe(true);
  });

  it('学习契约：card 不抵 practice、缺语境失败、选项不足降级、泄题失败、跳过场景不作取材', () => {
    const t = task();
    const intro = t.targets.find((x) => t.brief.introduce.includes(x.item))!;
    const required = t.targets.filter((x) => x.interaction !== null);
    const expose = t.targets.filter((x) => x.interaction === null);
    const head = 'ENDLESS-DRAFT/1\n@kind story\n@series duck_detective\n@title t\n@subtitle s\n@description d';
    const narrative = introContext(t).join('\n');
    const padN = fillerNeutral('duck', 'cat', 'agency_office');
    // 只有一处语境（中性填充补足场次但不含目标形式）
    const oneCtx = `${head}\n@comic agency_office\nduck: The ${intro.forms[0]} is here.\ncat: I see a ${expose.map((x) => x.forms[0]).join(', a ') || 'box'}.\n@end\n${required.map((x) => choiceBlock(t, x.alias)).join('\n')}\n${padN.slice(0, 8).join('\n')}`;
    expect(content.compileDraft(oneCtx, t, content.pilot, 'ai-d').ok).toBe(false);
    // card 不抵 practice：必需目标没有可作答组件
    const missingTarget = required[0]!;
    const cardOnly = `${head}\n${narrative}\n${required.filter((x) => x !== missingTarget).map((x) => choiceBlock(t, x.alias)).join('\n')}\n@card ${missingTarget.alias}\n@end\n${padN.slice(0, 7).join('\n')}`;
    const cardCompiled = content.compileDraft(cardOnly, t, content.pilot, 'ai-d');
    expect(cardCompiled.ok).toBe(false);
    if (!cardCompiled.ok) expect(cardCompiled.issues.some((i) => i.message.includes(missingTarget.item))).toBe(true);
    const retrieval = t.targets.find((x) => x.interaction && x.interaction !== 'practice');
    if (retrieval) {
      // 三选项不能当四选一独立检索
      const under = `${head}\n${narrative}\n@choice ${retrieval.alias}\n? Which?\n+ The ${retrieval.forms[0]}.\n- No.\n- Hmm.\n= ok\n@end\n${required.filter((x) => x !== retrieval).map((x) => choiceBlock(t, x.alias)).join('\n')}\n${padN.slice(0, 7).join('\n')}`;
      expect(content.compileDraft(under, t, content.pilot, 'ai-d').ok).toBe(false);
      // 泄题：检索目标形式先出现在正文
      const primed = draftFor(t).replace('duck: The', `duck: The ${retrieval.forms[0]} and the`);
      expect(content.compileDraft(primed, t, content.pilot, 'ai-d').ok).toBe(false);
    }
  });

  it('v4 全路径验收：10 组件含 8 个 @remember 不枚举爆炸；选择记录一次，跳过不记录', () => {
    const session = completedPilot();
    const t = task();
    const required = t.targets.filter((x) => x.interaction !== null);
    // 8 个四选项 @remember 选择 + 覆盖全部新词的正文语境（controlled task，真实编译/验收路径）
    const used = new Set(t.targets.map((x) => x.item));
    const extraItems = [...content.lexicon.entries.values()]
      .filter((entry) => entry.kind === 'sense' && !used.has(entry.id))
      .map((entry) => entry.id)
      .slice(0, 8);
    const extraTargets = extraItems.slice(0, 8 - required.length).map((item, i) => ({
      alias: `x${i + 1}`, item, forms: content.lexicon.forms.get(item) ?? [], gloss: '',
      interaction: 'practice' as const,
      materials: { gloss: true, example: false, picture: false },
    }));
    const bigTask = { ...t, targets: [...t.targets, ...extraTargets] };
    const rememberBlocks = [...required, ...extraTargets].map((x) => choiceBlock(bigTask, x.alias, true));
    const narrative = introContext(t);
    const draft = `ENDLESS-DRAFT/1\n@kind story\n@series duck_detective\n@title t\n@subtitle s\n@description d\n${[...narrative, ...rememberBlocks].join('\n')}`;
    // controlled task 不参与真实绑定（accept 会用真实 planCreative 重编译），
    // 因此这里直接驱动同一个合并前缀校验器 + 实际播放，覆盖「不枚举爆炸」与记录语义。
    const compiled = content.compileDraft(draft, bigTask, content.pilot, 'ai-big');
    assertOk(compiled);
    if (!compiled.ok) return;
    expect(compiled.batch.scenes).toHaveLength(narrative.length + 8);
    expect(compiled.batch.scenes.filter((s) => s.effects && Object.keys(s.effects).length)).toHaveLength(8);
    const episode = createEpisode(compiled.batch, content.creativeContext(bigTask.context),
      { title: 't', subtitle: 's', description: 'd', presentation: content.creativePresentation('story', 'duck_detective', compiled.sceneSources) });
    const library: Library = { ...content.pilot, episodes: [...content.pilot.episodes, episode] };
    const started = performance.now();
    content.validatePathsCreative(createSession(library), library);
    expect(performance.now() - started).toBeLessThan(2000);
    const ep = episode;
    let played = transition(createSession(library), { type: 'select', episode: ep.id }, library, at);
    const scenes = getScenes(ep);
    const withEffects = scenes.find((s) => getOptions(s).some((o) => o.effect));
    expect(withEffects).toBeTruthy();
    for (const scene of scenes) {
      if (scene === withEffects) {
        const idx = getOptions(scene).findIndex((o) => o.effect);
        played = transition(played, { type: 'answer', scene: scene.id, choice: idx }, library, at);
        played = transition(played, { type: 'advance', scene: scene.id, skip: false }, library, at);
      } else {
        played = transition(played, { type: 'advance', scene: scene.id, skip: true }, library, at);
      }
    }
    const view = content.stateContext(played, library).view;
    const chosen = view.world.userFacts().filter((f) => f.predicate === 'chose' && f.batch === ep.id);
    expect(chosen).toHaveLength(1);
    // 全部跳过时一条都不记录
    let skipPlayed = transition(createSession(library), { type: 'select', episode: ep.id }, library, at);
    for (const scene of scenes) {
      skipPlayed = transition(skipPlayed, { type: 'advance', scene: scene.id, skip: true }, library, at);
    }
    const skipView = content.stateContext(skipPlayed, library).view;
    expect(skipView.world.userFacts().filter((f) => f.predicate === 'chose' && f.batch === ep.id)).toHaveLength(0);
  });

  it('历史取材只用真正读完的叙述行：已读供词给出确切 reference/text，跳过则不可用', () => {
    const session = completedPilot();
    const t = task();
    const behind = 'lx:behind#prep.location';
    const base = { ...t,
      brief: { ...t.brief, introduce: [], expose: [] },
      context: { ...t.context, brief: { ...t.context.brief, introduce: [], expose: [] } },
      targets: [{ alias: 't1', item: behind, forms: content.lexicon.forms.get(behind) ?? [], gloss: '在…后面', interaction: 'recognition-4' as const, role: 'review' as const, materials: { gloss: true, example: false, picture: false } }],
      detection: [{ item: behind, type: 'recognition-4' as const }], practice: [] } as typeof t;
    const draft = `ENDLESS-DRAFT/1
@kind story
@series duck_detective
@title t
@subtitle s
@description d
@quiz cloze t1
@end
${fillerNeutral('duck', 'cat', 'agency_office').slice(0, 9).join('\n')}`;
    const compiled = content.compileDraft(draft, base, content.pilot, 'ai-src');
    assertOk(compiled);
    if (!compiled.ok) return;
    const source = compiled.creation.sources.find((s) => s.field === 'prior');
    expect(source).toBeTruthy();
    expect(source!.text).toContain('behind');
    expect(source!.reference).toMatch(/^pilot-/);
    // 第一集全部跳过 → 该句不再是可用历史取材
    let skipped = createSession(content.pilot);
    const ep1 = content.pilot.episodes[0]!;
    skipped = transition(skipped, { type: 'select', episode: ep1.id }, content.pilot, at);
    for (const scene of getScenes(ep1)) {
      skipped = transition(skipped, { type: 'advance', scene: scene.id, skip: true }, content.pilot, at);
    }
    let rest = skipped;
    for (const episode of content.pilot.episodes.slice(1)) {
      rest = transition(rest, { type: 'select', episode: episode.id }, content.pilot, at);
      for (const scene of getScenes(episode)) {
        const options = getOptions(scene);
        if (options.length) rest = transition(rest, { type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct) }, content.pilot, at);
        rest = transition(rest, { type: 'advance', scene: scene.id, skip: false }, content.pilot, at);
      }
    }
    const skippedView = content.stateContext(rest, content.pilot).view;
    const skippedTask = { ...base, view: skippedView } as typeof t;
    const rejected = content.compileDraft(draft, skippedTask, content.pilot, 'ai-src');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.issues.some((i) => i.message.includes('cloze'))).toBe(true);
  });

  it('find 取图精确配对：登记名词映射到对应道具图，干扰项也是登记道具且不与答案重复', () => {
    const t = task();
    const item = 'lx:notebook#n.notepad';
    const picture = materialPictureOf(item)!;
    const base = { ...t,
      brief: { ...t.brief, introduce: [], expose: [] },
      context: { ...t.context, brief: { ...t.context.brief, introduce: [], expose: [] } },
      targets: [{ alias: 't1', item, forms: content.lexicon.forms.get(item) ?? [], gloss: '笔记本', interaction: 'practice' as const, role: 'expose' as const, materials: { gloss: true, example: false, picture: true } }],
      detection: [], practice: [{ item, type: 'practice' as const }] } as typeof t;
    const draft = `ENDLESS-DRAFT/1
@kind story
@series duck_detective
@title t
@subtitle s
@description d
@quiz find t1
@end
${fillerNeutral('duck', 'cat', 'agency_office').slice(0, 9).join('\n')}`;
    const compile = (batchId: string) => content.compileDraft(draft, base, content.pilot, batchId);
    const compiled = compile('ai-find');
    assertOk(compiled);
    if (!compiled.ok) return;
    const scene = compiled.batch.scenes.find((s) => s.type === 'quiz')!;
    if (scene.type !== 'quiz') return;
    const correct = scene.options.find((o) => o.correct)!;
    expect(correct.asset).toBe(`@emoji:${picture}`);
    for (const other of scene.options.filter((o) => !o.correct)) {
      expect(other.asset).toBeTruthy();
      expect(other.asset).not.toBe(correct.asset);
      expect(other.asset!.startsWith('@emoji:')).toBe(true);
    }

    // 干扰项随批次确定性抽样：同批次重编译完全一致，不同批次不再共用同一组
    const distractors = (batchId: string) => {
      const result = compile(batchId);
      if (!result.ok) throw new Error('find 草稿应可编译');
      const quiz = result.batch.scenes.find((s) => s.type === 'quiz')!;
      if (quiz.type !== 'quiz') throw new Error('缺少 quiz 场景');
      return quiz.options.filter((o) => !o.correct).map((o) => o.asset).sort();
    };
    expect(distractors('ai-find')).toEqual(distractors('ai-find'));
    expect(distractors('ai-find')).not.toEqual(distractors('ai-find-other'));
  });

  it('@fact 之后接 cloze 时取材必须落在真实英文上，不能把中文词义当原句', () => {
    const t = task();
    const intros = t.targets.filter((x) => t.brief.introduce.includes(x.item));
    const intro = intros[0]!;
    const retrieval = t.targets.find((x) => x.interaction && x.interaction !== 'practice' && x.item !== intro.item);
    const expose = t.targets.filter((x) => x.interaction === null && !t.brief.introduce.includes(x.item));
    // knowledge 的语境是「一份 fact 词义 + 一份 example 原句」：每个新词成对出现，并各自有 practice 互动
    const build = (blocks: readonly string[]) => `ENDLESS-DRAFT/1
@kind knowledge
@series word_window
@title 词义窗
@subtitle Word window
@description 本地词库的小窗口
${padBlocks([...blocks], []).join('\n')}`;

    // ① @fact 紧跟 @quiz cloze，中间还没有英文原句时，编译器必须明确拒绝，
    //    不能拿 @fact 的中文词义硬凑句子（example 放在 cloze 之后，取材时前文还没有原句）
    const withoutSource = build([
      ...(retrieval ? [`@quiz meaning ${retrieval.alias}\n@end`] : []),
      ...intros.flatMap((x) => [`@fact ${x.alias}\n@end`]),
      `@quiz cloze ${intro.alias}\n@end`,
      ...intros.flatMap((x) => [`@example ${x.alias}\n@end`]),
      ...intros.map((x) => `@quiz meaning ${x.alias}\n@end`),
      ...expose.map((x) => `@fact ${x.alias}\n@end`),
    ]);
    const rejected = content.compileDraft(withoutSource, t, content.pilot, 'ai-fact-cloze');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      // 必须明确报「找不到可取材原句」，而不是拿词义卡凑句子蒙混
      expect(rejected.issues.some((i) => i.message.includes('cloze'))).toBe(true);
      expect(rejected.issues.some((i) => i.message.includes('找不到含'))).toBe(true);
    }

    // ② @example（词库英文例句）在 @quiz cloze 之前时，cloze 只能从英文原句挖空：
    //    题干不含中文，来源记为 prior（原句）而不是 gloss（中文词义）
    const withSource = build([
      ...(retrieval ? [`@quiz meaning ${retrieval.alias}\n@end`] : []),
      ...intros.flatMap((x) => [`@fact ${x.alias}\n@end`, `@example ${x.alias}\n@end`]),
      `@quiz cloze ${intro.alias}\n@end`,
      ...intros.map((x) => `@quiz meaning ${x.alias}\n@end`),
      ...expose.map((x) => `@fact ${x.alias}\n@end`),
      `@card ${intro.alias}\n@end`,
    ]);
    const compiled = content.compileDraft(withSource, t, content.pilot, 'ai-fact-cloze');
    assertOk(compiled);
    if (!compiled.ok) return;
    const quiz = compiled.batch.scenes.find((s) => s.type === 'quiz' && s.kind === 'cloze');
    expect(quiz?.type).toBe('quiz');
    if (quiz?.type === 'quiz') {
      // quiz 的题干在 prompt 上（不是 question）；cloze 题干必须来自英文原句
      expect(quiz.prompt).not.toMatch(/[\u4e00-\u9fa5]/);
      expect(quiz.prompt).toContain('____');
      expect(quiz.options.some((o) => o.correct)).toBe(true);
    }
    // @fact 的词义卡来源是 gloss；cloze 的取材必须是 prior（英文原句），两者不能混
    expect(compiled.creation.sources.some((e) => e.field === 'gloss' && e.item === intro.item)).toBe(true);
    const clozeSource = compiled.creation.sources.find((e) => e.field === 'prior');
    expect(clozeSource).toBeTruthy();
    if (clozeSource) {
      expect(clozeSource.text).not.toMatch(/[\u4e00-\u9fa5]/);
      // 词义卡正面是「buy — 购买」，含破折号；英文原句不含
      expect(clozeSource.text).not.toContain('—');
    }
  });

  it('v4 文档可验收与恢复；篡改草稿/正文/来源/系列都被拒绝；mixed v3+v4 恢复不推断新来源', () => {
    const session = completedPilot();
    const t = task();
    const document = documentFor(t, draftFor(t), session);
    const accepted = content.accept(JSON.parse(JSON.stringify(document)), content.snapshot(session, []));
    expect(accepted.library.episodes).toHaveLength(4);
    expect(accepted.library.episodes.at(-1)!.presentation?.label).toBe('鸭侦探事务所');
    const restored = content.restore(JSON.parse(JSON.stringify(content.snapshot(session, [document]))));
    expect(restored.library.episodes).toHaveLength(4);
    for (const mutate of [
      (d: GeneratedEpisode) => { d.batch.scenes[0]!.uses = ['lx:under#prep.location']; },
      (d: GeneratedEpisode) => { d.creation!.kind = 'daily'; },
      (d: GeneratedEpisode) => { d.creation!.draft = d.creation!.draft.replace('The', 'A'); },
      (d: GeneratedEpisode) => { d.creation!.sources.push({ sceneId: 's9', item: 'lx:x', field: 'gloss', reference: 'x', text: 'fake', hash: contentHash('x') }); },
      (d: GeneratedEpisode) => { d.creation!.series = 'tiny_posts' as never; },
      (d: GeneratedEpisode) => { d.title = '伪造标题'; },
    ]) {
      const bad = structuredClone(document);
      mutate(bad);
      bad.hash = contentHash(bad.batch);
      expect(() => content.restore(content.snapshot(session, [bad]))).toThrow();
    }
    // legacy v3 文档 + v4 文档混合恢复；v4 在旧集实际看完之后生成
    const legacy = legacyDocument(session);
    const r1 = content.restore(content.snapshot(session, [legacy]));
    const legacyEp = r1.library.episodes.at(-1)!;
    let played = r1.session;
    played = transition(played, { type: 'select', episode: legacyEp.id }, r1.library, at);
    for (const scene of getScenes(legacyEp)) {
      const options = getOptions(scene);
      if (options.length) played = transition(played, { type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct) }, r1.library, at);
      played = transition(played, { type: 'advance', scene: scene.id, skip: false }, r1.library, at);
    }
    const t2 = content.planCreative(played, r1.library, new Date(at));
    const later = documentFor(t2, draftFor(t2), played);
    const mixed = content.snapshot(played, [legacy, later]);
    const mixedRestored = content.restore(JSON.parse(JSON.stringify(mixed)));
    expect(mixedRestored.library.episodes).toHaveLength(5);
    expect(mixedRestored.library.episodes.at(-1)!.presentation?.series).toBe('duck_detective');
    // 验收后真实播放 v4 集（含作答与世界变化），再快照恢复：来源绑定不变
    const accepted2 = content.accept(JSON.parse(JSON.stringify(later)), content.snapshot(played, [legacy]));
    const v4ep = accepted2.library.episodes.at(-1)!;
    let v4played = transition(accepted2.session, { type: 'select', episode: v4ep.id }, accepted2.library, at);
    for (const scene of getScenes(v4ep)) {
      const options = getOptions(scene);
      if (options.length) v4played = transition(v4played, { type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct) }, accepted2.library, at);
      v4played = transition(v4played, { type: 'advance', scene: scene.id, skip: false }, accepted2.library, at);
    }
    const replayed = content.restore(JSON.parse(JSON.stringify(content.snapshot(v4played, [legacy, later]))));
    const replayedV4 = replayed.library.episodes.at(-1)!;
    expect(replayedV4.presentation?.series).toBe('duck_detective');
    expect(replayed.session.events.length).toBeGreaterThan(played.events.length);
    // 旧 schema 文档（无 learningVersion）仍按原路径恢复
    const legacyV1 = { ...document, learningVersion: undefined, creation: undefined } as unknown;
    expect(() => content.snapshot(session, [legacyV1 as GeneratedEpisode])).not.toThrow();
  });

  it('词表严格：注册专名可用，但仅在无关例句中出现的词不能进创作正文', () => {
    const t = task();
    // creativeProperNames 已加入 allowedForms
    for (const name of ['badger', 'mouse', 'guide']) {
      expect(t.context.vocab.allowedForms.has(name), name).toBe(true);
    }
    // 找一个只出现在词库例句里、不在 allowedForms 的词
    const allowed = t.context.vocab.allowedForms;
    let exampleOnly = '';
    for (const entry of content.lexicon.entries.values()) {
      for (const token of entry.example?.toLowerCase().match(/[a-z']+/g) ?? []) {
        if (!allowed.has(token) && /^[a-z]+$/.test(token)) { exampleOnly = token; break; }
      }
      if (exampleOnly) break;
    }
    expect(exampleOnly).not.toBe('');
    const intro = t.targets.find((x) => t.brief.introduce.includes(x.item))!;
    const draft = draftFor(t).replace('duck: Good.', `duck: The ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${exampleOnly} ${intro.forms[0]}.`);
    expect(content.compileDraft(draft, t, content.pilot, 'ai-v').ok).toBe(false);
  });
});

/** 构造一份 learningVersion 3 的旧契约生成文档（不走 v4 路径）。 */
function legacyDocument(session: PlayerSession): GeneratedEpisode {
  const plan = content.plan(session, content.pilot, new Date(at), 3);
  const target = plan.detection[0]!;
  const form = content.lexicon.forms.get(target.item)![0]!;
  const practice = plan.practice[0];
  const practiceForm = practice ? content.lexicon.forms.get(practice.item)![0]! : undefined;
  const batch = {
    batch: 'ai-legacy', channel: 'duck_detective', brief: plan.brief.brief, cast: ['duck', 'cat'], hook_out: 'Where is the cat?',
    scenes: [
      { id: 's1', type: 'comic', setting: '@tag:agency_office', uses: plan.brief.expose.map((e) => e.item),
        panels: [{ shot: 'wide', actors: ['@char:duck'], props: [],
          bubbles: [{ speaker: 'duck', text: plan.brief.expose.map((e) => content.lexicon.forms.get(e.item)![0]).join('. ') || 'Hello.' }] }] },
      { id: 's2', type: 'chat', skin: 'messenger', uses: practice ? [practice.item] : [],
        messages: [{ from: 'cat', text: practiceForm ?? 'Hello.' }],
        ...(practice ? { evidence: practice } : {}),
        reply: { options: [{ label: practiceForm ?? 'Yes.', correct: true, effect: 'clue' }, { label: 'No.' }],
          on_correct: { from: 'cat', text: 'Thank you.' }, on_wrong: { from: 'cat', text: 'Oh.' } },
        effects: { clue: [{ user_fact: { predicate: 'noticed', object: 'ai-legacy' } }] } },
      { id: 's3', type: 'pick', question: 'What is this?', uses: [],
        evidence: { item: target.item, type: target.type },
        options: [{ label: form, correct: true }, { label: 'hat' }, { label: 'door' }, { label: 'tea' }],
        feedback: { on_correct: 'Yes.', on_wrong: 'No.' } },
    ],
  };
  return {
    version: 1, generatedAt: at, basedOn: content.historyKey(session),
    title: '旧线索', subtitle: 'Old clue', description: '旧契约批次。',
    batch: batch as never, hash: contentHash(batch), learningVersion: 3,
  };
}
