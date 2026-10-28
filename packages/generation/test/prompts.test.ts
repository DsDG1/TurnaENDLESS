import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCreativePrompt, creativeSystem, type CreativePromptInput } from '../src/index.js';

/**
 * 提示词字节 golden（I-05 退出证据）。
 *
 * 端口拆分、条目移动或重构都不得改变提示词字节；这些摘要与拆分前的
 * `apps/api/src/creative-prompts.ts` 完全一致。要修改提示词必须是一次明确的创作政策变更，
 * 同时更新这里的摘要，并在计划/基线文档里记录理由——不能顺手改掉。
 */
const SYSTEM_SHA256 = 'e726ab21be4083c945435f992661a9a1721a8b9094a17a5fd30240009d567b62';
const PROMPT_SHA256 = 'ea85c57c05eb27859e1c7219f989d0622079b9722c48ed1ffcaa2872909537fb';
const REPAIR_SHA256 = '086549dd882f629b7300357de931c0ecbf6c0511cbaa2f34b810ad9ae305894a';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const sample: CreativePromptInput = {
  catalog: '{"kinds":["story"]}',
  learning: '[{"item":"anchor"}]',
  allowedWords: 'anchor,drift',
  history: '{"duck_detective":{"canon":[],"openThreads":[],"episodes":[]}}',
  recent: '[]',
  feedback: '{"answers":[],"completed":0,"skipped":0}',
};

describe('创作提示词字节稳定性', () => {
  it('系统提示词与首轮/修复轮提示词的字节都不变', () => {
    expect(sha256(creativeSystem)).toBe(SYSTEM_SHA256);
    expect(sha256(buildCreativePrompt(sample))).toBe(PROMPT_SHA256);
    expect(sha256(buildCreativePrompt({ ...sample, previousDraft: 'ENDLESS-DRAFT/1\n@kind story', problems: 'E-DRAFT 场景数量' }))).toBe(REPAIR_SHA256);
  });

  it('修复轮只增加原稿与问题清单，不重排首轮输入', () => {
    const first = buildCreativePrompt(sample);
    const repair = buildCreativePrompt({ ...sample, previousDraft: 'DRAFT', problems: 'PROBLEMS' });
    expect(repair.length).toBeGreaterThan(first.length);
    expect(repair).toContain('DRAFT');
    expect(repair).toContain('PROBLEMS');
  });
});
