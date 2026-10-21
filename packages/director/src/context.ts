/** 导演上下文组装器（第 5.6 节）：常驻记忆块各有 token 上限，超出按规则截断。
 * token 数用 chars/4 估算（构造期近似，足够稳定）。 */

export interface ContextBudgets {
  system: number;
  channelBible: number;
  learnerProfile: number;
  brief: number;
  castFacts: number;
  openThreads: number;
  recentSummary: number;
  callback: number;
  tropeLedger: number;
  feedback: number;
}

/** 第 5.6 节表的初始值。系统规则块固定在前缀，便于供应商前缀缓存。 */
export const DEFAULT_BUDGETS: ContextBudgets = {
  system: 1500,
  channelBible: 400,
  learnerProfile: 150,
  brief: 200,
  castFacts: 300,
  openThreads: 200,
  recentSummary: 250,
  callback: 100,
  tropeLedger: 200,
  feedback: 150,
};

export interface DirectorContextData {
  system: string;
  channelBible: string;
  learnerProfile: string;
  brief: string;
  castFacts: string;
  openThreads: string;
  recentSummary: string;
  callback: string;
  tropeLedger: string;
  feedback: string;
}

export interface ContextBlock {
  name: keyof ContextBudgets;
  text: string;
  budget: number;
  estimatedTokens: number;
  truncated: boolean;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function clip(text: string, budget: number): { text: string; truncated: boolean } {
  const maxChars = budget * 4;
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars - 1)}…`, truncated: true };
}

export function assembleContext(
  data: DirectorContextData,
  budgets: ContextBudgets = DEFAULT_BUDGETS,
): { blocks: ContextBlock[]; totalEstimatedTokens: number; anyTruncated: boolean } {
  const blocks: ContextBlock[] = [];
  let total = 0;
  let anyTruncated = false;
  for (const name of Object.keys(budgets) as (keyof ContextBudgets)[]) {
    const raw = data[name];
    const budget = budgets[name];
    if (!raw) {
      blocks.push({ name, text: '', budget, estimatedTokens: 0, truncated: false });
      continue;
    }
    const { text, truncated } = clip(raw, budget);
    const estimatedTokens = estimateTokens(text);
    blocks.push({ name, text, budget, estimatedTokens, truncated });
    total += estimatedTokens;
    if (truncated) anyTruncated = true;
  }
  return { blocks, totalEstimatedTokens: total, anyTruncated };
}
