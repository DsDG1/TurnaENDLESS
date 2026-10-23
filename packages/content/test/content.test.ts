import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentHash } from '@endless/esl';
import { createSession, getOptions, getScenes, projectSession, transition } from '@endless/player';
import { createContent, GeneratedEpisodeSchema, type GeneratedEpisode } from '../src/index.js';

const text = readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
const content = createContent(text);
const at = '2026-10-23T08:00:00.000Z';

function completedPilot() {
  let session = createSession(content.pilot);
  for (const episode of content.pilot.episodes) {
    session = transition(session, { type: 'select', episode: episode.id }, content.pilot, at);
    for (const scene of getScenes(episode)) {
      session = transition(session, { type: 'advance', scene: scene.id, skip: true }, content.pilot, at);
    }
  }
  return session;
}

function document(session = completedPilot()): GeneratedEpisode {
  const batch = {
    batch: 'ai-test', channel: 'duck_detective', brief: 'lb-0004', cast: ['duck', 'cat'],
    scenes: [
      { id: 's1', type: 'comic', setting: '@tag:agency_office', uses: [],
        panels: [{ shot: 'wide', actors: ['@char:duck'], props: [], bubbles: [{ speaker: 'duck', text: 'The cat is here.' }] }] },
      { id: 's2', type: 'chat', skin: 'messenger', uses: [], messages: [{ from: 'cat', text: 'Can you help me?' }],
        reply: { options: [{ label: 'Yes.', correct: true, effect: 'help' }, { label: 'No.' }],
          on_correct: { from: 'cat', text: 'Thank you.' }, on_wrong: { from: 'cat', text: 'Oh.' } },
        effects: { help: [{ user_fact: { predicate: 'helped', object: 'cat' } }] } },
      { id: 's3', type: 'pick', uses: [], question: 'Where is the cat?',
        options: [{ label: 'Here.', correct: true }, { label: 'There.' }],
        feedback: { on_correct: 'Yes.', on_wrong: 'No.' } },
    ],
  };
  return GeneratedEpisodeSchema.parse({
    version: 1, generatedAt: at, basedOn: content.historyKey(session),
    title: '新的线索', subtitle: 'A new clue', description: '鸭侦探遇见了一个新谜题。',
    batch, hash: contentHash(batch),
  });
}

describe('动态内容与存档边界', () => {
  it('旧试播存档不需要改写即可恢复', () => {
    const session = completedPilot();
    const restored = content.restore(session);
    expect(restored.session).toEqual(session);
    expect(restored.generated).toEqual([]);
    expect(restored.library.version).toBe('pilot-v1');
  });

  it('未看完内容前不生成，规划读取实际学习和剧情状态', () => {
    expect(() => content.plan(createSession(content.pilot), content.pilot, new Date(at))).toThrow(/看完/);
    const plan = content.plan(completedPilot(), content.pilot, new Date(at));
    expect(plan.brief.introduce.length).toBeGreaterThan(0);
    expect(plan.view.completed).toBe(0);
    expect(plan.view.skipped).toBe(9);
  });

  it('动态原文与进度一起恢复，内容被修改时拒绝恢复', () => {
    const session = completedPilot();
    const generated = document(session);
    const snapshot = content.snapshot(session, [generated]);
    const restored = content.restore(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.library.episodes).toHaveLength(4);
    expect(restored.generated[0]).toEqual(generated);
    const changed = structuredClone(snapshot);
    changed.generated[0]!.batch.scenes[0]!.uses = ['lx:under#prep.location'];
    expect(() => content.restore(changed)).toThrow(/哈希/);
  });

  it('拒绝重复 ID、错误历史绑定和不支持的场景，不丢弃场景', () => {
    const session = completedPilot();
    const generated = document(session);
    expect(() => content.restore(content.snapshot(session, [generated, generated]))).toThrow();
    const wrong = { ...generated, basedOn: { ...generated.basedOn, hash: '0000000000000000' } };
    expect(() => content.restore(content.snapshot(session, [wrong]))).toThrow(/历史/);
    const unsupported = structuredClone(generated);
    unsupported.batch.scenes[0] = { id: 's1', type: 'story', ink: 'Hello. -> END', uses: [] };
    unsupported.hash = contentHash(unsupported.batch);
    expect(() => content.restore(content.snapshot(session, [unsupported]))).toThrow(/支持/);
  });

  it('生成后答题可重复重放，不重复应用剧情效果', () => {
    let session = completedPilot();
    const generated = document(session);
    const library = content.restore(content.snapshot(session, [generated])).library;
    session = transition(session, { type: 'select', episode: generated.batch.batch }, library, at);
    for (const scene of getScenes(library.episodes.at(-1)!)) {
      const options = getOptions(scene);
      if (options.length) session = transition(session, { type: 'answer', scene: scene.id, choice: 0 }, library, at);
      session = transition(session, { type: 'advance', scene: scene.id, skip: false }, library, at);
    }
    const restored = content.restore(content.snapshot(session, [generated]));
    expect(projectSession(restored.session, restored.library).world.userFacts()).toHaveLength(1);
    expect(restored.session.events).toEqual(session.events);
  });
});
