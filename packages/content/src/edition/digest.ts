/**
 * Edition 的摘要与规范化（设计文档 §6.1）。
 *
 * 三条硬要求：
 * 1. 共享纯 TS 包不能依赖 Node 的 `crypto`，浏览器也不该只为一个摘要引入异步 API；
 *    这里的 SHA-256 是同步纯实现，Node 与浏览器结果一致，随时可用 Node 的 crypto 对照。
 * 2. 摘要必须建立在**先固定、后计算**的规范 JSON 上：键排序、数组保序、拒绝
 *    undefined/NaN/Date/BigInt，绝不「验收时顺便清洗」。正文规范化在
 *    `normalizeForDigest` 里显式定义，且带版本号。
 * 3. 哈希只保证一致性与内容寻址，不保证作者身份、许可证或事实真实：导入仍需信任门禁。
 */

// ---------- SHA-256 ----------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** UTF-8 编码：不依赖 TextEncoder 的可用性（少数测试环境没有 DOM/Node 全局）。 */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(
      0xf0 | (code >> 18),
      0x80 | ((code >> 12) & 0x3f),
      0x80 | ((code >> 6) & 0x3f),
      0x80 | (code & 0x3f),
    );
  }
  return new Uint8Array(out);
}

export function sha256Bytes(input: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLength = input.length * 8;
  const padded = new Uint8Array(((input.length + 9 + 63) >> 6) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  // 64 位大端长度：JS 数组长度远小于 2^32，高位恒为 0，仍按规范写出
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!);
  return out;
}

export function sha256Hex(text: string): string {
  return [...sha256Bytes(utf8Bytes(text))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------- 规范 JSON ----------

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

/**
 * 规范 JSON：对象键按码元排序，数组保序，数字必须是有限值且 -0 归一为 0，
 * 字符串原样（不做 Unicode 归一化——正文规范化是显式的独立步骤）。
 * `undefined` 字段一律省略；函数、Symbol、BigInt、Date、Map 视为契约错误。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    const num = value as number;
    if (!Number.isFinite(num)) throw new CanonicalError('规范 JSON 不接受非有限数值');
    return Object.is(num, -0) ? '0' : JSON.stringify(num);
  }
  if (type === 'undefined') throw new CanonicalError('规范 JSON 不接受顶层 undefined');
  if (type === 'bigint' || type === 'function' || type === 'symbol') {
    throw new CanonicalError(`规范 JSON 不接受 ${type}`);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CanonicalError('规范 JSON 只接受纯对象、数组与原始值（不接受 Date/Map/类实例）');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** 内容寻址摘要：`sha256:<hex>`；旧 ENDLESS 的 16 位内容哈希保持不变，两类摘要不混用。 */
export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const DIGEST_VERSION = 'sha256-canonical-1' as const;

/**
 * 正文字符串的规范化规则（版本化）：统一换行、去行尾空白、折叠连续空白、
 * 首尾去空。它只用于**比较与摘要**，不写回正文；不能在验收时顺便改变已发布文本。
 */
export const TEXT_NORMALIZATION_VERSION = 'text-normalize-1' as const;

export function normalizeForDigest(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ').split('\n').map((line) => line.trimEnd()).join('\n').trim();
}

/** 语境去重口径：忽略大小写、标点与多余空白，但仍要求语义不同（仅换标点不算两处）。 */
export function contextFingerprint(text: string): string {
  return normalizeForDigest(text)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
