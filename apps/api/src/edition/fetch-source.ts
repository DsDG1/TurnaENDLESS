/**
 * 独立安全抓取器（设计文档 §4.4、M3）。
 *
 * 这个模块与 LLM 完全分离：模型没有 fetch 工具，抓取只在本机服务端发生。
 * 每一跳都重新校验协议/域名/DNS/IP，连接固定在已校验地址上（Host/SNI 仍是原域名），
 * 不执行 JavaScript、不加载子资源、不携带 Cookie/Authorization/本机 capability。
 *
 * 抓取到的网页正文永远是**不可信数据**：其中的提示词、工具命令与「忽略前文」
 * 只会被记录成待审标记，不会成为指令。
 */
import { randomUUID } from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { edition } from '@endless/content';

const { FETCH_LIMITS, assertFetchRedirect, assertFetchTarget, digestOf, isUntrustedContentType } = edition;
type SourceSnapshot = edition.SourceSnapshot;

export interface TransportRequest {
  url: string;
  /** 已校验并固定的目标 IP；DNS rebinding 在校验之后无法改指向。 */
  address: string;
  hostHeader: string;
  timeoutMs: number;
  maxBytes: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface FetchDeps {
  lookup(host: string): Promise<string[]>;
  request(request: TransportRequest): Promise<TransportResponse>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface FetchOk {
  ok: true;
  snapshot: SourceSnapshot;
  finalUrl: string;
  truncated: boolean;
  /** 网页里出现的疑似指令：只记录，不执行。 */
  injectionFlags: string[];
}

export interface FetchFailure {
  ok: false;
  code: string;
  message: string;
}

export type FetchResult = FetchOk | FetchFailure;

const INJECTION_PATTERNS: readonly { code: string; pattern: RegExp }[] = [
  { code: 'ignore-instructions', pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/i },
  { code: 'system-prompt', pattern: /system\s*prompt|reveal\s+your\s+(prompt|instructions)/i },
  { code: 'tool-command', pattern: /\b(run|execute)\s+(the\s+)?(command|shell|tool)\b|curl\s+http/i },
  { code: 'credential-request', pattern: /(api[_\s-]?key|secret|password|token)\s*[:=]|send\s+(me\s+)?(your|the)\s+key/i },
  { code: 'chinese-injection', pattern: /忽略(上面|以上|之前)的?(所有)?(指令|提示)|泄露?(密钥|提示词)/ },
];

/**
 * 主机级速率限制跨调用生效：抓取器是长驻服务，不能每次请求都重置窗口。
 * 同一主机的等待必须串行排队——两个并发请求若各自计算间隔会同时放行。
 * 测试可显式清空，生产不在正常路径调用。
 */
const hostNextSlot = new Map<string, Promise<number>>();

export function resetFetchRateLimiter(): void {
  hostNextSlot.clear();
}

/** 返回放行时刻；同主机的并发请求按队列依次获得间隔开的放行时间。 */
function rateSlot(host: string, now: () => number): Promise<number> {
  const previous = hostNextSlot.get(host) ?? Promise.resolve(0);
  const slot = previous.then((readyAt) => Math.max(readyAt, now()));
  hostNextSlot.set(host, slot.then((readyAt) => readyAt + FETCH_LIMITS.hostIntervalMs));
  return slot;
}

export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.code);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

/**
 * 数字/十六进制字符引用：超出 Unicode 范围或空引用一律丢弃，
 * 不抛异常、也不让恶意实体毁掉整页提取。
 */
function decodeEntity(code: string): string {
  const radix = code.startsWith('x') || code.startsWith('X') ? 16 : 10;
  const value = Number.parseInt(radix === 16 ? code.slice(1) : code, radix);
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return '';
  return String.fromCodePoint(value);
}

/** HTML → 纯文本：先整块丢弃脚本/样式/框架，再按段落切分，绝不保留标签。 */
export function extractText(raw: string, contentType: string): string {
  const type = contentType.toLowerCase();
  let text = raw;
  if (type.includes('html') || type.includes('xml')) {
    text = text
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
  }
  return text
    .replace(/&#(x[0-9a-fA-F]+|\d+);/g, (_, code: string) => decodeEntity(code))
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 压缩编码白名单：只允许 gzip/deflate/br/identity；未知编码必须拒绝，
 * 不能当成原文返回（否则一份 zstd 页面会以乱码进快照）。
 */
function decodeBody(body: Buffer, headers: Record<string, string>): Buffer | null {
  const encoding = (headers['content-encoding'] ?? '').toLowerCase().trim();
  const options = { maxOutputLength: FETCH_LIMITS.maxDecodedBytes };
  if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(body, options);
  if (encoding === 'deflate') return inflateSync(body, options);
  if (encoding === 'br') return brotliDecompressSync(body, options);
  if (encoding === '' || encoding === 'identity') return body;
  return null;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if ([...text].length <= limit) return { text, truncated: false };
  const cut = [...text].slice(0, limit).join('');
  const boundary = cut.lastIndexOf('\n\n');
  return { text: boundary > limit * 0.8 ? cut.slice(0, boundary) : cut, truncated: true };
}

/**
 * 抓取一条已筛查 URL。返回不可变快照（规范文本）——运行时不回访 URL。
 * 失败一律返回安全错误码，不回显网页原始异常、响应头全集或正文片段。
 */
export async function fetchSource(
  rawUrl: string,
  input: { allowedHosts: readonly string[]; deps: FetchDeps; signal?: AbortSignal },
): Promise<FetchResult> {
  const now = input.deps.now ?? (() => Date.now());
  const sleep = input.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let current = rawUrl;
  let previous = rawUrl;
  let hops = 0;

  for (;;) {
    if (input.signal?.aborted) return { ok: false, code: 'E-FETCH-CANCEL', message: '抓取已取消' };
    const target = assertFetchTarget(current, input.allowedHosts);
    if (!target.ok) return target;
    const host = target.target.host;

    let addresses: string[];
    try {
      addresses = await input.deps.lookup(host);
    } catch {
      return { ok: false, code: 'E-FETCH-DNS', message: 'DNS 解析失败' };
    }
    const hopCheck = assertFetchRedirect(previous, current, input.allowedHosts, addresses);
    if (!hopCheck.ok) return hopCheck;

    // 每主机每 2 秒一个请求：等待被串行分配，并发请求不会同时放行
    const readyAt = await rateSlot(host, now);
    const wait = readyAt - now();
    if (wait > 0) await sleep(wait);

    let response: TransportResponse;
    try {
      response = await input.deps.request({
        url: current,
        address: addresses[0]!,
        hostHeader: host,
        timeoutMs: FETCH_LIMITS.timeoutMs,
        maxBytes: FETCH_LIMITS.maxDecodedBytes,
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'AbortError' || name === 'TimeoutError' || (error as { code?: string }).code === 'ETIMEDOUT') {
        return { ok: false, code: 'E-FETCH-TIMEOUT', message: '抓取超时，已停止；不会自动重试' };
      }
      return { ok: false, code: 'E-FETCH-NETWORK', message: '连接目标站点失败' };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) return { ok: false, code: 'E-FETCH-REDIRECT', message: '重定向缺少 Location' };
      if (hops >= FETCH_LIMITS.maxRedirects) {
        return { ok: false, code: 'E-FETCH-REDIRECT', message: `重定向超过 ${FETCH_LIMITS.maxRedirects} 次` };
      }
      hops += 1;
      previous = current;
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, code: 'E-FETCH-REDIRECT', message: '重定向地址无法解析' };
      }
      continue;
    }
    if (response.status >= 400) {
      return { ok: false, code: 'E-FETCH-STATUS', message: `目标站点返回 HTTP ${response.status}` };
    }
    const contentType = response.headers['content-type'] ?? '';
    if (isUntrustedContentType(contentType)) {
      return { ok: false, code: 'E-FETCH-TYPE', message: '内容类型不在允许清单（只要文本页面）' };
    }
    // 字符集白名单：快照按 UTF-8 提取，声明其他编码的一律拒绝而不是猜
    const charset = /charset\s*=\s*"?([a-z0-9_-]+)"?/i.exec(contentType)?.[1]?.toLowerCase();
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
      return { ok: false, code: 'E-FETCH-TYPE', message: `不支持的字符集 ${charset}（只按 UTF-8 提取）` };
    }
    const declared = Number(response.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > FETCH_LIMITS.maxDecodedBytes) {
      return { ok: false, code: 'E-FETCH-SIZE', message: '响应体超过解压后上限' };
    }
    let decoded: Buffer | null;
    try {
      decoded = decodeBody(response.body, response.headers);
    } catch {
      return { ok: false, code: 'E-FETCH-SIZE', message: '响应解压失败或解压后超过上限' };
    }
    if (decoded === null) {
      return { ok: false, code: 'E-FETCH-TYPE', message: '压缩编码不在允许清单（gzip / deflate / br）' };
    }
    if (decoded.length > FETCH_LIMITS.maxDecodedBytes) {
      return { ok: false, code: 'E-FETCH-SIZE', message: '响应解压后超过上限' };
    }
    const text = extractText(decoded.toString('utf8'), contentType);
    if (!text.trim()) return { ok: false, code: 'E-FETCH-EMPTY', message: '页面没有可提取的正文' };
    const limited = truncate(text, FETCH_LIMITS.maxTextCharacters);
    const paragraphs = limited.text.split('\n\n').filter(Boolean);

    const snapshot: SourceSnapshot = {
      id: `snp_${randomUUID()}`,
      sourceId: `src_${randomUUID()}`,
      title: paragraphs[0]?.slice(0, 120) || new URL(current).hostname,
      canonicalUrl: rawUrl,
      finalUrl: current,
      retrievedAt: new Date(now()).toISOString(),
      extractorVersion: 'edition-extractor-1',
      spanIndexVersion: 'unicode-codepoint-1',
      encoding: 'utf-8',
      text: limited.text,
      textDigest: digestOf(limited.text),
      paragraphCount: paragraphs.length,
    };
    return { ok: true, snapshot, finalUrl: current, truncated: limited.truncated, injectionFlags: detectInjection(limited.text) };
  }
}
