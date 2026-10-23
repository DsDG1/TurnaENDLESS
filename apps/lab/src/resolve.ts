/**
 * 名字解析（A2）：把「人话名字」解析成合法名字。
 *
 * 背景：剩下的 V2 失败全是「编名字」（结果 §4.2/§4.5），而提示词对名字无效（§5 #11）。
 * 参考给的出路是把名字从「生成」挪到「选择」：编剧室用人话声明需要什么，程序解析成合法名字，
 * 写手只从解析结果里引用。这里就是那个解析器 —— 纯查表，不猜测：
 *   1. 先用合法名字精确匹配；
 *   2. 再查人事先声明的别名表（`apartment → living_room`、`hat → top_hat`、`mouse → delivery_mouse`）；
 *   3. 都不中就是「解析不了」，由调用方当预检失败退回编剧室，绝不臆造。
 */
import type { LabData } from './data.js';

export type NeedKind = 'background' | 'prop' | 'cast';

export interface ResolvedName {
  ok: true;
  kind: NeedKind;
  /** 写进 ESL 的合法名字：@tag:<tag> / @emoji:<name> / @char:<id> 或实体 id */
  value: string;
  /** 命中方式：legit = 本来就是合法名字；alias = 查别名表 */
  via: 'legit' | 'alias';
  /** 编剧室原本写的词（日志与 V0 口径用） */
  asked: string;
}

export interface UnresolvedName {
  ok: false;
  kind: NeedKind;
  asked: string;
  reason: string;
}

export type NameResult = ResolvedName | UnresolvedName;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, '_');

/** 背景：恰好是背景标签，或别名指向某个背景。 */
export function resolveBackground(data: LabData, asked: string): NameResult {
  const word = norm(asked);
  if (word) {
    if (data.backgrounds.has(word)) return { ok: true, kind: 'background', value: `@tag:${word}`, via: 'legit', asked };
    const alias = data.aliases.get(word);
    if (alias?.kind === 'background') {
      return { ok: true, kind: 'background', value: `@tag:${alias.target}`, via: 'alias', asked };
    }
  }
  return {
    ok: false,
    kind: 'background',
    asked,
    reason: `背景「${asked}」既不是背景标签，也不在别名表里（合法：${[...data.backgrounds.keys()].join(' / ')}）`,
  };
}

/**
 * 道具：emoji 名 → 别名 → 标签（按名字排序取第一个）→ 标签别名。
 *
 * 别名必须排在「按标签挑 emoji」之前：`hat` 既是标签（`top_hat` 与 `cap` 都挂着它），
 * 又是人声明的别名（`hat → top_hat`）。按标签排序挑会挑到 `cap`，那是程序在猜；
 * 别名表是人事先写下的等价关系，应当优先。
 */
export function resolveProp(data: LabData, asked: string): NameResult {
  const word = norm(asked);
  if (word) {
    if (data.glyphs.has(word)) return { ok: true, kind: 'prop', value: `@emoji:${word}`, via: 'legit', asked };
    const alias = data.aliases.get(word);
    if (alias?.kind === 'emoji') return { ok: true, kind: 'prop', value: `@emoji:${alias.target}`, via: 'alias', asked };
    if (alias?.kind === 'background') {
      const bg = data.backgrounds.get(alias.target);
      if (bg) return { ok: true, kind: 'background', value: `@tag:${bg.tag}`, via: 'alias', asked };
    }
    if (data.assetTags.has(word)) {
      const names = (data.tagIndex.get(word) ?? []).slice().sort();
      if (names.length > 0) return { ok: true, kind: 'prop', value: `@emoji:${names[0]!}`, via: 'legit', asked };
    }
  }
  return {
    ok: false,
    kind: 'prop',
    asked,
    reason: `道具「${asked}」既不是 emoji 名，也不是标签或别名（写清单外的名字会整批失败）`,
  };
}

/** 角色：角色规格表 id → 角色别名 → 频道 cast 里的 id。 */
export function resolveCast(data: LabData, asked: string): NameResult {
  const word = norm(asked);
  if (word) {
    if (data.charSpecs.has(word)) return { ok: true, kind: 'cast', value: word, via: 'legit', asked };
    for (const bible of data.channels.values()) {
      if (bible.cast.some((c) => c.id === word)) return { ok: true, kind: 'cast', value: word, via: 'legit', asked };
    }
    const alias = data.aliases.get(word);
    if (alias?.kind === 'char') return { ok: true, kind: 'cast', value: alias.target, via: 'alias', asked };
  }
  const known = [...data.charSpecs.keys()].join(' / ');
  return { ok: false, kind: 'cast', asked, reason: `角色「${asked}」不在角色规格表，也不在别名表（合法：${known}）` };
}

export function resolveName(data: LabData, kind: NeedKind, asked: string): NameResult {
  if (kind === 'background') return resolveBackground(data, asked);
  if (kind === 'prop') return resolveProp(data, asked);
  return resolveCast(data, asked);
}

/** 泛化解析：给 autofix 的别名替换用（不知道调用点在哪个字段时）。 */
export function resolveAny(data: LabData, asked: string): NameResult | null {
  const word = norm(asked);
  if (!word) return null;
  if (data.backgrounds.has(word) || data.glyphs.has(word) || data.charSpecs.has(word)) return null; // 已经合法
  const alias = data.aliases.get(word);
  if (!alias) return null;
  if (alias.kind === 'background') return { ok: true, kind: 'background', value: `@tag:${alias.target}`, via: 'alias', asked };
  if (alias.kind === 'emoji') return { ok: true, kind: 'prop', value: `@emoji:${alias.target}`, via: 'alias', asked };
  return { ok: true, kind: 'cast', value: alias.target, via: 'alias', asked };
}
