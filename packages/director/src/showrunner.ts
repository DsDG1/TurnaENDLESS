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
  /**
   * 本批要发生的世界状态改变（审计 §3）。
   *
   * 为什么需要它：提示词以前只说「没人引用的 effect 删掉」，从没要求「本批至少改一次世界」，
   * 于是模型专挑最不容易出错的 comic / pick / swipe / hidden_object，20 批产出里 effects = 0，
   * 世界库除种子 canon 之外一片空白 —— R1–R5（世界状态开）与 R0（关）会变成同一个实验。
   *
   * 兼容性：字段可选。缺省时预检退化为结构检查（thread_ops 非空，或节拍里有 chat / story），
   * 手写计划与旧测试因此不必改；提示词里它是必填项。
   */
  world_change: z
    .object({
      kind: z.enum(['set_fact', 'end_fact', 'open_thread', 'advance_thread', 'resolve_thread', 'user_fact']),
      /** 由第几个节拍承载（对应 beats[].n）；只能指向 chat 或 story */
      carrier: z.number().int().min(1).max(4).optional(),
      note: z.string().min(1),
    })
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

/**
 * 只有 chat 与 story 能承载 effect：
 * - chat 靠 `reply.options[].effect`（pick 的选项没有 effect 字段）；
 * - story 靠 ink 标签 `# effect:名字`；
 * comic / swipe / hidden_object 三个类型在 ESL 里根本没有 effect 入口。
 */
export const EFFECT_CARRIER_SCENES: readonly SceneType[] = ['chat', 'story'];

/**
 * 能承载 `evidence` 的场景：除 comic 以外的五种。
 * pick / hidden_object / swipe(judge) / chat(带 reply) / story(带选项) 各按 5.8.4 的证据推导行进：
 * 四拍全是 comic 的批次写不出任何检测，学习层就整批空转。
 */
export const DETECTION_CARRIER_SCENES: readonly SceneType[] = ['chat', 'pick', 'swipe', 'hidden_object', 'story'];

/** 世界状态改变检查（预检第 6 项，审计 §3 修的落点）。 */
export function checkWorldChange(plan: ShowrunnerPlan): string[] {
  const failures: string[] = [];
  const carriers = plan.beats.filter((b) => EFFECT_CARRIER_SCENES.includes(b.scene));
  const wc = plan.world_change;
  if (wc) {
    if (wc.carrier === undefined) {
      if (carriers.length === 0) {
        failures.push('world_change 没有指定 carrier，且节拍里没有 chat 或 story —— 其余四种场景写不了 effects');
      }
    } else {
      const beat = plan.beats.find((b) => b.n === wc.carrier);
      if (!beat) {
        failures.push(`world_change.carrier 指向第 ${wc.carrier} 拍，但 beats 里没有这一拍`);
      } else if (!EFFECT_CARRIER_SCENES.includes(beat.scene)) {
        failures.push(
          `world_change 的载体是第 ${beat.n} 拍 ${beat.scene}，这一型写不了 effect：只能用 chat（reply 选项的 effect）或 story（ink 标签 # effect:）`,
        );
      }
    }
    return failures;
  }
  if ((plan.thread_ops ?? []).length === 0 && carriers.length === 0) {
    failures.push(
      '本批没有任何世界状态改变：world_change 缺失、thread_ops 为空、节拍里也没有 chat 或 story' +
        '（comic / pick / swipe / hidden_object 都写不了 effects）。把一拍改成 story 或带 reply 的 chat，并声明 world_change。',
    );
  }
  return failures;
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
  // 世界状态改变（审计 §3）：没有这一条，批次就是纯展示，世界状态层永远空转
  failures.push(...checkWorldChange(plan));
  // 检测供给：四拍全是 comic 的批次写不出 evidence，整批不产生学习证据（L1/L2 分母为 0）
  if (!plan.beats.some((b) => DETECTION_CARRIER_SCENES.includes(b.scene))) {
    failures.push('4 个节拍里没有能承载检测的场景（comic 写不了 evidence）：至少把一拍改成 pick / chat / hidden_object / swipe / story');
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
