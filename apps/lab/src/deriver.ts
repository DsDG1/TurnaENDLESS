/**
 * 程序派生的跨批检测（B3，借 ScrollToStudy「无限的不是内容，而是题目」与错题回插）。
 *
 * 现状：`derive` 的编译与证据语义都已实现（跨批来源计 recognition-4），但提示词从不要求模型写，
 * 所以 R5 的「derive 开」只有「不剔除」的含义，跑出来的东西与 R3 一样（结果 §7 第 8 条）。
 *
 * 这个派生器**不调 LLM**：对本批到期的复习条目，如果它的某个形式出现在**更早已播放批次**的台词里，
 * 就用那句原文挖空生成一个 cloze_pick。规则（计划 §3 B3）：
 *   - 只从更早批次取材（`priorTexts` 里只有已播放批次）→ 保持 R4 防启动；本批文本里出现该条目的不用；
 *   - 每批最多 1 个，派生卡不超过全部卡片的 25%（防 L5 习题感上升）；
 *   - 最近答错的条目优先（错题回插）；写进 FSRS 的仍然只是证据结果，SRS 是真相，派生只是投影。
 */
import type { TextUnit } from '@endless/esl';
import type { LearningBrief } from '@endless/learning';

export interface DeriveOptions {
  brief: LearningBrief;
  /** 已播放批次：batchId → 该批文本单元（只含更早批次） */
  priorTexts: Map<string, TextUnit[]>;
  lexicon: { formsOf(item: string): string[] | undefined };
  /** 最近答错的条目（错题回插，优先派生） */
  recentlyWrong: string[];
  /** 本批基本场景数（用于 25% 上限） */
  baseCards: number;
  /** 本批已被占用的场景 id（生成新 id 用） */
  usedSceneIds: string[];
}

export interface DerivedPlan {
  /** 直接追加进 `scenes` 的 derive 场景 */
  scene: {
    id: string;
    type: 'derive';
    from: string;
    kind: 'cloze_pick';
    item: string;
    distractors: 'confusables';
  };
  item: string;
  from: string;
  /** 取材批次与那句话，便于日志核对 */
  sourceBatch: string;
  sourceText: string;
  /** 是否属于错题回插 */
  errorReplay: boolean;
}

const MAX_DERIVED_PER_BATCH = 1;
const MAX_DERIVED_RATIO = 0.25;

/** 下一个可用场景 id：s1..s9 里取第一个没被占用的。 */
function nextSceneId(used: string[]): string {
  const taken = new Set(used);
  for (let i = 1; i < 100; i++) {
    const id = `s${i}`;
    if (!taken.has(id)) return id;
  }
  return `s${used.length + 1}`;
}

/** 在更早批次里找到「包含该条目某个形式」的最近一句话。 */
function findPriorSentence(
  priorTexts: Map<string, TextUnit[]>,
  forms: string[],
): { from: string; batch: string; text: string } | null {
  const batches = [...priorTexts.keys()];
  for (let i = batches.length - 1; i >= 0; i--) {
    const batchId = batches[i]!;
    const units = priorTexts.get(batchId) ?? [];
    for (const u of units) {
      const lower = u.text.toLowerCase();
      if (!forms.some((f) => f && lower.includes(f.toLowerCase()))) continue;
      // 只认「一句话里恰好出现一次目标形式」的单元：挖空后干扰项才有区分度
      const occurrences = forms.reduce((s, f) => {
        if (!f) return s;
        const needle = f.toLowerCase();
        let from = 0;
        let n = 0;
        for (;;) {
          const at = lower.indexOf(needle, from);
          if (at === -1) break;
          n++;
          from = at + needle.length;
        }
        return s + n;
      }, 0);
      if (occurrences !== 1) continue;
      return { from: `${batchId}.${u.sceneId}.${u.path}`, batch: batchId, text: u.text };
    }
  }
  return null;
}

export function planDerivedScene(opts: DeriveOptions): DerivedPlan | null {
  // 上限先行：3 场 + 1 派生 = 4 卡，1/4 = 25% 刚好卡线；2 场时 1/3 > 25%，不派生
  if (MAX_DERIVED_PER_BATCH < 1) return null;
  const totalAfter = opts.baseCards + MAX_DERIVED_PER_BATCH;
  if (MAX_DERIVED_PER_BATCH / totalAfter > MAX_DERIVED_RATIO) return null;

  // 顺序：错题优先 → 其余按 brief 原序（规划器已按到期时间排过）
  const wrong = new Set(opts.recentlyWrong);
  const ordered = [...opts.brief.review].sort((a, b) => Number(wrong.has(b.item)) - Number(wrong.has(a.item)));

  for (const r of ordered) {
    const forms = (opts.lexicon.formsOf(r.item) ?? []).filter(Boolean);
    if (forms.length === 0) continue;
    // 说明：派生卡插在本批最前面（见 pipeline），所以不存在「本批文本提前暴露答案」的问题；
    // 若本批自己也考同一条目，按方案 §5.2.2「同批第二次检测 = practice」结算，不重复写 FSRS。
    const found = findPriorSentence(opts.priorTexts, forms);
    if (!found) continue;
    return {
      scene: {
        id: nextSceneId(opts.usedSceneIds),
        type: 'derive',
        from: found.from,
        kind: 'cloze_pick',
        item: r.item,
        distractors: 'confusables',
      },
      item: r.item,
      from: found.from,
      sourceBatch: found.batch,
      sourceText: found.text,
      errorReplay: wrong.has(r.item),
    };
  }
  return null;
}
