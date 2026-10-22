/**
 * 程序化自检（autofix）测试：三类机械修复各自生效、且不动语义类问题。
 * 夹具沿用 validator 的基准批次（dd-0042），只在 YAML 上做最小改动。
 */
import { describe, expect, it } from 'vitest';
import { autoFixBatch } from '../src/autofix.js';
import { parseBatch } from '../src/parse.js';
import { validateBatch } from '../src/validate.js';
import { BASE_BATCH_YAML, makeCtx } from './fixture.js';

const parse = (yaml: string) => {
  const res = parseBatch(yaml, 'yaml');
  if (!res.ok) throw new Error(`夹具解析失败：${res.issues.map((i) => i.message).join('; ')}`);
  return res.batch;
};

describe('autoFixBatch', () => {
  it('基准批次无需修复，且校验通过', () => {
    const batch = parse(BASE_BATCH_YAML);
    const { fixes, batch: fixed } = autoFixBatch(batch, makeCtx());
    expect(fixes).toEqual([]);
    expect(fixed).toEqual(batch);
    expect(validateBatch(fixed, makeCtx()).ok).toBe(true);
  });

  it('删掉文本里找不到的 uses 声明（E-USES-NOT-FOUND）', () => {
    const yaml = BASE_BATCH_YAML.replace(
      'uses: [lx:behind#prep.location]',
      'uses: [lx:behind#prep.location, lx:borrow#v.take-temporarily]',
    );
    const ctx = makeCtx();
    const batch = parse(yaml);
    expect(validateBatch(batch, ctx).issues.map((i) => i.code)).toContain('E-USES-NOT-FOUND');

    const { batch: fixed, fixes } = autoFixBatch(batch, ctx);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toContain('lx:borrow#v.take-temporarily');
    expect(fixed.scenes[0]!.uses).toEqual(['lx:behind#prep.location']);
    expect(validateBatch(fixed, ctx).ok).toBe(true);
  });

  it('删掉没有任何选项或 ink 标签引用的 effect（E-EFFECT-INVALID）', () => {
    const yaml = BASE_BATCH_YAML.replace(
      '    effects:\n',
      '    effects:\n      never_used:\n        - set_fact: {subject: cat, predicate: suspect_status, object: suspect}\n',
    );
    const ctx = makeCtx();
    const batch = parse(yaml);
    expect(validateBatch(batch, ctx).issues.map((i) => i.code)).toContain('E-EFFECT-INVALID');

    const { batch: fixed, fixes } = autoFixBatch(batch, ctx);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toContain('never_used');
    const effects = (fixed.scenes.find((s) => s.id === 's4') as { effects?: Record<string, unknown> }).effects;
    expect(Object.keys(effects ?? {})).toEqual(['accuse_cat', 'accuse_moon']);
    expect(validateBatch(fixed, ctx).ok).toBe(true);
  });

  it('新条目曝光不足时去掉检测（E-NEW-TESTED-EARLY）', () => {
    const batch = parse(BASE_BATCH_YAML);
    const fresh = makeCtx({
      brief: {
        id: 'lb-0042',
        review: [],
        expose: [],
        introduce: ['lx:under#prep.location'],
        avoidBeforeTest: [],
      },
      exposureCounts: new Map(),
    });
    expect(validateBatch(batch, fresh).issues.map((i) => i.code)).toContain('E-NEW-TESTED-EARLY');

    const { batch: fixed, fixes } = autoFixBatch(batch, fresh);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toContain('lx:under#prep.location');
    expect(fixed.scenes.find((s) => s.id === 's2')!.evidence).toBeUndefined();

    // 已经曝光 ≥ 2 次时不该动它
    const seen = makeCtx({
      brief: { id: 'lb-0042', review: [], expose: [], introduce: ['lx:under#prep.location'], avoidBeforeTest: [] },
      exposureCounts: new Map([['lx:under#prep.location', 2]]),
    });
    expect(autoFixBatch(batch, seen).fixes).toEqual([]);
  });

  it('不修语义类问题：说话者不在 cast 仍交给校验器报错', () => {
    const yaml = BASE_BATCH_YAML.replace(
      '{from: duck, text: "Good work. Now I must ask the moon one question."}',
      '{from: ghost, text: "Good work. Now I must ask the moon one question."}',
    );
    const ctx = makeCtx();
    const batch = parse(yaml);
    const { batch: fixed, fixes } = autoFixBatch(batch, ctx);
    expect(fixes).toEqual([]);
    expect(fixed).toEqual(batch);
    expect(validateBatch(fixed, ctx).issues.map((i) => i.code)).toContain('E-ENTITY-UNKNOWN');
  });

  it('角色属性不在规格表时改成合法值或删掉（E-CHAR-ATTR）', () => {
    const yaml = BASE_BATCH_YAML.replace(
      'actors: ["@char:cat{expr=sweating}"]',
      'actors: ["@char:cat{expr=shock, hat=crown, holding=key}"]',
    );
    const ctx = makeCtx();
    const batch = parse(yaml);
    const codes = validateBatch(batch, ctx).issues.map((i) => i.code);
    expect(codes.filter((c) => c === 'E-CHAR-ATTR')).toHaveLength(3);

    const { batch: fixed, fixes } = autoFixBatch(batch, ctx);
    expect(fixes).toHaveLength(3);
    expect(fixes[0]).toContain('expr「shock」');
    expect(fixes[0]).toContain('「neutral」');
    const actors = (fixed.scenes.find((s) => s.id === 's1') as { panels: { actors: string[] }[] }).panels[1]!
      .actors;
    expect(actors).toEqual(['@char:cat{expr=neutral}']);
    expect(validateBatch(fixed, ctx).ok).toBe(true);
  });

  it('删掉装饰位里不存在的 emoji（E-ASSET-MISSING），必需位不动', () => {
    // 装饰位：comic 的 props、pick 选项的图案
    let yaml = BASE_BATCH_YAML.replace(
      "        actors: [\"@char:cat{expr=sweating}\"]",
      "        actors: [\"@char:cat{expr=sweating}\"]\n        props: [\"@emoji:crate\", \"@emoji:teapot\"]",
    );
    // 必需位：swipe 卡片的图案（删了卡片就没有图案，只能报错）
    yaml += `
  - id: s9
    type: swipe
    uses: [lx:under#prep.location]
    evidence: {item: lx:under#prep.location, type: recognition-2}
    mode: judge
    prompt: "Is the hat under the table?"
    cards:
      - {asset: "@emoji:crate", caption: "Under the table", side: left}
      - {asset: "@emoji:teapot", caption: "On the table", side: right}
`;
    const ctx = makeCtx();
    const batch = parse(yaml);
    const missing = validateBatch(batch, ctx)
      .issues.filter((i) => i.code === 'E-ASSET-MISSING' && i.message.includes('crate'));
    expect(missing.length).toBe(2); // props + swipe card

    const { batch: fixed, fixes } = autoFixBatch(batch, ctx);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toContain('@emoji:crate');
    const comic = fixed.scenes.find((s) => s.id === 's1') as { panels: { props: string[] }[] };
    expect(comic.panels[1]!.props).toEqual(['@emoji:teapot']);
    const swipe = fixed.scenes.find((s) => s.id === 's9') as { cards: { asset: string }[] };
    expect(swipe.cards[0]!.asset).toBe('@emoji:crate'); // 留给校验器
    const left = validateBatch(fixed, ctx).issues.filter((i) => i.code === 'E-ASSET-MISSING');
    expect(left).toHaveLength(1);
  });
});
