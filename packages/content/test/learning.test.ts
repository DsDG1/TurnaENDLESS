import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSession, getOptions, getScenes, transition, type PlayerSession } from '@endless/player';
import { createContent } from '../src/index.js';

const content = createContent(readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8'));

function completePilot() {
  let session = createSession(content.pilot);
  for (const episode of content.pilot.episodes) {
    session = transition(session, { type: 'select', episode: episode.id }, content.pilot);
    for (const scene of getScenes(episode)) {
      const options = getOptions(scene);
      if (options.length) session = transition(session, { type: 'answer', scene: scene.id, choice: options.findIndex((option) => option.correct) }, content.pilot);
      session = transition(session, { type: 'advance', scene: scene.id, skip: false }, content.pilot);
    }
  }
  return session;
}

describe('应用新词闭环', () => {
  it('每集为尚未接触的新单词安排教学练习，而非只反复测试旧词', () => {
    const session = completePilot();
    const plan = content.plan(session, content.pilot);
    const item = plan.brief.introduce[0]!;
    expect(item.startsWith('lx:')).toBe(true);
    expect(plan.view.exposed.has(item)).toBe(false);
    expect(plan.practice).toContainEqual({ item, type: 'practice' });
  });

  it('纯阅读遇到的词进入词汇足迹，不要求答题，也不冒充 FSRS 记录', () => {
    let session: PlayerSession = createSession(content.pilot);
    session = transition(session, { type: 'advance', scene: 's1', skip: false }, content.pilot);
    const notes = content.learningNotes(session, content.pilot);
    const behind = notes.find((note) => note.item === 'lx:behind#prep.location');
    expect(behind).toMatchObject({ exposures: 1, attempts: 0, status: 'exposed' });
    expect(content.stateContext(session, content.pilot).view.srs.size()).toBe(0);
    expect(content.learningNotes(createSession(content.pilot), content.pilot)).toEqual([]);
  });
});
