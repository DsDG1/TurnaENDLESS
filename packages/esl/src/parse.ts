/** 表层编码解析（第 5.8.6 节）：YAML 子集与 JSON 解析为同一规范模型。 */
import { parse as parseYaml } from 'yaml';
import { Batch, type ValidationIssue } from './model.js';

export type SurfaceFormat = 'yaml' | 'json';

export type ParseResult = { ok: true; batch: Batch; format: SurfaceFormat } | { ok: false; issues: ValidationIssue[] };

export function detectFormat(text: string): SurfaceFormat {
  return text.trimStart().startsWith('{') ? 'json' : 'yaml';
}

// 实测三种开头：`<think>`（短标签）、`<thinking>`、以及无标签的 `Thinking…`/`Thinking:`
const THINK_OPEN = /^(?:<\s*(?:think|thinking|reasoning)\s*>|think)/i;
const THINK_CLOSE = /<\/\s*(?:think|thinking|reasoning)\s*>/i;
/**
 * 答案第一行的样子：批次文本（`batch:` / `scenes:` / JSON）、计划文本（`logline:` / `beats:` …）、
 * 代码围栏。单/双反引号是模型「想开栅栏但只打了一两个」的常见残缺写法，也认。
 */
const ANSWER_HEAD = /^\s*(?:`{1,2}\s*)?(?:batch\s*:|scenes\s*:|logline\s*:|beats\s*:|cast\s*:|channel\s*:|hook_out\s*:|```|\{|\[)/;

/**
 * 剥掉推理模型内联进正文的思考块（第 5.8.6 节）。
 *
 * 为什么要在解析层做：能不能「不思考」由供应商和模型决定，而且越来越不由我们控制——
 * 实测 `MiniMax-M3.1-Flash` 直接拒绝 `thinking.type=disabled`（HTTP 400：
 * requires adaptive thinking），`MiniMax-M3` 在 `reasoning_effort=low` 时把思考写在正文开头
 * （`Thinking:…` 或 `<thinking>…`）。所以不能假设思考一定关得掉，只能让解析容错。
 *
 * 只在正文开头出现思考标记时才动手，正常输出原样返回（返回 null 表示「没找到可剥的块」）：
 *   1. 有闭合标记（`</thinking>`，或实测见到的短形式 `</think>`）→ 取闭合标记之后的内容；
 *   2. 没有闭合标记 → 从第一行「像答案开头」的行开始取（顺手去掉那一两个残缺的反引号）；
 *   3. 两者都找不到 → 返回 null，让调用方按原样解析并报错，不猜。
 */
export function stripThinking(text: string): string | null {
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (!THINK_OPEN.test(t)) return null;
  const close = THINK_CLOSE.exec(t);
  if (close) {
    const rest = t.slice(close.index + close[0].length).trim();
    return rest === '' ? null : rest;
  }
  const lines = t.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (ANSWER_HEAD.test(line)) {
      // 整行是 ``` 围栏时保留（下游 parseLooseYaml 会自己剥栅栏）；只有 1–2 个反引号才当噪声去掉
      const head = /^\s*```/.test(line) ? line : line.replace(/^(\s*)`{1,2}\s*/, '$1');
      const rest = [head, ...lines.slice(i + 1)].join('\n').trim();
      return rest === '' ? null : rest;
    }
  }
  return null;
}

export function parseBatch(text: string, format: SurfaceFormat = detectFormat(text)): ParseResult {
  // 思考块先剥掉再解析：YAML 会把 `Thinking: …` 当成一个映射键，不剥的话报的是 E-SCHEMA 而不是「模型在思考」
  const cleaned = stripThinking(text);
  const body = cleaned ?? text;
  let raw: unknown;
  try {
    raw = format === 'json' ? JSON.parse(body) : parseYaml(body);
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
