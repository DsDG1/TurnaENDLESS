/**
 * 程序化自检（实验方案第 7 节：生成后自检 + 定点修复，能程序化的部分先程序化）。
 *
 * 做六类「删声明 / 换名字、不改故事」的机械修复，每条都对应校验器的一条阻断规则：
 *   0. 别名替换（A2）：只按人事先声明的别名表把口语名字换成合法名字（背景/emoji/角色），
 *      V0 仍按替换前口径单列，所以它不会把「模型没写对」藏起来
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
  /** 别名替换命中（A2）：单独计数进报告，V0 仍按替换前口径 */
  aliasHits: { from: string; to: string; kind: 'background' | 'emoji' | 'char' }[];
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
  const aliasHits: AutoFixResult['aliasHits'] = [];
  const next = structuredClone(batch) as Batch;
  const scenes = next.scenes as MutableScene[];
  const formsOf = (item: string) => (ctx.lexicon.formsOf(item) ?? []).map((f) => f.toLowerCase());

  // ---------- 0. 别名替换（A2 第六类）----------
  // 只查人事先声明的别名表：等价关系是数据，不是程序猜的（结果 §7 第 4 条划的边界）。
  // 查不到就照旧走修复循环；V0 用替换前口径，所以这里不会把「模型没写对」藏起来。
  const aliasOf = (name: string) => ctx.assets.aliases?.get(name.toLowerCase());

  /** 素材引用改写；不需要改时返回 null。 */
  const rewriteRef = (ref: string): string | null => {
    const parsed = parseAssetRef(ref);
    if (!parsed) return null;
    if (parsed.kind === 'emoji' && !ctx.assets.emojis.has(parsed.name)) {
      const a = aliasOf(parsed.name);
      if (!a) return null;
      if (a.kind === 'emoji') return `@emoji:${a.target}`;
      if (a.kind === 'background') return `@tag:${a.target}`;
      return null;
    }
    if (parsed.kind === 'tag' && !ctx.assets.tags.has(parsed.tag)) {
      const a = aliasOf(parsed.tag);
      if (a?.kind === 'background') return `@tag:${a.target}`;
      if (a?.kind === 'emoji') return `@emoji:${a.target}`;
      return null;
    }
    if (parsed.kind === 'char' && !ctx.assets.chars.has(parsed.entity)) {
      const a = aliasOf(parsed.entity);
      if (a?.kind !== 'char') return null;
      const attrs = Object.entries(parsed.attrs).map(([k, v]) => `${k}=${v}`);
      return attrs.length > 0 ? `@char:${a.target}{${attrs.join(', ')}}` : `@char:${a.target}`;
    }
    return null;
  };

  const fixRef = (ref: string, where: string): string => {
    const replaced = rewriteRef(ref);
    if (replaced === null) return ref;
    const parsedFrom = parseAssetRef(ref);
    const parsedTo = parseAssetRef(replaced);
    const kind = parsedTo?.kind === 'tag' ? 'background' : parsedTo?.kind === 'char' ? 'char' : 'emoji';
    const fromName = parsedFrom?.kind === 'tag' ? parsedFrom.tag : parsedFrom?.kind === 'char' ? parsedFrom.entity : parsedFrom?.kind === 'emoji' ? parsedFrom.name : ref;
    const toName = parsedTo?.kind === 'tag' ? parsedTo.tag : parsedTo?.kind === 'char' ? parsedTo.entity : parsedTo?.kind === 'emoji' ? parsedTo.name : replaced;
    aliasHits.push({ from: fromName, to: toName, kind });
    fixes.push(`${where}：按别名表把 ${ref} 换成 ${replaced}`);
    return replaced;
  };

  /**
   * 实体 id 改写（cast / 说话者 / new_entities 用）。
   * 顺带记下「替换后真正出现的角色」：模型常常只在 `@char:` 或说话者位置写了别名、
   * 却没把那个角色写进批次 cast，替换完反而变成「说话者不在 cast」。
   */
  const renamedChars = new Set<string>();
  const aliasEntity = (id: string): string | null => {
    const a = aliasOf(id);
    if (a?.kind !== 'char') return null;
    // 目标必须是角色规格表里的真角色，否则宁可不动（那是修复循环的事）
    if (ctx.assets.chars.has(a.target)) renamedChars.add(a.target);
    return a.target;
  };

  for (const scene of scenes) {
    if (scene.type === 'comic') {
      scene.setting = fixRef(scene.setting, `${scene.id}.setting`);
      scene.panels.forEach((p, pi) => {
        p.actors = p.actors.map((a, ai) => fixRef(a, `${scene.id}.panels[${pi}].actors[${ai}]`));
        p.props = p.props.map((a, ai) => fixRef(a, `${scene.id}.panels[${pi}].props[${ai}]`));
        p.bubbles.forEach((b, bi) => {
          const fixed = aliasEntity(b.speaker);
          if (fixed) {
            fixes.push(`${scene.id}.panels[${pi}].bubbles[${bi}]：按别名表把说话者 ${b.speaker} 换成 ${fixed}`);
            aliasHits.push({ from: b.speaker, to: fixed, kind: 'char' });
            b.speaker = fixed;
          }
        });
      });
    } else if (scene.type === 'swipe') {
      scene.cards.forEach((c, ci) => {
        c.asset = fixRef(c.asset, `${scene.id}.cards[${ci}].asset`);
      });
    } else if (scene.type === 'pick' || scene.type === 'quiz') {
      scene.options.forEach((o, oi) => {
        if (o.asset) o.asset = fixRef(o.asset, `${scene.id}.options[${oi}].asset`);
      });
    } else if (scene.type === 'hidden_object') {
      scene.background = fixRef(scene.background, `${scene.id}.background`);
      scene.objects.forEach((o, oi) => {
        o.asset = fixRef(o.asset, `${scene.id}.objects[${oi}].asset`);
      });
    } else if (scene.type === 'chat') {
      scene.messages.forEach((m, mi) => {
        const fixed = aliasEntity(m.from);
        if (fixed) {
          fixes.push(`${scene.id}.messages[${mi}]：按别名表把说话者 ${m.from} 换成 ${fixed}`);
          aliasHits.push({ from: m.from, to: fixed, kind: 'char' });
          m.from = fixed;
        }
      });
      if (scene.reply) {
        for (const side of ['on_correct', 'on_wrong'] as const) {
          const fixed = aliasEntity(scene.reply[side].from);
          if (fixed) {
            fixes.push(`${scene.id}.reply.${side}：按别名表把说话者 ${scene.reply[side].from} 换成 ${fixed}`);
            aliasHits.push({ from: scene.reply[side].from, to: fixed, kind: 'char' });
            scene.reply[side].from = fixed;
          }
        }
      }
    } else if (scene.type === 'story') {
      // ink 的说话者前缀（`Mouse: ...`）也要跟着换，否则换完 cast 反而对不上
      scene.ink = scene.ink.replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/gm, (all, indent: string, name: string, tail: string) => {
        const fixed = aliasEntity(name);
        if (!fixed) return all;
        fixes.push(`${scene.id}.ink：按别名表把说话者 ${name} 换成 ${fixed}`);
        aliasHits.push({ from: name, to: fixed, kind: 'char' });
        return `${indent}${fixed}${tail}`;
      });
    }
    if (scene.cast) {
      scene.cast = scene.cast.map((id) => {
        const fixed = aliasEntity(id);
        return fixed ?? id;
      });
    }
  }
  next.cast = next.cast.map((id) => aliasEntity(id) ?? id);
  // 替换只改了引用、没改批次 cast 的补进去：不补就是「说话者不在 cast」（E-ENTITY-UNKNOWN）
  for (const id of renamedChars) {
    if (next.cast.includes(id)) continue;
    next.cast.push(id);
    fixes.push(`batch.cast：补入按别名表替换后的角色 ${id}（引用已指向它，不补就对不上）`);
  }
  if (next.new_entities) {
    // 自造实体如果其实是某个已知角色的别名，删掉声明（角色本来就在注册表里）
    const kept = next.new_entities.filter((e) => {
      const fixed = aliasEntity(e.id);
      if (!fixed) return true;
      fixes.push(`new_entities：删掉「${e.id}」的声明（别名表指向已存在的角色 ${fixed}）`);
      aliasHits.push({ from: e.id, to: fixed, kind: 'char' });
      return false;
    });
    if (kept.length === 0) delete next.new_entities;
    else next.new_entities = kept;
  }

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
    } else if (scene.type === 'pick' || scene.type === 'quiz') {
      scene.options.forEach((o, oi) => {
        const asset = (o as { asset?: string }).asset;
        if (!emojiMissing(asset)) return;
        delete (o as { asset?: string }).asset;
        fixes.push(`${scene.id}：options[${oi}] 删掉素材清单里没有的图案「${asset}」`);
      });
    }
  }

  return { batch: next, fixes, aliasHits };
}
