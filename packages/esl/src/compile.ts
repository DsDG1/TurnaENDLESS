/**
 * 编译器（第 5.8.7 节）：把通过校验的批次编成扁平节点表 Runtime AST。
 * 文本渲染器与 app 运行时只读 AST，不读 ESL；derive 场景在这里展开成派生检测。
 */
import type { Batch, Effect, EvidenceType } from './model.js';
import { contentHash } from './hash.js';
import { locateForm, type TextUnit } from './text.js';
import type { ValidateOutput } from './validate.js';
import type { InkPathInfo } from './ink.js';

export interface AstNode {
  id: string;
  type: string;
  parent?: string;
  data: Record<string, unknown>;
}

export interface DerivedPick {
  sceneId: string;
  from: string;
  item: string;
  clozeText: string;
  options: string[];
  correct: string;
  /** 同批来源＝practice（不写入 FSRS）；跨批来源＝声明的证据类型 */
  evidenceType: EvidenceType;
}

export interface RuntimeAst {
  hash: string;
  batch: string;
  channel: string;
  brief: string;
  nodes: AstNode[];
  targets: ValidateOutput['targets'];
  evidence: { sceneId: string; item: string; type: EvidenceType; derived: EvidenceType | null }[];
  effects: { sceneId: string; name: string; ops: Effect[] }[];
  ink: { sceneId: string; paths: InkPathInfo[] }[];
  derived: DerivedPick[];
}

export interface CompileContext {
  lexicon: { formsOf(item: string): string[] | undefined; confusables(item: string): string[] };
  /** 跨批派生（from 指向更早批次）时提供：batchId → 该批文本单元 */
  priorTexts?: Map<string, TextUnit[]>;
  /** confusables 不足时补充干扰项的形式池 */
  distractorPool?: string[];
}

/** 解析 from 路径（如 s1.panels[1].bubbles[0] 或 dd-0041.s1.panels[0].bubbles[0]）。 */
function resolveFrom(
  from: string,
  units: TextUnit[],
  priorTexts: Map<string, TextUnit[]> | undefined,
): { unit: TextUnit; crossBatch: boolean } | undefined {
  const parts = from.split('.');
  const first = parts[0]!;
  // 形如 dd-0041 的批次前缀 → 跨批引用
  if (/^[a-z]+-\d+$/.test(first)) {
    const sceneId = parts[1];
    const path = parts.slice(2).join('.');
    const unit = (priorTexts?.get(first) ?? []).find((u) => u.sceneId === sceneId && (path === '' || u.path === path));
    return unit ? { unit, crossBatch: true } : undefined;
  }
  const rest = parts.slice(1).join('.');
  const unit = units.find((u) => u.sceneId === first && (rest === '' || u.path === rest));
  return unit ? { unit, crossBatch: false } : undefined;
}

