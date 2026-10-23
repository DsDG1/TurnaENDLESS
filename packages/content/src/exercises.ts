/**
 * 程序练习卡拼接器（双层生成的下半层）：LLM 只写叙事批次，这里按学习任务把
 * 单词卡（card）与练习卡（quiz：cloze / meaning / sentence / find）从词库和
 * 已播放文本拼进同一批次。不调 LLM，全部材料在构造时落进场景本体。
 *
 * 选材规则：
 *   - 复习检测类练习只挑「已识」条目（累计曝光 ≥ 2），否则一律记 practice；
 *   - 永不触碰 brief.review / detection 条目的任何形式：任何练习文本、选项或
 *     原句里出现这些形式都会给 LLM 的独立检索造成启动（E-PRIMED）；
 *   - 干扰项优先取词库 confusables，其次同词性条目，最后任意其他条目的形式；
 *   - 中文题干/选项不产生英文 token，天然不抬 OOV；
 *   - 取材自本批或更早批次的叙述行，cloze 只认「目标形式恰好出现一次」的句子。
 */
import {
  batchTextUnits, locateForm, Scene,
  type Batch, type EvidenceType,
} from '@endless/esl';
import type { LearningBrief, Lexicon } from '@endless/learning';
import type { Library, PlayerView } from '@endless/player';

export interface ExerciseTask {
  view: PlayerView;
  exposureCounts: Map<string, number>;
  brief: LearningBrief;
  detection: { item: string; type: EvidenceType }[];
  practice: { item: string; type: EvidenceType }[];
}

export interface ExerciseInput {
  batch: Batch;
  library: Library;
  task: ExerciseTask;
  lexicon: Lexicon;
  /** 可用 emoji 名（find 题型的选项图案） */
  emojis: string[];
  /** 集序：用于轮换练习组合，保证各集题型不同 */
  seq: number;
}

type QuizKind = 'cloze' | 'meaning' | 'sentence' | 'find';
interface ExerciseScene {
  /** 插入位置：数字 = scenes 数组下标；'after:<sceneId>' = 该场景之后；'end' = 末尾 */
  at: number | `after:${string}` | 'end';
  scene: Scene;
}

/** emoji → 可考词库条目：只有建立了图案↔词条对应关系的才能出「找一找」。 */
const EMOJI_ITEMS: Record<string, string> = {
  notebook: 'lx:notebook#n.notepad',
};

const MAX_EXERCISES = 4;

function nextSceneId(used: Set<string>): string {
  for (let i = 1; i < 100; i++) {
    const id = `s${i}`;
    if (!used.has(id)) return id;
  }
  return `s${used.size + 1}`;
}

/** 已播放剧集里的叙述行（气泡 / 消息 / 漫画旁白）。 */
function priorLines(library: Library): string[] {
  const lines: string[] = [];
  for (const episode of library.episodes) {
    for (const node of episode.ast.nodes) {
      if (node.type === 'bubble' || node.type === 'message' || node.type === 'question') {
        if (typeof node.data.text === 'string' && node.data.text) lines.push(node.data.text);
      } else if (node.type === 'panel' && typeof node.data.caption === 'string' && node.data.caption) {
        lines.push(node.data.caption);
      }
    }
  }
  return lines;
}

/** 本批次的叙述行（供单词卡 / 选句子取材）。 */
function batchLines(batch: Batch): { sceneId: string; text: string }[] {
  return batchTextUnits(batch)
    .filter((u) => u.role === 'narrative')
    .map((u) => ({ sceneId: u.sceneId, text: u.text }));
}

/** 句中目标形式总出现次数（所有形式合计）。 */
function formOccurrences(text: string, forms: string[]): { count: number; hit?: { form: string; start: number; end: number } } {
  let count = 0;
  let hit: { form: string; start: number; end: number } | undefined;
  for (const form of forms) {
    for (const h of locateForm(text, form)) {
      count++;
      hit ??= { form, start: h.start, end: h.end };
    }
  }
  return { count, hit };
}

