/**
 * 程序化自检（实验方案第 7 节：生成后自检 + 定点修复，能程序化的部分先程序化）。
 *
 * 做五类「删声明 / 换名字、不改故事」的机械修复，每条都对应校验器的一条阻断规则：
 *   1. uses 里的条目在本场景文本中找不到 → 删掉这条声明（E-USES-NOT-FOUND）
 *   2. 声明了但没有任何选项 / ink 标签引用的 effect → 删掉（E-EFFECT-INVALID）
 *   3. 新条目（brief.introduce）累计曝光 < 2 就被检测 → 去掉检测（E-NEW-TESTED-EARLY）
 *   4. 角色属性不在规格表（expr 写了个没有的表情、hat 写了个没有的配件、用了没开的键）
 *      → expr 换成该角色的 neutral（没有就取第一个表情），hat 与未知键直接删（E-CHAR-ATTR）
 *   5. 素材清单里不存在的 emoji，且该字段是纯装饰（comic 的 props、pick 选项的图案）
 *      → 删掉这一项（E-ASSET-MISSING）
 *
 * 为什么是删而不是让模型重写：这几类问题都是「声明与事实对不上」，删掉声明后
 * 批次讲的故事一个字没变，只是不再声称做了没做的事（世界状态也不会被悄悄改掉）。
 * 第 4 类换成 neutral 是唯一一处「改值」，因为 express 是给插画用的装饰字段，
 * 不在规格表的表情根本画不出来；换成一个合法表情不改变台词与判定。
 * 语义类问题（说话者不在 cast、事实冲突、答案不唯一）不在这里修，留给修复循环 ——
 * 那些改动会改变故事本身，必须由模型重写并经人审。
 */
import { EVIDENCE_RANK, type Batch, type Scene } from './model.js';
import { parseAssetRef } from './assets.js';
import { batchTextUnits, locateForm } from './text.js';
import { checkInk } from './ink.js';
import type { ValidationContext } from './validate.js';

export interface AutoFixResult {
  batch: Batch;
  /** 人类可读的修复记录，按发生顺序；为空表示没有可修的 */
  fixes: string[];
}

const isRetrieval = (t: string) => ((EVIDENCE_RANK as Record<string, number>)[t] ?? 0) >= 1;

/** 可变视图：场景是联合类型，这里只碰三个可选字段 */
type MutableScene = Scene & {
  uses?: string[];
  effects?: Record<string, unknown>;
  evidence?: { item: string; type: string };
};

