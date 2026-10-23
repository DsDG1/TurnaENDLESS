/** 校验器正反例（实验方案第 8 节 Day 2–3 完成标志：正例 ≥10、反例 ≥20，每个阻断码至少 1 个反例）。 */
import { describe, expect, it } from 'vitest';
import type { Batch, Scene } from '../src/model.js';
import { validateBatch, type ValidationContext } from '../src/validate.js';
import { parseBatch } from '../src/parse.js';
import { compileBatch } from '../src/compile.js';
import { contentHash } from '../src/hash.js';
import { LEXICON, BASE_BATCH_YAML, loadBaseBatch, makeCtx, mutate } from './fixture.js';

function sceneOf<T extends Scene['type']>(b: Batch, id: string, _t: T): Extract<Scene, { type: T }> {
  return b.scenes.find((s) => s.id === id) as Extract<Scene, { type: T }>;
}

const codes = (b: Batch, ctx = makeCtx()) => {
  const res = validateBatch(b, ctx);
  return { res, codes: new Set(res.issues.filter((i) => i.level === 'error').map((i) => i.code)) };
};

const warns = (b: Batch, ctx = makeCtx()) =>
  new Set(validateBatch(b, ctx).issues.filter((i) => i.level === 'warning').map((i) => i.code));

// ---------- 正例 ----------

