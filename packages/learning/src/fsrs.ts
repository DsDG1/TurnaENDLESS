/**
 * ts-fsrs 封装（第 5.3.3 节）：FSRS 卡片的粒度是（条目，维度），
 * 评分只用 Again、Hard、Good 三档——单次选择题区分不出「容易」和「正常」。
 */
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  type Card,
  type FSRS,
} from 'ts-fsrs';
import type { Facet } from './lexicon.js';

export type Grade3 = 'Again' | 'Hard' | 'Good';
const RATING: Record<Grade3, Rating> = { Again: Rating.Again, Hard: Rating.Hard, Good: Rating.Good };

export const cardKey = (item: string, facet: Facet): string => `${item}#${facet}`;

export interface DueItem {
  item: string;
  facet: Facet;
  card: Card;
  /** 逾期比例：已逾期天数 / 计划间隔（R2 优先级用） */
  overdueRatio: number;
}

export class SrsStore {
  private cards = new Map<string, Card>();
  private f: FSRS;

  constructor(params?: ReturnType<typeof generatorParameters>) {
    this.f = fsrs(params ?? generatorParameters());
  }

  getCard(item: string, facet: Facet, now: Date): Card {
    const key = cardKey(item, facet);
    const existing = this.cards.get(key);
    if (existing) return existing;
    const created = createEmptyCard(now);
    this.cards.set(key, created);
    return created;
  }

  hasCard(item: string, facet: Facet): boolean {
    return this.cards.has(cardKey(item, facet));
  }

  /** 写入一次评分，返回更新后的卡片。 */
  grade(item: string, facet: Facet, grade: Grade3, now: Date): Card {
    const key = cardKey(item, facet);
    const card = this.getCard(item, facet, now);
    const next = this.f.next(card, now, RATING[grade] as unknown as 1 | 2 | 3);
    this.cards.set(key, next.card);
    return next.card;
  }

  /** 预测回忆率（0–1）。没有卡片的条目返回 null。 */
  predictedRecall(item: string, facet: Facet, now: Date): number | null {
    const card = this.cards.get(cardKey(item, facet));
    if (!card) return null;
    return this.f.get_retrievability(card, now, false) as number;
  }

  /** 到期队列。默认只算 Review / Relearning（真间隔回顾，规划器用）；
   *  includeLearning 时包含 Learning 态已到期卡（合成事件流用，对应学习步进内的到期）。 */
  dueItems(now: Date, facet: Facet = 'meaning', includeLearning = false): DueItem[] {
    const out: DueItem[] = [];
    for (const [key, card] of this.cards) {
      const stateOk = card.state === 2 || card.state === 3 || (includeLearning && card.state === 1);
      if (!stateOk) continue;
      if (card.due.getTime() > now.getTime()) continue;
      const hash = key.lastIndexOf('#');
      const item = key.slice(0, hash);
      if (facet && key.slice(hash + 1) !== facet) continue;
      const elapsedDays = Math.max(0, (now.getTime() - card.due.getTime()) / 86_400_000);
      out.push({ item, facet: key.slice(hash + 1) as Facet, card, overdueRatio: elapsedDays / Math.max(1, card.scheduled_days) });
    }
    return out.sort(
      (a, b) =>
        b.overdueRatio * (1 - (this.predictedRecall(b.item, b.facet, now) ?? 0.5)) -
        a.overdueRatio * (1 - (this.predictedRecall(a.item, a.facet, now) ?? 0.5)),
    );
  }

  allCards(): { key: string; card: Card }[] {
    return [...this.cards.entries()].map(([key, card]) => ({ key, card }));
  }

  /** 检查点恢复：直接放回一张已验证的卡片（不评分，不产生学习证据）。 */
  restoreCard(key: string, card: Card): void {
    this.cards.set(key, card);
  }

  size(): number {
    return this.cards.size;
  }
}
