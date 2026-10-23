/**
 * 写手允许词表：短表（A5）。
 *
 * 结果 §4.6 的结论是「L3 的瓶颈是能力门 + 写手对允许词表的遵守度」：旧表把 321 个功能词
 * 和全部已知形式全列进去，写手输入 token 从 3.7k 涨到 5.4–5.9k，L3 仍停在 9.7%。
 * 参考给的做法是「列表页只取需要的列」：功能词在提示词里一句话说明「总是允许」，
 * 表里只列本批用得到的内容词。
 *
 * **校验口径不变**：`ValidationContext.vocab.allowedForms` 仍然包含全部功能词与全部已知形式，
 * 这里改的只是「给模型看的那一份」。所以 L3 的下降只能来自写手真的看懂了表，不是放宽了判定。
 */
import type { LearningBrief } from '@endless/learning';
import type { LabData } from './data.js';

/** 表里列多少个内容词（K=60，先按这个值定，读数见判据：写手输入 token 低于 5.4k）。 */
export const ALLOWED_WORDS_K = 60;

/**
 * 组装短表：
 *   1. 本批目标条目的形式（必须用）+ brief 的 allowed_extra（明确允许）排在前面；
 *   2. 再按字母序补已知内容词，凑到 K 个；
 *   3. 功能词一个不列（提示词里已声明总是允许）。
 * 前两段是慢变部分，构成稳定前缀；只有目标形式随批次变 —— 供应商前缀缓存照旧命中。
 */
export function shortAllowedWords(input: {
  data: LabData;
  brief: LearningBrief;
  /** 校验器认可的完整允许集合（`buildValidationContext().vocab.allowedForms`） */
  allowedForms: Set<string>;
  /** 本批额外允许词（brief.vocab.allowed_extra） */
  allowedExtra: string[];
  k?: number;
}): string {
  const { data, brief, allowedForms, allowedExtra } = input;
  const k = input.k ?? ALLOWED_WORDS_K;
  const targets = new Set<string>();
  const items = [...brief.review.map((r) => r.item), ...brief.expose.map((e) => e.item), ...brief.introduce];
  for (const item of items) for (const f of data.lexicon.forms.get(item) ?? []) targets.add(f.toLowerCase());
  const head = [...new Set([...targets, ...allowedExtra.map((w) => w.toLowerCase())])]
    .filter((w) => allowedForms.has(w))
    .sort();
  const headSet = new Set(head);
  const content = [...allowedForms].filter((w) => !headSet.has(w) && !data.lexicon.functionWords.has(w)).sort();
  const tail = content.slice(0, Math.max(0, k - head.length));
  return [...head, ...tail].join(', ');
}

/** 短表的词数（测试与报告用）。 */
export function countWords(list: string): number {
  return list.split(',').map((w) => w.trim()).filter(Boolean).length;
}
