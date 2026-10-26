import { describe, expect, it, vi } from 'vitest';
import { createEpisode, createSession, projectSession, transition, type Library } from '@endless/player';
import {
  cloudVerifiedPrefix, legacyEnvelopeGeneratedAt, localVerifiedPrefix, parseWorkspace, planAtFrozenTime,
} from '../src/index.js';
import { cloudTestContent as content } from './cloud-fixture.js';

const item = 'lx:under#prep.location';
const t0 = '2026-10-24T08:00:00.000Z';

function dueLibrary(): Library {
  const scenes = [
    {
      id: 's1', type: 'pick' as const, uses: [item],
      evidence: { item, type: 'recognition-4' as const },
      question: 'The hat is ____ it.',
      options: [
        { label: 'above' }, { label: 'behind' }, { label: 'under', correct: true }, { label: 'next to' },
      ],
      feedback: {
        on_correct: 'Exactly. The hat is under it.',
        on_wrong: 'Look below. The hat is under it.',
      },
    },
    {
      id: 's2', type: 'comic' as const, setting: '@tag:agency_office', uses: [item],
      panels: [{ shot: 'wide' as const, actors: ['@char:cat'], props: [], bubbles: [{ speaker: 'cat', text: 'The hat is under it.' }] }],
    },
    {
      id: 's3', type: 'comic' as const, setting: '@tag:agency_office',
      panels: [{ shot: 'wide' as const, actors: ['@char:cat'], props: [], bubbles: [{ speaker: 'cat', text: 'The cat is here.' }] }],
    },
  ];
  const episode = (id: string) => createEpisode({
    batch: id, channel: 'duck_detective', brief: id, cast: ['cat'], scenes,
  }, content.pilotContext, { title: id, subtitle: 'Due boundary', description: 'A plannedAt fixture.' });
  return {
    version: content.pilot.version,
    episodes: [episode('due-a'), episode('due-b')],
    glossary: content.pilot.glossary,
    entities: content.pilot.entities,
    predicates: content.pilot.predicates,
  };
}

describe('已验证前缀上的计划时间', () => {
  it('跨过复习到期点时仍使用 plannedAt，不改用当时的时钟', () => {
    const library = dueLibrary();
    const correct = 2;
    let session = createSession(library);
    session = transition(session, { type: 'answer', scene: 's1', choice: correct }, library, t0);
    session = transition(session, { type: 'advance', scene: 's1', skip: false }, library, t0);
    session = transition(session, { type: 'advance', scene: 's2', skip: false }, library, t0);
    session = transition(session, { type: 'advance', scene: 's3', skip: false }, library, t0);
    const learning = projectSession(session, library).srs.allCards().find((row) => row.key === `${item}#meaning`);
    expect(learning?.card.state).toBe(1);

    const secondAt = new Date(learning!.card.due.getTime() + 1000).toISOString();
    session = transition(session, { type: 'select', episode: 'due-b' }, library, secondAt);
    session = transition(session, { type: 'answer', scene: 's1', choice: correct }, library, secondAt);
    session = transition(session, { type: 'advance', scene: 's1', skip: false }, library, secondAt);
    session = transition(session, { type: 'advance', scene: 's2', skip: false }, library, secondAt);
    session = transition(session, { type: 'advance', scene: 's3', skip: false }, library, secondAt);
    const review = projectSession(session, library).srs.allCards().find((row) => row.key === `${item}#meaning`);
    expect(review?.card.state).toBe(2);

    const beforeDue = new Date(review!.card.due.getTime() - 1000).toISOString();
    const afterDue = new Date(review!.card.due.getTime() + 86_400_000).toISOString();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
      const frozen = planAtFrozenTime(content, localVerifiedPrefix(session, library, beforeDue));
      const direct = content.planCreative(session, library, new Date(beforeDue));
      const later = content.planCreative(session, library, new Date(afterDue));
      expect(later.exposureCounts.get(item)).toBeGreaterThanOrEqual(2);
      expect(frozen.brief.review).toEqual(direct.brief.review);
      expect(frozen.detection).toEqual(direct.detection);
      expect(frozen.brief.review.map((entry) => entry.item)).not.toContain(item);
      expect(later.brief.review.map((entry) => entry.item)).toContain(item);
      expect(legacyEnvelopeGeneratedAt(beforeDue)).toBe(beforeDue);

      const cloud = cloudVerifiedPrefix({
        events: session.events, catalog: session.catalog, current: session.current,
        library, plannedAt: beforeDue, completePrefix: true,
      });
      expect(cloud).toMatchObject({ source: 'cloud-history', plannedAt: beforeDue, completePrefix: true });
      expect(planAtFrozenTime(content, cloud).brief.review).toEqual(frozen.brief.review);
      expect(() => cloudVerifiedPrefix({
        events: session.events, catalog: session.catalog, current: session.current,
        library, plannedAt: beforeDue, completePrefix: false,
      })).toThrow(/截断/);
      expect(() => cloudVerifiedPrefix({
        events: session.events, catalog: 'other-catalog', current: session.current,
        library, plannedAt: beforeDue, completePrefix: true,
      })).toThrow(/目录/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('云工作区信封不能被解析成旧工作区', () => {
    expect(() => parseWorkspace({
      contract: 'endless-cloud-workspace/1',
      workspaceId: '00000000-0000-4000-8000-000000000001',
      catalogVersion: 'pilot-v1',
      history: { streamId: 'brn_00000000-0000-4000-8000-000000000002', eventCount: 0, eventHash: '0'.repeat(16), headSegmentId: null },
      adoption: { headManifestId: null, entryCount: 0 },
    })).toThrow(/endless-workspace/);
  });
});
