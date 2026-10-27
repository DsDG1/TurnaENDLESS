/**
 * 程序派生的跨批检测与零延迟填缝引擎（B3）。
 *
 * 核心机制（借 ScrollToStudy「无限的不是内容，而是题目」与错题回插）：
 * 1. 不调 LLM：对到期复习或近期学过的条目，如果某个形式在已读剧集的叙述行（台词/旁白）中恰好出现过一次，
 *    即可就地挖空生成一道 cloze 填空题。
 * 2. 0 毫秒即时生成：作为后台调用大模型生成新一集时的「等待过渡互动（Filler Card）」，
 *    彻底消除用户等待生成时的空转卡顿。
 * 3. 严格遵循防启动规则（R4）：只从更早已读批次取材，取材句子不提前泄露本批内容。
 */
import { locateForm, type TextUnit } from '@endless/esl';
import type { Lexicon } from '@endless/learning';
import type { Library } from '@endless/player';

export interface DeriveOptions {
  brief: { review: { item: string }[] };
  /** 已播放批次：batchId → 该批文本单元（只含更早批次） */
  priorTexts: Map<string, TextUnit[]>;
  lexicon: {
    formsOf(item: string): string[] | undefined;
    confusables?(item: string): string[];
  };
  /** 最近答错的条目（错题回插，优先派生） */
  recentlyWrong: string[];
  /** 本批基本场景数（用于 25% 上限） */
  baseCards: number;
  /** 本批已被占用的场景 id（生成新 id 用） */
  usedSceneIds: string[];
}

