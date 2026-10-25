/**
 * EDITION-DRAFT/1 确定性编译器（设计文档 §9.3）。
 *
 * 模型写的只是「用哪个已批准正文、什么教学情境、考哪个目标」；
 * 场景 ID、正文面板切分、选项顺序、证据类型、来源标签、`uses` 全部由程序产出。
 * 同一草稿 + 同一冻结依据 + 同一编译器版本必须得到同一份可执行批次；
 * 验收与恢复都靠「重新编译并逐项比较」，而不是相信模型报的 URL 或哈希。
 */
import {
  locateForm, tokenize,
  EVIDENCE_RANK,
  type Batch, type ChatSceneT, type Scene, type ValidationIssue,
} from '@endless/esl';
import type { PassageRevision } from './sources.js';
import {
  EDITION_COMPILER_VERSION, EDITION_COMPILER_VERSION_V1, EDITION_COMPILER_VERSIONS,
  EDITION_DRAFT_PROTOCOL,
  type Cefr, type EditionCreation, type EditionSourceBinding, type UnitLevelPlan,
} from './contract.js';
import { materialBackgrounds, materialCharacters, materialPictureOf, materialProps } from '../materials.js';
import { parseChoiceLines, parseEditionDraft, type EditionDraftComponent } from './draft.js';
import type { LanguageEntry, LanguagePackRevision } from './language.js';
import { contextFingerprint, normalizeForDigest, sha256Hex } from './digest.js';

export const EDITION_CHANNEL = 'edition' as const;
const SKINS = ['messenger', 'dating', 'forum', 'news_comments'] as const;

export interface EditionTarget {
  /** 提示词与草稿里的短名：t1、t2… */
  alias: string;
  item: string;
  entry: LanguageEntry;
  /** 本单元首次教学：需要两处真实语境 + 一次练习。 */
  introduce: boolean;
}

export interface EditionPassage {
  alias: string;
  revision: PassageRevision;
}

export interface EditionPriorLine { reference: string; text: string }

export interface EditionCompileInput {
  /** 修订 ID 作为编译种子：同一修订重新编译选项位置不变，新修订才可能不同。 */
  seed: string;
  batchId: string;
  unitId: string;
  cefr: Cefr;
  plan: UnitLevelPlan;
  pack: LanguagePackRevision;
  passages: EditionPassage[];
  targets: EditionTarget[];
  /** 仅真实读过的历史行；未读内容不能当取材来源。 */
  priorLines?: EditionPriorLine[];
  /** 阅读场景使用的注册背景（程序选择，模型不能指定外部素材）。 */
  readingBackground?: string;
  /** 目录允许的角色（编辑计划中的教学情境角色）。 */
  allowedCharacters?: readonly string[];
  /** 传入批量校验器（结构 / 素材 / 学习证据）。 */
  validate?: (batch: Batch) => ValidationIssue[];
  /**
   * 编译器版本：复核旧修订时传入其冻结的 `basis.compilerVersion`，
   * 新编译缺省为当前版本。旧版本按原语义重放，不套新修正。
   */
  compilerVersion?: string;
}

export interface EditionTeachingReport {
  contexts: { item: string; scenes: string[]; distinct: number }[];
  practiceItems: string[];
  narrativeWords: number;
  estimatedMinutes: number;
}

export interface EditionCompileSuccess {
  ok: true;
  batch: Batch;
  title: string;
  subtitle: string;
  description: string;
  creation: EditionCreation;
  teaching: EditionTeachingReport;
}

export type EditionCompileResult = EditionCompileSuccess | { ok: false; issues: ValidationIssue[] };

const error = (issues: ValidationIssue[], message: string, scene?: string) =>
  issues.push({ code: 'E-EDITION-COMPILE', level: 'error', message, ...(scene ? { scene } : {}) });

