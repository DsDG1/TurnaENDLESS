/**
 * 文本抽取与分词：供词汇检查（OOV）、防启动（E-PRIMED）、uses 定位（E-USES-NOT-FOUND）使用。
 * 每个文本单元带角色：narrative（叙述）/ prompt（题面）/ option（选项）/ feedback（回应）。
 * 防启动只看「检测之前的文本」＝ 更早场景的全部文本 + 检测场景的 narrative 部分；
 * 题面与选项本身属于检测，不算启动。
 */
import type { Batch } from './model.js';

export type TextRole = 'narrative' | 'prompt' | 'option' | 'feedback';

export interface TextUnit {
  sceneId: string;
  sceneIndex: number;
  path: string;
  role: TextRole;
  speaker?: string;
  text: string;
}

export function batchTextUnits(batch: Batch): TextUnit[] {
  const out: TextUnit[] = [];
  batch.scenes.forEach((scene, sceneIndex) => {
    const add = (path: string, role: TextRole, text: string | undefined, speaker?: string) => {
      if (text !== undefined && text !== '') out.push({ sceneId: scene.id, sceneIndex, path, role, speaker, text });
    };
    switch (scene.type) {
      case 'comic':
        scene.panels.forEach((p, pi) => {
          add(`panels[${pi}].caption`, 'narrative', p.caption);
          p.bubbles.forEach((b, bi) => add(`panels[${pi}].bubbles[${bi}]`, 'narrative', b.text, b.speaker));
        });
        break;
      case 'chat':
        scene.messages.forEach((m, mi) => add(`messages[${mi}]`, 'narrative', m.text, m.from));
        if (scene.reply) {
          add('reply.prompt', 'prompt', scene.reply.prompt);
          add('reply.on_correct', 'feedback', scene.reply.on_correct.text, scene.reply.on_correct.from);
          add('reply.on_wrong', 'feedback', scene.reply.on_wrong.text, scene.reply.on_wrong.from);
          scene.reply.options.forEach((o, oi) => add(`reply.options[${oi}]`, 'option', o.label));
        }
        break;
      case 'swipe':
        add('prompt', 'prompt', scene.prompt);
        scene.cards.forEach((c, ci) => add(`cards[${ci}].caption`, 'option', c.caption));
        break;
      case 'pick':
        add('question', 'prompt', scene.question);
        add('hint', 'prompt', scene.hint);
        scene.options.forEach((o, oi) => add(`options[${oi}]`, 'option', o.label));
        add('feedback.on_correct', 'feedback', scene.feedback.on_correct);
        add('feedback.on_wrong', 'feedback', scene.feedback.on_wrong);
        break;
      case 'hidden_object':
        add('instruction', 'prompt', scene.instruction);
        break;
      case 'story':
        for (const unit of inkTextUnits(scene.ink)) {
          add(unit.path, unit.role, unit.text, unit.speaker);
        }
        break;
      case 'quiz':
        add('prompt', 'prompt', scene.prompt);
        scene.options.forEach((o, oi) => add(`options[${oi}]`, 'option', o.label));
        add('feedback.on_correct', 'feedback', scene.feedback.on_correct);
        add('feedback.on_wrong', 'feedback', scene.feedback.on_wrong);
        break;
      case 'card':
        add('front', 'narrative', scene.front);
        break;
      case 'derive':
        break;
    }
  });
  return out;
}

/** 从 ink 源码抽文本：`角色: 台词` 是叙述；`* [x]` 选项文本是 option；标签与 divert 行不算文本。 */
export function inkTextUnits(ink: string): { path: string; role: TextRole; text: string; speaker?: string }[] {
  const out: { path: string; role: TextRole; text: string; speaker?: string }[] = [];
  const lines = ink.split(/\r?\n/);
  lines.forEach((raw, li) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('===') || line.startsWith('->')) return;
    if (line.startsWith('*') || line.startsWith('+')) {
      const open = line.indexOf('[');
      const close = open === -1 ? -1 : line.indexOf(']', open);
      if (open !== -1 && close > open + 1) {
        out.push({ path: `ink:${li}`, role: 'option', text: line.slice(open + 1, close) });
      }
      return;
    }
    if (line.startsWith('-')) return; // gather 行
    const colon = line.indexOf(':');
    const head = colon > 0 ? line.slice(0, colon) : '';
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(head)) {
      const hash = line.indexOf('#', colon);
      const body = (hash === -1 ? line.slice(colon + 1) : line.slice(colon + 1, hash)).trim();
      if (body) out.push({ path: `ink:${li}`, role: 'narrative', text: body, speaker: head });
      return;
    }
    if (line.startsWith('=')) return; // stitch 行
    if (!line.includes('#')) out.push({ path: `ink:${li}`, role: 'narrative', text: line });
  });
  return out;
}

const WORD_RE = /[a-z']+/g;

/**
 * 弯撇号归一化：模型输出里 `don’t` / `moon’s` 用的是 U+2019，而分词正则只认 ASCII 撇号，
 * 不归一化就会把 `don’t` 拆成 `don` + `t` 两个 token —— 既是两个假 OOV，也把词数算多。
 * locateForm 早就做了同样的归一化，分词漏了。
 */
export function normalizeApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019]/g, "'");
}

/** 小写分词：保留撇号（where's、I'd）。 */
export function tokenize(text: string): string[] {
  return normalizeApostrophes(text).toLowerCase().match(WORD_RE) ?? [];
}

export function wordCount(text: string): number {
  return tokenize(text).length;
}

export interface FormHit {
  form: string;
  start: number;
  end: number;
}

/** 词字符：字母或撇号（撇号属于词内，如 where's）。 */
function isWordChar(c: string | undefined): boolean {
  if (c === undefined) return false;
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === "'";
}

/**
 * 在原文中定位一个形式（可多词），大小写与弯撇号不敏感，词边界敏感。
 * 纯字符串扫描，不构造动态正则；返回字符区间供 AST 标注目标词。
 */
export function locateForm(text: string, form: string): FormHit[] {
  const hits: FormHit[] = [];
  const norm = text.replace(/\u2019/g, "'");
  const lower = norm.toLowerCase();
  const target = form.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(target, from);
    if (idx === -1) break;
    const before = idx > 0 ? norm[idx - 1] : undefined;
    const after = norm[idx + target.length];
    if (!isWordChar(before) && !isWordChar(after)) {
      hits.push({ form, start: idx, end: idx + target.length });
    }
    from = idx + 1;
  }
  return hits;
}
