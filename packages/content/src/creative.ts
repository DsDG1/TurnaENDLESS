/**
 * 创作草稿（ENDLESS-DRAFT/1，learningVersion 4）的严格编译器。
 * AI 只写形态、系列、组件与正文；本文件把草稿确定性编译成可执行 Batch：
 * 场景 ID、词库条目、素材引用、学习证据、答案位置与来源记录全部由程序产出。
 * 同一份草稿 + 同一学习任务 + 同一内容库必然得到同一份批次——验收与恢复靠
 * 「重新编译并比较」拒绝伪造的 kind/series/来源或被篡改的正文。
 */
import {
  batchTextUnits, contentHash, locateForm, stripThinking,
  EVIDENCE_RANK,
  type Batch, type EvidenceType, type Scene, type ValidationIssue,
} from '@endless/esl';
import type { Lexicon } from '@endless/learning';
import { getScenes, type Library, type PlayerView } from '@endless/player';
import {
  creativeKinds, creativeSeries,
  type CreativeKind, type CreativeSeriesId,
} from './creative-policy.js';
import {
  materialAssetCatalog, materialItemPictures, materialPictureOf, materialProps,
  type MaterialProp,
} from './materials.js';

export const DRAFT_PROTOCOL = 'endless-draft-v1' as const;
export const DRAFT_HEADER = 'ENDLESS-DRAFT/1';

/** 学习目标短名（t1、t2…）与必需互动。 */
export interface CreativeTarget {
  alias: string;
  item: string;
  /** 本任务要求的互动证据；null = 只需正文曝光（expose） */
  interaction: EvidenceType | null;
  /** 提示词用的任务角色：introduce = 本批新词（两次语境 + practice）、review = 到期复习、expose = 只需出现 */
  role?: 'introduce' | 'expose' | 'review';
}

/** compileDraft 需要的最小任务视图（由 planCreative 提供）。 */
export interface CreativeTask {
  brief: {
    brief: string;
    introduce: string[];
    expose: { item: string }[];
    review: { item: string; min_evidence: EvidenceType }[];
  };
  detection: { item: string; type: EvidenceType }[];
  practice: { item: string; type: EvidenceType }[];
  exposureCounts: Map<string, number>;
  view: PlayerView;
  targets: CreativeTarget[];
}

export interface CreationSource {
  sceneId: string;
  item: string;
  field: 'gloss' | 'example' | 'prior';
  reference: string;
  text: string;
  hash: string;
}

export interface DraftCreation {
  protocol: typeof DRAFT_PROTOCOL;
  draft: string;
  kind: CreativeKind;
  series: CreativeSeriesId;
  sources: CreationSource[];
}

export interface DraftSuccess {
  ok: true;
  batch: Batch;
  title: string;
  subtitle: string;
  description: string;
  creation: DraftCreation;
  /** sceneId → 来源说明（呈现元数据） */
  sceneSources: Record<string, string>;
}

export type DraftResult = DraftSuccess | { ok: false; issues: ValidationIssue[] };

// ---------- 小工具 ----------

/** FNV-1a 32 位：正确答案位置按 batchId+场次+短名确定，不总在第一个。 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const error = (issues: ValidationIssue[], message: string, scene?: string) =>
  issues.push({ code: 'E-DRAFT', level: 'error', message, scene });

/** 只剥已知外壳：思考块 + 最外层代码围栏；不做内容猜测。 */
function unwrap(text: string): string {
  let body = (stripThinking(text) ?? text).replace(/^﻿/, '').trim();
  if (/^```/.test(body)) {
    const lines = body.split(/\r?\n/);
    const last = lines.length - 1;
    // 只剥完整的外层围栏；未闭合的围栏原样留给标题校验报错，不吞掉首行
    if (/^```\s*$/.test(lines[last]!.trim()) && last > 0) {
      body = lines.slice(1, last).join('\n').trim();
    }
  }
  return body;
}

// ---------- 草稿解析 ----------

interface ChoiceLines { prompt: string; correct: string; distractors: string[]; feedback: string; remember: boolean }
interface Component {
  type: 'comic' | 'chat' | 'post' | 'choice' | 'quiz' | 'card' | 'fact' | 'example';
  arg?: string;
  arg2?: string;
  lines: string[];
}

const META_KEYS = ['@kind', '@series', '@title', '@subtitle', '@description', '@hook'] as const;

