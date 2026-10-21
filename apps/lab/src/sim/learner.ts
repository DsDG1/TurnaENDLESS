/**
 * 学习者模拟器（第 5.2 节）：提供确定的交互数据，检验调度与证据逻辑是否自洽。
 * 隐藏真值模型故意选用与 FSRS 不同的遗忘曲线形式（指数衰减），
 * 避免「FSRS 预测得准」成为循环论证。
 */
import { lognormal, mulberry32, seedOf, uniform, type Rng } from './rng.js';

export type PersonaId = 'P1' | 'P2' | 'P3';

export interface PersonaSpec {
  id: PersonaId;
  name: string;
  desc: string;
  /** 初始已掌握比例（A1 词义中约 30% / 50% / 50%） */
  knownRatio: number;
  /** 简单卡停留时间（对数正态中位数，毫秒） */
  dwellMedianMs: number;
  dwellSigma: number;
  /** 长文本直接跳过的概率（P1 为 0.4） */
  skipLongProb: number;
  /** 分支偏好：random 近似随机；helpful 偏向帮助角色 */
  choice: 'random' | 'helpful';
  /** 听力题正确率惩罚（P3 乘 0.7） */
  listeningPenalty: number;
}

export const PERSONAS: Record<PersonaId, PersonaSpec> = {
  P1: { id: 'P1', name: 'Swiper 快刷型', desc: '简单卡平均停留 4 秒；长文本 40% 跳过；分支选择接近随机', knownRatio: 0.3, dwellMedianMs: 4000, dwellSigma: 0.45, skipLongProb: 0.4, choice: 'random', listeningPenalty: 1 },
  P2: { id: 'P2', name: 'Diligent 认真型', desc: '停留长；不跳过；分支偏向帮助角色', knownRatio: 0.5, dwellMedianMs: 8000, dwellSigma: 0.4, skipLongProb: 0, choice: 'helpful', listeningPenalty: 1 },
  P3: { id: 'P3', name: 'Uneven 偏科型', desc: '阅读强、听力弱（听力题正确率乘 0.7）', knownRatio: 0.5, dwellMedianMs: 6000, dwellSigma: 0.4, skipLongProb: 0.1, choice: 'helpful', listeningPenalty: 0.7 },
};

export const S_CAP = 365;
export const S_MIN = 0.3;

/** 学习时钟（第 5.2.3 节）：每 60 张卡一个学习时段，时段间按固定模式推进天数。 */
const SESSION_GAP_DAYS = [1, 1, 2, 1, 3, 1, 1, 4];

export function studyDayOf(card: number): number {
  const sessions = Math.floor(card / 60);
  let day = 0;
  for (let i = 0; i < sessions; i++) day += SESSION_GAP_DAYS[i % SESSION_GAP_DAYS.length]!;
  return day;
}

export class LearnerSimulator {
  readonly spec: PersonaSpec;
  private rng: Rng;
  /** key = `${item}#${facet}` → 真实记忆强度 S_true（天） */
  private sTrue = new Map<string, number>();
  /** key → 上次见到（任何形式）的学习日 */
  private lastSeenDay = new Map<string, number>();

  constructor(persona: PersonaId, seed: number) {
    this.spec = PERSONAS[persona];
    this.rng = mulberry32(seed);
  }

  /** 初始化已知水平：knownRatio 的条目掌握（S ∈ [10, 60]），其余 [0.5, 3]。 */
  seedKnowledge(items: string[], facet = 'meaning'): void {
    for (const item of items) {
      const key = `${item}#${facet}`;
      const known = this.rng() < this.spec.knownRatio;
      this.sTrue.set(key, known ? uniform(this.rng, 10, 60) : uniform(this.rng, 0.5, 3));
    }
  }

  private strength(item: string, facet: string): number {
    return this.sTrue.get(`${item}#${facet}`) ?? uniform(this.rng, 0.5, 3);
  }

