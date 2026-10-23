import { describe, expect, it } from 'vitest';
import { createSession, getScenes, projectSession, transition } from '@endless/player';
import { library } from '../src/content/catalog.js';

describe('离线试播内容', () => {
  it('三个完整批次都经已有 ESL 校验与编译，只含已支持的场景', () => {
    expect(library.episodes).toHaveLength(3);
    for (const episode of library.episodes) {
      expect(episode.ast.hash).toBeTruthy();
      expect(getScenes(episode).map((s) => s.type).sort()).toEqual(['chat', 'comic', 'pick']);
    }
  });

  it('能完整播放九个场景，真实结算学习和剧情，并识别同批练习', () => {
    let session = createSession(library);
    const now = '2026-10-23T08:00:00.000Z';
    for (const episode of library.episodes) {
      session = transition(session, { type: 'select', episode: episode.id }, library, now);
      for (const scene of getScenes(episode)) {
        const options = scene.type === 'pick' ? scene.options : scene.type === 'chat' ? scene.reply?.options : undefined;
        if (options) session = transition(session, {
          type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct),
        }, library, now);
        session = transition(session, { type: 'advance', scene: scene.id, skip: false }, library, now);
      }
    }
    const view = projectSession(session, library);
    expect(view.completed).toBe(9);
    expect(view.answers).toHaveLength(6);
    expect(view.world.userFacts()).toHaveLength(3);
    expect(view.world.currentFacts().some((fact) => fact.predicate === 'owns')).toBe(true);
    expect(view.world.currentFacts().find((fact) => fact.predicate === 'case_status')?.object).toBe('closed');
    expect(view.answers.at(-1)?.evidence).toBe('practice');
    expect(view.srs.size()).toBeGreaterThan(0);
  });
});