export interface DerivedPlan {
  /** 直接追加进 scenes 的 derive 场景规范 */
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

/** 前端播放器在等待 AI 生成时即时消费的填缝交互卡 */
export interface FillerCard {
  id: string;
  item: string;
  itemLabel: string;
  itemGloss: string;
  sourceEpisodeId: string;
  sourceEpisodeTitle: string;
  sourceText: string;
  clozePrompt: string;
  options: { label: string; correct: boolean }[];
  feedback: {
    on_correct: string;
    on_wrong: string;
  };
}

const MAX_DERIVED_PER_BATCH = 1;
const MAX_DERIVED_RATIO = 0.25;

/** 下一个可用场景 id：s1..s99 里取第一个没被占用的。 */
function nextSceneId(used: string[]): string {
  const taken = new Set(used);
  for (let i = 1; i < 100; i++) {
    const id = `s${i}`;
    if (!taken.has(id)) return id;
  }
  return `s${used.length + 1}`;
}

/**
 * 从 Library 中提取所有已播放剧集的叙述性文本单元（气泡、对白、旁白）。
 */
export function extractPriorTexts(library: Library): Map<string, TextUnit[]> {
  const map = new Map<string, TextUnit[]>();
  for (const episode of library.episodes) {
    const units: TextUnit[] = [];
    let sceneIndex = 0;
    const sceneIdMap = new Map<string, number>();
    for (const node of episode.ast.nodes) {
      if (node.type === 'scene') {
        sceneIdMap.set(node.id, sceneIndex++);
      }
    }
    for (const node of episode.ast.nodes) {
      if (node.type === 'bubble') {
        const sceneId = node.parent?.split('.')[0] ?? '';
        const path = node.id.slice(sceneId.length + 1);
        units.push({
          sceneId,
          sceneIndex: sceneIdMap.get(sceneId) ?? 0,
          path,
          role: 'narrative',
          speaker: typeof node.data.speaker === 'string' ? node.data.speaker : undefined,
          text: typeof node.data.text === 'string' ? node.data.text : '',
        });
      } else if (node.type === 'message') {
        const sceneId = node.parent ?? '';
        const path = node.id.slice(sceneId.length + 1);
        units.push({
          sceneId,
          sceneIndex: sceneIdMap.get(sceneId) ?? 0,
          path,
          role: 'narrative',
          speaker: typeof node.data.from === 'string' ? node.data.from : undefined,
          text: typeof node.data.text === 'string' ? node.data.text : '',
        });
      } else if (node.type === 'panel' && typeof node.data.caption === 'string' && node.data.caption) {
        const sceneId = node.parent ?? '';
        const path = node.id.slice(sceneId.length + 1);
        units.push({
          sceneId,
          sceneIndex: sceneIdMap.get(sceneId) ?? 0,
          path,
          role: 'narrative',
          text: node.data.caption,
        });
      }
    }
    map.set(episode.id, units);
  }
  return map;
}

/** 在更早批次里找到「包含该条目某个形式恰好一次」的最近一句话。 */
export function findPriorSentence(
  priorTexts: Map<string, TextUnit[]>,
  forms: string[],
): { from: string; batch: string; text: string; matchedForm: string; hit: { start: number; end: number } } | null {
  const batches = [...priorTexts.keys()];
  for (let i = batches.length - 1; i >= 0; i--) {
    const batchId = batches[i]!;
    const units = priorTexts.get(batchId) ?? [];
    for (const u of units) {
      if (!u.text || u.role !== 'narrative') continue;
      let totalOccurrences = 0;
      let singleHit: { form: string; start: number; end: number } | null = null;

      for (const form of forms) {
        if (!form) continue;
        const hits = locateForm(u.text, form);
        totalOccurrences += hits.length;
        if (hits.length === 1 && !singleHit) {
          singleHit = { form, start: hits[0]!.start, end: hits[0]!.end };
        }
      }

      // 必须在一句话中恰好出现一次目标词，挖空后才有明确的语义唯一解
      if (totalOccurrences === 1 && singleHit) {
        return {
          from: `${batchId}.${u.sceneId}.${u.path}`,
          batch: batchId,
          text: u.text,
          matchedForm: singleHit.form,
          hit: { start: singleHit.start, end: singleHit.end },
        };
      }
    }
  }
  return null;
}

/**
 * 编译/实验流派生规划器（与 lab/deriver 语义完全对齐）。
 */
export function planDerivedScene(opts: DeriveOptions): DerivedPlan | null {
  if (MAX_DERIVED_PER_BATCH < 1) return null;
  const totalAfter = opts.baseCards + MAX_DERIVED_PER_BATCH;
  if (MAX_DERIVED_PER_BATCH / totalAfter > MAX_DERIVED_RATIO) return null;

  const wrong = new Set(opts.recentlyWrong);
  const ordered = [...opts.brief.review].sort((a, b) => Number(wrong.has(b.item)) - Number(wrong.has(a.item)));

  for (const r of ordered) {
    const forms = (opts.lexicon.formsOf(r.item) ?? []).filter(Boolean);
    if (forms.length === 0) continue;
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

/**
 * 生成等待期间，为前端直接产出 0 毫秒立即可互动的填缝卡（FillerCard）。
 */
export function deriveFillerCard(
  library: Library,
  lexicon: Lexicon,
  options: {
    wrongItems?: string[];
    candidates?: string[];
  } = {},
): FillerCard | null {
  const priorTexts = extractPriorTexts(library);
  const wrongSet = new Set(options.wrongItems ?? []);

  // 候选条目池：优先答错条目 -> 传入的 candidates -> 词库中已有的 sense 条目
  const targetItems: string[] = [];
  if (options.wrongItems?.length) targetItems.push(...options.wrongItems);
  if (options.candidates?.length) targetItems.push(...options.candidates);
  if (!targetItems.length) {
    for (const [item, entry] of lexicon.entries.entries()) {
      if (entry.kind === 'sense') targetItems.push(item);
    }
  }

  // 排序：错题最优先
  const uniqueItems = [...new Set(targetItems)].sort((a, b) => Number(wrongSet.has(b)) - Number(wrongSet.has(a)));

  for (const item of uniqueItems) {
    const entry = lexicon.entries.get(item);
    const forms = lexicon.forms.get(item) ?? [];
    if (!entry || !forms.length) continue;

    const found = findPriorSentence(priorTexts, forms);
    if (!found) continue;

    const episode = library.episodes.find((e) => e.id === found.batch);
    const episodeTitle = episode?.title ?? '已读故事';

    const clozePrompt = found.text.slice(0, found.hit.start) + '____' + found.text.slice(found.hit.end);
    const correctForm = found.matchedForm;

    // 收集干扰项：优先 confusables，不足时补充同词性词
    const distractors: string[] = [];
    const confusables = entry.confusables ?? [];
    for (const cid of confusables) {
      const f = (lexicon.forms.get(cid) ?? [])[0];
      if (f && f.toLowerCase() !== correctForm.toLowerCase() && !distractors.includes(f)) {
        distractors.push(f);
      }
    }

    if (distractors.length < 3) {
      for (const [otherItem, otherEntry] of lexicon.entries.entries()) {
        if (otherItem === item || otherEntry.pos !== entry.pos) continue;
        const f = (lexicon.forms.get(otherItem) ?? [])[0];
        if (f && f.toLowerCase() !== correctForm.toLowerCase() && !distractors.includes(f)) {
          distractors.push(f);
          if (distractors.length >= 3) break;
        }
      }
    }

    // 仍不足时从全词表中任取不重复的形式
    if (distractors.length < 3) {
      for (const formsList of lexicon.forms.values()) {
        const f = formsList[0];
        if (f && f.toLowerCase() !== correctForm.toLowerCase() && !distractors.includes(f)) {
          distractors.push(f);
          if (distractors.length >= 3) break;
        }
      }
    }

    if (distractors.length < 3) continue;

    // 组装 4 个选项，按确定性哈希打乱位置
    const rawOptions = [
      { label: correctForm, correct: true },
      ...distractors.slice(0, 3).map((d) => ({ label: d, correct: false })),
    ];
    // 简单确定性洗牌：使用句首字符码
    const seed = found.text.charCodeAt(0) % 4;
    const shuffled = [
      rawOptions[seed % 4]!,
      rawOptions[(seed + 1) % 4]!,
      rawOptions[(seed + 2) % 4]!,
      rawOptions[(seed + 3) % 4]!,
    ];

    return {
      id: `filler-${found.from}`,
      item,
      itemLabel: entry.lemma ?? forms[0] ?? item,
      itemGloss: entry.gloss_zh ?? '',
      sourceEpisodeId: found.batch,
      sourceEpisodeTitle: episodeTitle,
      sourceText: found.text,
      clozePrompt,
      options: shuffled,
      feedback: {
        on_correct: `太棒了！「${correctForm}」正是原句中的正确用法。`,
        on_wrong: `这句原话用的是「${correctForm}」（${entry.gloss_zh ?? ''}）。`,
      },
    };
  }

  return null;
}
