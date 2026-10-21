/**
 * 检索与故事筛选（第 5.5.4 节）。
 * 检索打分公式为初始值：开放伏笔 = 优先级 × (1 + min(陈旧度, 1)) × 频道匹配系数 1.2；
 * 相关历史事件 = 新近度衰减 + 重要度（按事件类型）+ 相关度（关键词重合），仿 Generative Agents。
 */
import type { FactRow, ThreadRow } from './schema.js';
import type { WorldStore } from './store.js';

/** 出场角色的当前事实。 */
export function currentFactsFor(store: WorldStore, subjects: string[]): FactRow[] {
  return store.currentFacts(subjects);
}

/** 出场角色的「曾经是」：最近 2 条已结束的单值事实，供台词用过去时提及。 */
export function pastFactsFor(store: WorldStore, subject: string, limit = 2): FactRow[] {
  return store.endedFacts(subject, limit);
}

/** 开放伏笔打分取前 N。 */
export function topThreads(store: WorldStore, card: number, channel?: string, n = 3): { thread: ThreadRow; score: number }[] {
  return store
    .openThreads()
    .map((thread) => {
      const window = thread.expires_after_cards ?? 200;
      const staleness = (card - thread.last_touched_card) / window;
      const channelBonus = channel && thread.owner_channel === channel ? 1.2 : 1;
      return { thread, score: thread.priority * (1 + Math.min(staleness, 1)) * channelBonus };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

const EVENT_IMPORTANCE: Record<string, number> = {
  set_fact: 0.3,
  end_fact: 0.3,
  open_thread: 0.8,
  advance_thread: 0.6,
  resolve_thread: 0.7,
  user_fact: 0.6,
  accusation: 0.9,
};

/** 相关历史事件：新近度 + 重要度 + 相关度。 */
export function relevantEvents(
  store: WorldStore,
  opts: { card: number; actors: string[]; keywords: string[]; limit?: number },
): { event: ReturnType<WorldStore['allEvents']>[number]; score: number }[] {
  const limit = opts.limit ?? 5;
  const kw = new Set(opts.keywords.map((k) => k.toLowerCase()));
  return store
    .allEvents()
    .map((event) => {
      const recency = Math.exp(-(opts.card - event.card) / 200);
      const importance = EVENT_IMPORTANCE[event.type] ?? 0.3;
      const actorHit = event.actors.filter((a) => opts.actors.includes(a)).length;
      const words = event.summary_en.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const kwHit = words.filter((w) => kw.has(w)).length;
      const relevance = (actorHit * 0.5 + kwHit * 0.25) / Math.max(1, Math.sqrt(words.length));
      return { event, score: recency + importance + relevance };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------- 故事筛选（第 5.5.4 节模式表） ----------

export interface SiftingPatternConfig {
  id: 'rejected_returns' | 'debt_unpaid' | 'missing_object' | 'role_change_echo' | string;
  enabled?: boolean;
  /** 各模式的阈值参数（缺省用方案里的初始值：50 / 80 / 30 张卡） */
  params?: Record<string, number>;
}

export interface SiftingHit {
  pattern: string;
  /** 供导演引用的事实 / 实体 ID */
  subject: string;
  detail: string;
}

/** 执行全部启用的筛选模式，返回跨频道回调候选（每批最多取 1 条，由调用方截取）。 */
export function sift(store: WorldStore, patterns: SiftingPatternConfig[], card: number): SiftingHit[] {
  const hits: SiftingHit[] = [];
  for (const p of patterns) {
    if (p.enabled === false) continue;
    const params = p.params ?? {};
    if (p.id === 'rejected_returns') {
      const quiet = params.quiet_cards ?? 50;
      for (const uf of store.userFacts('rejected')) {
        const lastSeen = store
          .allEvents()
          .filter((e) => e.actors.includes(uf.object))
          .reduce((m, e) => Math.max(m, e.card), 0);
        if (card - lastSeen >= quiet && card - uf.card >= quiet) {
          hits.push({ pattern: p.id, subject: uf.object, detail: `${uf.object} 被用户拒绝后已 ${card - lastSeen} 张卡未出场` });
        }
      }
    } else if (p.id === 'debt_unpaid') {
      const minAge = params.min_age_cards ?? 80;
      for (const f of store.currentFacts()) {
        if (f.predicate === 'owes' && card - f.valid_from_card >= minAge) {
          hits.push({ pattern: p.id, subject: f.subject, detail: `${f.subject} ${f.predicate} ${f.object} 已持续 ${card - f.valid_from_card} 张卡` });
        }
      }
    } else if (p.id === 'missing_object') {
      for (const f of store.currentFacts()) {
        if (f.predicate !== 'status' || f.object !== 'missing') continue;
        const thread = store.getThread(f.subject);
        const expired =
          thread &&
          thread.status === 'open' &&
          thread.expires_after_cards !== null &&
          card - thread.opened_card > thread.expires_after_cards;
        if (expired || !thread) {
          hits.push({ pattern: p.id, subject: f.subject, detail: `${f.subject} status missing 且对应伏笔已过期或不存在` });
        }
      }
    } else if (p.id === 'role_change_echo') {
      const window = params.window_cards ?? 30;
      for (const subject of new Set(store.currentFacts().map((f) => f.subject))) {
        const ended = store
          .endedFacts(subject, 1)
          .filter((e) => e.predicate === 'role' && e.valid_to_card !== null && card - e.valid_to_card <= window);
        if (ended.length > 0) {
          const e = ended[0]!;
          const endedAt = e.valid_to_card ?? card;
          const current = store.currentFacts([subject]).find((f) => f.predicate === 'role');
          hits.push({
            pattern: p.id,
            subject,
            detail: `${subject} 的 role 从 ${e.object} 变为 ${current?.object ?? '？'}（${card - endedAt} 张卡前）`,
          });
        }
      }
    }
  }
  return hits;
}

/** 伏笔卫生（C2）：过期未处理比例与孤儿伏笔。 */
export function threadHygiene(store: WorldStore, card: number): {
  open: number;
  resolved: number;
  abandoned: number;
  expiredOpen: number;
  orphans: number;
  total: number;
} {
  const threads = store.allThreads();
  let open = 0;
  let resolved = 0;
  let abandoned = 0;
  let expiredOpen = 0;
  let orphans = 0;
  for (const t of threads) {
    if (t.status === 'open') {
      open++;
      if (t.expires_after_cards !== null && card - t.opened_card > t.expires_after_cards) expiredOpen++;
      if (t.last_touched_card === t.opened_card && card - t.opened_card > 30) orphans++;
    } else if (t.status === 'resolved') resolved++;
    else if (t.status === 'abandoned') abandoned++;
  }
  return { open, resolved, abandoned, expiredOpen, orphans, total: threads.length };
}
