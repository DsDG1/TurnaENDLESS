/**
 * ESL 校验器（第 5.9 节）：结构校验 → 素材解析 → 实体与 effect 校验 → ink 编译 →
 * 词汇检查 → 证据检查 → 状态一致性检查。产出问题分级（阻断级 / 建议级）。
 *
 * 边界说明：E-FACT-CONFLICT 的「台词以现在时陈述与当前事实相反」需要语义判断，
 * 程序只覆盖结构性部分（end_fact 与当前事实不符、set_fact 与 canon 冲突）；
 * 语义部分由评审模型标出并经人工确认（指标 C1 的另一半来源）。
 */
import {
  EVIDENCE_RANK,
  countBaseScenes,
  type Batch,
  type EvidenceType,
  type Scene,
  type ValidationIssue,
  type ValidationReport,
} from './model.js';
import { collectAssetRefs, parseAssetRef } from './assets.js';
import { batchTextUnits, inkTextUnits, locateForm, tokenize, wordCount, type TextUnit } from './text.js';
import { checkInk, type InkCheckResult } from './ink.js';

// ---------- 校验上下文（由调用方注入，包本身不依赖词库/存储实现） ----------

export interface CharSpec {
  expr: string[];
  hat: string[];
  props_allowed: string[];
}

export interface AssetCatalog {
  emojis: Set<string>;
  tags: Set<string>;
  chars: Map<string, CharSpec>;
}

export interface BriefSpec {
  id: string;
  review: { item: string; facet: string; minEvidence: EvidenceType }[];
  expose: { item: string }[];
  introduce: string[];
  avoidBeforeTest: string[]; // 形式列表（R4）
}

export interface ValidationContext {
  vocab: {
    /** 允许出现的全部小写形式（功能词 + 已知条目形式 + 专名 + allowed_extra + 本批目标条目形式） */
    allowedForms: Set<string>;
    oovWarn: number; // 0.02
    oovBlock: number; // 0.05
    maxWordsPerLine: number; // A1=12，A2=16
  };
  brief?: BriefSpec;
  lexicon: { formsOf(item: string): string[] | undefined; confusables(item: string): string[] };
  assets: AssetCatalog;
  entities: { exists(id: string): boolean };
  predicates: Map<string, { cardinality: 'single' | 'multi' }>;
  canonFacts: { subject: string; predicate: string; object: string }[];
  /** 当前仍成立的事实（valid_to 为空），供 end_fact 的一致性检查 */
  activeFacts: { subject: string; predicate: string; object: string; standing: string }[];
  threads: Map<string, { status: string }>;
  /** 本批之前每个条目的累计曝光数（R1：新条目首次检测前须 ≥ 2） */
  exposureCounts?: Map<string, number>;
  channelIsImprov?: boolean;
  /** 最近 5 批的场景类型序列（W-SEQUENCE-REPEAT） */
  recentSceneSequences?: string[][];
  /** 最近 10 批各角色出场次数（W-CAST-OVERUSE） */
  recentCastCounts?: Map<string, number>;
}

export interface ValidateOutput extends ValidationReport {
  textUnits: TextUnit[];
  targets: { sceneId: string; path: string; itemId: string; form: string; start: number; end: number }[];
  ink: Map<string, InkCheckResult>;
  sceneSequence: string[];
}

const retrievalTypes: EvidenceType[] = ['recognition-2', 'recognition-4', 'listening-4', 'production'];
const isRetrieval = (t: EvidenceType) => EVIDENCE_RANK[t] >= 1;

/** 推导场景的证据类型（第 5.8.4 节各场景的「证据推导」行）。null = 该场景不产生证据。 */
function deriveEvidenceType(scene: Scene): EvidenceType | null {
  switch (scene.type) {
    case 'pick':
      return scene.options.length === 4 && !scene.hint ? 'recognition-4' : 'recognition-2';
    case 'chat':
      if (!scene.reply) return null;
      return scene.reply.options.length === 4 ? 'recognition-4' : 'recognition-2';
    case 'hidden_object':
      return scene.spots.length >= 4 ? 'recognition-4' : 'recognition-2';
    case 'swipe':
      return scene.mode === 'judge' ? 'recognition-2' : null;
    case 'story':
      return 'recognition-2'; // 子集每处选择 ≤3 项
    default:
      return null;
  }
}