describe('正例', () => {
  it('基准批次（方案 5.8.5 示例）通过全部校验', () => {
    const { res, codes: err } = codes(loadBaseBatch());
    expect([...err]).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('JSON 表层编码解析为同一规范模型', () => {
    const yamlRes = parseBatch(BASE_BATCH_YAML, 'yaml');
    expect(yamlRes.ok).toBe(true);
    const jsonText = JSON.stringify(yamlRes.ok && yamlRes.batch, null, 2);
    const jsonRes = parseBatch(jsonText, 'json');
    expect(jsonRes.ok).toBe(true);
    if (jsonRes.ok && yamlRes.ok) {
      expect(contentHash(jsonRes.batch)).toBe(contentHash(yamlRes.batch));
    }
  });

  it('compileBatch 产出 AST：哈希稳定、目标词定位、ink 路径与 effect 挂接', () => {
    const b = loadBaseBatch();
    const out = validateBatch(b, makeCtx());
    const ast = compileBatch(b, out, {
      lexicon: makeCtx().lexicon,
    });
    expect(ast.hash).toMatch(/^[0-9a-f]{16}$/);
    const again = compileBatch(loadBaseBatch(), validateBatch(loadBaseBatch(), makeCtx()), { lexicon: makeCtx().lexicon });
    expect(again.hash).toBe(ast.hash);
    const items = new Set(ast.targets.map((t) => t.itemId));
    expect(items).toContain('lx:behind#prep.location');
    expect(items).toContain('lx:under#prep.location');
    expect(items).toContain('ck:where-is');
    const story = ast.ink.find((i) => i.sceneId === 's4');
    expect(story?.paths.length).toBe(2);
    expect(story?.paths.some((p) => p.effects.includes('accuse_cat'))).toBe(true);
    expect(story?.paths.some((p) => p.effects.includes('accuse_moon'))).toBe(true);
  });

  it('derive 同批派生：挖空 + 干扰项来自 confusables，证据为 practice', () => {
    const b = mutate((x) => {
      x.scenes.push({
        id: 's5',
        type: 'derive',
        from: 's1.panels[1].bubbles[0]',
        kind: 'cloze_pick',
        item: 'lx:behind#prep.location',
        distractors: 'confusables',
      });
    });
    const ctx = makeCtx();
    const out = validateBatch(b, ctx);
    expect(out.ok).toBe(true); // derive 不计入 3–4 场景上限
    const ast = compileBatch(b, out, { lexicon: ctx.lexicon });
    const d = ast.derived.find((x) => x.sceneId === 's5');
    expect(d).toBeDefined();
    expect(d!.correct).toBe('behind');
    expect(d!.clozeText).toContain('____');
    expect(d!.options).toContain('under');
    expect(d!.options).toContain('in front of');
    expect(d!.evidenceType).toBe('practice');
  });

  it('derive 跨批派生：from 指向更早批次时证据为 recognition-4', () => {
    const b = mutate((x) => {
      x.scenes.push({
        id: 's5',
        type: 'derive',
        from: 'dd-0041.s1.panels[0].bubbles[0]',
        kind: 'cloze_pick',
        item: 'ck:where-is',
        distractors: 'confusables',
      });
    });
    const ctx = makeCtx();
    const out = validateBatch(b, ctx);
    const ast = compileBatch(b, out, {
      lexicon: ctx.lexicon,
      priorTexts: new Map([
        [
          'dd-0041',
          [
            {
              sceneId: 's1',
              sceneIndex: 0,
              path: 'panels[0].bubbles[0]',
              role: 'narrative' as const,
              speaker: 'moon',
              text: 'Where was the crown last night?',
            },
          ],
        ],
      ]),
    });
    const d = ast.derived.find((x) => x.sceneId === 's5');
    expect(d!.correct).toBe('where was');
    expect(d!.evidenceType).toBe('recognition-4');
  });

  it('访问计数条件 {knot: ...} 是允许的 ink 子集', () => {
    const b = mutate((x) => {
      const s4 = sceneOf(x, 's4', 'story');
      s4.ink = s4.ink.replace('Duck: The hat was under the table.', 'Duck: {accuse: The hat was under the table.}');
    });
    expect(codes(b).codes.size).toBe(0);
  });

  it('W-OOV：2%–5% 只给建议级', () => {
    const b = mutate((x) => {
      const s1 = sceneOf(x, 's1', 'comic');
      s1.panels[0]!.bubbles.push({ speaker: 'moon', text: 'Zorp quibbles the fluminox snib.' });
    });
    const w = warns(b);
    expect(w.has('W-OOV')).toBe(true);
    expect(codes(b).codes.has('E-OOV-HIGH')).toBe(false);
    expect(codes(b).res.ok).toBe(true);
  });

  it('W-OOV：弯撇号与所有格不算生词', () => {
    // 模型输出常用 U+2019 写 `don’t` / `moon’s`；分词不归一化会拆成 don + t、moon + s，全是假 OOV。
    // 所有格 `moon's` 该查的是 moon 这个专名本身。
    const b = mutate((x) => {
      const s1 = sceneOf(x, 's1', 'comic');
      s1.panels[0]!.bubbles.push({ speaker: 'moon', text: 'Don’t put the moon’s hat there.' });
      s1.panels[1]!.bubbles.push({ speaker: 'duck', text: "The cat's hat isn't here." });
    });
    const ctx = makeCtx({ vocab: { ...makeCtx().vocab, oovWarn: 0, oovBlock: 1 } });
    const res = validateBatch(b, ctx);
    const oov = res.issues.find((i) => i.code === 'W-OOV');
    const detail = oov?.message ?? '';
    for (const bad of ['"s"', '"don"', '"t"', '"moon\'s"', '"cat\'s"', '"isn"']) {
      expect(detail).not.toContain(bad);
    }
    expect(res.ok).toBe(true);
  });

  it('W-LINE-LONG：超长句只给建议级', () => {
    const ctx = makeCtx();
    for (const w of ['anything', 'today', 'dear', 'friend', 'sir']) ctx.vocab.allowedForms.add(w);
    const b = mutate((x) => {
      const s1 = sceneOf(x, 's1', 'comic');
      s1.panels[2]!.bubbles[0]!.text = 'Nobody asked you anything at all today my dear friend cat detective sir.';
    });
    const { res, codes: err } = codes(b, ctx);
    expect(err.size).toBe(0);
    expect(res.ok).toBe(true);
    expect(warns(b, ctx).has('W-LINE-LONG')).toBe(true);
  });

  it('W-NO-HOOK：持续频道缺 hook_out 只给建议级', () => {
    const b = mutate((x) => delete x.hook_out);
    const { res, codes: err } = codes(b);
    expect(err.size).toBe(0);
    expect(res.ok).toBe(true);
    expect(warns(b).has('W-NO-HOOK')).toBe(true);
  });

  it('W-SEQUENCE-REPEAT 与 W-CAST-OVERUSE', () => {
    const ctx = makeCtx({
      recentSceneSequences: [['comic', 'hidden_object', 'chat', 'story']],
      recentCastCounts: new Map([['duck', 8]]),
    });
    const w = warns(loadBaseBatch(), ctx);
    expect(w.has('W-SEQUENCE-REPEAT')).toBe(true);
    expect(w.has('W-CAST-OVERUSE')).toBe(true);
    expect(codes(loadBaseBatch(), ctx).res.ok).toBe(true);
  });

  it('chat 不带 evidence 也合法（brief 无对应复习时）', () => {
    const ctx = makeCtx();
    ctx.brief = { ...ctx.brief!, review: ctx.brief!.review.filter((r) => !r.item.startsWith('ck:')) };
    const b = mutate((x) => {
      const s3 = sceneOf(x, 's3', 'chat');
      delete s3.evidence;
      delete s3.uses;
    });
    expect(codes(b, ctx).codes.size).toBe(0);
  });
});

// ---------- 反例（每个阻断码 ≥1） ----------

describe('反例', () => {
  it('E-PARSE：YAML 语法错误', () => {
    const res = parseBatch('scenes: [1, 2', 'yaml');
    expect(!res.ok && res.issues.some((i) => i.code === 'E-PARSE')).toBe(true);
  });

  it('E-PARSE：JSON 语法错误', () => {
    const res = parseBatch('{"batch": dd-0042', 'json');
    expect(!res.ok && res.issues.some((i) => i.code === 'E-PARSE')).toBe(true);
  });

  it('E-SCHEMA：zod 层缺必填字段（skin）', () => {
    const badYaml = BASE_BATCH_YAML.replace('skin: messenger', 'skinx: messenger');
    const res = parseBatch(badYaml, 'yaml');
    expect(!res.ok && res.issues.some((i) => i.code === 'E-SCHEMA')).toBe(true);
  });

  it('E-SCHEMA：基本场景超过 4 个', () => {
    const b = mutate((x) => {
      x.scenes.push({
        id: 's5',
        type: 'pick',
        question: 'Where is the hat?',
        options: [
          { label: 'under', correct: true },
          { label: 'behind' },
        ],
        feedback: { on_correct: 'Yes.', on_wrong: 'No.' },
      });
    });
    expect(codes(b).codes.has('E-SCHEMA')).toBe(true);
  });

  it('E-SCHEMA：场景 cast 越出批次 cast', () => {
    const b = mutate((x) => {
      sceneOf(x, 's3', 'chat').cast!.push('wizard');
    });
    expect(codes(b).codes.has('E-SCHEMA')).toBe(true);
  });

  it('E-SCHEMA：derive 的 from 路径无法解析', () => {
    const b = mutate((x) => {
      x.scenes.push({ id: 's5', type: 'derive', from: 's1.panels[9].bubbles[3]', kind: 'cloze_pick', item: 'lx:behind#prep.location', distractors: 'confusables' });
    });
    expect(codes(b).codes.has('E-SCHEMA')).toBe(true);
  });

  it('E-SCHEMA：chat 声明 evidence 但没有 reply', () => {
    const b = mutate((x) => {
      delete sceneOf(x, 's3', 'chat').reply;
    });
    expect(codes(b).codes.has('E-SCHEMA')).toBe(true);
  });

  it('E-SCHEMA：条目不在词库（AI 不能发明条目 ID）', () => {
    const b = mutate((x) => {
      sceneOf(x, 's1', 'comic').uses = ['lx:unicorn#n.magic'];
    });
    expect(codes(b).codes.has('E-SCHEMA')).toBe(true);
  });

  it('E-ASSET-MISSING：素材清单里没有该 emoji', () => {
    const b = mutate((x) => {
      sceneOf(x, 's2', 'hidden_object').objects[0]!.asset = '@emoji:golden_carrot';
    });
    expect(codes(b).codes.has('E-ASSET-MISSING')).toBe(true);
  });

  it('E-CHAR-ATTR：表情不在角色规格表', () => {
    const b = mutate((x) => {
      const s1 = sceneOf(x, 's1', 'comic');
      s1.panels[0]!.actors[0] = '@char:moon{expr=angry}';
    });
    expect(codes(b).codes.has('E-CHAR-ATTR')).toBe(true);
  });

  it('E-ENTITY-UNKNOWN：cast 引用不存在的实体', () => {
    const b = mutate((x) => x.cast.push('wizard'));
    expect(codes(b).codes.has('E-ENTITY-UNKNOWN')).toBe(true);
  });

  it('E-ENTITY-UNKNOWN：new_entities 与既有实体重名', () => {
    const b = mutate((x) => {
      x.new_entities = [{ id: 'duck', kind: 'character', name: 'Duck Two' }];
    });
    expect(codes(b).codes.has('E-ENTITY-UNKNOWN')).toBe(true);
  });

  it('E-EFFECT-INVALID：谓词未声明', () => {
    const b = mutate((x) => {
      const s4 = sceneOf(x, 's4', 'story');
      s4.effects!.accuse_cat!.push({ set_fact: { subject: 'cat', predicate: 'teleport_to', object: 'moon', standing: 'stated' } });
    });
    expect(codes(b).codes.has('E-EFFECT-INVALID')).toBe(true);
  });

  it('E-EFFECT-INVALID：effect 已声明但从未被引用', () => {
    const b = mutate((x) => {
      sceneOf(x, 's4', 'story').effects!.unused_op = [{ user_fact: { predicate: 'shrugged', object: 'cat' } }];
    });
    expect(codes(b).codes.has('E-EFFECT-INVALID')).toBe(true);
  });

  it('E-EFFECT-INVALID：ink 标签引用未声明的 effect', () => {
    const b = mutate((x) => {
      const s4 = sceneOf(x, 's4', 'story');
      s4.ink = s4.ink.replace('# effect:accuse_cat', '# effect:ghost_op');
    });
    expect(codes(b).codes.has('E-EFFECT-INVALID')).toBe(true);
  });

  it('E-CANON：set_fact 改写 canon 事实', () => {
    const b = mutate((x) => {
      const s4 = sceneOf(x, 's4', 'story');
      s4.effects!.accuse_moon!.push({ set_fact: { subject: 'duck', predicate: 'role', object: 'shop_clerk', standing: 'stated' } });
    });
    expect(codes(b).codes.has('E-CANON')).toBe(true);
  });

  it('E-CANON：end_fact 结束 canon 事实', () => {
    const b = mutate((x) => {
      const s4 = sceneOf(x, 's4', 'story');
      s4.effects!.accuse_moon!.push({ end_fact: { subject: 'duck', predicate: 'role', object: 'detective' } });
    });
    expect(codes(b).codes.has('E-CANON')).toBe(true);
  });

  it('E-FACT-CONFLICT：end_fact 与当前事实不符', () => {
    const b = mutate((x) => {
      const s4 = sceneOf(x, 's4', 'story');
      s4.effects!.accuse_moon!.push({ end_fact: { subject: 'cat', predicate: 'location', object: 'agency_office' } });
    });
    expect(codes(b).codes.has('E-FACT-CONFLICT')).toBe(true);
  });

  it('E-FACT-CONFLICT：end_fact 没有可结束的活动事实', () => {
    const b = mutate((x) => {
      const s4 = sceneOf(x, 's4', 'story');
      s4.effects!.accuse_moon!.push({ end_fact: { subject: 'moon', predicate: 'location', object: 'rooftop' } });
    });
    expect(codes(b).codes.has('E-FACT-CONFLICT')).toBe(true);
  });

  it('E-INK：禁止 VAR 赋值', () => {
    const b = mutate((x) => {
      const s4 = sceneOf(x, 's4', 'story');
      s4.ink = 'VAR trust = 1\n' + s4.ink;
    });
    expect(codes(b).codes.has('E-INK')).toBe(true);
  });

  it('E-INK：divert 指向不存在的 knot', () => {
    const b = mutate((x) => {
      const s4 = sceneOf(x, 's4', 'story');
      s4.ink = s4.ink.replace('-> accuse\n', '-> missing_knot\n');
    });
    expect(codes(b).codes.has('E-INK')).toBe(true);
  });

  it('E-ANSWER-COUNT：chat 两个正确答案', () => {
    const b = mutate((x) => {
      sceneOf(x, 's3', 'chat').reply!.options[1]!.correct = true;
    });
    expect(codes(b).codes.has('E-ANSWER-COUNT')).toBe(true);
  });

  it('E-ANSWER-COUNT：hidden_object 两个目标', () => {
    const b = mutate((x) => {
      sceneOf(x, 's2', 'hidden_object').objects[1]!.target = true;
    });
    expect(codes(b).codes.has('E-ANSWER-COUNT')).toBe(true);
  });

  it('E-ANSWER-DUP：选项文本重复', () => {
    const b = mutate((x) => {
      sceneOf(x, 's3', 'chat').reply!.options[1]!.label = 'Where was your hat last night?';
    });
    expect(codes(b).codes.has('E-ANSWER-DUP')).toBe(true);
  });

  it('E-ANSWER-DUP：干扰项与答案是同一条目的不同形式', () => {
    const b = mutate((x) => {
      x.scenes.push({
        id: 's5',
        type: 'pick',
        question: 'The cat ____ a hat yesterday.',
        uses: ['lx:borrow#v.take-temporarily'],
        evidence: { item: 'lx:borrow#v.take-temporarily', type: 'recognition-4' },
        options: [
          { label: 'borrowed', correct: true },
          { label: 'borrows' },
          { label: 'lends' },
          { label: 'takes' },
        ],
        feedback: { on_correct: 'Right.', on_wrong: 'Not quite.' },
      });
    });
    expect(codes(b).codes.has('E-ANSWER-DUP')).toBe(true);
  });

  it('E-EVIDENCE-OVERCLAIM：spots < 4 却声明 recognition-4', () => {
    const b = mutate((x) => {
      const s2 = sceneOf(x, 's2', 'hidden_object');
      s2.spots = ['sofa_behind', 'table_under', 'lamp_top'];
      s2.objects = s2.objects.slice(0, 3);
    });
    expect(codes(b).codes.has('E-EVIDENCE-OVERCLAIM')).toBe(true);
  });

  it('E-EVIDENCE-OVERCLAIM：preference 模式声明了证据', () => {
    const b = mutate((x) => {
      x.scenes.push({
        id: 's5',
        type: 'swipe',
        prompt: 'Which hat do you like?',
        mode: 'preference',
        evidence: { item: 'lx:behind#prep.location', type: 'recognition-2' },
        cards: [
          { asset: '@emoji:top_hat', caption: 'A tall hat.', side: 'left' },
          { asset: '@emoji:sock', caption: 'A warm sock.', side: 'right' },
        ],
      });
    });
    expect(codes(b).codes.has('E-EVIDENCE-OVERCLAIM')).toBe(true);
  });

  it('E-PRIMED：复习条目在检测前出现（方案 5.8.5 说明的场景）', () => {
    const b = mutate((x) => {
      sceneOf(x, 's1', 'comic').panels[0]!.bubbles[0]!.text = 'Where is my hat?';
    });
    expect(codes(b).codes.has('E-PRIMED')).toBe(true);
  });

  it('E-NEW-TESTED-EARLY：新条目曝光不足 2 次就被检测（R1）', () => {
    const ctx = makeCtx();
    ctx.brief!.introduce = ['lx:borrow#v.take-temporarily'];
    ctx.exposureCounts = new Map([['lx:borrow#v.take-temporarily', 1]]);
    const b = mutate((x) => {
      sceneOf(x, 's3', 'chat').evidence = { item: 'lx:borrow#v.take-temporarily', type: 'recognition-4' };
    });
    expect(codes(b, ctx).codes.has('E-NEW-TESTED-EARLY')).toBe(true);
  });

  it('E-BRIEF-UNCOVERED：review 条目没有合格证据', () => {
    const b = mutate((x) => {
      delete sceneOf(x, 's2', 'hidden_object').evidence;
    });
    expect(codes(b).codes.has('E-BRIEF-UNCOVERED')).toBe(true);
  });

  it('E-BRIEF-UNCOVERED：expose 条目没有出现', () => {
    const b = mutate((x) => {
      sceneOf(x, 's1', 'comic').uses = [];
    });
    expect(codes(b).codes.has('E-BRIEF-UNCOVERED')).toBe(true);
  });

  it('E-USES-NOT-FOUND：uses 在文本中找不到', () => {
    const b = mutate((x) => {
      sceneOf(x, 's1', 'comic').uses = ['lx:in-front-of#prep.location'];
    });
    expect(codes(b).codes.has('E-USES-NOT-FOUND')).toBe(true);
  });

  it('E-OOV-HIGH：未知词占比超过 5%', () => {
    const b = mutate((x) => {
      const s1 = sceneOf(x, 's1', 'comic');
      s1.panels[0]!.bubbles.push({ speaker: 'moon', text: 'Zorp quibbles the fluminox blorptastic snib vorpal zingle meep.' });
    });
    expect(codes(b).codes.has('E-OOV-HIGH')).toBe(true);
  });

  it('§12 词表计数：没触发告警也要回报比例（L3 指标读取原始计数）', () => {
    // 早先 L3 只能从 W-OOV 文案里正则抠百分比，于是「OOV 低于告警线」的批次被当成没有数据丢掉，
    // 指标系统性偏高（结果文档 §4.6）。现在由校验器直接回报 totalTokens / oovTokens。
    const clean = validateBatch(loadBaseBatch(), makeCtx());
    expect(clean.vocab.totalTokens).toBeGreaterThan(0);
    expect(clean.vocab.oovTokens).toBe(0);
    expect(clean.vocab.oovRatio).toBe(0);
    const b = mutate((x) => {
      sceneOf(x, 's1', 'comic').panels[0]!.bubbles.push({ speaker: 'moon', text: 'Zorp quibbles the fluminox snib.' });
    });
    const dirty = validateBatch(b, makeCtx());
    expect(dirty.vocab.oovTokens).toBeGreaterThan(0);
    expect(dirty.vocab.oovRatio).toBeCloseTo(dirty.vocab.oovTokens / dirty.vocab.totalTokens, 10);
  });

  it('§12 不污染调用方的词表：多词形式不会被第一轮校验吃掉', () => {
    const ctx = makeCtx();
    ctx.vocab.oovWarn = 0;
    ctx.vocab.oovBlock = 1;
    const b = mutate((x) => {
      sceneOf(x, 's1', 'comic').panels[0]!.bubbles.push({ speaker: 'moon', text: 'in front of' });
    });
    expect(validateBatch(b, ctx).vocab.oovTokens).toBe(0); // 多词形式整体算已知
    // 第二轮复用同一个 ctx：若第一轮直接从 ctx 的集合里删了多词形式，这里 in / front / of 会变成 3 个生词
    expect(validateBatch(b, ctx).vocab.oovTokens).toBe(0);
  });
});

// ---------- D4：选项长度泄露 ----------

describe('D4 选项长度泄露（建议级）', () => {
  it('正确选项比干扰项均值长 50% 以上时报 W-OPTION-LENGTH-LEAK，且不阻断', () => {
    const b = mutate((x) => {
      const s = sceneOf(x, 's3', 'chat');
      s.reply!.options = [
        { label: 'Where was your hat last night before the show?', correct: true },
        { label: 'Who was it?' },
        { label: 'When was it?' },
        { label: 'How was it?' },
      ];
    });
    expect(warns(b).has('W-OPTION-LENGTH-LEAK')).toBe(true);
    expect([...codes(b).codes]).toEqual([]); // 建议级不改变通过率
  });

  it('长度相近的选项不报警（基准批次）', () => {
    expect(warns(loadBaseBatch()).has('W-OPTION-LENGTH-LEAK')).toBe(false);
  });
});

// ---------- 世界状态改变（审计 §3）----------

describe('世界状态改变计数与 W-NO-WORLD-CHANGE', () => {
  /** 一个完全没有 effects 的批次：comic + pick + chat（chat 无 reply 也就没有 effect 入口）。 */
  const NO_EFFECT_YAML = `
batch: b-noworld
channel: duck_detective
brief: lb-0001
cast: [duck]
scenes:
  - id: s1
    type: comic
    setting: "@tag:agency_office"
    panels:
      - shot: wide
        actors: ["@char:duck{expr=neutral}"]
        bubbles:
          - {speaker: duck, text: "No cases today."}
  - id: s2
    type: pick
    question: "What is under the box?"
    cast: [duck]
    evidence: {item: ck:where-is, type: recognition-2}
    options:
      - {label: "a key", correct: true}
      - {label: "a hat"}
    feedback: {on_correct: "Right.", on_wrong: "Look again."}
  - id: s3
    type: chat
    skin: messenger
    cast: [duck]
    messages:
      - {from: duck, text: "Nothing happened today."}
`;
  // 学习任务与词汇预算都与本节无关：去掉 brief、放开 OOV 与句长，只看世界状态那一条
  const noBrief = () => makeCtx({ brief: undefined, vocab: { allowedForms: new Set(), oovWarn: 1, oovBlock: 1, maxWordsPerLine: 999 } });

  it('基准批次：生效 effect 数 > 0，不报 W-NO-WORLD-CHANGE', () => {
    const out = validateBatch(loadBaseBatch(), makeCtx());
    // s4 的 accuse_cat（open_thread + set_fact）与 accuse_moon（set_fact + user_fact）
    expect(out.worldChanges).toBe(4);
    expect(out.issues.some((i) => i.code === 'W-NO-WORLD-CHANGE')).toBe(false);
  });

  it('没有任何 effect 的批次：worldChanges = 0 且报建议级 W-NO-WORLD-CHANGE（不阻断）', () => {
    const parsed = parseBatch(NO_EFFECT_YAML, 'yaml');
    expect(parsed.ok, parsed.ok ? '' : parsed.issues.map((i) => i.message).join('; ')).toBe(true);
    if (!parsed.ok) return;
    const out = validateBatch(parsed.batch, noBrief());
    expect(out.worldChanges).toBe(0);
    const issue = out.issues.find((i) => i.code === 'W-NO-WORLD-CHANGE');
    expect(issue?.level).toBe('warning');
    expect(out.ok).toBe(true); // 建议级：不改变通过率
  });

  it('声明了 effect 但没被引用：不算世界改变，且仍报 E-EFFECT-INVALID', () => {
    const b = mutate((x) => {
      const s = sceneOf(x, 's3', 'chat');
      s.effects = { unused_mark: [{ set_fact: { subject: 'cat', predicate: 'suspect_status', object: 'clear', standing: 'stated' } }] };
    });
    const out = validateBatch(b, noBrief());
    expect(out.issues.some((i) => i.code === 'E-EFFECT-INVALID' && i.message.includes('从未被引用'))).toBe(true);
  });

  it('没有任何检测交互的批次：detectionScenes = 0 且报 W-NO-DETECTION（学习层空转可见）', () => {
    // 基准批次有 2 个检测场景（hidden_object + chat）
    expect(validateBatch(loadBaseBatch(), noBrief()).detectionScenes).toBe(2);
    const pure = mutate(() => undefined);
    for (const s of pure.scenes) delete (s as { evidence?: unknown }).evidence;
    const out = validateBatch(pure, noBrief());
    expect(out.detectionScenes).toBe(0);
    expect(out.issues.find((i) => i.code === 'W-NO-DETECTION')?.level).toBe('warning');
  });
});

// ---------- 覆盖率自检：全部阻断码都有反例 ----------

describe('阻断码覆盖自检', () => {
  it('ISSUE_CODES 里的每个阻断码都被上方反例覆盖', async () => {
    const model = await import('../src/model.js');
    // 下方清单是上面反例中实际断言过的码；若有人往 ISSUE_CODES 加新阻断码而没写反例，这里会失败
    const coveredByTests = new Set([
      'E-PARSE', 'E-SCHEMA', 'E-ASSET-MISSING', 'E-CHAR-ATTR', 'E-ENTITY-UNKNOWN',
      'E-EFFECT-INVALID', 'E-CANON', 'E-FACT-CONFLICT', 'E-INK', 'E-ANSWER-COUNT',
      'E-ANSWER-DUP', 'E-EVIDENCE-OVERCLAIM', 'E-PRIMED', 'E-NEW-TESTED-EARLY',
      'E-BRIEF-UNCOVERED', 'E-USES-NOT-FOUND', 'E-OOV-HIGH',
    ]);
    for (const code of model.BLOCKING_CODES) {
      expect(coveredByTests.has(code)).toBe(true);
    }
    expect(Object.keys(LEXICON).length).toBeGreaterThan(0);
  });
});
