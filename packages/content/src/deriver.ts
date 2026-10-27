/**
 * 程序派生的跨批检测与零延迟填缝引擎（B3）。
 *
 * 核心机制（借 ScrollToStudy「无限的不是内容，而是题目」与错题回插）：
 * 1. 不调 LLM：对到期复习或近期学过的条目，如果某个形式在已读剧集的叙述行（台词/旁白）中恰好出现过一次，
 *    即可就地挖空生成一道 cloze 填空题。取材只限真实阅读过的场景（readScenes 过滤），
 *    未读剧集与集内被跳过的场景绝不取材（R4：未展示内容不计入学习）。
 * 2. 0 毫秒即时生成：作为后台调用大模型生成新一集时的「等待过渡互动（Filler Card）」，
 *    彻底消除用户等待生成时的空转卡顿。
 * 3. 批次内 derive 场景的编译期规划（planDerivedScene）由 apps/lab/src/deriver.ts 独占实现，
 *    本文件只保留运行时真正消费的取材与填缝部分。
 */
import { locateForm, type TextUnit } from '@endless/esl';
import type { Lexicon } from '@endless/learning';
import type { Library } from '@endless/player';

/** 生成等待期间，为前端直接产出 0 毫秒立即可互动的填缝交互卡 */
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

/**
 * 从 Library 中提取所有已播放剧集的叙述性文本单元（气泡、对白、旁白）。
 * 注意：这里不做阅读状态过滤，调用方（deriveFillerCard）用 readScenes 过滤真实读过的场景。
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
 * 生成等待期间，为前端直接产出 0 毫秒立即可互动的填缝卡（FillerCard）。
 * readScenes：真实读过的场景集合（`episodeId.sceneId`）；提供时只从这些场景取材，
 * 未读剧集与被跳过的场景绝不出现（R4：未展示内容不计入学习）。
 */
export function deriveFillerCard(
  library: Library,
  lexicon: Lexicon,
  options: {
    wrongItems?: string[];
    candidates?: string[];
    readScenes?: Set<string>;
  } = {},
): FillerCard | null {
  const allTexts = extractPriorTexts(library);
  const priorTexts = options.readScenes
    ? new Map(
        [...allTexts]
          .map(([batchId, units]) => [batchId, units.filter((u) => options.readScenes!.has(`${batchId}.${u.sceneId}`))] as const)
          .filter(([, units]) => units.length > 0),
      )
    : allTexts;
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

    // 收集干扰项：优先 confusables，不足时补充同词性词。
    // 干扰项与正确答案取同一屈折位置的形式（词库 forms 顺序为 原形/三单/过去式/进行式），
    // 避免「正确项是过去式、干扰项全是原形」这种靠词形就能猜出的泄底。
    const matchedIndex = Math.max(0, forms.indexOf(found.matchedForm));
    const alignedForm = (otherItem: string): string | null => {
      const f = (lexicon.forms.get(otherItem) ?? [])[matchedIndex];
      return f && f.toLowerCase() !== correctForm.toLowerCase() ? f : null;
    };
    const distractors: string[] = [];
    const pushDistractor = (f: string | null): void => {
      if (f && !distractors.includes(f)) distractors.push(f);
    };

    for (const cid of entry.confusables ?? []) {
      pushDistractor(alignedForm(cid));
    }

    if (distractors.length < 3) {
      for (const [otherItem, otherEntry] of lexicon.entries.entries()) {
        if (otherItem === item || otherEntry.pos !== entry.pos) continue;
        pushDistractor(alignedForm(otherItem));
        if (distractors.length >= 3) break;
      }
    }

    // 仍不足时从全词表中任取同屈折位置的形式
    if (distractors.length < 3) {
      for (const formsList of lexicon.forms.values()) {
        pushDistractor(formsList[matchedIndex] ?? null);
        if (distractors.length >= 3) break;
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