export function buildExerciseScenes(input: ExerciseInput): Scene[] {
  const { batch, library, task, lexicon, emojis, seq } = input;
  const formsOf = (item: string) => lexicon.forms.get(item) ?? [];
  const glossOf = (item: string) => lexicon.entries.get(item)?.gloss_zh;
  const used = new Set(batch.scenes.map((s) => s.id));

  // 防启动边界：brief.review 与 detection 条目的任何形式都不得出现在练习卡里
  const avoidItems = new Set([...task.brief.review.map((r) => r.item), ...task.detection.map((d) => d.item)]);
  const avoidForms = new Set([...avoidItems].flatMap(formsOf));
  const safe = (text: string) => ![...avoidForms].some((f) => locateForm(text, f).length);

  const introduce = task.brief.introduce.filter((item) => formsOf(item).length);
  const wrong = new Set(task.view.answers.filter((a) => a.correct === false).map((a) => a.item));
  const exercisable = (item: string) =>
    !avoidItems.has(item) && !introduce.includes(item) && formsOf(item).length > 0 &&
    safe(formsOf(item)[0]!);
  // 已识条目（可检索）：错题优先，其次还没有 SRS 卡的，稳定排序保证可复现
  const known = [...task.exposureCounts.keys()]
    .filter((item) => exercisable(item) && (task.exposureCounts.get(item) ?? 0) >= 2)
    .sort((a, b) => Number(wrong.has(b)) - Number(wrong.has(a)) ||
      Number(task.view.srs.hasCard(a, 'meaning')) - Number(task.view.srs.hasCard(b, 'meaning')) ||
      a.localeCompare(b));
  const lines = batchLines(batch);
  const earlier = priorLines(library);

  /** 干扰项词形池：confusables → 其他条目形式；排除本条目形式与防启动形式。 */
  const distractorForms = (item: string, n: number): string[] => {
    const own = new Set(formsOf(item));
    const pool: string[] = [];
    for (const cid of lexicon.entries.get(item)?.confusables ?? []) {
      for (const f of formsOf(cid)) if (!own.has(f) && !avoidForms.has(f) && !pool.includes(f)) pool.push(f);
    }
    if (pool.length < n) {
      const samePos = [...lexicon.entries.values()]
        .filter((e) => e.id !== item && e.pos === lexicon.entries.get(item)?.pos)
        .sort((a, b) => a.freq_band - b.freq_band || a.id.localeCompare(b.id));
      for (const e of samePos) {
        for (const f of formsOf(e.id)) if (!own.has(f) && !avoidForms.has(f) && !pool.includes(f)) pool.push(f);
      }
    }
    return pool.slice(0, n);
  };

  /** 干扰项释义池：confusables → 高频档相近条目；中文，不进 OOV。 */
  const distractorGlosses = (item: string, n: number): string[] => {
    const own = glossOf(item);
    const pool: string[] = [];
    const push = (id: string) => {
      const g = glossOf(id);
      if (g && g !== own && !pool.includes(g)) pool.push(g);
    };
    for (const cid of lexicon.entries.get(item)?.confusables ?? []) push(cid);
    if (pool.length < n) {
      for (const e of [...lexicon.entries.values()].sort((a, b) => a.freq_band - b.freq_band || a.id.localeCompare(b.id))) push(e.id);
    }
    return pool.slice(0, n);
  };

  const quiz = (kind: QuizKind, item: string, prompt: string, correct: string, distractors: string[], evidence: EvidenceType, assets?: (string | undefined)[]): ExerciseScene['scene'] | null => {
    const options = [correct, ...distractors].slice(0, 4);
    if (options.length < 2) return null;
    const derived: EvidenceType = options.length === 4 ? 'recognition-4' : 'recognition-2';
    if (evidence !== 'practice' && evidence !== derived) return null; // 声明不得超过推导档
    const order = options.map((_, i) => i);
    // 稳定乱序：按 seq + item 哈希转动，避免正确答案总在同一位置
    const shift = (seq + [...item].reduce((s, c) => s + c.charCodeAt(0), 0)) % order.length;
    const rotated = [...order.slice(shift), ...order.slice(0, shift)];
    const id = nextSceneId(used);
    used.add(id);
    return {
      id, type: 'quiz', kind, item, prompt,
      options: rotated.map((i) => ({ label: options[i]!, ...(assets?.[i] ? { asset: assets[i] } : {}), ...(i === 0 ? { correct: true } : {}) })),
      feedback: { on_correct: `对，就是它。`, on_wrong: `再想想——正确的是「${correct}」。` },
      evidence: { item, type: evidence },
    } as ExerciseScene['scene'];
  };

  const exercises: ExerciseScene[] = [];

  // ---------- 1. 开场热身：已识条目的选择式填空（取自已播放的原句） ----------
  const buildCloze = (item: string): ExerciseScene['scene'] | null => {
    const forms = formsOf(item);
    for (const line of [...earlier].reverse()) {
      if (!safe(line)) continue;
      const { count, hit } = formOccurrences(line, forms);
      if (count !== 1 || !hit) continue;
      const prompt = `${line.slice(0, hit.start)}____${line.slice(hit.end)}`;
      const distractors = distractorForms(item, 3).filter((f) => f !== hit.form);
      return quiz('cloze', item, prompt, hit.form, distractors, 'recognition-4');
    }
    return null;
  };

  // ---------- 2. 单词卡：新条目 + 本批原句，紧贴在它的出处之后 ----------
  const buildCard = (item: string): ExerciseScene | null => {
    const forms = formsOf(item);
    const line = lines.find((l) => forms.some((f) => locateForm(l.text, f).length) && safe(l.text));
    if (!line) return null;
    const id = nextSceneId(used);
    used.add(id);
    return {
      at: `after:${line.sceneId}`,
      scene: {
        id, type: 'card', item, front: line.text,
        uses: [item], evidence: { item, type: 'practice' },
      } as Scene,
    };
  };

  // ---------- 3. 词义辨认：中文释义四选一（新条目记 practice） ----------
  const buildMeaning = (item: string, evidence: EvidenceType): ExerciseScene['scene'] | null => {
    const form = formsOf(item)[0];
    const gloss = glossOf(item);
    if (!form || !gloss) return null;
    return quiz('meaning', item, `「${form}」在故事里是什么意思？`, gloss, distractorGlosses(item, 3), evidence);
  };

  // ---------- 4. 选句子：原句 vs 换掉目标形式的干扰句 ----------
  const buildSentence = (item: string): ExerciseScene['scene'] | null => {
    const forms = formsOf(item);
    const sources = [...earlier].reverse().concat(lines.map((l) => l.text));
    for (const line of sources) {
      if (!safe(line)) continue;
      const { count, hit } = formOccurrences(line, forms);
      if (count !== 1 || !hit) continue;
      const swaps = distractorForms(item, 3)
        .map((f) => `${line.slice(0, hit.start)}${f}${line.slice(hit.end)}`)
        .filter((s) => safe(s) && s !== line);
      if (swaps.length < 1) continue;
      return quiz('sentence', item, '哪一句在故事里说得对？', line, swaps, swaps.length >= 3 ? 'recognition-4' : 'recognition-2');
    }
    return null;
  };

  // ---------- 5. 找一找：emoji 图案 ↔ 词 ----------
  const buildFind = (): ExerciseScene['scene'] | null => {
    const usable = emojis.filter((name) => EMOJI_ITEMS[name]);
    if (!usable.length || emojis.length < 2) return null;
    for (const name of usable) {
      const item = EMOJI_ITEMS[name]!;
      // 找一找是词↔图的辨认：只对已识（曝光≥2）条目出检索证据，未曝光不出
      if (!exercisable(item) || (task.exposureCounts.get(item) ?? 0) < 2) continue;
      const assets = [name, ...emojis.filter((e) => e !== name)];
      const labels = assets.map((e) => (e === name ? glossOf(item) ?? e : e === 'magnifying_glass' ? '放大镜' : e === 'top_hat' ? '高帽' : e));
      return quiz('find', item, `「${formsOf(item)[0]}」是哪一个？`, labels[0]!, labels.slice(1), 'recognition-2',
        assets.map((a) => `@emoji:${a}`));
    }
    return null;
  };

  // ---------- 组装：热身 + 单词卡 + 收尾练习，按集序轮换组合 ----------
  const warmup = known[0] ? buildCloze(known[0]) ?? (known[0] ? buildSentence(known[0]) ?? buildMeaning(known[0], 'recognition-4') : null) : null;
  if (warmup) exercises.push({ at: 0, scene: warmup });
  for (const item of introduce) {
    const card = buildCard(item);
    if (card) exercises.push(card);
  }
  const closers: Scene[] = [];
  const meaningItem = introduce[0] ?? known[1] ?? known[0];
  const meaningEvidence: EvidenceType = introduce.includes(meaningItem ?? '') ? 'practice' : 'recognition-4';
  const closerBuilders = [
    () => (meaningItem ? buildMeaning(meaningItem, meaningEvidence) : null),
    () => (known[1] ?? known[0] ? buildSentence(known[1] ?? known[0]!) : null),
    () => buildFind(),
  ];
  const offset = seq % closerBuilders.length;
  for (const builder of [...closerBuilders.slice(offset), ...closerBuilders.slice(0, offset)]) {
    if (closers.length >= 2) break;
    const built = builder();
    if (built) closers.push(built);
  }
  for (const scene of closers) exercises.push({ at: 'end', scene });

  // ---------- 拼接：热身在最前，单词卡跟在出处场景后，其余收尾 ----------
  const scenes: Scene[] = [...batch.scenes];
  const insert = (at: ExerciseScene['at'], scene: Scene) => {
    if (typeof at === 'number') scenes.splice(at, 0, scene);
    else if (at === 'end') scenes.push(scene);
    else {
      const idx = scenes.findIndex((s) => s.id === at.slice(6));
      scenes.splice(idx === -1 ? scenes.length : idx + 1, 0, scene);
    }
  };
  // 后插的往前放，先处理位置靠后的，避免下标漂移
  for (const ex of [...exercises].sort((a, b) => pos(b.at, scenes.length) - pos(a.at, scenes.length)).slice(0, MAX_EXERCISES)) {
    insert(ex.at, ex.scene);
  }
  return scenes;
}

function pos(at: ExerciseScene['at'], length: number): number {
  if (at === 'end') return length;
  if (typeof at === 'number') return at;
  return length - 1; // after:X 的相对位置由 insert 精确求，排序时近似为靠后
}
