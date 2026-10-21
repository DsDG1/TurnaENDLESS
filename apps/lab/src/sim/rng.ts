/** 确定性随机数（mulberry32）：种子固定保证可复现（第 5.2.4 节）。 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从字符串派生稳定的种子（条目难度等确定性参数用）。 */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** [min, max) 均匀抽样。 */
export function uniform(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** 对数正态抽样（停留时间，第 5.2.3 节）。 */
export function lognormal(rng: Rng, mu: number, sigma: number): number {
  const u = Math.max(rng(), 1e-12);
  const v = Math.max(rng(), 1e-12);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.exp(mu + sigma * z);
}

/** 百分位。 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
