/**
 * 进程内滑动窗口限流（登录/验证码等匿名端点按来源 IP）。
 * 说明：这是每进程限额；多实例部署时收件人维度另有数据库计数兜底，
 * IP 维度的全局限额需要网关层实现——属 C8 运维事项，此处如实记录。
 */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  take(key: string): { ok: true } | { ok: false; retryAfter: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const hits = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (hits.length >= this.limit) {
      this.hits.set(key, hits);
      return { ok: false, retryAfter: Math.max(1, Math.ceil(((hits[0] ?? now) + this.windowMs - now) / 1000)) };
    }
    hits.push(now);
    this.hits.set(key, hits);
    return { ok: true };
  }

  /** 防止 map 无界增长：定期清掉空桶（由调用方低频调用）。 */
  sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, hits] of this.hits) {
      if (!hits.some((at) => at > cutoff)) this.hits.delete(key);
    }
  }
}
