/** 编剧室（Showrunner，第 5.7.1 节）与预检（第 5.7.2 节，纯程序不调 LLM）。 */
import { z } from 'zod';
import type { EvidenceType } from '@endless/esl';
import type { LearningBrief } from '@endless/learning';
import type { TropeLedger } from './ledger.js';

export const SCENE_TYPES = ['comic', 'chat', 'swipe', 'pick', 'hidden_object', 'story'] as const;
export type SceneType = (typeof SCENE_TYPES)[number];

export const ShowrunnerPlan = z.object({
  logline: z.string().min(1),
  channel: z.string().min(1),
  cast: z.array(z.string()).min(1),
  beats: z
    .array(z.object({ n: z.number().int().min(1), scene: z.enum(SCENE_TYPES), gist: z.string().min(1) }))
    .min(3)
    .max(4),
  thread_ops: z
    .array(
      z.union([
        z.object({ op: z.literal('open'), id: z.string(), title: z.string() }),
        z.object({ op: z.literal('advance'), id: z.string() }),
        z.object({ op: z.literal('resolve'), id: z.string() }),
      ]),
    )
    .optional(),
  callback: z.string().nullable().optional(),
  tropes: z.array(z.string()).default([]),
  punchline: z.string().optional(),
  learning_placement: z
    .array(z.object({ item: z.string(), beat: z.number().int(), as: z.string() }))
    .default([]),
  /**
   * 本批需要的背景 / 道具 / 配角（A2）：用人话写，程序按别名表解析成合法名字。
   * 这是「把名字从生成挪到选择」的入口 —— 编剧室声明意图，写手只从解析结果里引用。
   */
  needs: z
    .object({
      background: z.string().optional(),
      props: z.array(z.string()).default([]),
      cast: z.array(z.string()).default([]),
    })
    .optional(),
  hook_out: z.string().optional(),
});
export type ShowrunnerPlan = z.infer<typeof ShowrunnerPlan>;

export interface PrecheckInput {
  plan: ShowrunnerPlan;
  brief: LearningBrief;
  ledger: TropeLedger;
  /** 实体是否已知（世界状态库 + new_entities 由编剧室在 ESL 阶段声明） */
  entityExists: (id: string) => boolean;
  /** 条目 → 形式（防启动粗查：gist 里不得提前出现复习条目的形式） */
  formsOf: (item: string) => string[];
  /**
   * 名字解析（A2）：把 `needs` 里的人话名字解析成合法名字。
   * 解析不了的项作为预检失败原因退回编剧室 —— 这一步纯程序、不花 token，
   * 正符合两段式「问题在第一步就拦下」的设计初衷。
   */
  resolveNeed?: (kind: 'background' | 'prop' | 'cast', asked: string) => { ok: boolean; value?: string; reason?: string };
}

/** 预检（5.7.2 表）。不合格附原因重试，最多 2 次；仍不合格记一次「预检失败」用最后一次继续。 */
export function precheckPlan(input: PrecheckInput): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const { plan, brief, ledger, entityExists, formsOf } = input;

  // 梗重复：与台账最近 20 批重合率 > 1/3
  if (ledger.overlapRatio(plan.tropes) > 1 / 3) {
    failures.push(`梗与台账重合率 ${(ledger.overlapRatio(plan.tropes) * 100).toFixed(0)}% 超过 1/3：${plan.tropes.join('/')}`);
  }
  // 结构重复：场景序列与最近 5 批之一完全相同
  const seq = plan.beats.map((b) => b.scene).join('|');
  if (ledger.recentSequences(5).some((s) => s.join('|') === seq)) {
    failures.push(`场景序列 ${seq} 与最近 5 批之一相同`);
  }
  // 学习覆盖：learning_placement 覆盖全部 review 和 expose
  const covered = new Set(plan.learning_placement.map((p) => p.item));
  for (const r of brief.review) {
    if (!covered.has(r.item)) failures.push(`learning_placement 未覆盖 review 条目 ${r.item}`);
  }
  for (const e of brief.expose) {
    if (!covered.has(e.item)) failures.push(`learning_placement 未覆盖 expose 条目 ${e.item}`);
  }
  // 防启动粗查：到期复习条目的检测节拍之前，gist 不得出现其形式（最终由校验器精查）
  for (const r of brief.review) {
    const testBeat = plan.learning_placement.find((p) => p.item === r.item && p.as !== 'exposure')?.beat;
    if (testBeat === undefined) continue;
    for (const b of plan.beats) {
      if (b.n >= testBeat) continue;
      for (const form of formsOf(r.item)) {
        if (b.gist.toLowerCase().includes(form.toLowerCase())) {
          failures.push(`节拍 ${b.n} 的梗概提前出现了复习条目 ${r.item} 的形式 "${form}"（检测在节拍 ${testBeat}）`);
        }
      }
    }
  }
  // 角色合法：cast 里的未知实体
  for (const id of plan.cast) {
    if (!entityExists(id)) failures.push(`cast 实体 ${id} 未知（新角色须在 new_entities 声明）`);
  }
  // 名字解析（A2）：needs 里每一项都必须解析成合法名字；解析不了退回编剧室换方案
  if (input.resolveNeed && plan.needs) {
    const { resolveNeed } = input;
    const check = (kind: 'background' | 'prop' | 'cast', word: string) => {
      const r = resolveNeed(kind, word);
      if (!r.ok) failures.push(r.reason ?? `needs.${kind} 的「${word}」解析不了`);
    };
    if (plan.needs.background) check('background', plan.needs.background);
    // zod 的 default([]) 只在 parse 后生效：手写计划（测试、插件）可能缺字段，这里兜一层空数组
    for (const p of plan.needs.props ?? []) check('prop', p);
    for (const c of plan.needs.cast ?? []) check('cast', c);
  }
  return { ok: failures.length === 0, failures };
}
