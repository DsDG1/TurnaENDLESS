/**
 * reducer（第 5.5.3 节写入纪律）：只有 reducer 能写世界状态，且只接受 ESL 里声明的 effects。
 * - 单值谓词写入新值时自动结束旧值（失效而不删除，双时态）
 * - canon 事实不能被结束或覆盖
 * - 事件自动记录，不需要在 ESL 里声明
 * - 挂在选项上的 effect 由调用方（交互模拟器）只把「被选中的」具名 effect 传进来
 */
import type { Effect } from '@endless/esl';
import type { EventRow, FactRow, ThreadRow } from './schema.js';
import type { WorldStore } from './store.js';

export interface PredicateSpec {
  cardinality: 'single' | 'multi';
}

export interface ReduceContext {
  /** 世界时钟：累计卡片序号 */
  card: number;
  batch: string;
  scene?: string;
  channel: string;
  predicates: Map<string, PredicateSpec>;
  /** 不可变事实，格式 "subject predicate object"（来自频道圣经 canon_locked 与既有 canon 事实） */
  canonLocked: string[];
  /** 本批用户实际选中的选项标签（记录进事件表 user_choice 列） */
  userChoice?: string;
}

export interface ReduceViolation {
  effect: Effect;
  reason: string;
}

export interface ReduceResult {
  applied: Effect[];
  violations: ReduceViolation[];
  changes: {
    factsEnded: number[];
    factsOpened: FactRow[];
    threadsTouched: string[];
    userFacts: number;
  };
  events: EventRow[];
}

const canonKey = (s: string, p: string, o: string) => `${s} ${p} ${o}`;

export function applyEffects(store: WorldStore, effects: Effect[], ctx: ReduceContext): ReduceResult {
  const result: ReduceResult = {
    applied: [],
    violations: [],
    changes: { factsEnded: [], factsOpened: [], threadsTouched: [], userFacts: 0 },
    events: [],
  };
  const record = (type: string, actors: string[], summary: string, tags?: string[]) => {
    result.events.push(
      store.insertEvent({
        card: ctx.card,
        batch: ctx.batch,
        channel: ctx.channel,
        type,
        actors,
        summary_en: summary,
        user_choice: ctx.userChoice ?? null,
        tags: tags ?? null,
      }),
    );
  };

  for (const op of effects) {
    if ('set_fact' in op) {
      const { subject, predicate, object, standing } = op.set_fact;
      if (!ctx.predicates.has(predicate)) {
        result.violations.push({ effect: op, reason: `谓词 ${predicate} 未声明` });
        continue;
      }
      const active = store.currentFacts([subject]).filter((f) => f.predicate === predicate);
      // canon 拒写：① 已有 standing=canon 的活动事实且值不同；② canon_locked 里声明的事实
      // （subject predicate object）当前成立，而新值要改写同一谓词
      const lockedConflict = ctx.canonLocked.some((key) => {
        const [ls, lp, lo] = key.split(' ');
        return (
          ls === subject && lp === predicate && lo !== undefined && lo !== object && active.some((f) => f.object === lo)
        );
      });
      const isCanonLocked = active.some((f) => f.standing === 'canon' && f.object !== object) || lockedConflict;
      if (isCanonLocked) {
        result.violations.push({ effect: op, reason: `canon 事实 ${subject} ${predicate} 不可改写` });
        continue;
      }
      // 幂等：同值活动事实已存在则跳过
      if (active.some((f) => f.object === object && f.standing === standing)) continue;
      // 单值谓词：自动结束旧值
      if (ctx.predicates.get(predicate)?.cardinality === 'single') {
        for (const old of active) {
          store.endFact(old.id, ctx.card);
          result.changes.factsEnded.push(old.id);
        }
      }
      const fact = store.insertFact({
        subject,
        predicate,
        object,
        valid_from_card: ctx.card,
        valid_to_card: null,
        recorded_card: ctx.card,
        source_batch: ctx.batch,
        source_scene: ctx.scene ?? null,
        standing,
      });
      result.changes.factsOpened.push(fact);
      result.applied.push(op);
      record('set_fact', [subject], `${subject} ${predicate} ${object}`);
    } else if ('end_fact' in op) {
      const { subject, predicate, object } = op.end_fact;
      const matching = store
        .currentFacts([subject])
        .filter((f) => f.predicate === predicate && (object === undefined || f.object === object));
      if (matching.length === 0) {
        result.violations.push({ effect: op, reason: `${subject} ${predicate} 没有可结束的活动事实` });
        continue;
      }
      const canonHit = matching.some(
        (f) => f.standing === 'canon' || ctx.canonLocked.includes(canonKey(f.subject, f.predicate, f.object)),
      );
      if (canonHit) {
        result.violations.push({ effect: op, reason: `canon 事实 ${subject} ${predicate} 不可结束` });
        continue;
      }
      for (const f of matching) {
        store.endFact(f.id, ctx.card);
        result.changes.factsEnded.push(f.id);
      }
      result.applied.push(op);
      record('end_fact', [subject], `${subject} ${predicate} ended`);
    } else if ('open_thread' in op) {
      const t = op.open_thread;
      const existing = store.getThread(t.id);
      if (existing && existing.status === 'open') {
        result.violations.push({ effect: op, reason: `伏笔 ${t.id} 已处于 open 状态` });
        continue;
      }
      const row: ThreadRow = {
        id: t.id,
        title: t.title,
        status: 'open',
        owner_channel: ctx.channel,
        opened_card: ctx.card,
        last_touched_card: ctx.card,
        priority: t.priority,
        setup: t.title,
        payoff_hint: t.payoff_hint ?? null,
        expires_after_cards: t.expires_after_cards ?? null,
      };
      store.upsertThread(row);
      result.changes.threadsTouched.push(t.id);
      result.applied.push(op);
      record('open_thread', [], `Thread opened: ${t.title}`);
    } else if ('advance_thread' in op) {
      const t = store.getThread(op.advance_thread.id);
      if (!t || t.status !== 'open') {
        result.violations.push({ effect: op, reason: `伏笔 ${op.advance_thread.id} 不存在或不在 open 状态` });
        continue;
      }
      t.status = 'advanced';
      t.last_touched_card = ctx.card;
      store.upsertThread(t);
      result.changes.threadsTouched.push(t.id);
      result.applied.push(op);
      record('advance_thread', [], `Thread advanced: ${t.title}`);
    } else if ('resolve_thread' in op) {
      const t = store.getThread(op.resolve_thread.id);
      if (!t || (t.status !== 'open' && t.status !== 'advanced')) {
        result.violations.push({ effect: op, reason: `伏笔 ${op.resolve_thread.id} 不存在或已结束` });
        continue;
      }
      t.status = 'resolved';
      t.last_touched_card = ctx.card;
      store.upsertThread(t);
      result.changes.threadsTouched.push(t.id);
      result.applied.push(op);
      record('resolve_thread', [], `Thread resolved: ${t.title}`);
    } else if ('user_fact' in op) {
      store.insertUserFact({
        predicate: op.user_fact.predicate,
        object: op.user_fact.object,
        card: ctx.card,
        batch: ctx.batch,
      });
      result.changes.userFacts++;
      result.applied.push(op);
      record('user_fact', [op.user_fact.object], `User ${op.user_fact.predicate} ${op.user_fact.object}`);
    }
  }
  return result;
}
