import { describe, expect, it } from 'vitest';
import { type LlmClient, type LlmRequest, type LlmResponse } from '@endless/director';
import { GenerationFailureError, runCreativeGeneration } from '@endless/generation';
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

const PLAN_AT = '2026-10-27T09:30:00.000Z';

describe('生成执行端口（I-05）', () => {
  it('计划时间由调用方冻结：排队后执行不改成 now()，两次同参数产出同一文档', async () => {
    const save = complete();
    const first = await runCreativeGeneration(
      { content, llm: client(() => draftFor(save)).llm },
      { save, plannedAt: PLAN_AT, batchId: 'ai-frozen-1' },
      { phase: () => {} },
    );
    const second = await runCreativeGeneration(
      { content, llm: client(() => draftFor(save)).llm },
      { save, plannedAt: PLAN_AT, batchId: 'ai-frozen-1' },
      { phase: () => {} },
    );
    expect(first.episode.generatedAt).toBe(PLAN_AT);
    expect(first.episode.batch.batch).toBe('ai-frozen-1');
    expect(second.episode).toEqual(first.episode);
  });

  it('传输失败原样抛出且不自动重试，不产生成功文档', async () => {
    const { llm, calls } = client(() => new Error('connection reset'));
    await expect(runCreativeGeneration(
      { content, llm },
      { save: complete(), plannedAt: PLAN_AT, batchId: 'ai-transport' },
      { phase: () => {} },
    )).rejects.toThrow('connection reset');
    expect(calls).toHaveLength(1);
  });

  it('验收失败是端口级失败分类，不带 HTTP 状态，也不回显草稿正文', async () => {
    const save = complete();
    const { llm } = client(() => 'ENDLESS-DRAFT/1\n@kind story\n@series duck_detective');
    const error = await runCreativeGeneration(
      { content, llm },
      { save, plannedAt: PLAN_AT, batchId: 'ai-invalid' },
      { phase: () => {} },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenerationFailureError);
    const failure = error as GenerationFailureError;
    expect(failure.failure.category).toBe('content');
    expect(failure.failure.codes.length).toBeGreaterThan(0);
    expect(failure.message).toMatch(/未通过校验/);
    expect(failure).not.toHaveProperty('status');
    expect(failure.message).not.toContain('ENDLESS-DRAFT/1');
    expect(failure.message).not.toContain('@series');
  });

  it('每轮外部调用后给出 attempt 记录，成功轮 ok=true 且 token 按轮切分', async () => {
    const save = complete();
    const seen: { ordinal: number; ok: boolean; inputTokens: number }[] = [];
    const outcome = await runCreativeGeneration(
      { content, llm: client(() => draftFor(save), 100).llm },
      { save, plannedAt: PLAN_AT, batchId: 'ai-attempts' },
      { phase: () => {}, onAttempt: (record) => seen.push(record) },
    );
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]).toMatchObject({ ordinal: 1, stage: 'single', ok: true, inputTokens: 100, outputTokens: 100, issueCodes: [] });
    expect(seen).toEqual(outcome.attempts);
    expect(outcome.usage).toEqual({ calls: 1, inputTokens: 100, outputTokens: 100 });
  });

  it('尝试上限由调用方给定，用尽后按该上限报告', async () => {
    const save = complete();
    const { llm, calls } = client((request, index) => (index % 2 === 0
      ? 'garbage one'
      : 'ENDLESS-DRAFT/1\n@kind story\n@series duck_detective'));
    const error = await runCreativeGeneration(
      { content, llm },
      { save, plannedAt: PLAN_AT, batchId: 'ai-limit', limits: { maxAttempts: 2 } },
      { phase: () => {} },
    ).catch((caught: unknown) => caught);
    expect(calls).toHaveLength(2);
    expect((error as GenerationFailureError).failure.codes).toContain('E-DRAFT-ATTEMPTS');
    // 用户可见文案只由固定标签拼成（不含条数正文），与拆分前一致
    expect((error as GenerationFailureError).message).toContain('自动修复次数已达到上限');
  });
});
