/** 提示词模板（附录 A–C 的骨架放在 apps/lab/data/prompts/，这里负责加载与占位符替换）。 */

export interface PromptTemplates {
  system: string;
  showrunner: string;
  writer: string;
  single: string;
  repair: string;
  judge: string;
}

/** {{name}} 占位符替换；未提供的占位符替换为空串。 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

export const BLOCK_PLACEHOLDERS = [
  'channel_bible',
  'learner_profile',
  'brief',
  'cast_facts',
  'open_threads',
  'recent_summary',
  'callback',
  'trope_ledger',
  'feedback',
] as const;