function parseDraft(body: string, issues: ValidationIssue[]): { meta: Record<string, string>; components: Component[] } | null {
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1 || lines[first]!.trim() !== DRAFT_HEADER) {
    error(issues, `第一行必须是 ${DRAFT_HEADER}；不接受 JSON/YAML 批次或其他格式`);
    return null;
  }
  const meta: Record<string, string> = {};
  const components: Component[] = [];
  let current: Component | null = null;
  const componentOf = (line: string): { component?: Component; bad?: string } => {
    const parts = line.split(/\s+/);
    const cmd = parts[0]!;
    const arity = (n: number) => parts.length - 1 === n;
    switch (cmd) {
      case '@comic': return arity(1) ? { component: { type: 'comic', arg: parts[1], lines: [] } } : { bad: '@comic 需要一个背景 ID' };
      case '@chat': return arity(1) ? { component: { type: 'chat', arg: parts[1], lines: [] } } : { bad: '@chat 需要一个 skin' };
      case '@post': return arity(1) ? { component: { type: 'post', arg: parts[1], lines: [] } } : { bad: '@post 需要一个角色 ID' };
      case '@choice': return arity(1) ? { component: { type: 'choice', arg: parts[1], lines: [] } } : { bad: '@choice 需要一个目标短名' };
      case '@quiz': return arity(2) ? { component: { type: 'quiz', arg: parts[1], arg2: parts[2], lines: [] } } : { bad: '@quiz 需要类型和目标短名' };
      case '@card': return arity(1) ? { component: { type: 'card', arg: parts[1], lines: [] } } : { bad: '@card 需要一个目标短名' };
      case '@fact': return arity(1) ? { component: { type: 'fact', arg: parts[1], lines: [] } } : { bad: '@fact 需要一个目标短名' };
      case '@example': return arity(1) ? { component: { type: 'example', arg: parts[1], lines: [] } } : { bad: '@example 需要一个目标短名' };
      default: return { bad: `未知指令：${cmd}` };
    }
  };
  for (let i = first + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === '') continue;
    if (/^[{[]/.test(line) || /^(batch|channel|cast|brief|scenes|scenes?|new_entities|hook_out)\s*:/.test(line)) {
      error(issues, '草稿不接受可执行 JSON/YAML 内容，只接受组件语法');
      return null;
    }
    if (current === null) {
      if (line.startsWith('@')) {
        const key = META_KEYS.find((k) => line.startsWith(`${k} `) || line === k);
        if (key) {
          if (components.length) error(issues, `元数据 @${key.slice(1)} 必须写在组件之前`);
          else if (meta[key.slice(1)] !== undefined) error(issues, `元数据 @${key.slice(1)} 重复`);
          else meta[key.slice(1)] = line.slice(key.length).trim();
          continue;
        }
        const opened = componentOf(line);
        if (opened.bad) {
          error(issues, opened.bad);
          return null;
        }
        current = opened.component!;
        continue;
      }
      error(issues, `组件块之外不允许正文：${line.slice(0, 30)}`);
      return null;
    }
    if (line === '@end') {
      components.push(current);
      current = null;
      continue;
    }
    current.lines.push(raw);
  }
  if (current !== null) {
    error(issues, `组件块缺少 @end（${current.type}）`);
    return null;
  }
  for (const key of ['kind', 'series', 'title', 'subtitle', 'description'] as const) {
    if (!meta[key]) error(issues, `缺少元数据 @${key}`);
  }
  for (const [key, cap] of [['title', 100], ['subtitle', 160], ['description', 400]] as const) {
    if ((meta[key] ?? '').length > cap) error(issues, `@${key} 超过 ${cap} 字符上限`);
  }
  return issues.some((i) => i.level === 'error') ? null : { meta, components };
}

/** 解析 choice / @reply 的 ? + - = 与可选 @remember。 */
function parseChoiceLines(lines: string[], issues: ValidationIssue[], where: string): ChoiceLines | null {
  const result: ChoiceLines = { prompt: '', correct: '', distractors: [], feedback: '', remember: false };
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (line === '@remember') {
      if (result.remember) error(issues, `${where}：@remember 只能出现一次`);
      result.remember = true;
      continue;
    }
    if (line.startsWith('@')) {
      error(issues, `${where}：未知指令 ${line.split(/\s+/)[0]}`);
      continue;
    }
    const head = line[0];
    const text = line.slice(1).trim();
    if (head === '?') {
      if (result.prompt) error(issues, `${where}：? 题干只能一行`);
      result.prompt = text;
    } else if (head === '+') {
      if (result.correct) error(issues, `${where}：+ 正确选项只能一行`);
      result.correct = text;
    } else if (head === '-') {
      result.distractors.push(text);
    } else if (head === '=') {
      if (result.feedback) error(issues, `${where}：= 反馈只能一行`);
      result.feedback = text;
    } else {
      error(issues, `${where}：无法识别的行「${line.slice(0, 24)}」`);
    }
  }
  if (!result.prompt) error(issues, `${where}：缺少 ? 题干`);
  if (!result.correct) error(issues, `${where}：缺少 + 正确选项`);
  if (result.distractors.length < 1 || result.distractors.length > 3) error(issues, `${where}：需要 1–3 行 - 干扰项`);
  if (!result.feedback) error(issues, `${where}：缺少 = 反馈`);
  const labels = [result.correct, ...result.distractors].filter(Boolean).map((l) => l.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) error(issues, `${where}：选项重复`);
  if (result.distractors.some((d) => !d)) error(issues, `${where}：干扰项不能为空`);
  return issues.some((i) => i.level === 'error') ? null : result;
}

