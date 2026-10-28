import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type LlmClient, type LlmRequest, type LlmResponse } from '@endless/director';
import { MeteredLlmClient, createGenerator } from '../src/generate.js';
import { creativeSystem } from '../src/creative-prompts.js';
import { complete, content } from './fixtures.js';
import { draftFor } from './creative-draft.js';

function client(respond: (request: LlmRequest, index: number) => string | Error, tokens = 100): { llm: LlmClient; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    llm: {
      modelId: async () => 'test-model',
      complete: async (request): Promise<LlmResponse> => {
        calls.push(request);
        const out = respond(request, calls.length - 1);
        if (out instanceof Error) throw out;
        return { text: out, usage: { inputTokens: tokens, outputTokens: tokens }, cacheHit: false, latencyMs: 1, requestHash: 'test-hash' };
      },
    },
  };
}

describe('v4 创作草稿生成器', () => {
  it('草稿文本直接编译为可播放批次：ID/素材引用/学习证据由程序生成', async () => {
    const save = complete();
    const id = randomUUID();
    const { llm, calls } = client(() => draftFor(save));
    const result = await createGenerator(content, llm)(save, id, () => {});
    expect(result.learningVersion).toBe(4);
    expect(result.creation?.protocol).toBe('endless-draft-v1');
    expect(result.batch.batch).toBe(`ai-${id}`);
    expect(result.batch.scenes.every((s) => /^s\d+$/.test(s.id))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toBe(creativeSystem);
    expect(calls[0]!.prompt).toContain('t1');
    expect(calls[0]!.prompt).toContain('duck_detective');
    const accepted = content.accept(result, save);
    expect(accepted.library.episodes.at(-1)!.id).toBe(`ai-${id}`);
  });

  it('续写上下文包含真实读完的正文与实际选择记录，按系列分组', async () => {
    const save = complete();
    const { llm, calls } = client(() => draftFor(save));
    await createGenerator(content, llm)(save, randomUUID(), () => {});
    const history = JSON.parse(calls[0]!.prompt.match(/\[实际完成的内容、用户选择、按系列分组的历史\]\n(.+?)\n\[/)![1]!);
    const duck = history.duck_detective;
    expect(duck).toBeTruthy();
    // 真实完成内容：试播集里有已读正文与状态
    const scenes = duck.episodes.flatMap((e: { scenes: unknown[] }) => e.scenes) as { status: string; text: string }[];
    expect(scenes.some((s) => s.status === 'read' && s.text.length > 0)).toBe(true);
    // 用户实际选择被记录（试播中有剧情回复选择）
    const answers = scenes.filter((s) => 'answer' in s) as { status: string; answer: { chosen: string } }[];
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every((a) => typeof a.answer.chosen === 'string')).toBe(true);
    // 未读场景不泄露正文
    expect(scenes.filter((s) => s.status === 'unread').every((s) => s.text === '')).toBe(true);
    // 其他系列不出现在侦探历史里
    expect(Object.keys(history).every((k) => k === 'duck_detective')).toBe(true);
  });

  it('不接受可执行 JSON：JSON 输出进入整稿修复，修复提示携带完整原稿与问题清单', async () => {
    const save = complete();
    const id = randomUUID();
    const draft = draftFor(save);
    const { llm, calls } = client((request, index) => {
      if (index === 0) return JSON.stringify({ batch: { scenes: [] } });
      expect(request.prompt).toContain(JSON.stringify({ batch: { scenes: [] } }));
      expect(request.prompt).toContain('ENDLESS-DRAFT/1');
      return draft;
    });
    const result = await createGenerator(content, llm)(save, id, () => {});
    expect(result.learningVersion).toBe(4);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.stage).toBe('repair');
  });

  it('连续相同失败即停；传输错误不自动重试；预算内的 token 用量不打断', async () => {
    const save = complete();
    const { llm: bad, calls } = client(() => 'not a draft at all');
    await expect(createGenerator(content, bad)(save, randomUUID(), () => {})).rejects.toThrow(/未通过校验/);
    // 首次失败 + 相同失败签名 → 第二次调用后即停
    expect(calls).toHaveLength(2);
    const { llm: failing } = client(() => new Error('connection reset'));
    await expect(createGenerator(content, failing)(save, randomUUID(), () => {})).rejects.toThrow('connection reset');
    // 单次 50k×2 = 100k，仍在 120k 预算内：内容有效即接受
    const { llm: greedy, calls: greedyCalls } = client(() => draftFor(save), 50_000);
    const result = await createGenerator(content, greedy)(save, randomUUID(), () => {});
    expect(result.learningVersion).toBe(4);
    expect(greedyCalls).toHaveLength(1);
    expect(result.usage?.calls).toBe(1);
  });

  it('MeteredLlmClient 只计量不限额；不同失败签名可继续修复', async () => {
    const metered = new MeteredLlmClient(client(() => 'x', 45_000).llm, () => {});
    const request: LlmRequest = { stage: 'single', system: 's', prompt: 'p', modelTier: 'fast', maxTokens: 100 };
    await metered.complete(request);
    await metered.complete(request);
    expect(metered.usage().calls).toBe(2);
    const save = complete();
    const draft = draftFor(save);
    const { llm, calls } = client((request, index) => {
      // 两次失败签名不同（解析失败 vs 缺元数据），循环继续；第三次产出合法草稿
      if (index === 0) return 'garbage one';
      if (index === 1) return 'ENDLESS-DRAFT/1\n@kind story\n@series duck_detective';
      return draft;
    });
    const result = await createGenerator(content, llm)(save, randomUUID(), () => {});
    expect(result.learningVersion).toBe(4);
    expect(calls).toHaveLength(3);
  });

  it('归一化失败签名：只有场景数不同的同类错误第二次就停', async () => {
    const save = complete();
    const neutral = '@post duck\ntext: Good.\n@end';
    const draft = (count: number) => [
      'ENDLESS-DRAFT/1', '@kind story', '@series duck_detective',
      '@title 少了场景', '@subtitle Short', '@description 场景数不足的草稿。',
      ...Array.from({ length: count }, () => neutral),
    ].join('\n');
    const { llm, calls } = client((request, index) => (index === 0 ? draft(8) : draft(9)));
    await expect(createGenerator(content, llm)(save, randomUUID(), () => {})).rejects.toThrow(/未通过校验/);
    // 8 场与 9 场折叠成同一签名，不做第二次「新问题」重复付费
    expect(calls).toHaveLength(2);
  });

  it('不同失败签名交替也最多自动修复 6 次', async () => {
    const save = complete();
    const { llm, calls } = client((request, index) => (index % 2 === 0
      ? 'garbage one'
      : 'ENDLESS-DRAFT/1\n@kind story\n@series duck_detective'));
    await expect(createGenerator(content, llm)(save, randomUUID(), () => {}))
      .rejects.toMatchObject({ status: 422, failure: { codes: expect.arrayContaining(['E-DRAFT-ATTEMPTS']) } });
    expect(calls).toHaveLength(6);
  });

  it('token 预算超限时立即停止自动修复', async () => {
    const save = complete();
    // 每次调用 50k 输入 + 50k 输出：第二次失败后累计 200k，超过 120k 预算
    const { llm, calls } = client((request, index) => (index % 2 === 0
      ? 'garbage one'
      : 'ENDLESS-DRAFT/1\n@kind story\n@series duck_detective'), 50_000);
    await expect(createGenerator(content, llm)(save, randomUUID(), () => {}))
      .rejects.toThrow(/token 预算/);
    expect(calls).toHaveLength(2);
  });
});
