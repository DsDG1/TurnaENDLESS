/** 表层编码解析（第 5.8.6 节）：YAML 子集与 JSON 解析为同一规范模型。 */
import { parse as parseYaml } from 'yaml';
import { Batch, type ValidationIssue } from './model.js';

export type SurfaceFormat = 'yaml' | 'json';

export type ParseResult = { ok: true; batch: Batch; format: SurfaceFormat } | { ok: false; issues: ValidationIssue[] };

export function detectFormat(text: string): SurfaceFormat {
  return text.trimStart().startsWith('{') ? 'json' : 'yaml';
}

export function parseBatch(text: string, format: SurfaceFormat = detectFormat(text)): ParseResult {
  let raw: unknown;
  try {
    raw = format === 'json' ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    return {
      ok: false,
      issues: [{ code: 'E-PARSE', level: 'error', message: `${format} 解析失败：${(e as Error).message}` }],
    };
  }
  const parsed = Batch.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((iss) => ({
        code: 'E-SCHEMA' as const,
        level: 'error' as const,
        path: iss.path.map(String).join('.'),
        message: `${iss.path.map(String).join('.') || '(root)'}：${iss.message}`,
      })),
    };
  }
  return { ok: true, batch: parsed.data, format };
}
