import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type LlmClient, type LlmRequest, type LlmResponse } from '@endless/director';
import { BudgetLlmClient, createGenerator } from '../src/generate.js';
import { contentHash } from '@endless/esl';
import { complete, content, generated } from './fixtures.js';

function client(respond: (request: LlmRequest) => string): LlmClient {
  return {
    modelId: async () => 'test-model',
    complete: async (request): Promise<LlmResponse> => ({
      text: respond(request), usage: { inputTokens: 100, outputTokens: 100 },
      cacheHit: false, latencyMs: 1, requestHash: 'test-hash',
    }),
  };
}

describe('实际 director 与动态播放器集成', () => {
  it('连续生成两集，读取真实学习和剧情，生成内容可恢复并作答', async () => {
    let save = complete();
    let calls = 0;
    for (let index = 0; index < 2; index++) {
      const id = randomUUID();
      const expected = generated(save, `ai-${id}`);
      const llm = client((request) => {
        calls++;
        expect(request.prompt).toContain('completed_case');
        if (index) expect(request.prompt).toContain('noticed');
        return JSON.stringify(expected.batch);
      });
      const result = await createGenerator(content, llm)(save, id, () => {});
      const accepted = content.accept(result, save);
      save = complete(content.snapshot(save.session, accepted.generated));
      const restored = content.restore(JSON.parse(JSON.stringify(save)));
      expect(restored.library.episodes).toHaveLength(4 + index);
      expect(content.stateContext(restored.session, restored.library).view.world.userFacts().filter((fact) => fact.predicate === 'noticed')).toHaveLength(index + 1);
    }
    expect(calls).toBe(2);
  });

  it('拒绝不支持的场景，不将删减后的内容交付给用户', async () => {
    const save = complete();
    const id = randomUUID();
    const document = generated(save, `ai-${id}`);
    document.batch.scenes.push({ id: 's4', type: 'story', ink: 'Hello. -> END' });
    let calls = 0;
    const llm = client(() => { calls++; return JSON.stringify(document.batch); });
    await expect(createGenerator(content, llm)(save, id, () => {})).rejects.toThrow(/未通过校验/);
    expect(calls).toBeLessThanOrEqual(3);
    expect(content.restore(save).library.episodes).toHaveLength(3);
  });

  it('调用与 token 预算达到上限后，不再调用供应商', async () => {
    let calls = 0;
    const limited = new BudgetLlmClient(client(() => { calls++; return '{}'; }), () => {});
    const request: LlmRequest = { stage: 'single', system: 'test', prompt: 'test', modelTier: 'fast', maxTokens: 100 };
    for (let i = 0; i < 3; i++) await limited.complete(request);
    await expect(limited.complete(request)).rejects.toThrow(/预算/);
    expect(calls).toBe(3);
    await expect(new BudgetLlmClient(client(() => ''), () => {}).complete({ ...request, maxTokens: 40_000 })).rejects.toThrow(/预算/);
  });

  it('词汇预算错误触发带完整约束的整批修复，而不是仅修部分场景', async () => {
    const save = complete();
    const id = randomUUID();
    const valid = generated(save, `ai-${id}`).batch;
    const invalid = structuredClone(valid);
    const comic = invalid.scenes.find((scene) => scene.type === 'comic')!;
    if (comic.type !== 'comic') throw new Error('fixture');
    comic.panels[0]!.caption = 'extraordinary bewilderment mysterious chandelier '.repeat(20);
    let calls = 0;
    const llm = client((request) => {
      calls++;
      if (calls > 1) {
        expect(request.prompt).toContain('E-OOV-HIGH');
        expect(request.prompt).toContain('allowed_words');
        expect(request.prompt).toContain('上一版完整批次');
      }
      return JSON.stringify(calls === 1 ? invalid : valid);
    });
    const result = await createGenerator(content, llm)(save, id, () => {});
    // 修复结果比对限定在写手负责的叙事场景；程序练习卡由拼接器追加，不在比对范围
    expect({ ...result.batch, scenes: result.batch.scenes.filter((s) => !['quiz', 'card'].includes(s.type)) }).toEqual(valid);
    expect(calls).toBe(2);
  });

  it('无用 uses 和未引用效果可机械修正，但不会删学习任务或选中效果', async () => {
    const save = complete();
    const id = randomUUID();
    const batch = generated(save, `ai-${id}`).batch;
    const comic = batch.scenes.find((scene) => scene.type === 'comic')!;
    comic.uses = [...comic.uses ?? [], 'lx:borrow#v.take-temporarily'];
    const chat = batch.scenes.find((scene) => scene.type === 'chat')!;
    chat.effects!.unused = [{ user_fact: { predicate: 'not_selected', object: 'unused' } }];
    let calls = 0;
    const result = await createGenerator(content, client(() => { calls++; return JSON.stringify(batch); }))(save, id, () => {});
    expect(calls).toBe(1);
    expect(result.batch.scenes.find((scene) => scene.type === 'comic')!.uses).not.toContain('lx:borrow#v.take-temporarily');
    expect(result.batch.scenes.find((scene) => scene.type === 'chat')!.effects).not.toHaveProperty('unused');
    expect(content.accept(result, save).library.episodes).toHaveLength(4);
  });

  it('新词先教学练习，两次真实阅读后优先在下一集独立检索并进入 FSRS', async () => {
    let save = complete();
    const before = content.restore(save);
    const item = content.plan(before.session, before.library).brief.introduce[0]!;
    const id = randomUUID();
    const draft = generated(save, `ai-${id}`);
    const first = await createGenerator(content, client(() => JSON.stringify(draft.batch)))(save, id, () => {});
    expect(first.learningVersion).toBe(3);
    save = complete(content.snapshot(save.session, [first]));
    const after = content.restore(save);
    const nextPlan = content.plan(after.session, after.library);
    // 单词卡也是一次真实阅读曝光，计数至少为两次叙述曝光
    expect(nextPlan.exposureCounts.get(item)).toBeGreaterThanOrEqual(2);
    expect(nextPlan.view.srs.hasCard(item, 'meaning')).toBe(false);
    expect(nextPlan.detection).toContainEqual({ item, type: 'recognition-4' });
    expect(content.learningNotes(after.session, after.library).find((note) => note.item === item)?.status).toBe('practice');
    const secondId = randomUUID();
    const secondDraft = generated(save, `ai-${secondId}`);
    const second = await createGenerator(content, client(() => JSON.stringify(secondDraft.batch)))(save, secondId, () => {});
    save = complete(content.snapshot(save.session, [first, second]));
    const finished = content.restore(save);
    expect(content.stateContext(finished.session, finished.library).view.srs.hasCard(item, 'meaning')).toBe(true);
    expect(content.learningNotes(finished.session, finished.library).find((note) => note.item === item)?.status).toBe('scheduled');
    expect(new Set(finished.generated.flatMap((document) => document.batch.scenes.flatMap((scene) =>
      scene.evidence?.type === 'practice' ? [scene.evidence.item] : []))).size).toBe(2);
  });

  it('新词被误标成检索时降为真实练习，不删除互动、不伪造掌握', async () => {
    const save = complete();
    const id = randomUUID();
    const draft = generated(save, `ai-${id}`);
    const teaching = draft.batch.scenes.find((scene) => scene.evidence?.type === 'practice')!;
    const item = teaching.evidence!.item;
    teaching.evidence!.type = 'recognition-4';
    const result = await createGenerator(content, client(() => `\`\`\`json\n${JSON.stringify(draft.batch)}\n\`\`\``))(save, id, () => {});
    expect(result.batch.scenes.find((scene) => scene.id === teaching.id)?.evidence).toEqual({ item, type: 'practice' });
    expect(result.hash).toBe(contentHash(result.batch));
    expect(result.batch.scenes.length).toBeGreaterThanOrEqual(draft.batch.scenes.length);
  });

  it('最终仍不合法时提供明确原因，并且最多三次模型调用', async () => {
    const save = complete();
    const id = randomUUID();
    const batch = generated(save, `ai-${id}`).batch;
    const comic = batch.scenes.find((scene) => scene.type === 'comic')!;
    if (comic.type !== 'comic') throw new Error('fixture');
    comic.panels[0]!.caption = 'extraordinary chandelier bewilderment '.repeat(20);
    let calls = 0;
    await expect(createGenerator(content, client(() => { calls++; return JSON.stringify(batch); }))(save, id, () => {}))
      .rejects.toMatchObject({ failure: { category: 'content', codes: ['E-OOV-HIGH'] }, message: expect.stringContaining('词表外用词过多') });
    expect(calls).toBe(3);
  });

  it('历史 AI 内容继续按旧学习任务验收，不重写已保存的原文', () => {
    const save = complete();
    const document = generated(save, `ai-${randomUUID()}`, new Date(), 1);
    expect(document.learningVersion).toBeUndefined();
    expect(content.accept(document, save).generated[0]).toEqual(document);
    expect(content.restore(content.snapshot(save.session, [document])).library.episodes).toHaveLength(4);
  });

  it('连续六集持续引入不同新单词，真实完成后都能保留在词汇足迹', () => {
    let save = complete();
    const words: string[] = [];
    for (let index = 0; index < 6; index++) {
      const restored = content.restore(save);
      const task = content.plan(restored.session, restored.library);
      const item = task.brief.introduce[0]!;
      words.push(item);
      expect(task.view.exposed.has(item)).toBe(false);
      const document = generated(save, `ai-${randomUUID()}`);
      content.accept(document, save);
      save = complete(content.snapshot(save.session, [...save.generated, document]));
    }
    expect(new Set(words).size).toBe(6);
    const restored = content.restore(JSON.parse(JSON.stringify(save)));
    const notes = content.learningNotes(restored.session, restored.library);
    for (const item of words) expect(notes.some((note) => note.item === item && note.exposures >= 2 && note.attempts >= 1)).toBe(true);
  });

  it('不允许未标 uses 的正文提前透露首次独立检索的答案', () => {
    const save = complete();
    const document = generated(save, `ai-${randomUUID()}`);
    const restored = content.restore(save);
    const task = content.plan(restored.session, restored.library);
    const target = task.detection.find((entry) => entry.type !== 'practice')!;
    const comic = document.batch.scenes.find((scene) => scene.type === 'comic')!;
    if (comic.type !== 'comic') throw new Error('fixture');
    comic.panels[0]!.caption = content.lexicon.forms.get(target.item)![0]!;
    document.hash = contentHash(document.batch);
    expect(() => content.accept(document, save)).toThrow(/已经出现答案/);
  });
});
