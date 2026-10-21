/**
 * ESL v0 规范模型（实验方案第 5.8 节）。
 * 规范模型与表层编码分离：YAML 与 JSON 两种表层解析后都得到这里的类型。
 */
import { z } from 'zod';

// ---------- 通用 ----------

/** 学习证据类型（第 5.3.3 节）。 */
export const EvidenceType = z.enum([
  'exposure',
  'comprehension',
  'recognition-2',
  'recognition-4',
  'listening-4',
  'production',
  'retry',
  'practice',
]);
export type EvidenceType = z.infer<typeof EvidenceType>;

/** 检索型证据的强度序，用于 min_evidence 比较。非检索型为 -1。 */
export const EVIDENCE_RANK: Record<EvidenceType, number> = {
  exposure: -1,
  comprehension: -1,
  retry: -1,
  practice: -1,
  'recognition-2': 1,
  'recognition-4': 2,
  'listening-4': 2,
  production: 3,
};

/** 学习条目 ID：lx:<lemma>#<pos>.<sense> / ck:<slug> / pt:<slug>（第 5.1 节）。 */
export const ItemId = z.string().regex(/^(lx:[^#\s]+#[\w-]+(\.[\w-]+)?|ck:[a-z0-9-]+|pt:[a-z0-9-]+)$/, '非法条目 ID');
export type ItemId = z.infer<typeof ItemId>;

/** 素材引用：@emoji:<name> / @tag:<tag> / @char:<entity>{k=v,...}（第 5.8.3 节）。 */
export const AssetRef = z.string().regex(/^@(emoji:[a-z0-9_]+|tag:[a-z0-9_]+|char:[a-z0-9_]+(\{[a-z0-9_=,\s]*\})?)$/);
export type AssetRef = z.infer<typeof AssetRef>;

/** 实体 ID：小写字母数字下划线，如 duck、agency_office。 */
export const EntityId = z.string().regex(/^[a-z][a-z0-9_]*$/);

// ---------- 世界状态 effect（第 5.5.3 节） ----------

export const SetFactEffect = z.object({
  set_fact: z.object({
    subject: EntityId,
    predicate: z.string().min(1),
    object: z.string().min(1),
    standing: z.enum(['canon', 'stated', 'rumor']).default('stated'),
  }),
});

export const EndFactEffect = z.object({
  end_fact: z.object({
    subject: EntityId,
    predicate: z.string().min(1),
    object: z.string().min(1).optional(),
  }),
});

export const OpenThreadEffect = z.object({
  open_thread: z.object({
    id: EntityId,
    title: z.string().min(1),
    priority: z.number().int().min(1).max(5).default(2),
    payoff_hint: z.string().optional(),
    expires_after_cards: z.number().int().positive().optional(),
  }),
});

export const AdvanceThreadEffect = z.object({ advance_thread: z.object({ id: EntityId }) });
export const ResolveThreadEffect = z.object({ resolve_thread: z.object({ id: EntityId }) });
export const UserFactEffect = z.object({
  user_fact: z.object({ predicate: z.string().min(1), object: z.string().min(1) }),
});

export const Effect = z.union([
  SetFactEffect,
  EndFactEffect,
  OpenThreadEffect,
  AdvanceThreadEffect,
  ResolveThreadEffect,
  UserFactEffect,
]);
export type Effect = z.infer<typeof Effect>;
export type EffectOp = Effect[keyof Effect & string];

/** 具名 effect 表：`名字: [effect, ...]`，由选项或 ink 标签引用。 */
export const EffectTable = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.array(Effect));
export type EffectTable = z.infer<typeof EffectTable>;

// ---------- 场景（第 5.8.4 节） ----------

const SceneBase = z.object({
  id: z.string().regex(/^s\d+[a-z]?$/),
  cast: z.array(EntityId).optional(),
  uses: z.array(ItemId).optional(),
  evidence: z.object({ item: ItemId, type: EvidenceType }).optional(),
  effects: EffectTable.optional(),
});

export const Bubble = z.object({ speaker: EntityId, text: z.string().min(1) });

export const ComicScene = SceneBase.extend({
  type: z.literal('comic'),
  setting: AssetRef,
  panels: z
    .array(
      z.object({
        shot: z.enum(['wide', 'medium', 'close']),
        actors: z.array(AssetRef).max(3).default([]),
        props: z.array(AssetRef).max(3).default([]),
        caption: z.string().optional(),
        bubbles: z.array(Bubble).max(2).default([]),
      }),
    )
    .min(1)
    .max(4),
});

export const ChatScene = SceneBase.extend({
  type: z.literal('chat'),
  skin: z.enum(['messenger', 'dating', 'forum', 'news_comments']),
  messages: z.array(z.object({ from: EntityId, text: z.string().min(1) })).min(1).max(8),
  reply: z
    .object({
      options: z
        .array(
          z.object({
            label: z.string().min(1),
            correct: z.boolean().optional(),
            effect: z.string().optional(),
          }),
        )
        .min(2)
        .max(4),
      on_correct: z.object({ from: EntityId, text: z.string().min(1) }),
      on_wrong: z.object({ from: EntityId, text: z.string().min(1) }),
    })
    .optional(),
  ink: z.string().optional(),
});

export const SwipeScene = SceneBase.extend({
  type: z.literal('swipe'),
  prompt: z.string().min(1),
  mode: z.enum(['judge', 'preference']),
  cards: z
    .array(z.object({ asset: AssetRef, caption: z.string(), side: z.enum(['left', 'right']) }))
    .min(2)
    .max(6),
});

export const PickScene = SceneBase.extend({
  type: z.literal('pick'),
  question: z.string().min(1),
  options: z
    .array(z.object({ label: z.string().min(1), asset: AssetRef.optional(), correct: z.boolean().optional() }))
    .min(2)
    .max(4),
  hint: z.string().optional(),
  feedback: z.object({ on_correct: z.string().min(1), on_wrong: z.string().min(1) }),
});

export const HiddenObjectScene = SceneBase.extend({
  type: z.literal('hidden_object'),
  background: AssetRef,
  spots: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(3).max(6),
  objects: z
    .array(z.object({ asset: AssetRef, spot: z.string(), target: z.boolean().optional() }))
    .min(2),
  instruction: z.string().min(1),
});

export const StoryScene = SceneBase.extend({
  type: z.literal('story'),
  ink: z.string().min(1),
});

/** 派生场景：AI 只写一行指令，编译器从已有内容生成检测场景（第 5.8.4 节第 7 种）。 */
export const DeriveScene = SceneBase.extend({
  type: z.literal('derive'),
  from: z.string().min(1), // 如 s1.panels[1].bubbles[0]
  kind: z.enum(['cloze_pick']),
  item: ItemId,
  distractors: z.enum(['confusables', 'none']).default('confusables'),
});

export const Scene = z.discriminatedUnion('type', [
  ComicScene,
  ChatScene,
  SwipeScene,
  PickScene,
  HiddenObjectScene,
  StoryScene,
  DeriveScene,
]);
export type Scene = z.infer<typeof Scene>;
export type ComicSceneT = z.infer<typeof ComicScene>;
export type ChatSceneT = z.infer<typeof ChatScene>;
export type SwipeSceneT = z.infer<typeof SwipeScene>;
export type PickSceneT = z.infer<typeof PickScene>;
export type HiddenObjectSceneT = z.infer<typeof HiddenObjectScene>;
export type StorySceneT = z.infer<typeof StoryScene>;
export type DeriveSceneT = z.infer<typeof DeriveScene>;

// ---------- 批次（第 5.8.2 节） ----------

export const NewEntity = z.object({
  id: EntityId,
  kind: z.enum(['character', 'location', 'object', 'organization']),
  name: z.string().min(1),
});

export const Batch = z.object({
  batch: z.string().min(1),
  channel: z.string().min(1),
  brief: z.string().min(1),
  cast: z.array(EntityId).min(1),
  new_entities: z.array(NewEntity).optional(),
  hook_out: z.string().optional(),
  scenes: z.array(Scene).min(1),
});
export type Batch = z.infer<typeof Batch>;

/** 计入 3–4 场上限的是六种基本场景；derive 不计（第 5.8.2 节）。 */
export function countBaseScenes(batch: Batch): number {
  return batch.scenes.filter((s) => s.type !== 'derive').length;
}

// ---------- 校验问题 ----------

export const ISSUE_CODES = [
  'E-PARSE',
  'E-SCHEMA',
  'E-ASSET-MISSING',
  'E-CHAR-ATTR',
  'E-ENTITY-UNKNOWN',
  'E-EFFECT-INVALID',
  'E-CANON',
  'E-FACT-CONFLICT',
  'E-INK',
  'E-ANSWER-COUNT',
  'E-ANSWER-DUP',
  'E-EVIDENCE-OVERCLAIM',
  'E-PRIMED',
  'E-NEW-TESTED-EARLY',
  'E-BRIEF-UNCOVERED',
  'E-USES-NOT-FOUND',
  'E-OOV-HIGH',
  'W-OOV',
  'W-LINE-LONG',
  'W-TROPE-REPEAT',
  'W-SEQUENCE-REPEAT',
  'W-CAST-OVERUSE',
  'W-TENSE-ENDED-FACT',
  'W-GRAMMAR',
  'W-NO-HOOK',
  'W-SENSE-UNSURE',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];
export const BLOCKING_CODES: readonly string[] = ISSUE_CODES.filter((c) => c.startsWith('E-'));

export interface ValidationIssue {
  code: IssueCode | string;
  level: 'error' | 'warning';
  scene?: string;
  path?: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean; // 无阻断级问题
  issues: ValidationIssue[];
  derivedEvidence: { sceneId: string; item: string; declared?: EvidenceType; derived: EvidenceType | null }[];
  factRefs: number; // 对出场实体当前属性的陈述数（C1 分母，程序可判部分）
}