  /** 检索难度的增长系数 a ∈ [1, 2]（按条目难度取值，确定性派生）。 */
  private growthA(item: string): number {
    return 1 + (seedOf(item) % 100) / 100;
  }

  /** 真实回忆概率 R_true(Δt) = exp(−Δt / S_true)。 */
  recall(item: string, facet: string, day: number): number {
    const key = `${item}#${facet}`;
    const last = this.lastSeenDay.get(key) ?? -30;
    const dt = Math.max(0.5, day - last);
    return Math.exp(-dt / this.strength(item, facet));
  }

  /**
   * 作答（第 5.2.2 节）：P(correct) = R + (1−R)·g；被启动（同批先看过）＋0.3。
   * 不在此处更新 S_true —— 更新按事件类型显式调用（settle*）。
   */
  answer(item: string, guessRate: number, day: number, opts: { primed?: boolean; listening?: boolean } = {}): boolean {
    let r = this.recall(item, 'meaning', day);
    if (opts.primed) r = Math.min(1, r + 0.3);
    let p = r + (1 - r) * guessRate;
    if (opts.listening) p *= this.spec.listeningPenalty;
    this.lastSeenDay.set(`${item}#meaning`, day);
    return this.rng() < p;
  }

  /** 被动曝光：S ← min(S × 1.05, S_cap)。 */
  settleExposure(item: string, facet = 'meaning'): void {
    const key = `${item}#${facet}`;
    const s = this.strength(item, facet);
    this.sTrue.set(key, Math.min(s * 1.05, S_CAP));
  }

  /** 检索成功：S ← S × (1 + a)，a ∈ [1, 2]。 */
  settleCorrect(item: string, facet = 'meaning'): void {
    const key = `${item}#${facet}`;
    this.sTrue.set(key, this.strength(item, facet) * (1 + this.growthA(item)));
  }

  /** 检索失败：S ← max(S × 0.4, S_min)。 */
  settleWrong(item: string, facet = 'meaning'): void {
    const key = `${item}#${facet}`;
    this.sTrue.set(key, Math.max(this.strength(item, facet) * 0.4, S_MIN));
  }

  /** 第 60 模拟日的平均真实回忆率（L7 用）。 */
  meanRecallAt(items: string[], day: number, facet = 'meaning'): number {
    if (items.length === 0) return 0;
    let sum = 0;
    for (const item of items) sum += this.recall(item, facet, day);
    return sum / items.length;
  }

  /** 停留时间（毫秒）：按场景类型与文本长度，对数正态抽样。 */
  dwellMs(sceneType: string, textWords: number): number {
    const base = { comic: 1.1, chat: 1.0, swipe: 0.8, pick: 1.0, hidden_object: 1.6, story: 1.3, derive: 1.0 }[sceneType] ?? 1;
    const mu = Math.log(this.spec.dwellMedianMs * base) + Math.log(1 + textWords / 25);
    return Math.round(lognormal(this.rng, mu, this.spec.dwellSigma));
  }

  /** 长文本是否直接跳过（P1 有 40% 概率）。 */
  skipsLongText(textWords: number): boolean {
    if (textWords < 20) return false;
    return this.rng() < this.spec.skipLongProb;
  }

  /**
   * 分支选择（第 5.2.4 节）：按画像偏好打分后随机抽样。
   * helpful 偏向「帮助/给予/肯定」语义的选项（关键词近似）；random 均匀。
   */
  chooseOption(labels: string[]): number {
    const helpfulRe = /help|share|give|open|yes|save|find|thanks|take/i;
    const candidates = labels.map((label, i) => ({ i, hit: helpfulRe.test(label) }));
    const hits = candidates.filter((c) => c.hit);
    if (this.spec.choice === 'helpful' && hits.length > 0) {
      return hits[Math.floor(this.rng() * hits.length)]!.i;
    }
    return Math.floor(this.rng() * labels.length);
  }

  /** 实例级 RNG 透出（频道调度等复用同一随机流）。 */
  get rand(): Rng {
    return this.rng;
  }
}