/** FNV-1a 32 位：正确选项位置由修订种子 + 场次 + 短名决定，不总在第一个。 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function placeCorrect<T>(correct: T, others: T[], seedKey: string): T[] {
  const options = [...others];
  options.splice(fnv1a32(seedKey) % (options.length + 1), 0, correct);
  return options;
}

/** 句子切分保留原文字符片段：面板 caption 拼接后必须等于被审阅的正文。 */
function sentencesOf(text: string): string[] {
  const normalized = normalizeForDigest(text);
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+["')\]]?\s+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized))) {
    const end = match.index + match[0].length;
    out.push(normalized.slice(start, end).trim());
    start = end;
  }
  if (start < normalized.length) out.push(normalized.slice(start).trim());
  return out.filter(Boolean);
}

export function compileEditionDraft(raw: string, input: EditionCompileInput): EditionCompileResult {
  const issues: ValidationIssue[] = [];
  const compilerVersion = input.compilerVersion ?? EDITION_COMPILER_VERSION;
  if (!EDITION_COMPILER_VERSIONS.includes(compilerVersion)) {
    return { ok: false, issues: [{ code: 'E-EDITION-COMPILE', level: 'error', message: `编译器版本不受支持：${compilerVersion}` }] };
  }
  // 旧版本只服务于既有冻结数据的复核：按原语义重放，不套用新修正。
  const legacy = compilerVersion === EDITION_COMPILER_VERSION_V1;
  const parsed = parseEditionDraft(raw);
  if (!parsed.ok) return parsed;
  const { meta, components } = parsed.draft;

  const entryOf = new Map(input.targets.map((target) => [target.alias, target]));
  const passageOf = new Map(input.passages.map((passage) => [passage.alias, passage]));
  const backgrounds = new Set<string>(materialBackgrounds.map((b) => b.id));
  const characters = new Set<string>(input.allowedCharacters ?? materialCharacters.map((entry) => entry.id));
  const props = new Set(materialProps.map((prop) => prop.id));
  const readingBackground = input.readingBackground && backgrounds.has(input.readingBackground)
    ? input.readingBackground : 'cafe';

  const scenes: Scene[] = [];
  const narrative: { sceneId: string; text: string; kind: 'reading' | 'comic' | 'chat'; reference: string }[] = [];
  const sources: EditionSourceBinding[] = [];
  const passageBindings: EditionCreation['passageBindings'] = [];
  const sceneSources: Record<string, string> = {};
  const usedCharacters = new Set<string>();
  const cast = (id: string, where: string): boolean => {
    if (!characters.has(id)) {
      error(issues, `${where}：角色 ${id} 不在本刊允许的角色表（${[...characters].join('/')}）`);
      return false;
    }
    usedCharacters.add(id);
    return true;
  };
  const nextSceneId = () => `s${scenes.length + 1}`;
  /** 正文里的真实句子（只统计已批准正文与本单元已生成的叙述行）。 */
  const readingLines = () => narrative.filter((line) => line.kind === 'reading');

  const formsOf = (item: string): string[] => input.pack.entries.find((entry) => entry.item === item)?.forms ?? [];
  const entryByItem = (item: string): LanguageEntry | undefined => input.pack.entries.find((entry) => entry.item === item);

  const distractorGlosses = (item: string, count: number): string[] => {
    const own = entryByItem(item)?.glossZh;
    const pool: string[] = [];
    const push = (id: string) => {
      const gloss = entryByItem(id)?.glossZh;
      if (gloss && gloss !== own && !pool.includes(gloss)) pool.push(gloss);
    };
    for (const id of entryByItem(item)?.confusables ?? []) push(id);
    for (const entry of [...input.pack.entries].sort((a, b) => a.freqBand - b.freqBand || a.item.localeCompare(b.item))) push(entry.item);
    return pool.slice(0, count);
  };
  const distractorForms = (item: string, count: number, own: ReadonlySet<string>): string[] => {
    const pool: string[] = [];
    const push = (id: string) => {
      for (const form of entryByItem(id)?.forms ?? []) {
        if (!own.has(form.toLowerCase()) && !pool.includes(form)) pool.push(form);
      }
    };
    for (const id of entryByItem(item)?.confusables ?? []) push(id);
    const pos = entryByItem(item)?.pos;
    for (const entry of [...input.pack.entries].sort((a, b) => a.freqBand - b.freqBand || a.item.localeCompare(b.item))) {
      if (entry.pos === pos) push(entry.item);
    }
    return pool.slice(0, count);
  };

  /** 在已批准正文里找一句恰好出现一次目标形式的话（cloze / sentence 的取材）。 */
  const findReviewedLine = (item: string) => {
    const forms = formsOf(item);
    for (const line of readingLines()) {
      let count = 0;
      let hit: { form: string; start: number; end: number } | undefined;
      for (const form of forms) {
        for (const found of locateForm(line.text, form)) {
          count++;
          hit ??= { form, start: found.start, end: found.end };
        }
      }
      if (count === 1 && hit) return { line, ...hit };
    }
    return null;
  };

  const addReading = (component: EditionDraftComponent) => {
    const passage = passageOf.get(component.arg ?? '');
    if (!passage) {
      error(issues, `@reading 引用了未批准的正文 ${component.arg}`);
      return;
    }
    if (component.lines.some((line) => line.trim())) {
      error(issues, '@reading 不允许附加正文：正文只能来自已批准的分级资产');
      return;
    }
    if (!passage.revision.textSegments.length) {
      error(issues, `正文 ${passage.alias} 没有可编译的段落`);
      return;
    }
    let segmentIndex = 0;
    for (const segment of passage.revision.textSegments) {
      const sentences = sentencesOf(segment.text);
      if (!sentences.length) continue;
      const panels: { caption: string }[] = [];
      let buffer: string[] = [];
      let words = 0;
      const flush = () => {
        if (buffer.length) {
          panels.push({ caption: buffer.join(' ') });
          buffer = [];
          words = 0;
        }
      };
      for (const sentence of sentences) {
        const count = tokenize(sentence).length;
        if (buffer.length >= 2 || words + count > 22) flush();
        buffer.push(sentence);
        words += count;
      }
      flush();
      for (let index = 0; index < panels.length; index += 4) {
        const chunk = panels.slice(index, index + 4);
        const id = nextSceneId();
        const scene: Scene = {
          id, type: 'comic', setting: `@tag:${readingBackground}`,
          panels: chunk.map((panel, panelIndex) => ({
            shot: chunk.length === 1 ? 'wide' : panelIndex === 0 ? 'wide' : panelIndex === chunk.length - 1 ? 'close' : 'medium',
            actors: [], props: [], bubbles: [], caption: panel.caption,
          })),
        };
        scenes.push(scene);
        sceneSources[id] = '已审阅正文 · 原文';
        for (const panel of chunk) {
          narrative.push({ sceneId: id, text: panel.caption, kind: 'reading', reference: `${passage.revision.id}#seg${segmentIndex}` });
          sources.push({
            sceneId: id, field: 'passage', reference: `${passage.revision.id}#seg${segmentIndex}`,
            text: panel.caption, hash: digestText(panel.caption),
          });
        }
        passageBindings.push({ sceneId: id, passageRevisionId: passage.revision.id, segmentIndex });
      }
      segmentIndex += 1;
    }
  };

  const addComic = (component: EditionDraftComponent) => {
    const background = component.arg ?? '';
    if (!backgrounds.has(background)) {
      error(issues, `背景 ${background} 不在注册素材目录`);
      return;
    }
    const dialogues: { who: string; expr?: string; text: string }[] = [];
    const sceneProps: string[] = [];
    let bad = false;
    for (const raw of component.lines) {
      const line = raw.trim();
      if (!line) continue;
      const prop = line.match(/^prop\s*:\s*([a-z0-9_]+)$/);
      if (prop) {
        if (!props.has(prop[1]!)) { error(issues, `道具 ${prop[1]} 不在素材目录`); bad = true; }
        else if (sceneProps.length >= 3) { error(issues, '每个漫画块最多三个道具'); bad = true; }
        else sceneProps.push(prop[1]!);
        continue;
      }
      const dialogue = line.match(/^([a-z][a-z0-9_]*)(?:\.([a-z]+))?\s*:\s*(.+)$/);
      if (!dialogue) { error(issues, `漫画行无法识别：${line.slice(0, 30)}`); bad = true; continue; }
      const [, who, expr, text] = dialogue;
      if (!cast(who!, '漫画')) bad = true;
      const spec = materialCharacters.find((entry) => entry.id === who)?.spec;
      if (expr && !spec?.expr.includes(expr)) { error(issues, `表情 ${expr} 不在 ${who} 的表情目录`); bad = true; }
      dialogues.push({ who: who!, expr, text: text! });
    }
    if (dialogues.length < 1 || dialogues.length > 4) { error(issues, '漫画需要 1–4 行台词'); bad = true; }
    if (bad) return;
    const id = nextSceneId();
    const shotOf = (index: number, total: number) =>
      total === 1 ? 'wide' : index === 0 ? 'wide' : index === total - 1 ? 'close' : 'medium';
    scenes.push({
      id, type: 'comic', setting: `@tag:${background}`,
      cast: [...new Set(dialogues.map((entry) => entry.who))],
      panels: dialogues.map((entry, index) => ({
        shot: shotOf(index, dialogues.length),
        actors: [`@char:${entry.who}${entry.expr ? `{expr=${entry.expr}}` : ''}`],
        props: index === 0 ? sceneProps.map((prop) => `@emoji:${prop}`) : [],
        bubbles: [{ speaker: entry.who, text: entry.text }],
      })),
    });
    sceneSources[id] = '教学情境（虚构）';
    for (const entry of dialogues) narrative.push({ sceneId: id, text: entry.text, kind: 'comic', reference: `draft.${id}` });
  };

  const addChat = (component: EditionDraftComponent, isPost: boolean) => {
    const skin = isPost ? 'forum' : (component.arg ?? '');
    if (!isPost && !SKINS.includes(skin as (typeof SKINS)[number])) {
      error(issues, `chat 需要 skin：${SKINS.join(' / ')}`);
      return;
    }
    const messages: { from: string; text: string }[] = [];
    const replyLines: string[] = [];
    let replyTarget: string | null = null;
    let bad = false;
    for (const raw of component.lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line === '@reply' || line.startsWith('@reply ')) {
        if (isPost || replyTarget !== null) { error(issues, '@reply 只能出现一次，且不在 post 中'); bad = true; continue; }
        replyTarget = line.slice(6).trim();
        continue;
      }
      if (replyTarget !== null) { replyLines.push(line); continue; }
      if (isPost) {
        const text = line.match(/^text\s*:\s*(.+)$/);
        if (!text) { error(issues, `post 只接受 text: 行：${line.slice(0, 30)}`); bad = true; continue; }
        if (!cast(component.arg ?? '', '短帖')) bad = true;
        messages.push({ from: component.arg ?? '', text: text[1]! });
        continue;
      }
      const message = line.match(/^([a-z][a-z0-9_]*)\s*:\s*(.+)$/);
      if (!message) { error(issues, `chat 行无法识别：${line.slice(0, 30)}`); bad = true; continue; }
      if (!cast(message[1]!, '对话')) bad = true;
      messages.push({ from: message[1]!, text: message[2]! });
    }
    if (messages.length < 1 || messages.length > 8) { error(issues, 'chat 需要 1–8 条消息'); bad = true; }
    let reply: ChatSceneT['reply'];
    let replyEvidence: { item: string; type: 'practice' } | undefined;
    if (replyTarget !== null) {
      if (!messages.length) { error(issues, '@reply 之前至少需要一条消息'); bad = true; }
      const target = entryOf.get(replyTarget);
      if (!target) { error(issues, `@reply 目标 ${replyTarget} 不是本单元的目标短名`); bad = true; }
      const choice = parseChoiceLines(replyLines, issues, 'chat 的 @reply');
      if (target && choice) {
        const options = placeCorrect(choice.correct, choice.distractors, `${input.seed}:${scenes.length + 1}:${target.alias}`);
        const answerLinked = target.entry.forms.some((form) => locateForm(choice.correct, form).length)
          || choice.correct.trim() === target.entry.glossZh;
        if (!answerLinked) {
          error(issues, `@reply ${target.alias}：+ 正确选项必须包含目标形式，或与语言包词义完全一致`);
          bad = true;
        } else if (!bad) {
          reply = {
            prompt: choice.prompt,
            options: options.map((label) => ({ label, ...(label === choice.correct ? { correct: true } : {}) })),
            on_correct: { from: messages[0]!.from, text: choice.feedback },
            on_wrong: { from: messages[0]!.from, text: choice.feedback },
          };
          // 正文内互动一律 practice：不因四个选项或答对写 FSRS
          replyEvidence = { item: target.item, type: 'practice' };
        }
      } else bad = true;
    }
    if (bad) return;
    const id = nextSceneId();
    scenes.push({
      id, type: 'chat', skin: skin as ChatSceneT['skin'],
      cast: [...new Set(messages.map((entry) => entry.from))],
      messages,
      ...(reply ? { reply } : {}),
      ...(replyEvidence ? { evidence: replyEvidence } : {}),
    });
    sceneSources[id] = '教学情境（虚构）';
    for (const entry of messages) narrative.push({ sceneId: id, text: entry.text, kind: 'chat', reference: `draft.${id}` });
  };

  const addQuiz = (component: EditionDraftComponent) => {
    const target = entryOf.get(component.arg2 ?? '');
    const kind = component.arg ?? '';
    if (!target) { error(issues, `@quiz 目标 ${component.arg2} 不是本单元的目标短名`); return; }
    if (!['meaning', 'cloze', 'sentence', 'find'].includes(kind)) {
      error(issues, 'quiz 需要类型：meaning / cloze / sentence / find');
      return;
    }
    if (component.lines.some((line) => line.trim())) { error(issues, 'quiz 组件不接受正文；材料由程序构造'); return; }
    const id = nextSceneId();
    const ordinal = scenes.length + 1;
    const forms = target.entry.forms;
    const own = new Set(forms.map((form) => form.toLowerCase()));
    const build = (
      sceneKind: 'meaning' | 'cloze' | 'sentence' | 'find',
      prompt: string,
      correct: string,
      distractors: string[],
      optionAssets?: (string | undefined)[],
      source?: { reference: string; text: string; label: string },
    ) => {
      const picked = distractors.slice(0, 3);
      const ordered = placeCorrect(correct, picked, `${input.seed}:${ordinal}:${target.alias}:${sceneKind}`);
      const correctIndex = ordered.indexOf(correct);
      const scene: Scene = {
        id, type: 'quiz', kind: sceneKind, item: target.item, prompt,
        options: ordered.map((label, index) => {
          const asset = optionAssets?.[index === correctIndex ? 0 : picked.indexOf(label) + 1];
          // v2 按位置标记正确项，避免重名标签被重复标记；v1 重放原标签匹配。
          const isCorrect = legacy ? label === correct : index === correctIndex;
          return { label, ...(isCorrect ? { correct: true } : {}), ...(asset ? { asset } : {}) };
        }),
        feedback: { on_correct: `答对了——「${correct}」。`, on_wrong: `再想想——正确的是「${correct}」。` },
        evidence: { item: target.item, type: 'practice' },
      };
      scenes.push(scene);
      if (source) {
        sources.push({ sceneId: id, field: 'prior', reference: source.reference, text: source.text, hash: digestText(source.text) });
        sceneSources[id] = source.label;
      } else sceneSources[id] = '本地语言包';
    };
    if (kind === 'meaning') {
      const form = forms[0];
      if (!form) { error(issues, `@quiz meaning：${target.alias} 缺少词形`); return; }
      build('meaning', `「${form}」是什么意思？`, target.entry.glossZh, distractorGlosses(target.item, 3));
      return;
    }
    if (kind === 'find') {
      const prop = materialPictureOf(target.item);
      if (!prop) { error(issues, `@quiz find：${target.item} 没有登记图片素材，不能编造图案`); return; }
      // 干扰图：v1 固定取前三件，v2 用修订种子做确定性抽样，并排除与答案同名道具。
      const others = legacy
        ? materialProps.filter((prop2) => prop2.id !== prop).slice(0, 3)
        : materialProps
          .filter((prop2) => prop2.id !== prop && prop2.label !== target.entry.glossZh)
          .map((prop2) => ({ prop2, key: fnv1a32(`${input.seed}:${id}:${target.item}:${prop2.id}`) }))
          .sort((a, b) => a.key - b.key || a.prop2.id.localeCompare(b.prop2.id))
          .slice(0, 3)
          .map((entry) => entry.prop2);
      build('find', `「${forms[0]}」是哪一个？`, target.entry.glossZh, others.map((entry) => entry.label),
        [undefined, ...others.map((entry) => `@emoji:${entry.id}`)]);
      const scene = scenes.at(-1);
      if (scene && scene.type === 'quiz') {
        const index = scene.options.findIndex((option) => option.correct);
        if (index >= 0) scene.options[index]!.asset = `@emoji:${prop}`;
      }
      return;
    }
    const found = findReviewedLine(target.item);
    if (!found) {
      error(issues, `@quiz ${kind}：在已批准正文里找不到含 ${target.alias} 恰好一次的原句`);
      return;
    }
    if (kind === 'cloze') {
      const prompt = `${found.line.text.slice(0, found.start)}____${found.line.text.slice(found.end)}`;
      build('cloze', prompt, found.form, distractorForms(target.item, 3, own), undefined,
        { reference: found.line.reference, text: found.line.text, label: '已审阅正文 · 原句' });
      return;
    }
    const swaps = distractorForms(target.item, 3, own)
      .map((form) => `${found.line.text.slice(0, found.start)}${form}${found.line.text.slice(found.end)}`)
      .filter((sentence) => sentence !== found.line.text);
    if (!swaps.length) { error(issues, `@quiz sentence：无法构造与原文不同的干扰句`); return; }
    build('sentence', '哪一句在正文里真的出现过？', found.line.text, swaps, undefined,
      { reference: found.line.reference, text: found.line.text, label: '已审阅正文 · 原句' });
  };

  const addCard = (component: EditionDraftComponent) => {
    const target = entryOf.get(component.arg ?? '');
    if (!target) { error(issues, `@card 目标 ${component.arg} 不是本单元的目标短名`); return; }
    if (component.lines.some((line) => line.trim())) { error(issues, 'card 组件不接受正文'); return; }
    const line = narrative.find((entry) => formsOf(target.item).some((form) => locateForm(entry.text, form).length));
    if (!line) { error(issues, `@card：本单元前文没有含 ${target.alias} 的原句，无法取材`); return; }
    const id = nextSceneId();
    const card: Scene = {
      id, type: 'card', item: target.item, front: line.text,
      uses: [target.item], evidence: { item: target.item, type: 'practice' },
    };
    scenes.push(card);
    sceneSources[id] = line.kind === 'reading' ? '已审阅正文 · 原句' : '本单元原句';
    sources.push({
      sceneId: id, field: 'prior',
      reference: line.kind === 'reading' ? 'passage' : `draft.${line.sceneId}`,
      text: line.text, hash: digestText(line.text),
    });
  };

  const addFact = (component: EditionDraftComponent, kind: 'fact' | 'example') => {
    const target = entryOf.get(component.arg ?? '');
    if (!target) { error(issues, `@${kind} 目标 ${component.arg} 不是本单元的目标短名`); return; }
    if (component.lines.some((line) => line.trim())) { error(issues, `${kind} 组件不接受正文`); return; }
    const entry = target.entry;
    if (kind === 'fact') {
      const form = entry.forms[0];
      if (!form || !entry.glossZh) { error(issues, `fact：${target.item} 缺少词形或词义`); return; }
      const id = nextSceneId();
      scenes.push({
        id, type: 'card', item: target.item, front: `${form} — ${entry.glossZh}`,
        uses: [target.item], evidence: { item: target.item, type: 'practice' },
      });
      sceneSources[id] = '本地语言包 · 词义';
      sources.push({ sceneId: id, field: 'gloss', reference: entry.sourceRef, text: entry.glossZh, hash: digestText(entry.glossZh) });
      // v1 缺陷重放：词义串曾进入叙述原句池（被 @card 取材、被语境覆盖误计）。
      // 新版本不再注入；fact 已通过 scene.uses 与 sources(gloss) 绑定目标词。
      if (legacy) {
        narrative.push({ sceneId: id, text: `${form} — ${entry.glossZh}`, kind: 'comic', reference: entry.sourceRef });
      }
      return;
    }
    const example = entry.example;
    if (!example || !entry.forms.some((form) => locateForm(example, form).length)) {
      error(issues, `example：${target.item} 没有含目标形式的语言包例句，不能用编造材料代替`);
      return;
    }
    const id = nextSceneId();
    scenes.push({
      id, type: 'card', item: target.item, front: example,
      uses: [target.item], evidence: { item: target.item, type: 'practice' },
    });
    sceneSources[id] = '本地语言包 · 例句';
    sources.push({ sceneId: id, field: 'example', reference: entry.sourceRef, text: example, hash: digestText(example) });
    narrative.push({ sceneId: id, text: example, kind: 'comic', reference: entry.sourceRef });
  };

  const addChoice = (component: EditionDraftComponent) => {
    const target = entryOf.get(component.arg ?? '');
    if (!target) { error(issues, `@choice 目标 ${component.arg} 不是本单元的目标短名`); return; }
    const choice = parseChoiceLines(component.lines, issues, `choice ${target.alias}`);
    if (!choice) return;
    const linked = target.entry.forms.some((form) => locateForm(choice.correct, form).length)
      || choice.correct.trim() === target.entry.glossZh;
    if (!linked) { error(issues, `choice ${target.alias}：+ 正确选项必须包含目标形式，或与语言包词义完全一致`); return; }
    const options = placeCorrect(choice.correct, choice.distractors, `${input.seed}:${scenes.length + 1}:${target.alias}:choice`);
    const id = nextSceneId();
    scenes.push({
      id, type: 'pick', question: choice.prompt,
      options: options.map((label) => ({ label, ...(label === choice.correct ? { correct: true } : {}) })),
      feedback: { on_correct: choice.feedback, on_wrong: choice.feedback },
      evidence: { item: target.item, type: 'practice' },
    });
    sceneSources[id] = '教学情境（虚构）';
  };

  for (const component of components) {
    switch (component.type) {
      case 'reading': addReading(component); break;
      case 'comic': addComic(component); break;
      case 'chat': addChat(component, false); break;
      case 'post': addChat(component, true); break;
      case 'quiz': addQuiz(component); break;
      case 'card': addCard(component); break;
      case 'fact': addFact(component, 'fact'); break;
      case 'example': addFact(component, 'example'); break;
      case 'choice': addChoice(component); break;
    }
  }

  if (issues.some((issue) => issue.level === 'error')) return { ok: false, issues };
  if (!scenes.length) return { ok: false, issues: [{ code: 'E-EDITION-COMPILE', level: 'error', message: '编译后没有任何场景' }] };

  // ---------- 教学覆盖：两处语义不同的真实语境 + 一次练习 ----------
  const contextScenes = new Map<string, { scenes: Set<string>; fingerprints: Set<string> }>();
  for (const line of narrative) {
    for (const target of input.targets) {
      if (!target.introduce) continue;
      if (!target.entry.forms.some((form) => locateForm(line.text, form).length)) continue;
      const bucket = contextScenes.get(target.item) ?? { scenes: new Set<string>(), fingerprints: new Set<string>() };
      bucket.scenes.add(line.sceneId);
      bucket.fingerprints.add(contextFingerprint(line.text));
      contextScenes.set(target.item, bucket);
    }
  }
  const practiceItems = new Set<string>();
  for (const scene of scenes) {
    if (scene.type === 'pick' || scene.type === 'quiz') {
      if (scene.evidence?.type === 'practice') practiceItems.add(scene.evidence.item);
    } else if (scene.type === 'chat' && scene.reply && scene.evidence?.type === 'practice') {
      practiceItems.add(scene.evidence.item);
    }
  }
  for (const target of input.targets.filter((entry) => entry.introduce)) {
    const bucket = contextScenes.get(target.item);
    const distinct = bucket?.fingerprints.size ?? 0;
    if (distinct < 2) {
      error(issues, `新目标 ${target.item} 需要两处语义不同的真实正文语境（当前 ${distinct} 处）；仅换标点或重复同一句不算`);
    }
    if (!practiceItems.has(target.item)) {
      error(issues, `新目标 ${target.item} 缺少练习互动；翻词卡、fact/example 不能代替`);
    }
  }
  for (const scene of scenes) {
    if (scene.evidence && EVIDENCE_RANK[scene.evidence.type] > -1) {
      error(issues, '单元内互动只能记 practice/comprehension；合格检索放在独立复习段', scene.id);
    }
  }
  if (issues.some((issue) => issue.level === 'error')) return { ok: false, issues };

  // ---------- uses 推导 ----------
  const taskItems = input.targets.map((target) => target.item);
  for (const scene of scenes) {
    const texts: string[] = [];
    if (scene.type === 'comic') {
      for (const panel of scene.panels) {
        if (panel.caption) texts.push(panel.caption);
        for (const bubble of panel.bubbles) texts.push(bubble.text);
      }
    } else if (scene.type === 'chat') {
      for (const message of scene.messages) texts.push(message.text);
      if (legacy && scene.reply) {
        texts.push(...scene.reply.options.map((option) => option.label));
        if (scene.reply.prompt) texts.push(scene.reply.prompt);
      }
    } else if (legacy && scene.type === 'pick') texts.push(scene.question, ...scene.options.map((option) => option.label));
    else if (legacy && scene.type === 'quiz') texts.push(scene.prompt);
    // 只统计叙述单元：题干、干扰项、反馈里出现目标词不等于「在正文里读过」。
    // card.front 保持计入（esl/text.ts 把它定义为 narrative）。
    else if (scene.type === 'card') texts.push(scene.front);
    const uses = new Set(scene.uses ?? []);
    for (const item of taskItems) {
      if (uses.has(item)) continue;
      if (formsOf(item).some((form) => texts.some((text) => locateForm(text, form).length))) uses.add(item);
    }
    if (uses.size) scene.uses = [...uses];
  }

  const batch: Batch = {
    batch: input.batchId,
    channel: EDITION_CHANNEL,
    brief: `${input.unitId}#${input.cefr}`,
    cast: usedCharacters.size ? [...usedCharacters] : [materialCharacters[0]!.id],
    scenes,
  };
  if (input.validate) {
    const reported = input.validate(batch);
    issues.push(...reported);
    if (issues.some((issue) => issue.level === 'error')) return { ok: false, issues };
  }

  const narrativeWords = narrative.reduce((sum, line) => sum + tokenize(line.text).length, 0);
  const interactionCount = scenes.filter((scene) =>
    scene.type === 'quiz' || scene.type === 'pick' || (scene.type === 'chat' && !!scene.reply)).length;
  const estimatedMinutes = Number((narrativeWords / 110 + (interactionCount * 25) / 60).toFixed(1));

  return {
    ok: true,
    batch,
    title: meta.title,
    subtitle: meta.subtitle,
    description: meta.description,
    creation: {
      protocol: EDITION_DRAFT_PROTOCOL,
      draft: raw,
      unitId: input.unitId,
      compilerVersion,
      passageBindings,
      sources,
      sceneSources,
    },
    teaching: {
      contexts: input.targets.filter((target) => target.introduce).map((target) => ({
        item: target.item,
        scenes: [...(contextScenes.get(target.item)?.scenes ?? [])],
        distinct: contextScenes.get(target.item)?.fingerprints.size ?? 0,
      })),
      practiceItems: [...practiceItems],
      narrativeWords,
      estimatedMinutes,
    },
  };
}

/** 正文片段的摘要：Edition 全量使用 `sha256:` 内容寻址，不用旧 ENDLESS 的 16 位哈希。 */
function digestText(text: string): string {
  return `sha256:${sha256Hex(normalizeForDigest(text))}`;
}
