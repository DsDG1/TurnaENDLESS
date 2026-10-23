/**
 * 失败分类重试（A4，借 ScrollToStudy 的「不完整 / 网络错 / 最终失败」三分法）。
 *
 * 三类失败的处置不同，混在一起就会把「供应商抖动」算进「ESL 好不好写」：
 *   1. 传输类（网络错误、超时、429、5xx）→ 指数退避 + 抖动重试；429 优先读 Retry-After。
 *   2. 请求类（400 / 401 / 403 / 404 / 422 等）→ 立即失败，重试只会重复烧钱。
 *   3. 不完整（finish=length、空正文）→ 不在这一层重试：正文为空/被截断要靠「带错误重写」，
 *      由导演的解析重写路径处理，这里只把 finishReason / empty 记进调用记录，供指标单独计数。
 *
 * 这层包在 CachingLlmClient 的**内层**：请求哈希不变，缓存与回放完全不受影响。
 */
import type { LlmClient, LlmRequest, LlmResponse } from './llm.js';

export type LlmErrorClass = 'transport' | 'request';

/** 带分类的 LLM 失败。传输类在重试耗尽后抛出，pipeline 据此记 `E-TRANSPORT`。 */
export class LlmFailure extends Error {
  readonly klass: LlmErrorClass;
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** 已经尝试过的次数（含最后一次）；由 RetryingLlmClient 填 */
  attempts = 1;

  constructor(message: string, klass: LlmErrorClass, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'LlmFailure';
    this.klass = klass;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

const TRANSPORT_PATTERNS = [
  /fetch failed/i,
  /network/i,
  /socket hang up/i,
  /econnreset|econnrefused|enotfound|etimedout|eai_again|epipe/i,
  /timed? ?out|timeout/i,
  /aborted|aborterror/i,
  /rate.?limit|too many requests/i,
  /overloaded|service unavailable|bad gateway|gateway timeout/i,
  /internal server error/i,
];

const statusOf = (e: unknown): number | undefined => {
  const o = e as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } };
  const raw = o?.statusCode ?? o?.status ?? o?.response?.status;
  return typeof raw === 'number' ? raw : undefined;
};

/** 错误链里找第一个带状态码的（AI SDK 会把底层错误挂在 cause 上）。 */
function statusDeep(e: unknown, depth = 0): number | undefined {
  if (e === null || typeof e !== 'object' || depth > 4) return undefined;
  const direct = statusOf(e);
  if (direct !== undefined) return direct;
  return statusDeep((e as { cause?: unknown }).cause, depth + 1);
}

function messageDeep(e: unknown, depth = 0): string {
  if (e === null || typeof e !== 'object' || depth > 4) return e === null ? '' : String(e);
  const msg = e instanceof Error ? e.message : String(e);
  const cause = (e as { cause?: unknown }).cause;
  return cause === undefined ? msg : `${msg} ${messageDeep(cause, depth + 1)}`;
}

/** Retry-After：秒数或 HTTP 日期，统一换成毫秒。 */
export function retryAfterMsOf(e: unknown): number | undefined {
  const headers = (e as { responseHeaders?: Record<string, string>; headers?: Record<string, string> })?.responseHeaders ??
    (e as { headers?: Record<string, string> })?.headers;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** 分类：只有明确的传输类才重试，其余按请求类立即失败。 */
export function classifyLlmError(e: unknown): LlmErrorClass {
  if (e instanceof LlmFailure) return e.klass;
  const status = statusDeep(e);
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 425 || status === 429) return 'transport';
    if (status >= 500) return 'transport';
    if (status >= 400) return 'request';
  }
  // AI SDK 的 APICallError 自己会标 isRetryable（含连接层错误）
  if ((e as { isRetryable?: unknown })?.isRetryable === true) return 'transport';
  if ((e as { name?: string })?.name === 'AbortError' || (e as { name?: string })?.name === 'TimeoutError') return 'transport';
  const text = messageDeep(e);
  return TRANSPORT_PATTERNS.some((re) => re.test(text)) ? 'transport' : 'request';
}

export interface RetryPolicy {
  /** 最多尝试次数（含首次）；默认 4 */
  maxAttempts?: number;
  /** 首次退避基准（毫秒），之后翻倍；默认 800 */
  baseDelayMs?: number;
  /** 单次退避上限（毫秒）；默认 20 000 */
  maxDelayMs?: number;
  /** 抖动比例（0.3 = ±30%）；默认 0.3 */
  jitter?: number;
  /** 最小请求间隔（毫秒，D1 的 min_interval）：并发下也串行排队，避免供应商 429 */
  minIntervalMs?: number;
  /** 退避实现（测试注入以免真的等待）；默认 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** 每次重试的回调（打日志用） */
  onRetry?: (info: { attempt: number; delayMs: number; klass: LlmErrorClass; message: string; status?: number }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * 传输类失败自动重试的装饰器。
 * 成功后把 `transportRetries` / `transportWaitMs` 挂在响应上，随调用记录进 calls.jsonl。
 */
export class RetryingLlmClient implements LlmClient {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitter: number;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** 上一次请求结束时间：min_interval 的节流基准 */
  private lastCallAt = 0;

  constructor(private inner: LlmClient, private policy: RetryPolicy = {}) {
    this.maxAttempts = Math.max(1, policy.maxAttempts ?? 4);
    this.baseDelayMs = Math.max(1, policy.baseDelayMs ?? 800);
    this.maxDelayMs = Math.max(this.baseDelayMs, policy.maxDelayMs ?? 20_000);
    this.jitter = Math.max(0, Math.min(1, policy.jitter ?? 0.3));
    this.minIntervalMs = Math.max(0, policy.minIntervalMs ?? 0);
    this.sleep = policy.sleep ?? defaultSleep;
  }

  async modelId(tier: 'fast' | 'premium'): Promise<string> {
    return this.inner.modelId(tier);
  }

  hashSalt(): string {
    return this.inner.hashSalt?.() ?? '';
  }

  /** 指数退避 + 抖动；429 的 Retry-After 优先，且不超过单次上限。 */
  private delayFor(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, this.maxDelayMs);
    const raw = this.baseDelayMs * 2 ** (attempt - 1);
    const jittered = raw * (1 + (Math.random() * 2 - 1) * this.jitter);
    return Math.min(this.maxDelayMs, Math.max(0, Math.round(jittered)));
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    let retries = 0;
    let waitMs = 0;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.minIntervalMs > 0) {
        const gap = Date.now() - this.lastCallAt;
        if (gap < this.minIntervalMs) {
          const wait = this.minIntervalMs - gap;
          waitMs += wait;
          await this.sleep(wait);
        }
      }
      this.lastCallAt = Date.now();
      try {
        const res = await this.inner.complete(req);
        return { ...res, transportRetries: retries, transportWaitMs: waitMs };
      } catch (e) {
        const klass = classifyLlmError(e);
        lastError = e;
        if (klass === 'request' || attempt === this.maxAttempts) {
          const failure = new LlmFailure(
            e instanceof Error ? e.message : String(e),
            klass,
            { status: statusDeep(e), retryAfterMs: retryAfterMsOf(e), cause: e },
          );
          failure.attempts = attempt;
          throw failure;
        }
        retries++;
        const delay = this.delayFor(attempt, retryAfterMsOf(e));
        waitMs += delay;
        this.policy.onRetry?.({
          attempt,
          delayMs: delay,
          klass,
          message: (e instanceof Error ? e.message : String(e)).split('\n')[0]!,
          ...(statusDeep(e) !== undefined ? { status: statusDeep(e)! } : {}),
        });
        await this.sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
