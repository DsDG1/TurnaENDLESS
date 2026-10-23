/**
 * C1 批次补丁：改值，不重新生成。
 *
 * 判据（计划文档）：对 20o 的失败批次写一条补丁（`@tag:apartment → @tag:living_room`、
 * `mouse → delivery_mouse`），重新校验通过；针对 `locked` 字段的补丁被拒绝。
 *
 * 这里的批次就是 20o 失败谱的复刻（自造背景 + 自造角色 + 别名道具），
 * 补丁走的是「人手动改」的路径 —— 与 autofix 的别名替换结果相同，但它是人工干预，**不计入 V2**。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPatch, classifyPath, parseBatch, patchLogLine, validateBatch, type ValidationContext } from '@endless/esl';
import { buildValidationContext, loadLabData, type LabData } from '../src/data.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');

const BATCH_20O = `
batch: b-0008
channel: duck_detective
brief: lb-0008
cast: [duck, cat]
hook_out: "The flat is empty."
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

function ctxFor(data: LabData): ValidationContext {
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
    maxWordsPerLine: 999,
    oovWarn: 1,
    oovBlock: 1,
  });
}

describe('C1 批次补丁', () => {
  it('路径分类：名字类可改、文字类可改、检测口径锁定', () => {
    expect(classifyPath('scenes[s1].setting')).toBe('asset');
    expect(classifyPath('scenes[s1].panels[0].props[1]')).toBe('asset');
    expect(classifyPath('scenes[s1].panels[0].bubbles[0].speaker')).toBe('asset');
    expect(classifyPath('scenes[s2].options[0].label')).toBe('text');
    expect(classifyPath('scenes[s3].messages[0].text')).toBe('text');
    expect(classifyPath('scenes[s2].evidence')).toBe('locked');
    expect(classifyPath('scenes[s2].uses')).toBe('locked');
    expect(classifyPath('scenes[s2].options[0].correct')).toBe('locked');
    expect(classifyPath('scenes[s1].id')).toBe('locked');
  });

  it('20o 失败谱的补丁：改完重新校验通过', async () => {
    const data = await loadLabData(DATA_DIR);
    const ctx = ctxFor(data);
    const parsed = parseBatch(BATCH_20O, 'yaml');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 补丁前：自造背景与自造角色，校验不过
    expect(validateBatch(parsed.batch, ctx).ok).toBe(false);

    const patched = applyPatch(parsed.batch, [
      { path: 'scenes[s1].setting', value: '@tag:living_room', note: 'apartment → living_room' },
      { path: 'scenes[s1].panels[0].actors[1]', value: '@char:delivery_mouse' },
      { path: 'scenes[s1].panels[0].props[0]', value: '@emoji:top_hat' },
      { path: 'scenes[s1].panels[0].bubbles[0].speaker', value: 'delivery_mouse' },
      { path: 'batch.cast', value: ['duck', 'cat', 'delivery_mouse'] },
    ]);
    expect(patched.rejected).toHaveLength(0);
    expect(patched.applied).toHaveLength(5);
    expect(validateBatch(patched.batch, ctx).ok).toBe(true);
    // 日志格式与 autofix 一致：`<位置>：<旧> → <新>`
    expect(patchLogLine(patched.applied[0]!)).toContain('scenes[s1].setting');
    expect(patchLogLine(patched.applied[0]!)).toContain('→');
  });

  it('locked 字段的补丁被拒绝，且整批不写出（不做半改的批次）', async () => {
    const data = await loadLabData(DATA_DIR);
    const parsed = parseBatch(BATCH_20O, 'yaml');
    if (!parsed.ok) return;
    const patched = applyPatch(parsed.batch, [
      { path: 'scenes[s1].setting', value: '@tag:living_room' },
      { path: 'scenes[s2].evidence', value: { item: 'lx:under#prep.location', type: 'recognition-4' } },
    ]);
    expect(patched.ok).toBe(false);
    expect(patched.rejected.map((r) => r.path)).toEqual(['scenes[s2].evidence']);
    expect(patched.rejected[0]!.reason).toContain('locked');
  });

  it('路径写错时拒绝，而不是悄悄新建一个字段', async () => {
    const parsed = parseBatch(BATCH_20O, 'yaml');
    if (!parsed.ok) return;
    const patched = applyPatch(parsed.batch, [{ path: 'scenes[s9].setting', value: '@tag:living_room' }]);
    expect(patched.ok).toBe(false);
    expect(patched.rejected[0]!.reason).toContain('路径不存在');
  });

  it('text 类补丁可以改台词（改完由调用方重跑词汇检查）', async () => {
    const parsed = parseBatch(BATCH_20O, 'yaml');
    if (!parsed.ok) return;
    const patched = applyPatch(parsed.batch, [
      { path: 'scenes[s3].messages[0].text', value: 'The key is not here at all.' },
    ]);
    expect(patched.ok).toBe(true);
    expect(patched.applied[0]!.cls).toBe('text');
    const scene = patched.batch.scenes.find((s) => s.id === 's3');
    expect(scene && scene.type === 'chat' ? scene.messages[0]!.text : '').toBe('The key is not here at all.');
  });
});