export function autoFixBatch(batch: Batch, ctx: ValidationContext): AutoFixResult {
  const fixes: string[] = [];
  const next = structuredClone(batch) as Batch;
  const scenes = next.scenes as MutableScene[];
  const formsOf = (item: string) => (ctx.lexicon.formsOf(item) ?? []).map((f) => f.toLowerCase());

  // ---------- 1. uses 定位失败 ----------
  const units = batchTextUnits(next);
  for (const scene of scenes) {
    if (!scene.uses || scene.uses.length === 0) continue;
    const sceneUnits = units.filter((u) => u.sceneId === scene.id);
    const kept = scene.uses.filter((item) => {
      const forms = formsOf(item);
      if (forms.length === 0) return true; // 词库外的条目归 E-SCHEMA 管，不在这里吞掉
      return sceneUnits.some((u) => forms.some((form) => locateForm(u.text, form).length > 0));
    });
    if (kept.length === scene.uses.length) continue;
    for (const item of scene.uses) {
      if (!kept.includes(item)) fixes.push(`${scene.id}：删掉文本里找不到的 uses「${item}」`);
    }
    if (kept.length === 0) delete scene.uses;
    else scene.uses = kept;
  }

  // ---------- 2. 声明了但从未被引用的 effect ----------
  for (const scene of scenes) {
    if (!scene.effects) continue;
    const referenced = new Set<string>();
    if (scene.type === 'chat' && scene.reply) {
      for (const o of scene.reply.options) {
        const eff = (o as { effect?: string }).effect;
        if (eff) referenced.add(eff);
      }
    }
    const ink = scene.type === 'story' ? scene.ink : scene.type === 'chat' ? scene.ink : undefined;
    if (ink !== undefined) {
      const res = checkInk(ink);
      if (res.ok) for (const path of res.paths) for (const name of path.effects) referenced.add(name);
    }
    const dead = Object.keys(scene.effects).filter((name) => !referenced.has(name));
    if (dead.length === 0) continue;
    for (const name of dead) {
      delete scene.effects[name];
      fixes.push(`${scene.id}：删掉没有被任何选项或 ink 标签引用的 effect「${name}」`);
    }
    if (Object.keys(scene.effects).length === 0) delete scene.effects;
  }

  // ---------- 3. 新条目曝光不足就被检测 ----------
  const introduce = new Set(ctx.brief?.introduce ?? []);
  if (introduce.size > 0 && ctx.exposureCounts) {
    for (const scene of scenes) {
      const ev = scene.evidence;
      if (!ev || !introduce.has(ev.item) || !isRetrieval(ev.type)) continue;
      if ((ctx.exposureCounts.get(ev.item) ?? 0) >= 2) continue;
      delete scene.evidence;
      fixes.push(`${scene.id}：去掉新条目「${ev.item}」的检测（累计曝光不足 2 次）`);
    }
  }

  // ---------- 4. 角色属性不在规格表 ----------
  const charRef = (entity: string, attrs: Record<string, string>) => {
    const parts = Object.entries(attrs).map(([k, v]) => `${k}=${v}`);
    return parts.length > 0 ? `@char:${entity}{${parts.join(', ')}}` : `@char:${entity}`;
  };
  for (const scene of scenes) {
    if (scene.type !== 'comic') continue;
    scene.panels.forEach((panel, pi) => {
      panel.actors = panel.actors.map((ref) => {
        const parsed = parseAssetRef(ref);
        if (!parsed || parsed.kind !== 'char') return ref;
        const spec = ctx.assets.chars.get(parsed.entity);
        if (!spec) return ref; // 角色本身不存在归 E-ASSET-MISSING，不在这里编造
        const attrs = { ...parsed.attrs };
        let changed = false;
        if (attrs.expr !== undefined && !spec.expr.includes(attrs.expr)) {
          const fallback = spec.expr.includes('neutral') ? 'neutral' : spec.expr[0];
          const bad = attrs.expr;
          if (fallback === undefined) {
            delete attrs.expr;
            fixes.push(`${scene.id}：panel[${pi}] ${parsed.entity} 的 expr「${bad}」不在表情表且无可替换，删掉`);
          } else {
            attrs.expr = fallback;
            fixes.push(`${scene.id}：panel[${pi}] ${parsed.entity} 的 expr「${bad}」不在表情表，改成「${fallback}」`);
          }
          changed = true;
        }
        for (const key of Object.keys(attrs)) {
          if (key === 'expr') continue;
          const allowed = key === 'hat' ? spec.hat : spec.props_allowed;
          if (allowed.includes(attrs[key]!)) continue;
          const bad = attrs[key];
          delete attrs[key];
          fixes.push(`${scene.id}：panel[${pi}] ${parsed.entity} 的 ${key}「${bad}」不在规格表，删掉`);
          changed = true;
        }
        return changed ? charRef(parsed.entity, attrs) : ref;
      });
    });
  }

  // ---------- 5. 纯装饰位引用了不存在的 emoji ----------
  const emojiMissing = (ref: string | undefined) => {
    if (!ref) return false;
    const parsed = parseAssetRef(ref);
    return parsed?.kind === 'emoji' && !ctx.assets.emojis.has(parsed.name);
  };
  for (const scene of scenes) {
    if (scene.type === 'comic') {
      scene.panels.forEach((panel, pi) => {
        const dead = panel.props.filter((p) => emojiMissing(p));
        if (dead.length === 0) return;
        panel.props = panel.props.filter((p) => !emojiMissing(p));
        for (const p of dead) fixes.push(`${scene.id}：panel[${pi}] 删掉素材清单里没有的道具「${p}」`);
      });
    } else if (scene.type === 'pick') {
      scene.options.forEach((o, oi) => {
        const asset = (o as { asset?: string }).asset;
        if (!emojiMissing(asset)) return;
        delete (o as { asset?: string }).asset;
        fixes.push(`${scene.id}：options[${oi}] 删掉素材清单里没有的图案「${asset}」`);
      });
    }
  }

  return { batch: next, fixes };
}