export function validateBatch(batch: Batch, ctx: ValidationContext): ValidateOutput {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string, scene?: string, path?: string) =>
    issues.push({ code, level: 'error', scene, path, message });
  const warn = (code: string, message: string, scene?: string, path?: string) =>
    issues.push({ code, level: 'warning', scene, path, message });

  const textUnits = batchTextUnits(batch);
  const formsOf = (item: string): string[] => {
    const f = ctx.lexicon.formsOf(item);
    return f ?? [];
  };

  // ---------- 1. 结构：场景数、ID 唯一 ----------
  const baseCount = countBaseScenes(batch);
  if (baseCount < 3 || baseCount > 4) {
    err('E-SCHEMA', `基本场景数为 ${baseCount}，须在 3–4 之间（derive 不计入）`);
  }
  const ids = new Set(batch.scenes.map((s) => s.id));
  if (ids.size !== batch.scenes.length) err('E-SCHEMA', '场景 id 不唯一');
  if (batch.scenes.length > 0 && baseCount === 0) err('E-SCHEMA', '批次不能只由派生场景组成');

  // ---------- 2. 实体 ----------
  const newIds = new Set((batch.new_entities ?? []).map((e) => e.id));
  for (const e of batch.new_entities ?? []) {
    if (ctx.entities.exists(e.id)) err('E-ENTITY-UNKNOWN', `new_entities 声明的实体 ${e.id} 已存在`, undefined, 'new_entities');
  }
  const entityOk = (id: string) => ctx.entities.exists(id) || newIds.has(id);
  for (const id of batch.cast) {
    if (!entityOk(id)) err('E-ENTITY-UNKNOWN', `cast 实体 ${id} 不存在且未在 new_entities 声明`, undefined, 'cast');
  }
  for (const scene of batch.scenes) {
    for (const id of scene.cast ?? []) {
      if (!batch.cast.includes(id)) err('E-SCHEMA', `场景 ${scene.id} 的 cast 包含 ${id}，不在批次 cast 内`, scene.id);
    }
    const speakers: { who: string; path: string }[] = [];
    if (scene.type === 'comic') {
      scene.panels.forEach((p, pi) => p.bubbles.forEach((b, bi) => speakers.push({ who: b.speaker, path: `panels[${pi}].bubbles[${bi}]` })));
    }
    if (scene.type === 'chat') {
      scene.messages.forEach((m, mi) => speakers.push({ who: m.from, path: `messages[${mi}]` }));
      if (scene.reply) speakers.push({ who: scene.reply.on_correct.from, path: 'reply.on_correct' });
    }
    for (const s of speakers) {
      if (!batch.cast.includes(s.who)) err('E-ENTITY-UNKNOWN', `说话者 ${s.who} 不在批次 cast`, scene.id, s.path);
    }
    if (scene.type === 'story') {
      for (const u of inkTextUnits(scene.ink)) {
        if (u.speaker && !batch.cast.includes(u.speaker.toLowerCase())) {
          err('E-ENTITY-UNKNOWN', `ink 说话者 ${u.speaker} 不在批次 cast`, scene.id, u.path);
        }
      }
    }
  }

  // ---------- 3. 素材解析 ----------
  for (const site of collectAssetRefs(batch)) {
    const parsed = parseAssetRef(site.ref);
    if (!parsed) {
      err('E-SCHEMA', `素材引用 ${site.ref} 语法非法`, site.sceneId, site.path);
      continue;
    }
    if (parsed.kind === 'emoji' && !ctx.assets.emojis.has(parsed.name)) {
      err('E-ASSET-MISSING', `@emoji:${parsed.name} 不在素材清单`, site.sceneId, site.path);
    }
    if (parsed.kind === 'tag' && !ctx.assets.tags.has(parsed.tag)) {
      err('E-ASSET-MISSING', `@tag:${parsed.tag} 查不到素材`, site.sceneId, site.path);
    }
    if (parsed.kind === 'char') {
      const spec = ctx.assets.chars.get(parsed.entity);
      if (!spec) {
        err('E-ASSET-MISSING', `角色规格表没有 ${parsed.entity}`, site.sceneId, site.path);
      } else {
        for (const [k, v] of Object.entries(parsed.attrs)) {
          if (k === 'expr') {
            if (!spec.expr.includes(v)) err('E-CHAR-ATTR', `expr=${v} 不在 ${parsed.entity} 的表情列表`, site.sceneId, site.path);
          } else if (k === 'hat') {
            if (!spec.hat.includes(v)) err('E-CHAR-ATTR', `hat=${v} 不在 ${parsed.entity} 的配件列表`, site.sceneId, site.path);
          } else if (!spec.props_allowed.includes(k)) {
            err('E-CHAR-ATTR', `键 ${k} 不在 ${parsed.entity} 的可用键列表`, site.sceneId, site.path);
          }
        }
      }
    }
  }

  // ---------- 4. effect 校验 ----------
  const threadStatus = (id: string) => ctx.threads.get(id)?.status;
  const declaredEffects = new Map<string, Set<string>>(); // sceneId -> names
  const referencedEffects = new Map<string, Set<string>>();
  const refEffect = (sceneId: string, name: string, where: string) => {
    if (!referencedEffects.has(sceneId)) referencedEffects.set(sceneId, new Set());
    referencedEffects.get(sceneId)!.add(name);
  };
  for (const scene of batch.scenes) {
    if (!scene.effects) continue;
    const names = new Set(Object.keys(scene.effects));
    declaredEffects.set(scene.id, names);
    for (const [name, ops] of Object.entries(scene.effects)) {
      const where = `${scene.id}.effects.${name}`;
      for (const op of ops) {
        if ('set_fact' in op) {
          const { subject, predicate, object } = op.set_fact;
          if (!entityOk(subject)) err('E-ENTITY-UNKNOWN', `set_fact 的 subject ${subject} 不存在`, scene.id, where);
          if (!ctx.predicates.has(predicate)) err('E-EFFECT-INVALID', `谓词 ${predicate} 未声明`, scene.id, where);
          if (ctx.canonFacts.some((f) => f.subject === subject && f.predicate === predicate && f.object !== object)) {
            err('E-CANON', `set_fact 试图改写 canon 事实 ${subject} ${predicate}`, scene.id, where);
          }
        } else if ('end_fact' in op) {
          const { subject, predicate, object } = op.end_fact;
          if (!entityOk(subject)) err('E-ENTITY-UNKNOWN', `end_fact 的 subject ${subject} 不存在`, scene.id, where);
          if (!ctx.predicates.has(predicate)) err('E-EFFECT-INVALID', `谓词 ${predicate} 未声明`, scene.id, where);
          if (ctx.canonFacts.some((f) => f.subject === subject && f.predicate === predicate && (object === undefined || f.object === object))) {
            err('E-CANON', `end_fact 试图结束 canon 事实 ${subject} ${predicate}`, scene.id, where);
          } else {
            const matching = ctx.activeFacts.filter((f) => f.subject === subject && f.predicate === predicate);
            if (matching.length === 0) {
              err('E-FACT-CONFLICT', `end_fact：${subject} ${predicate} 没有可结束的活动事实`, scene.id, where);
            } else if (object !== undefined && !matching.some((f) => f.object === object)) {
              err('E-FACT-CONFLICT', `end_fact：${subject} ${predicate} 的当前值是 ${matching.map((f) => f.object).join('/')}，与要结束的 ${object} 不符`, scene.id, where);
            }
          }
        } else if ('open_thread' in op) {
          if (threadStatus(op.open_thread.id) === 'open') {
            err('E-EFFECT-INVALID', `伏笔 ${op.open_thread.id} 已处于 open 状态`, scene.id, where);
          }
        } else if ('advance_thread' in op || 'resolve_thread' in op) {
          const id = 'advance_thread' in op ? op.advance_thread.id : op.resolve_thread.id;
          const st = threadStatus(id);
          if (st !== 'open') err('E-EFFECT-INVALID', `伏笔 ${id} 不存在或不在 open 状态（当前：${st ?? '无'}）`, scene.id, where);
        }
      }
    }
  }
  // 引用完整性：chat 选项
  for (const scene of batch.scenes) {
    if (scene.type === 'chat' && scene.reply) {
      scene.reply.options.forEach((o, oi) => {
        if (o.effect) {
          refEffect(scene.id, o.effect, `reply.options[${oi}]`);
          if (!scene.effects || !(o.effect in scene.effects)) {
            err('E-EFFECT-INVALID', `选项引用的 effect ${o.effect} 未声明`, scene.id, `reply.options[${oi}]`);
          }
        }
      });
    }
  }

  // ---------- 5. ink 编译与路径穷举（story 场景 + chat 的可选 ink） ----------
  const inkResults = new Map<string, InkCheckResult>();
  for (const scene of batch.scenes) {
    const src = scene.type === 'story' ? scene.ink : scene.type === 'chat' ? scene.ink : undefined;
    if (src === undefined) continue;
    const res = checkInk(src);
    inkResults.set(scene.id, res);
    if (!res.ok) {
      for (const e of res.errors) err('E-INK', e, scene.id);
    } else {
      for (const path of res.paths) {
        for (const name of path.effects) {
          refEffect(scene.id, name, 'ink');
          if (!declaredEffects.get(scene.id)?.has(name)) {
            err('E-EFFECT-INVALID', `ink 标签引用的 effect ${name} 未声明`, scene.id);
          }
        }
      }
    }
  }
  for (const [sceneId, names] of declaredEffects) {
    for (const name of names) {
      if (!referencedEffects.get(sceneId)?.has(name)) {
        err('E-EFFECT-INVALID', `effect ${name} 已声明但从未被引用`, sceneId);
      }
    }
  }

  // ---------- 6. 答案唯一性与重复 ----------
  for (const scene of batch.scenes) {
    if (scene.type === 'pick') {
      const n = scene.options.filter((o) => o.correct).length;
      if (n !== 1) err('E-ANSWER-COUNT', `pick 正确答案数为 ${n}，须恰好 1`, scene.id);
      const labels = scene.options.map((o) => o.label.trim().toLowerCase());
      if (new Set(labels).size !== labels.length) err('E-ANSWER-DUP', 'pick 选项重复', scene.id);
    }
    if (scene.type === 'chat' && scene.reply) {
      const n = scene.reply.options.filter((o) => o.correct).length;
      if (n !== 1) err('E-ANSWER-COUNT', `chat 回复正确答案数为 ${n}，须恰好 1`, scene.id);
      const labels = scene.reply.options.map((o) => o.label.trim().toLowerCase());
      if (new Set(labels).size !== labels.length) err('E-ANSWER-DUP', 'chat 选项重复', scene.id);
    }
    if (scene.type === 'hidden_object') {
      const n = scene.objects.filter((o) => o.target).length;
      if (n !== 1) err('E-ANSWER-COUNT', `hidden_object 目标数为 ${n}，须恰好 1`, scene.id);
      for (const o of scene.objects) {
        if (!scene.spots.includes(o.spot)) err('E-SCHEMA', `物体位置 ${o.spot} 不在该背景的位置表中`, scene.id);
      }
      const spotKeys = scene.objects.map((o) => o.spot);
      if (new Set(spotKeys).size !== spotKeys.length) err('E-ANSWER-DUP', '两个物体占据同一位置', scene.id);
    }
    if (scene.type === 'swipe' && scene.mode === 'judge') {
      const keys = scene.cards.map((c) => `${c.asset}|${c.caption.trim().toLowerCase()}`);
      if (new Set(keys).size !== keys.length) err('E-ANSWER-DUP', 'swipe 卡片重复', scene.id);
    }
  }

  // ---------- 7. 证据推导与过度声明 ----------
  const derivedEvidence: ValidationReport['derivedEvidence'] = [];
  for (const scene of batch.scenes) {
    if (scene.type === 'derive') continue;
    const derived = deriveEvidenceType(scene);
    derivedEvidence.push({ sceneId: scene.id, item: scene.evidence?.item ?? '', declared: scene.evidence?.type, derived });
    if (scene.type === 'chat' && scene.evidence && !scene.reply) {
      err('E-SCHEMA', 'chat 场景声明了 evidence 但没有 reply 交互', scene.id);
    }
    if (scene.type === 'story' && scene.evidence) {
      const hasChoice = inkResults.get(scene.id)?.paths.some((p) => p.choices.length > 0) ?? false;
      if (!hasChoice) err('E-SCHEMA', 'story 场景声明了 evidence 但没有任何选项', scene.id);
    }
    if (scene.evidence) {
      const item = scene.evidence.item;
      if (ctx.lexicon.formsOf(item) === undefined) err('E-SCHEMA', `条目 ${item} 不在词库（AI 不能发明条目 ID）`, scene.id, 'evidence');
      if (derived === null || (scene.evidence.type && EVIDENCE_RANK[scene.evidence.type] > EVIDENCE_RANK[derived])) {
        err('E-EVIDENCE-OVERCLAIM', `声明的证据 ${scene.evidence.type} 高于推导结果 ${derived ?? '无'}`, scene.id, 'evidence');
      }
      // 干扰项与答案不得是同一条目的不同形式
      const answerForms = new Set(formsOf(item));
      const labels: string[] = [];
      if (scene.type === 'pick') labels.push(...scene.options.map((o) => o.label));
      if (scene.type === 'chat' && scene.reply) labels.push(...scene.reply.options.map((o) => o.label));
      const correct = labels.find((l, i) =>
        (scene.type === 'pick' && scene.options[i]?.correct) ||
        (scene.type === 'chat' && scene.reply?.options[i]?.correct));
      for (const label of labels) {
        if (label === correct) continue;
        const norm = label.trim().toLowerCase();
        if (answerForms.has(norm)) {
          err('E-ANSWER-DUP', `干扰项 "${label}" 与答案是同一条目 ${item} 的不同形式`, scene.id);
        }
      }
    }
  }

  // ---------- 7.5 derive 场景的 from 路径（同批引用必须可解析；跨批引用运行期解析） ----------
  for (const scene of batch.scenes) {
    if (scene.type !== 'derive') continue;
    const first = scene.from.split('.')[0]!;
    if (/^[a-z]+-\d+$/.test(first)) continue; // 跨批引用，由编译器带 priorTexts 解析
    const ok = textUnits.some((u) => u.sceneId === first && u.path === scene.from.split('.').slice(1).join('.'));
    if (!ok) err('E-SCHEMA', `derive 的 from 路径 ${scene.from} 无法在本批次内解析`, scene.id);
    if (ctx.lexicon.formsOf(scene.item) === undefined) {
      err('E-SCHEMA', `条目 ${scene.item} 不在词库`, scene.id, 'item');
    }
  }

  // ---------- 8. uses 定位（E-USES-NOT-FOUND）与目标词区间 ----------
  const targets: ValidateOutput['targets'] = [];
  for (const scene of batch.scenes) {
    const units = textUnits.filter((u) => u.sceneId === scene.id);
    for (const item of scene.uses ?? []) {
      if (ctx.lexicon.formsOf(item) === undefined) {
        err('E-SCHEMA', `条目 ${item} 不在词库（AI 不能发明条目 ID）`, scene.id, 'uses');
        continue;
      }
      let found = false;
      for (const u of units) {
        for (const form of formsOf(item)) {
          for (const hit of locateForm(u.text, form)) {
            targets.push({ sceneId: scene.id, path: `${u.path}`, itemId: item, form, start: hit.start, end: hit.end });
            found = true;
          }
        }
      }
      if (!found) err('E-USES-NOT-FOUND', `uses 声明的条目 ${item} 在 ${scene.id} 的文本中找不到`, scene.id, 'uses');
    }
  }

  // ---------- 9. 防启动（E-PRIMED，R4） ----------
  // 每个到期复习条目：它的任何形式都不得出现在「它的检测」之前的文本里。
  // 之前的文本 ＝ 更早场景的全部文本 ＋ 检测场景的叙述部分（题面/选项属于检测本身）。
  // 注意：某条目检测之后的复用是允许的，所以窗口按条目各自计算，avoid_before_test
  // 只是规划器给的提示（其形式已包含在 formsOf 里），不单独全局检查。
  const brief = ctx.brief;
  if (brief) {
    const evidenceSceneOf = (item: string) =>
      batch.scenes.find(
        (s) => s.evidence?.item === item && isRetrieval(s.evidence.type) && s.evidence.type !== 'practice',
      );
    for (const r of brief.review) {
      const evScene = evidenceSceneOf(r.item);
      if (!evScene) continue; // 覆盖缺口由 E-BRIEF-UNCOVERED 报
      const evIndex = batch.scenes.findIndex((s) => s.id === evScene.id);
      for (const u of textUnits) {
        const before = u.sceneIndex < evIndex || (u.sceneIndex === evIndex && u.role === 'narrative');
        if (!before) continue;
        for (const form of formsOf(r.item)) {
          if (locateForm(u.text, form).length > 0) {
            err('E-PRIMED', `到期复习条目 ${r.item} 的形式 "${form}" 在检测（${evScene.id}）之前出现：${u.sceneId}.${u.path}`, u.sceneId, u.path);
          }
        }
      }
    }
  }

  // ---------- 10. 新条目过早检测（E-NEW-TESTED-EARLY，R1） ----------
  if (brief && ctx.exposureCounts) {
    for (const item of brief.introduce) {
      const tested = batch.scenes.some(
        (s) => s.evidence?.item === item && isRetrieval(s.evidence.type),
      );
      if (!tested) continue;
      const seen = ctx.exposureCounts.get(item) ?? 0;
      if (seen < 2) err('E-NEW-TESTED-EARLY', `新条目 ${item} 曝光 ${seen} 次（<2）就被检测`, undefined, undefined);
    }
  }

  // ---------- 11. brief 覆盖（E-BRIEF-UNCOVERED） ----------
  if (brief) {
    for (const r of brief.review) {
      const covered = batch.scenes.some(
        (s) =>
          s.evidence?.item === r.item &&
          isRetrieval(s.evidence.type) &&
          s.evidence.type !== 'practice' &&
          EVIDENCE_RANK[s.evidence.type] >= EVIDENCE_RANK[r.minEvidence],
      );
      if (!covered) err('E-BRIEF-UNCOVERED', `review 条目 ${r.item} 没有达到 ${r.minEvidence} 的合格证据`);
    }
    for (const ex of brief.expose) {
      const present = batch.scenes.some((s) => (s.uses ?? []).includes(ex.item));
      if (!present) err('E-BRIEF-UNCOVERED', `expose 条目 ${ex.item} 没有出现在任何场景的 uses`);
    }
  }

  // ---------- 12. 词汇预算（OOV 与句长） ----------
  const singleForms = ctx.vocab.allowedForms;
  const multiForms = new Set([...singleForms].filter((f) => f.includes(' ')));
  for (const f of multiForms) singleForms.delete(f);
  let totalTokens = 0;
  let oovTokens = 0;
  const oovDetail: string[] = [];
  for (const u of textUnits) {
    const tokens = tokenize(u.text);
    for (let i = 0; i < tokens.length; i++) {
      totalTokens++;
      const t = tokens[i]!;
      const next = i + 1 < tokens.length ? tokens[i + 1]! : null;
      // 所有格：`moon's hat` 里该查的是 moon；"'s" 本身永远不算生词。
      const possessiveBase = t.endsWith("'s") && t.length > 2 ? t.slice(0, -2) : null;
      if (
        singleForms.has(t) ||
        (possessiveBase !== null && singleForms.has(possessiveBase)) ||
        t === "n't" ||
        t === "'s"
      ) {
        continue;
      }
      if (next && multiForms.has(`${t} ${next}`)) {
        i++; // 多词形式占两个 token
        continue;
      }
      oovTokens++;
      if (oovDetail.length < 10) oovDetail.push(`${u.sceneId}.${u.path}:"${t}"`);
    }
  }
  const oovRatio = totalTokens === 0 ? 0 : oovTokens / totalTokens;
  if (totalTokens > 0 && oovRatio > ctx.vocab.oovBlock) {
    err('E-OOV-HIGH', `OOV 比例 ${(oovRatio * 100).toFixed(1)}% 超过 ${(ctx.vocab.oovBlock * 100).toFixed(0)}%：${oovDetail.join(' ')}`);
  } else if (totalTokens > 0 && oovRatio > ctx.vocab.oovWarn) {
    warn('W-OOV', `OOV 比例 ${(oovRatio * 100).toFixed(1)}%：${oovDetail.join(' ')}`);
  }
  for (const u of textUnits) {
    const wc = wordCount(u.text);
    if (wc > ctx.vocab.maxWordsPerLine) warn('W-LINE-LONG', `${u.sceneId}.${u.path} 有 ${wc} 词（上限 ${ctx.vocab.maxWordsPerLine}）："${u.text.slice(0, 40)}"`, u.sceneId, u.path);
  }

  // ---------- 13. 建议级：悬念 / 结构重复 / 角色过用 ----------
  const sceneSequence = batch.scenes.filter((s) => s.type !== 'derive').map((s) => s.type);
  if (!ctx.channelIsImprov && !batch.hook_out) warn('W-NO-HOOK', '持续频道的批次没有 hook_out');
  if (ctx.recentSceneSequences?.some((seq) => seq.length === sceneSequence.length && seq.join('|') === sceneSequence.join('|'))) {
    warn('W-SEQUENCE-REPEAT', '场景类型序列与最近 5 批之一相同');
  }
  for (const id of batch.cast) {
    if ((ctx.recentCastCounts?.get(id) ?? 0) >= 8) warn('W-CAST-OVERUSE', `角色 ${id} 在最近 10 批中出场过 ${(ctx.recentCastCounts?.get(id) ?? 0)} 次`);
  }

  // ---------- 14. 事实引用计数（C1 分母的程序部分：带说话者的叙述 + 旁白） ----------
  const factRefs = textUnits.filter(
    (u) => u.role === 'narrative' && (u.speaker !== undefined || u.path.includes('caption')),
  ).length;

  const ok = !issues.some((i) => i.level === 'error');
  return { ok, issues, derivedEvidence, factRefs, textUnits, targets, ink: inkResults, sceneSequence };
}
