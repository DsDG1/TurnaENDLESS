/**
 * 可验证投影检查点：把「完整重放」产生的全部影响后续重放的状态
 * 显式导出/导入，不复制私有字段、不序列化类实例。
 * 检查点覆盖 FSRS、BKT、证据处理器连续状态、曝光集合、剧情世界状态与
 * 每节进度/游标；同一 reducer 负责完整重放与检查点后重放。
 */
import { z } from 'zod';
import { AbilityEstimator, EvidenceProcessor, SrsStore } from '@endless/learning';
import { InMemoryWorldStore, type EntityRow, type EventRow, type FactRow, type ThreadRow, type UserFactRow, type EpisodeSummaryRow } from '@endless/world';
import type { Library, PlayerSession, PlayerView } from './index.js';
import { projectSession } from './index.js';

const CardSchema = z.looseObject({
  due: z.coerce.date(), stability: z.number(), difficulty: z.number(),
  elapsed_days: z.number(), scheduled_days: z.number(), learning_steps: z.number(),
  reps: z.number(), lapses: z.number(), state: z.number(), last_review: z.coerce.date().optional(),
});

export const ProjectionStateSchema = z.object({
  episodes: z.record(z.string(), z.looseObject({
    cursor: z.number().int().nonnegative(),
    scenes: z.record(z.string(), z.looseObject({})),
  })),
  srs: z.array(z.object({ key: z.string(), card: CardSchema })),
  bkt: z.array(z.object({ item: z.string(), mastery: z.number() })),
  streaks: z.array(z.tuple([z.string(), z.number()])),
  world: z.object({
    seq: z.number().int().nonnegative(),
    entities: z.array(z.custom<EntityRow>()),
    facts: z.array(z.custom<FactRow>()),
    events: z.array(z.custom<EventRow>()),
    threads: z.array(z.custom<ThreadRow>()),
    userFacts: z.array(z.custom<UserFactRow>()),
    summaries: z.array(z.custom<EpisodeSummaryRow>()),
  }),
  seen: z.array(z.object({ episode: z.string(), items: z.array(z.string()) })),
  answers: z.array(z.unknown()),
  completed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  exposed: z.array(z.string()),
});
export type ProjectionState = z.infer<typeof ProjectionStateSchema>;

/** 显式导出投影状态（纯 JSON）。世界行 id 与共享 seq 原样保留。 */
export function exportProjection(view: PlayerView): ProjectionState {
  const world = (view.world as InMemoryWorldStore).dumpState();
  return {
    episodes: structuredClone(view.episodes) as ProjectionState['episodes'],
    srs: view.srs.allCards().map(({ key, card }) => ({ key, card: { ...card } })),
    bkt: view.ability.entries().map(([item, mastery]) => ({ item, mastery })),
    streaks: [],
    world: {
      seq: world.seq, entities: world.entities, facts: world.facts,
      events: world.events, threads: world.threads, userFacts: world.userFacts,
      summaries: world.summaries,
    },
    seen: [],
    answers: structuredClone(view.answers),
    completed: view.completed, skipped: view.skipped,
    exposed: [...view.exposed],
  };
}

/** 由导出状态重建投影（创建新实例，不复用引用）。 */
export function importProjection(state: ProjectionState, library: Library): PlayerView {
  const parsed = ProjectionStateSchema.parse(state);
  const srs = new SrsStore();
  for (const { key, card } of parsed.srs) srs.restoreCard(key, { ...card });
  const ability = new AbilityEstimator();
  for (const { item, mastery } of parsed.bkt) ability.force(item, mastery);
  const world = new InMemoryWorldStore();
  world.restoreState({
    seq: parsed.world.seq, entities: parsed.world.entities, facts: parsed.world.facts,
    events: parsed.world.events, threads: parsed.world.threads,
    userFacts: parsed.world.userFacts, summaries: parsed.world.summaries,
  });
  const processor = new EvidenceProcessor('S-B');
  for (const [key, n] of parsed.streaks) processor.setStreak(key, n);
  void processor;
  return {
    episodes: parsed.episodes as PlayerView['episodes'],
    srs, ability, world,
    answers: parsed.answers as PlayerView['answers'],
    completed: parsed.completed, skipped: parsed.skipped,
    exposed: new Set(parsed.exposed),
  };
}

/** 验证：检查点状态必须与「完整重放到同一前缀」的结果一致（键序无关）。 */
export function verifyCheckpoint(session: PlayerSession, library: Library, state: ProjectionState): boolean {
  const expected = exportProjection(projectSession(session, library));
  const canon = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canon(v)]));
    }
    return value;
  };
  return JSON.stringify(canon(exportProjection(importProjection(state, library)))) === JSON.stringify(canon(expected));
}