// ---------- 取材 ----------

/** 已真正读完的历史叙述行（completed、非 skip、非仅生成）。 */
function historyLines(library: Library, view: PlayerView): { reference: string; text: string }[] {
  const lines: { reference: string; text: string }[] = [];
  for (const episode of library.episodes) {
    const progress = view.episodes[episode.id];
    const completed = new Set(
      Object.entries(progress?.scenes ?? {}).filter(([, s]) => s.completed).map(([id]) => id),
    );
    for (const node of episode.ast.nodes) {
      if (node.type === 'bubble' || node.type === 'message') {
        const sceneId = node.parent?.startsWith('s') && node.parent.includes('.')
          ? episode.ast.nodes.find((n) => n.id === node.parent)?.parent ?? node.parent
          : node.parent;
        if (sceneId && completed.has(sceneId) && typeof node.data.text === 'string' && node.data.text) {
          lines.push({ reference: `${episode.id}.${sceneId}`, text: node.data.text });
        }
      } else if (node.type === 'panel' && node.parent && completed.has(node.parent) &&
        typeof node.data.caption === 'string' && node.data.caption) {
        lines.push({ reference: `${episode.id}.${node.parent}`, text: node.data.caption });
      }
    }
  }
  return lines;
}

// ---------- 编译 ----------

