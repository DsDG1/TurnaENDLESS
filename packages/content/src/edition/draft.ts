/**
 * EDITION-DRAFT/1 严格解析（设计文档 §9.1、§9.2）。
 *
 * 模型只写紧凑草稿与选材意图，不写执行 JSON、场景 ID、学习证据或任意 UI。
 * 未知指令、未知组件、非法参数一律报错，**不静默丢弃**——丢掉一个组件就等于
 * 让模型用「少写一点」绕过校验。
 */
import { stripThinking, type ValidationIssue } from '@endless/esl';
import { EDITION_DRAFT_HEADER } from './contract.js';

export interface EditionDraftMeta {
  title: string;
  subtitle: string;
  description: string;
}

export interface EditionDraftComponent {
  type: 'reading' | 'comic' | 'chat' | 'post' | 'quiz' | 'card' | 'fact' | 'example' | 'choice';
  arg?: string;
  arg2?: string;
  lines: string[];
}

export interface EditionDraft {
  meta: EditionDraftMeta;
  components: EditionDraftComponent[];
}

export type ParseResult = { ok: true; draft: EditionDraft } | { ok: false; issues: ValidationIssue[] };

const META_KEYS = ['@title', '@subtitle', '@description'] as const;
export const MAX_COMPONENTS = 24;

const error = (issues: ValidationIssue[], message: string, scene?: string) =>
  issues.push({ code: 'E-EDITION-DRAFT', level: 'error', message, ...(scene ? { scene } : {}) });

/** 只剥已知外壳：思考块 + 最外层代码围栏；不做内容猜测。 */
export function unwrapDraft(text: string): string {
  let body = (stripThinking(text) ?? text).replace(/^﻿/, '').trim();
  if (/^```/.test(body)) {
    const lines = body.split(/\r?\n/);
    const last = lines.length - 1;
    if (last > 0 && /^```\s*$/.test((lines[last] ?? '').trim())) body = lines.slice(1, last).join('\n').trim();
  }
  return body;
}

function componentOf(line: string): { component?: EditionDraftComponent; bad?: string } {
  const parts = line.split(/\s+/);
  const cmd = parts[0] ?? '';
  const arity = (n: number) => parts.length - 1 === n;
  switch (cmd) {
    case '@reading':
      return arity(1) ? { component: { type: 'reading', arg: parts[1], lines: [] } } : { bad: '@reading 需要一个正文别名（p1、p2…）' };
    case '@comic':
      return arity(1) ? { component: { type: 'comic', arg: parts[1], lines: [] } } : { bad: '@comic 需要一个已注册背景 ID' };
    case '@chat':
      return arity(1) ? { component: { type: 'chat', arg: parts[1], lines: [] } } : { bad: '@chat 需要一个 skin' };
    case '@post':
      return arity(1) ? { component: { type: 'post', arg: parts[1], lines: [] } } : { bad: '@post 需要一个角色 ID' };
    case '@quiz':
      return arity(2) ? { component: { type: 'quiz', arg: parts[1], arg2: parts[2], lines: [] } } : { bad: '@quiz 需要类型和目标别名（@quiz meaning t1）' };
    case '@card':
      return arity(1) ? { component: { type: 'card', arg: parts[1], lines: [] } } : { bad: '@card 需要一个目标别名' };
    case '@fact':
      return arity(1) ? { component: { type: 'fact', arg: parts[1], lines: [] } } : { bad: '@fact 需要一个目标别名' };
    case '@example':
      return arity(1) ? { component: { type: 'example', arg: parts[1], lines: [] } } : { bad: '@example 需要一个目标别名' };
    case '@choice':
      return arity(1) ? { component: { type: 'choice', arg: parts[1], lines: [] } } : { bad: '@choice 需要一个目标别名' };
    default:
      return { bad: `未知指令：${cmd}` };
  }
}

/**
 * 解析草稿。`headerLine` 必须是第一行非空内容：它是协议标识，不是可选注释。
 */
export function parseEditionDraft(rawText: string): ParseResult {
  const issues: ValidationIssue[] = [];
  const body = unwrapDraft(rawText);
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1 || (lines[first] ?? '').trim() !== EDITION_DRAFT_HEADER) {
    error(issues, `第一行必须是 ${EDITION_DRAFT_HEADER}；不接受 JSON/YAML 批次或其他协议`);
    return { ok: false, issues };
  }
  const meta: Partial<Record<'title' | 'subtitle' | 'description', string>> = {};
  const components: EditionDraftComponent[] = [];
  let current: EditionDraftComponent | null = null;

  for (let i = first + 1; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line === '') continue;
    if (/^[{[]/.test(line) || /^(batch|channel|brief|scenes?|effects|new_entities|id)\s*:/.test(line)) {
      error(issues, '草稿不接受可执行 JSON/YAML 内容，只接受组件语法');
      return { ok: false, issues };
    }
    if (current === null) {
      if (line.startsWith('@')) {
        const key = META_KEYS.find((entry) => line === entry || line.startsWith(`${entry} `));
        if (key) {
          if (components.length) error(issues, `${key} 必须写在组件之前`);
          else if (meta[key.slice(1) as 'title'] !== undefined) error(issues, `${key} 重复`);
          else meta[key.slice(1) as 'title'] = line.slice(key.length).trim();
          continue;
        }
        const opened = componentOf(line);
        if (opened.bad) {
          error(issues, opened.bad);
          return { ok: false, issues };
        }
        if (components.length >= MAX_COMPONENTS) {
          error(issues, `组件超过 ${MAX_COMPONENTS} 个；一个单元应拆成更小的阅读单元`);
          return { ok: false, issues };
        }
        current = opened.component!;
        continue;
      }
      error(issues, `组件块之外不允许正文：${line.slice(0, 30)}`);
      return { ok: false, issues };
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
    return { ok: false, issues };
  }
  for (const key of ['title', 'subtitle', 'description'] as const) {
    if (!meta[key]) error(issues, `缺少元数据 @${key}`);
  }
  for (const [key, cap] of [['title', 120], ['subtitle', 160], ['description', 500]] as const) {
    if ((meta[key] ?? '').length > cap) error(issues, `@${key} 超过 ${cap} 字符上限`);
  }
  if (!components.length) error(issues, '单元至少要有一个组件');
  if (issues.some((issue) => issue.level === 'error')) return { ok: false, issues };
  return {
    ok: true,
    draft: {
      meta: { title: meta.title!, subtitle: meta.subtitle!, description: meta.description! },
      components,
    },
  };
}

/** choice / @reply 的 ? + - = 解析（与创作协议同构，但答案位置由编译种子决定）。 */
export interface ChoiceLines { prompt: string; correct: string; distractors: string[]; feedback: string }

export function parseChoiceLines(lines: readonly string[], issues: ValidationIssue[], where: string): ChoiceLines | null {
  const before = issues.filter((issue) => issue.level === 'error').length;
  const result: ChoiceLines = { prompt: '', correct: '', distractors: [], feedback: '' };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
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
  const labels = [result.correct, ...result.distractors].filter(Boolean).map((label) => label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) error(issues, `${where}：选项重复`);
  if (result.distractors.some((distractor) => !distractor.trim())) error(issues, `${where}：干扰项不能为空`);
  const failed = issues.filter((issue) => issue.level === 'error').length > before;
  return failed ? null : result;
}
