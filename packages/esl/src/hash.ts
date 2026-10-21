/** 纯 TS 工具：稳定序列化与内容哈希（不依赖 Node 专有 API）。 */

/** 键排序的确定性 JSON 序列化。 */
export function stableStringify(value: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (v === null || typeof v !== 'object') {
      out.push(JSON.stringify(v));
      return;
    }
    if (Array.isArray(v)) {
      out.push('[');
      v.forEach((item, i) => {
        if (i > 0) out.push(',');
        walk(item);
      });
      out.push(']');
      return;
    }
    const obj = v as Record<string, unknown>;
    out.push('{');
    const keys = Object.keys(obj).sort();
    keys.forEach((k, i) => {
      if (i > 0) out.push(',');
      out.push(JSON.stringify(k), ':');
      walk(obj[k]);
    });
    out.push('}');
  };
  walk(value);
  return out.join('');
}

/** FNV-1a 64 位哈希（BigInt 实现），用于 AST 内容哈希与请求缓存键。 */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function contentHash(value: unknown): string {
  return fnv1a64(stableStringify(value));
}