export function compileDraft(
  rawText: string,
  task: CreativeTask,
  library: Library,
  batchId: string,
  lexicon: Lexicon,
  validate: (batch: Batch) => ValidationIssue[],
): DraftResult {
  const issues: ValidationIssue[] = [];
  const draft = unwrap(rawText);
  const parsed = parseDraft(draft, issues);
  if (!parsed) return { ok: false, issues };
  const { meta, components } = parsed;

  const kind = meta.kind as CreativeKind;
  const seriesId = meta.series as CreativeSeriesId;
  if (!creativeKinds.includes(kind)) {
    error(issues, `未知内容形态 ${meta.kind}`);
    return { ok: false, issues };
  }
  const series = creativeSeries[seriesId];
  if (!series) {
    error(issues, `未知系列 ${meta.series}`);
    return { ok: false, issues };
  }
  if (series.kind !== kind) {
    error(issues, `系列 ${seriesId} 属于 ${series.kind}，不能用于 ${kind}`);
    return { ok: false, issues };
  }
  const castAllowed = new Set<string>(series.cast);
  const backgrounds = new Set<string>(series.backgrounds);
  const assets = materialAssetCatalog();
  const targetOf = (alias: string | undefined) => task.targets.find((t) => t.alias === alias);
  const formsOf = (item: string) => lexicon.forms.get(item) ?? [];
  const required = new Map<string, EvidenceType>();
  for (const entry of task.detection) required.set(entry.item, entry.type);
  for (const entry of task.practice) required.set(entry.item, 'practice');

  const propIds = new Set(materialProps.map((p) => p.id));
  const distractorProps = (exclude: string, n: number): MaterialProp[] =>
    materialProps.filter((p) => p.id !== exclude).slice(0, n);

  // 场景与叙述行按草稿顺序累积（card/practice-quiz 只能引用更早的正文）
  const scenes: Scene[] = [];
  const draftNarrative: { sceneId: string; text: string }[] = [];
  const sources: CreationSource[] = [];
  const sceneSources: Record<string, string> = {};
  const cast = new Set<string>();
  const speaker = (id: string, where: string): boolean => {
    if (!castAllowed.has(id)) {
      error(issues, `${where}：角色 ${id} 不属于系列 ${seriesId}（可用：${series.cast.join('/')}）`);
      return false;
    }
    cast.add(id);
    return true;
  };
  /** 历史已读行在第一次用到时才收集（保持确定性）。 */
  let prior: { reference: string; text: string }[] | null = null;
  const priorLines = () => (prior ??= historyLines(library, task.view));
  /** 互动目标可用的原句：检索级只用历史已读行，练习级先用本稿前文、再退到历史。 */
  const sourceLines = (item: string) => {
    const retrieval = (required.get(item) ?? 'practice') !== 'practice';
    const draftLines = draftNarrative.map((l) => ({ reference: `draft.${l.sceneId}`, text: l.text }));
    return retrieval ? priorLines() : [...draftLines, ...priorLines()];
  };
  const recordSource = (sceneId: string, item: string, field: CreationSource['field'], reference: string, text: string, label: string) => {
    sources.push({ sceneId, item, field, reference, text, hash: contentHash(text) });
    sceneSources[sceneId] = label;
  };
  const sceneId = () => `s${scenes.length + 1}`;
  /** 正确答案插在 FNV 确定的槽位（fnv % 选项总数），不总是第一个。 */
  const placeCorrect = <T,>(correct: T, others: T[], alias: string, ordinal: number): T[] => {
    const options = [...others];
    options.splice(fnv1a32(`${batchId}:${ordinal}:${alias}`) % (options.length + 1), 0, correct);
    return options;
  };
  /** 目标绑定：正确选项必须实际包含目标形式，或与词库中文词义完全一致。 */
  const answerLinked = (item: string, correct: string): boolean => {
    if (formsOf(item).some((form) => locateForm(correct, form).length)) return true;
    return correct.trim() === (lexicon.entries.get(item)?.gloss_zh ?? '');
  };
  const decideEvidence = (item: string, optionCount: number, alias: string): EvidenceType | null => {
    const need = required.get(item);
    const derived: EvidenceType = optionCount === 4 ? 'recognition-4' : 'recognition-2';
    if (need === undefined) {
      return (task.exposureCounts.get(item) ?? 0) >= 2 ? derived : 'practice';
    }
    if (need === 'practice') return 'practice';
    if (EVIDENCE_RANK[derived] >= EVIDENCE_RANK[need]) return need;
    error(issues, `${alias}（${item}）需要 ${need} 独立检索，${optionCount} 个选项不足以支撑`);
    return null;
  };

  const distractorForms = (item: string, n: number, own: Set<string>): string[] => {
    const pool: string[] = [];
    for (const cid of lexicon.entries.get(item)?.confusables ?? []) {
      for (const f of formsOf(cid)) if (!own.has(f) && !pool.includes(f)) pool.push(f);
    }
    if (pool.length < n) {
      const pos = lexicon.entries.get(item)?.pos;
      for (const e of [...lexicon.entries.values()].sort((a, b) => a.freq_band - b.freq_band || a.id.localeCompare(b.id))) {
        if (e.id === item || e.pos !== pos) continue;
        for (const f of formsOf(e.id)) if (!own.has(f) && !pool.includes(f)) pool.push(f);
      }
    }
    return pool.slice(0, n);
  };
  const distractorGlosses = (item: string, n: number): string[] => {
    const own = lexicon.entries.get(item)?.gloss_zh;
    const pool: string[] = [];
    const push = (id: string) => {
      const g = lexicon.entries.get(id)?.gloss_zh;
      if (g && g !== own && !pool.includes(g)) pool.push(g);
    };
    for (const cid of lexicon.entries.get(item)?.confusables ?? []) push(cid);
    if (pool.length < n) {
      for (const e of [...lexicon.entries.values()].sort((a, b) => a.freq_band - b.freq_band || a.id.localeCompare(b.id))) push(e.id);
    }
    return pool.slice(0, n);
  };
  const findSourceLine = (item: string): { line: { reference: string; text: string }; form: string; start: number; end: number } | null => {
    for (const line of sourceLines(item)) {
      let count = 0;
      let hit: { form: string; start: number; end: number } | undefined;
      for (const form of formsOf(item)) {
        for (const h of locateForm(line.text, form)) {
          count++;
          hit ??= { form, start: h.start, end: h.end };
        }
      }
      if (count === 1 && hit) return { line, ...hit };
    }
    return null;
  };

  const knowledgeOnly = new Set(['fact', 'example', 'quiz', 'card']);

  for (const component of components) {
    const id = sceneId();
    const ordinal = scenes.length + 1;
    if (kind === 'knowledge' && !knowledgeOnly.has(component.type)) {
      error(issues, `knowledge 形态只允许 fact/example/quiz/card，不允许 ${component.type}`);
      continue;
    }
    switch (component.type) {
      case 'comic': {
        const bg = component.arg ?? '';
        if (!backgrounds.has(bg)) {
          error(issues, `背景 ${bg} 不在系列 ${seriesId} 的可用背景（${series.backgrounds.join('/')}）`);
          break;
        }
        const dialogues: { who: string; expr?: string; text: string }[] = [];
        const props: string[] = [];
        let bad = false;
        for (const raw of component.lines) {
          const line = raw.trim();
          if (!line) continue;
          const prop = line.match(/^prop\s*:\s*([a-z0-9_]+)\s*$/);
          if (prop) {
            if (!propIds.has(prop[1]!)) { error(issues, `道具 ${prop[1]} 不在素材目录`); bad = true; }
            else if (props.length >= 3) { error(issues, '每个漫画块最多三个道具'); bad = true; }
            else props.push(prop[1]!);
            continue;
          }
          const dialogue = line.match(/^([a-z][a-z0-9_]*)(?:\.([a-z]+))?\s*:\s*(.+)$/);
          if (!dialogue) { error(issues, `漫画行无法识别：${line.slice(0, 30)}`); bad = true; continue; }
          const [, who, expr, text] = dialogue;
          if (!speaker(who!, `漫画 ${id}`)) bad = true;
          if (expr && !materialAssetCatalog().chars.get(who!)?.expr.includes(expr)) {
            error(issues, `表情 ${expr} 不在 ${who} 的表情目录`); bad = true;
          }
          dialogues.push({ who: who!, expr, text: text! });
        }
        if (dialogues.length < 1 || dialogues.length > 4) { error(issues, '漫画需要 1–4 行台词'); bad = true; }
        if (bad || !dialogues.length) break;
        const shotOf = (index: number, total: number) =>
          total === 1 ? 'wide' : index === 0 ? 'wide' : index === total - 1 ? 'close' : 'medium';
        const scene: Scene = {
          id, type: 'comic', setting: `@tag:${bg}`, cast: [...new Set(dialogues.map((d) => d.who))],
          panels: dialogues.map((d, pi) => ({
            shot: shotOf(pi, dialogues.length),
            actors: [`@char:${d.who}${d.expr ? `{expr=${d.expr}}` : ''}`],
            props: pi === 0 ? props.map((p) => `@emoji:${p}`) : [],
            bubbles: [{ speaker: d.who, text: d.text }],
          })),
        };
        scenes.push(scene);
        for (const d of dialogues) draftNarrative.push({ sceneId: id, text: d.text });
        break;
      }
      case 'chat':
      case 'post': {
        const isPost = component.type === 'post';
        const skin = isPost ? 'forum' : (component.arg ?? '');
        if (!isPost && !['messenger', 'dating', 'forum', 'news_comments'].includes(skin)) {
          error(issues, `chat 需要 skin：messenger / dating / forum / news_comments`);
          break;
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
            if (!speaker(component.arg ?? '', `短帖 ${id}`)) bad = true;
            messages.push({ from: component.arg!, text: text[1]! });
            continue;
          }
          const message = line.match(/^([a-z][a-z0-9_]*)\s*:\s*(.+)$/);
          if (!message) { error(issues, `chat 行无法识别：${line.slice(0, 30)}`); bad = true; continue; }
          if (!speaker(message[1]!, `对话 ${id}`)) bad = true;
          messages.push({ from: message[1]!, text: message[2]! });
        }
        if (messages.length < 1 || messages.length > 8) { error(issues, 'chat 需要 1–8 条消息'); bad = true; }
        let reply: import('@endless/esl').ChatSceneT['reply'];
        let replyEvidence: { item: string; type: EvidenceType } | undefined;
        let replyEffects: Record<string, { user_fact: { predicate: string; object: string } }[]> | undefined;
        if (replyTarget !== null && !messages.length) {
          error(issues, `chat ${id}：@reply 之前至少需要一条消息`);
          bad = true;
        }
        if (replyTarget !== null && messages.length) {
          const target = targetOf(replyTarget);
          if (!target) { error(issues, `@reply 目标 ${replyTarget} 不是本任务的学习短名`); bad = true; }
          const choice = parseChoiceLines(replyLines, issues, `chat ${id} 的 @reply`);
          if (target && choice && !answerLinked(target.item, choice.correct)) {
            error(issues, `@reply ${target.alias}：+ 正确选项必须包含目标的英文形式，或与词库词义完全一致`);
            bad = true;
          }
          if (target && choice && !bad) {
            const options = placeCorrect(choice.correct, choice.distractors, target.alias, ordinal);
            const evidence = decideEvidence(target.item, options.length, target.alias);
            if (evidence === null) bad = true;
            const effects: Record<string, { user_fact: { predicate: string; object: string } }[]> = {};
            reply = {
              prompt: choice.prompt,
              options: options.map((label, oi) => {
                const option: { label: string; correct?: boolean; effect?: string } = { label, ...(label === choice.correct ? { correct: true } : {}) };
                if (choice.remember) {
                  option.effect = `remember_${oi}`;
                  effects[option.effect] = [{ user_fact: { predicate: 'chose', object: `${seriesId}:${label}` } }];
                }
                return option;
              }),
              on_correct: { from: messages[0]!.from, text: choice.feedback },
              on_wrong: { from: messages[0]!.from, text: choice.feedback },
            };
            if (evidence) replyEvidence = { item: target.item, type: evidence };
            if (Object.keys(effects).length) replyEffects = effects;
          }
        }
        if (bad) break;
        const scene: Scene = {
          id, type: 'chat', skin: skin as 'messenger' | 'dating' | 'forum' | 'news_comments',
          cast: [...new Set(messages.map((m) => m.from))],
          messages,
          ...(reply ? { reply } : {}),
          ...(replyEvidence ? { evidence: replyEvidence } : {}),
          ...(replyEffects ? { effects: replyEffects } : {}),
        };
        scenes.push(scene);
        for (const m of messages) draftNarrative.push({ sceneId: id, text: m.text });
        break;
      }
      case 'choice': {
        const target = targetOf(component.arg ?? '');
        if (!target) { error(issues, `@choice 目标 ${component.arg} 不是本任务的学习短名`); break; }
        const choice = parseChoiceLines(component.lines, issues, `choice ${id}`);
        if (!choice) break;
        if (!answerLinked(target.item, choice.correct)) {
          error(issues, `choice ${target.alias}：+ 正确选项必须包含目标的英文形式，或与词库词义完全一致`);
          break;
        }
        const options = placeCorrect(choice.correct, choice.distractors, target.alias, ordinal);
        const evidence = decideEvidence(target.item, options.length, target.alias);
        if (evidence === null) break;
        const effects: Record<string, { user_fact: { predicate: string; object: string } }[]> = {};
        const scene: Scene = {
          id, type: 'pick', question: choice.prompt,
          options: options.map((label, oi) => {
            const option: { label: string; correct?: boolean; effect?: string } = { label, ...(label === choice.correct ? { correct: true } : {}) };
            if (choice.remember) {
              option.effect = `remember_${oi}`;
              effects[option.effect] = [{ user_fact: { predicate: 'chose', object: `${seriesId}:${label}` } }];
            }
            return option;
          }),
          feedback: { on_correct: choice.feedback, on_wrong: choice.feedback },
          evidence: { item: target.item, type: evidence },
          ...(Object.keys(effects).length ? { effects } : {}),
        };
        scenes.push(scene);
        break;
      }
      case 'quiz': {
        const target = targetOf(component.arg2 ?? '');
        const quizKind = component.arg ?? '';
        if (!target) { error(issues, `@quiz 目标 ${component.arg2} 不是本任务的学习短名`); break; }
        if (!['meaning', 'cloze', 'sentence', 'find'].includes(quizKind)) {
          error(issues, `quiz 需要类型：meaning / cloze / sentence / find`); break;
        }
        if (component.lines.some((l) => l.trim())) {
          error(issues, 'quiz 组件不接受正文；材料由程序构造'); break;
        }
        const need = required.get(target.item);
        const minOptions = need !== undefined && need !== 'practice' && EVIDENCE_RANK[need] >= EVIDENCE_RANK['recognition-4'] ? 4 : 2;
        const entry = lexicon.entries.get(target.item);
        const forms = formsOf(target.item);
        let scene: Scene | null = null;
        const build = (kind: 'meaning' | 'cloze' | 'sentence' | 'find', prompt: string, correct: string, distractors: string[], optionAssets?: (string | undefined)[], source?: { reference: string; text: string; label: string }) => {
          const optionCount = Math.min(1 + distractors.length, 4);
          if (optionCount < minOptions) {
            error(issues, `quiz ${kind}（${target.alias}）只有 ${optionCount} 个可构造选项，无法满足 ${need}`);
            return;
          }
          const picked = distractors.slice(0, optionCount - 1);
          const ordered = placeCorrect(correct, picked, target.alias, ordinal);
          // 图案与文字保持同一轮换：先确定正确项位置，再按相同偏移排布素材
          const correctIndex = ordered.indexOf(correct);
          const evidence = decideEvidence(target.item, ordered.length, target.alias);
          if (evidence === null) return;
          scene = {
            id, type: 'quiz', kind, item: target.item, prompt,
            options: ordered.map((label, oi) => ({
              label,
              ...(label === correct ? { correct: true } : {}),
              ...(optionAssets?.[oi === correctIndex ? 0 : picked.indexOf(label) + 1] ? { asset: optionAssets[oi === correctIndex ? 0 : picked.indexOf(label) + 1] } : {}),
            })),
            feedback: { on_correct: `答对了——「${correct}」。`, on_wrong: `再想想——正确的是「${correct}」。` },
            evidence: { item: target.item, type: evidence },
          } as Scene;
          if (source) recordSource(id, target.item, 'prior', source.reference, source.text, source.label);
          else sceneSources[id] = '本地词库';
        };
        if (quizKind === 'meaning') {
          const gloss = entry?.gloss_zh;
          const form = forms[0];
          if (!gloss || !form) { error(issues, `quiz meaning：${target.item} 缺少词形或词义`); break; }
          build('meaning', `「${form}」是什么意思？`, gloss, distractorGlosses(target.item, 3));
        } else if (quizKind === 'cloze') {
          const found = findSourceLine(target.item);
          if (!found) { error(issues, `quiz cloze：找不到含 ${target.alias} 恰好一次的可取材原句`); break; }
          const { line, form, start, end } = found;
          build('cloze', `${line.text.slice(0, start)}____${line.text.slice(end)}`, form,
            distractorForms(target.item, 3, new Set(forms)).filter((f) => f !== form), undefined,
            { reference: line.reference, text: line.text, label: line.reference.startsWith('draft.') ? '本集前文原句' : '已读故事原句' });
        } else if (quizKind === 'sentence') {
          const found = findSourceLine(target.item);
          if (!found) { error(issues, `quiz sentence：找不到含 ${target.alias} 恰好一次的可取材原句`); break; }
          const { line, start, end } = found;
          const swaps = distractorForms(target.item, 3, new Set(forms))
            .map((f) => `${line.text.slice(0, start)}${f}${line.text.slice(end)}`)
            .filter((s) => s !== line.text);
          build('sentence', '哪一句在故事里真的出现过？', line.text, swaps, undefined,
            { reference: line.reference, text: line.text, label: line.reference.startsWith('draft.') ? '本集前文原句' : '已读故事原句' });
        } else {
          const prop = materialPictureOf(target.item);
          const gloss = entry?.gloss_zh;
          if (!prop || !gloss || !forms[0]) {
            error(issues, `quiz find：${target.item} 没有登记对应的图片素材，不能编造图案`); break;
          }
          const others = distractorProps(prop, 3);
          build('find', `「${forms[0]}」是哪一个？`, gloss, others.map((p) => p.label),
            [undefined, ...others.map((p) => `@emoji:${p.id}`)]);
          if (scene) {
            // 正确选项的图片是登记过的目标图案
            const correctIndex = (scene as Extract<Scene, { type: 'quiz' }>).options.findIndex((o) => o.correct);
            (scene as Extract<Scene, { type: 'quiz' }>).options[correctIndex]!.asset = `@emoji:${prop}`;
          }
        }
        if (scene) scenes.push(scene);
        break;
      }
      case 'card': {
        const target = targetOf(component.arg ?? '');
        if (!target) { error(issues, `@card 目标 ${component.arg} 不是本任务的学习短名`); break; }
        if (component.lines.some((l) => l.trim())) { error(issues, 'card 组件不接受正文'); break; }
        const found = draftNarrative
          .map((l) => ({ l, hits: formsOf(target.item).flatMap((f) => locateForm(l.text, f)) }))
          .find((entry) => entry.hits.length > 0);
        if (!found) { error(issues, `card：本稿前文没有含 ${target.alias} 的原句，无法取材`); break; }
        const scene: Scene = {
          id, type: 'card', item: target.item, front: found.l.text,
          uses: [target.item], evidence: { item: target.item, type: 'practice' },
        };
        scenes.push(scene);
        recordSource(id, target.item, 'prior', `draft.${found.l.sceneId}`, found.l.text, '本集前文原句');
        break;
      }
      case 'fact':
      case 'example': {
        const target = targetOf(component.arg ?? '');
        if (!target) { error(issues, `@${component.type} 目标 ${component.arg} 不是本任务的学习短名`); break; }
        if (component.lines.some((l) => l.trim())) { error(issues, `${component.type} 组件不接受正文`); break; }
        const entry = lexicon.entries.get(target.item);
        const forms = formsOf(target.item);
        if (component.type === 'fact') {
          if (!entry?.gloss_zh || !forms[0]) { error(issues, `fact：${target.item} 缺少可用词义`); break; }
          const front = `${forms[0]!} — ${entry.gloss_zh}`;
          const scene: Scene = {
            id, type: 'card', item: target.item, front,
            uses: [target.item], evidence: { item: target.item, type: 'practice' },
          };
          scenes.push(scene);
          recordSource(id, target.item, 'gloss', target.item, front, '本地词库 · 词义');
          draftNarrative.push({ sceneId: id, text: front });
          } else {
          const example = entry?.example;
          if (!example || !forms.some((f) => locateForm(example, f).length)) {
            error(issues, `example：${target.item} 没有含目标形式的词库例句，不能用编造材料代替`); break;
          }
          const scene: Scene = {
            id, type: 'card', item: target.item, front: example,
            uses: [target.item], evidence: { item: target.item, type: 'practice' },
          };
          scenes.push(scene);
          recordSource(id, target.item, 'example', target.item, example, '本地词库 · 例句');
          draftNarrative.push({ sceneId: id, text: example });
          }
        break;
      }
    }
  }

  // ---------- 学习任务契约 ----------
  const allScenes = scenes;
  const interactive = allScenes.filter((s) =>
    (s.type === 'pick' || s.type === 'quiz') || (s.type === 'chat' && s.reply));
  for (const need of [...task.detection, ...task.practice]) {
    const covered = interactive.some((s) => s.evidence?.item === need.item && s.evidence.type === need.type);
    if (!covered) {
      error(issues, `缺少必需互动 ${need.item}（${need.type}）；fact/example/post/无回复 chat/card 不能代替`);
    }
  }
  // 新条目：两个真实语境 + practice。story/daily/social 只数 comic/chat(含 post) 正文；
  // knowledge 数 fact+example（词义与例句即语境）。card 正面与选项不算语境。
  const introducedContexts = (item: string) => {
    const forms = formsOf(item);
    if (kind === 'knowledge') {
      const gloss = sources.some((s) => s.item === item && s.field === 'gloss');
      const example = sources.some((s) => s.item === item && s.field === 'example');
      return (gloss ? 1 : 0) + (example ? 1 : 0);
    }
    let count = 0;
    for (const scene of allScenes) {
      if (scene.type !== 'comic' && scene.type !== 'chat') continue;
      const units = batchTextUnits({ ...({} as Batch), batch: batchId, channel: seriesId, brief: task.brief.brief, cast: [...cast], scenes: [scene] })
        .filter((u) => u.role === 'narrative');
      if (units.some((u) => forms.some((f) => locateForm(u.text, f).length))) count++;
    }
    return count;
  };
  for (const item of task.brief.introduce) {
    if (introducedContexts(item) < 2) {
      error(issues, `新词 ${item} 需要两个不同组件的正文语境${kind === 'knowledge' ? '（一份 fact 词义加一份 example 原句）' : ''}，再加一个 practice 互动`);
    }
  }
  // 防启动：必需独立检索的目标，其任何形式不得出现在它自己的检测之前（含题面/选项/提示）。
  const units = allScenes.length ? batchTextUnits({ batch: batchId, channel: seriesId, brief: task.brief.brief, cast: [...cast], scenes: allScenes }) : [];
  for (const target of task.detection.filter((d) => EVIDENCE_RANK[d.type] >= 1)) {
    const index = allScenes.findIndex((s) => s.evidence?.item === target.item && s.evidence.type === target.type);
    if (index < 0) continue;
    const leak = units.find((u) => (u.sceneIndex < index || (u.sceneIndex === index && u.role === 'narrative')) &&
      formsOf(target.item).some((f) => locateForm(u.text, f).length));
    if (leak) error(issues, `独立检索 ${target.item} 之前已出现答案（${leak.sceneId}.${leak.path}）`, leak.sceneId);
  }

  if (issues.some((i) => i.level === 'error')) return { ok: false, issues };

  // ---------- uses 推导与批次组装 ----------
  const taskItems = new Set(task.targets.map((t) => t.item));
  for (const scene of allScenes) {
    const sceneUnits = units.filter((u) => u.sceneId === scene.id);
    const uses = new Set(scene.uses ?? []);
    for (const item of taskItems) {
      if (uses.has(item)) continue;
      if (sceneUnits.some((u) => formsOf(item).some((f) => locateForm(u.text, f).length))) uses.add(item);
    }
    if (uses.size) scene.uses = [...uses];
  }
  const batch: Batch = {
    batch: batchId, channel: seriesId, brief: task.brief.brief,
    cast: cast.size ? [...cast] : [series.cast[0]!],
    ...(meta.hook ? { hook_out: meta.hook } : {}),
    scenes: allScenes,
  };
  issues.push(...validate(batch));
  if (issues.some((i) => i.level === 'error')) return { ok: false, issues };

  return {
    ok: true,
    batch,
    title: meta.title!,
    subtitle: meta.subtitle!,
    description: meta.description!,
    creation: {
      protocol: DRAFT_PROTOCOL,
      draft,
      kind,
      series: seriesId,
      sources,
    },
    sceneSources,
  };
}