export function compileBatch(batch: Batch, output: ValidateOutput, ctx: CompileContext): RuntimeAst {
  const nodes: AstNode[] = [];
  const push = (id: string, type: string, data: Record<string, unknown>, parent?: string) =>
    nodes.push({ id, type, parent, data });

  push(batch.batch, 'batch', {
    channel: batch.channel,
    brief: batch.brief,
    cast: batch.cast,
    new_entities: batch.new_entities ?? [],
    hook_out: batch.hook_out ?? null,
  });

  const evidence: RuntimeAst['evidence'] = [];
  const effects: RuntimeAst['effects'] = [];
  const ink: RuntimeAst['ink'] = [];
  const derived: DerivedPick[] = [];

  for (const scene of batch.scenes) {
    const sid = scene.id;
    const { effects: _sceneEffects, ...sceneRest } = scene;
    push(sid, scene.type, sceneRest, batch.batch);
    for (const [name, ops] of Object.entries(scene.effects ?? {})) {
      effects.push({ sceneId: sid, name, ops });
    }
    if (scene.evidence) {
      evidence.push({
        sceneId: sid,
        item: scene.evidence.item,
        type: scene.evidence.type,
        derived: output.derivedEvidence.find((d) => d.sceneId === sid)?.derived ?? null,
      });
    }
    const inkRes = output.ink.get(sid);
    if (inkRes?.ok) ink.push({ sceneId: sid, paths: inkRes.paths });

    if (scene.type === 'comic') {
      scene.panels.forEach((p, pi) => {
        const pid = `${sid}.p${pi}`;
        push(pid, 'panel', { shot: p.shot, actors: p.actors, props: p.props, caption: p.caption ?? null, setting: pi === 0 ? scene.setting : undefined }, sid);
        p.bubbles.forEach((b, bi) => push(`${pid}.b${bi}`, 'bubble', { speaker: b.speaker, text: b.text }, pid));
      });
    } else if (scene.type === 'chat') {
      push(`${sid}.skin`, 'skin', { skin: scene.skin }, sid);
      scene.messages.forEach((m, mi) => push(`${sid}.m${mi}`, 'message', { from: m.from, text: m.text }, sid));
      if (scene.reply) {
        push(`${sid}.reply`, 'reply', { prompt: scene.reply.prompt ?? null, on_correct: scene.reply.on_correct, on_wrong: scene.reply.on_wrong }, sid);
        scene.reply.options.forEach((o, oi) =>
          push(`${sid}.reply.o${oi}`, 'option', { label: o.label, correct: o.correct === true, effect: o.effect ?? null }, `${sid}.reply`),
        );
      }
    } else if (scene.type === 'swipe') {
      push(`${sid}.prompt`, 'prompt', { text: scene.prompt, mode: scene.mode }, sid);
      scene.cards.forEach((c, ci) => push(`${sid}.c${ci}`, 'card', { asset: c.asset, caption: c.caption, side: c.side }, sid));
    } else if (scene.type === 'pick') {
      push(`${sid}.q`, 'question', { text: scene.question, hint: scene.hint ?? null }, sid);
      scene.options.forEach((o, oi) => push(`${sid}.o${oi}`, 'option', { label: o.label, asset: o.asset ?? null, correct: o.correct === true }, sid));
      push(`${sid}.fb`, 'feedback', scene.feedback, sid);
    } else if (scene.type === 'hidden_object') {
      push(`${sid}.bg`, 'background', { asset: scene.background, spots: scene.spots, instruction: scene.instruction }, sid);
      scene.objects.forEach((o, oi) => push(`${sid}.ob${oi}`, 'object', { asset: o.asset, spot: o.spot, target: o.target === true }, sid));
    } else if (scene.type === 'story') {
      push(`${sid}.ink`, 'ink', { source: scene.ink }, sid);
    } else if (scene.type === 'quiz') {
      push(`${sid}.q`, 'question', { text: scene.prompt, kind: scene.kind }, sid);
      scene.options.forEach((o, oi) =>
        push(`${sid}.o${oi}`, 'option', { label: o.label, asset: o.asset ?? null, correct: o.correct === true }, sid));
      push(`${sid}.fb`, 'feedback', scene.feedback, sid);
    } else if (scene.type === 'card') {
      push(`${sid}.front`, 'card_front', { text: scene.front, item: scene.item }, sid);
    } else if (scene.type === 'derive') {
      const resolved = resolveFrom(scene.from, output.textUnits, ctx.priorTexts ?? new Map());
      if (resolved) {
        const forms = ctx.lexicon.formsOf(scene.item) ?? [];
        let clozeText = resolved.unit.text;
        let correct = '';
        for (const form of forms) {
          const hit = locateForm(resolved.unit.text, form)[0];
          if (hit) {
            correct = form;
            clozeText = resolved.unit.text.slice(0, hit.start) + '____' + resolved.unit.text.slice(hit.end);
            break;
          }
        }
        const distractors: string[] = [];
        if (correct) {
          for (const cid of ctx.lexicon.confusables(scene.item)) {
            const f = (ctx.lexicon.formsOf(cid) ?? [])[0];
            if (f && f !== correct) distractors.push(f);
          }
          for (const f of ctx.distractorPool ?? []) {
            if (distractors.length >= 3) break;
            if (f !== correct && !distractors.includes(f)) distractors.push(f);
          }
        }
        const options = [correct, ...distractors.slice(0, 3)];
        derived.push({
          sceneId: sid,
          from: scene.from,
          item: scene.item,
          clozeText,
          options,
          correct,
          evidenceType: resolved.crossBatch ? 'recognition-4' : 'practice',
        });
        push(sid, 'derive_spec', { from: scene.from, item: scene.item, kind: scene.kind }, batch.batch);
      }
    }
  }

  const ast: RuntimeAst = {
    hash: '',
    batch: batch.batch,
    channel: batch.channel,
    brief: batch.brief,
    nodes,
    targets: output.targets,
    evidence,
    effects,
    ink,
    derived,
  };
  ast.hash = contentHash({ ...ast, hash: '' });
  return ast;
}
