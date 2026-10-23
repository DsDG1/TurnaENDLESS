/**
 * L4 歧义率（方案 6.3）的**程序口径**部分。
 *
 * 方案定义：「有不止一个合理答案的检测场景占比。程序检查 + 评审模型 + 人工抽查」。
 * 之前只有 E-ANSWER-COUNT / E-ANSWER-DUP 两个阻断码，且它们只看**最终批次**——
 * 被修复循环改写过的批次在最终产物上是干净的，所以「用 issue 计数当 L4」永远是 0（空心读数）。
 *
 * 这里改成直接从**最终批次的选项文本**判三类结构性歧义，不依赖历史 issue：
 *   1. 答案计数不是恰好 1（解题者无法确定要选几个）；
 *   2. 两个选项规范化后完全相同（同一个答案出现两次）；
 *   3. 干扰项与正确项的内容词 Jaccard ≥ 0.6（两个说法读起来都对，或差别只在功能词）。
 * 语义级歧义（「在桌上」与「在书桌上」在本场景都成立）程序判不了，留给评审模型与人工抽查；
 * 本条只保证 L4 有一半是可复现读数，而不是长期空白。
 */
import type { Batch, Scene } from './model.js';

/**
 * 功能词表：判「内容词是否重叠」时先剔掉这些词。
 * 故意写死在包内而不是读词库：L4 是跨运行比较的比值，判据一变历史读数就不可比。
 * 这张表只用于**比较两个选项的措辞**，不参与词表预算（OOV）判定。
 *
 * 注意疑问词（where / who / when / how…）**不在**表里：它们往往正是选项之间唯一的区别，
 * 例如 "Where was your hat?" 与 "Who was your hat?" 剔掉疑问词后内容词完全重合，
 * 会被误判成歧义。判据要能区分「措辞不同」与「说法相同」。
 */
const FUNCTION_WORDS = new Set(
  (
    'a an the this that these those my your his her its our their ' +
    'is am are was were be been being do does did done have has had ' +
    'to of in on at under behind near by with for from into onto over above below between ' +
    'and or but not no yes it he she they we you i me him them us ' +
    'can could will would shall should may might must ' +
    'here there some any all one last'
  ).split(' '),
);

/** 选项文本 → 内容词集合（小写、去标点、去功能词）。 */
export function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !FUNCTION_WORDS.has(w));
  return new Set(words);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 判定阈值：内容词重合到这个程度，两个选项在用同一个说法。 */
export const AMBIGUITY_JACCARD = 0.6;

export interface AmbiguousScene {
  sceneId: string;
  where: string;
  reason: string;
}

export interface AmbiguityReport {
  /** 检测场景总数（L4 的分母） */
  detectionScenes: number;
  /** 每一个「为什么算歧义」的理由（同一场景可能有多条：三个干扰项都与正确项重合） */
  ambiguous: AmbiguousScene[];
  /** 有歧义的**场景数**（L4 的分子：按场景计，不按理由计，所以不会超过 detectionScenes） */
  ambiguousScenes: number;
  /** L4 程序口径 = ambiguousScenes / detectionScenes；无检测场景时为 null（不可判定，不是 0） */
  rate: number | null;
}

interface LabeledOption {
  label: string;
  correct: boolean;
}

/** 一组：标签 + 恰好一个正确答案时的结构性歧义检查。 */
function checkLabels(sceneId: string, where: string, options: LabeledOption[], out: AmbiguousScene[]): void {
  const correctCount = options.filter((o) => o.correct).length;
  if (correctCount !== 1) {
    out.push({ sceneId, where, reason: `正确答案数为 ${correctCount}，不是恰好 1 个` });
    return;
  }
  const norm = options.map((o) => o.label.trim().toLowerCase().replace(/\s+/g, ' '));
  const seen = new Map<string, number>();
  norm.forEach((label, i) => {
    const first = seen.get(label);
    if (first !== undefined) {
      out.push({ sceneId, where, reason: `选项 ${first + 1} 与 ${i + 1} 的文本相同（"${label}"）` });
    } else {
      seen.set(label, i);
    }
  });
  const correctIdx = options.findIndex((o) => o.correct);
  const correctWords = contentWords(options[correctIdx]!.label);
  for (let i = 0; i < options.length; i++) {
    if (i === correctIdx) continue;
    const sim = jaccard(correctWords, contentWords(options[i]!.label));
    if (sim >= AMBIGUITY_JACCARD) {
      out.push({
        sceneId,
        where,
        reason: `干扰项 ${i + 1} 与正确项的内容词重合 ${(sim * 100).toFixed(0)}%（"${options[i]!.label}" vs "${options[correctIdx]!.label}"）：可能两个都对`,
      });
    }
  }
}

/** 是否算「检测场景」：能产生检索证据的交互形态（方案 5.8.4 的证据推导行）。 */
function isDetectionScene(scene: Scene): boolean {
  switch (scene.type) {
    case 'pick':
      return true;
    case 'chat':
      return scene.reply !== undefined;
    case 'hidden_object':
      return true;
    case 'swipe':
      return scene.mode === 'judge';
    case 'story':
      return scene.evidence !== undefined;
    default:
      return false;
  }
}

/**
 * 计算一个批次的 L4 程序口径。
 * 调用方传**最终播放的批次**（修复之后），否则量到的是「模型第一版有多歧义」，
 * 那对应的是 V 系列指标，不是 L4。
 */
export function detectionAmbiguity(batch: Batch): AmbiguityReport {
  const ambiguous: AmbiguousScene[] = [];
  let detectionScenes = 0;
  for (const scene of batch.scenes) {
    if (!isDetectionScene(scene)) continue;
    detectionScenes++;
    if (scene.type === 'pick') {
      checkLabels(scene.id, 'options', scene.options.map((o) => ({ label: o.label, correct: o.correct === true })), ambiguous);
    } else if (scene.type === 'chat' && scene.reply) {
      checkLabels(
        scene.id,
        'reply.options',
        scene.reply.options.map((o) => ({ label: o.label, correct: o.correct === true })),
        ambiguous,
      );
    } else if (scene.type === 'hidden_object') {
      const targets = scene.objects.filter((o) => o.target).length;
      if (targets !== 1) ambiguous.push({ sceneId: scene.id, where: 'objects', reason: `目标数为 ${targets}，不是恰好 1 个` });
    } else if (scene.type === 'swipe') {
      const keys = scene.cards.map((c) => `${c.asset}|${c.caption.trim().toLowerCase()}`);
      if (new Set(keys).size !== keys.length) {
        ambiguous.push({ sceneId: scene.id, where: 'cards', reason: '有完全相同的两张卡：判无可判' });
      }
    }
  }
  const ambiguousScenes = new Set(ambiguous.map((a) => a.sceneId)).size;
  return {
    detectionScenes,
    ambiguous,
    ambiguousScenes,
    rate: detectionScenes > 0 ? ambiguousScenes / detectionScenes : null,
  };
}
