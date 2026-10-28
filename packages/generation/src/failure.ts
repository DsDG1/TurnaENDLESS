import type { GenerationFailure } from '@endless/content';
import type { ValidationIssue } from '@endless/esl';

/**
 * 内容验收失败的可安全展示描述。
 *
 * 只暴露错误码与固定中文标签，不包含草稿正文、提示词或供应商响应。
 * HTTP 状态由调用方决定（本机 422、云端按自己的错误信封映射），本包不引入传输语义。
 */
export function describeContentFailure(issues: ValidationIssue[]): { message: string; failure: GenerationFailure } {
  const codes = [...new Set(issues.filter((issue) => issue.level === 'error').map((issue) => issue.code))]
    .filter((code) => /^E-[A-Z-]{1,50}$/.test(code));
  const labels: Record<string, string> = {
    'E-OOV-HIGH': '词表外用词过多', 'E-EFFECT-INVALID': '剧情效果引用不匹配',
    'E-USES-NOT-FOUND': '声明的学习词没有实际出现', 'E-NEW-TESTED-EARLY': '新词被过早当成独立测试',
    'E-LEARNING-TASK': '未完成指定的新词教学或复习', 'E-BRIEF-UNCOVERED': '学习任务未覆盖',
    'E-PRIMED': '复习题提前透露了答案', 'E-PARSE': '模型输出格式无法解析',
    'E-SCHEMA': '内容结构不符合播放器要求', 'E-PLAYER-PATH': '部分选项无法安全播放',
    'E-DRAFT': '创作草稿不符合协议或学习契约',
    'E-DRAFT-ATTEMPTS': '自动修复次数已达到上限', 'E-DRAFT-BUDGET': '自动修复的 token 预算已达到上限',
  };
  const reasons = codes.slice(0, 4).map((code) => labels[code] ?? code).join('；');
  return {
    message: `AI 内容未通过校验：${reasons || '内容不完整'}${codes.length ? `（${codes.join(', ')}）` : ''}。本次未加入内容库，可手动重试；可能产生费用。`,
    failure: { category: 'content', codes },
  };
}

/** 生成执行失败：携带可安全展示的文案与分类，不带 HTTP 状态或任务记录语义。 */
export class GenerationFailureError extends Error {
  constructor(message: string, readonly failure: GenerationFailure) {
    super(message);
    this.name = 'GenerationFailureError';
  }
}
