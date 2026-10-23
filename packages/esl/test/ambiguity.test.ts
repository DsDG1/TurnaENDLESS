/**
 * L4 歧义率程序口径（方案 6.3）。
 *
 * 这里固化的是「程序判得了的那一半」：答案计数、选项文本重复、干扰项与正确项内容词重叠。
 * 语义级歧义（两个说法在本场景都成立）程序判不了，测试里也明确不假装能判。
 */
import { describe, expect, it } from 'vitest';
import { AMBIGUITY_JACCARD, contentWords, detectionAmbiguity } from '../src/ambiguity.js';
import type { Batch } from '../src/model.js';

function batch(scenes: Batch['scenes']): Batch {
  return { batch: 'b-amb', channel: 'duck_detective', brief: 'lb-1', cast: ['duck'], scenes };
}

describe('L4 歧义率（程序口径）', () => {
  it('内容词：剔掉功能词后只留实词', () => {
    expect([...contentWords('under the box')]).toEqual(['box']);
    expect([...contentWords('on the table')]).toEqual(['table']);
  });

  it('选项措辞不同且只有一个正确答案：不判歧义', () => {
    const b = batch([
      {
        id: 's1',
        type: 'pick',
        question: 'Where is the key?',
        options: [
          { label: 'under the box', correct: true },
          { label: 'behind the door' },
          { label: 'on the table' },
          { label: 'next to the sofa' },
        ],
        feedback: { on_correct: 'Right.', on_wrong: 'Again.' },
      },
    ]);
    const out = detectionAmbiguity(b);
    expect(out.detectionScenes).toBe(1);
    expect(out.ambiguous).toEqual([]);
    expect(out.rate).toBe(0);
  });

  it('两个选项只有一个功能词之差（内容词完全重合）→ 判歧义', () => {
    const b = batch([
      {
        id: 's1',
        type: 'pick',
        question: 'Where is the key?',
        options: [
          { label: 'under the box', correct: true },
          { label: 'under a box' },
          { label: 'behind the door' },
        ],
        feedback: { on_correct: 'Right.', on_wrong: 'Again.' },
      },
    ]);
    const out = detectionAmbiguity(b);
    expect(out.ambiguous.length).toBe(1);
    expect(out.ambiguous[0]!.reason).toContain('重合');
    expect(out.rate).toBe(1);
  });

  it('完全没有正确答案 / 两个正确答案 → 判歧义', () => {
    const none = batch([
      {
        id: 's1',
        type: 'pick',
        question: 'Where is the key?',
        options: [
          { label: 'under the box' },
          { label: 'behind the door' },
        ],
        feedback: { on_correct: 'Right.', on_wrong: 'Again.' },
      },
    ]);
    expect(detectionAmbiguity(none).ambiguous[0]!.reason).toContain('不是恰好 1 个');
  });

  it('chat 的 reply 选项同样计入检测场景', () => {
    const b = batch([
      {
        id: 's2',
        type: 'chat',
        skin: 'messenger',
        messages: [{ from: 'duck', text: 'What do I say?' }],
        reply: {
          options: [
            { label: 'on the shelf', correct: true },
            { label: 'on a shelf' },
          ],
          on_correct: { from: 'duck', text: 'Good.' },
          on_wrong: { from: 'duck', text: 'No.' },
        },
      },
    ]);
    const out = detectionAmbiguity(b);
    expect(out.detectionScenes).toBe(1);
    expect(out.ambiguous.length).toBe(1);
  });

  it('只有一个疑问词不同（Where / Who / When）：不判歧义——疑问词正是选项的区别', () => {
    const b = batch([
      {
        id: 's2',
        type: 'chat',
        skin: 'messenger',
        messages: [{ from: 'duck', text: 'What do I say?' }],
        reply: {
          options: [
            { label: 'Where was your hat last night?', correct: true },
            { label: 'Who was your hat last night?' },
            { label: 'When was your hat last night?' },
            { label: 'How was your hat last night?' },
          ],
          on_correct: { from: 'duck', text: 'Good.' },
          on_wrong: { from: 'duck', text: 'No.' },
        },
      },
    ]);
    const out = detectionAmbiguity(b);
    expect(out.ambiguous).toEqual([]);
    expect(out.rate).toBe(0);
  });

  it('L4 按场景计，不按理由计：一个场景三个干扰项重合也只算 1 个歧义场景', () => {
    const b = batch([
      {
        id: 's1',
        type: 'pick',
        question: 'Where is the key?',
        options: [
          { label: 'under the box', correct: true },
          { label: 'under a box' },
          { label: 'under one box' },
          { label: 'under some box' },
        ],
        feedback: { on_correct: 'Right.', on_wrong: 'Again.' },
      },
      {
        id: 's2',
        type: 'pick',
        question: 'Where is the cat?',
        options: [
          { label: 'behind the door', correct: true },
          { label: 'on the shelf' },
        ],
        feedback: { on_correct: 'Right.', on_wrong: 'Again.' },
      },
    ]);
    const out = detectionAmbiguity(b);
    expect(out.detectionScenes).toBe(2);
    expect(out.ambiguous.length).toBeGreaterThan(1); // 三条理由
    expect(out.ambiguousScenes).toBe(1); // 但只有一个场景有歧义
    expect(out.rate).toBe(0.5);
  });

  it('没有检测场景时 rate 为 null（不可判定），不是 0%', () => {
    const out = detectionAmbiguity(
      batch([
        {
          id: 's1',
          type: 'comic',
          setting: '@tag:agency_office',
          panels: [{ shot: 'wide', actors: [], props: [], bubbles: [{ speaker: 'duck', text: 'Hi.' }] }],
        },
      ]),
    );
    expect(out.detectionScenes).toBe(0);
    expect(out.rate).toBeNull();
  });

  it('swipe 只有 judge 模式算检测；同图同文的卡重复判歧义', () => {
    const pref = batch([
      {
        id: 's1',
        type: 'swipe',
        prompt: 'Which one?',
        mode: 'preference',
        cards: [
          { asset: '@emoji:top_hat', caption: 'nice', side: 'left' },
          { asset: '@emoji:top_hat', caption: 'nice', side: 'right' },
        ],
      },
    ]);
    expect(detectionAmbiguity(pref).detectionScenes).toBe(0);

    const judge = batch([
      {
        id: 's1',
        type: 'swipe',
        prompt: 'Which one?',
        mode: 'judge',
        cards: [
          { asset: '@emoji:top_hat', caption: 'behind the door', side: 'left' },
          { asset: '@emoji:top_hat', caption: 'behind the door', side: 'right' },
        ],
      },
    ]);
    const out = detectionAmbiguity(judge);
    expect(out.detectionScenes).toBe(1);
    expect(out.ambiguous.length).toBe(1);
  });

  it('阈值常量可读：Jaccard 0.6', () => {
    expect(AMBIGUITY_JACCARD).toBe(0.6);
  });
});
