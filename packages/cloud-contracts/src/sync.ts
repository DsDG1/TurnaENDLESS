import { z } from 'zod';
import { CLOUD_LIMITS, UuidSchema } from './envelope.js';
import { ObjectDigestSchema } from './objects.js';

/**
 * 增量同步网络契约（计划 §8.2–8.6）。
 *
 * 同步单位是**事件**：事件是学习历史的权威记录，客户端提交时附带
 * 一条可重放的命令（同一前缀 + 同一 `at` 能在另一设备还原出同一事件）。
 * `current`（当前集）与 `largeText`（字号）属于设备界面状态，不进事件流、
 * 不进变更流，见 `DeviceStreamStateSchema`。
 */

/** 流身份即分支 ID（`brn_<uuid>`）；首版不给同一分支分配第二个流。 */
export const SyncStreamIdSchema = z.string().regex(/^[a-z]{3}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const EventCommon = {
  episode: z.string().min(1).max(128),
  scene: z.string().min(1).max(128),
  at: z.string().datetime(),
  contentId: z.string().min(1).max(128).optional(),
  revisionId: z.string().min(1).max(128).optional(),
};

/**
 * 事件正文：与播放器事件同形，额外带上内容/修订盖章。
 * 只接受会产生事件的三种动作——`select`/`text` 只改界面偏好，不产生事件。
 */
export const SyncPlayerEventSchema = z.discriminatedUnion('type', [
  z.object({ ...EventCommon, type: z.literal('answer'), choice: z.number().int().nonnegative() }).strict(),
  z.object({ ...EventCommon, type: z.literal('advance'), skip: z.boolean() }).strict(),
  z.object({ ...EventCommon, type: z.literal('reveal') }).strict(),
]);
export type SyncPlayerEvent = z.infer<typeof SyncPlayerEventSchema>;

/** 可重放命令：另一设备在共同前缀上用同一 `at` 重放，得到同一事件。 */
export const SyncCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answer'), scene: z.string().min(1).max(128), choice: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('advance'), scene: z.string().min(1).max(128), skip: z.boolean() }).strict(),
  z.object({ type: z.literal('reveal'), scene: z.string().min(1).max(128) }).strict(),
]);
export type SyncCommand = z.infer<typeof SyncCommandSchema>;

/**
 * 一条待同步事件。`seq` 是该流中的连续位置（从 1 开始），
 * `eventId` 在本地业务提交的同一事务内分配，网络重试沿用同一个。
 */
export const SyncEventEntrySchema = z.object({
  eventId: UuidSchema,
  seq: z.number().int().positive().max(1_000_000),
  at: z.string().datetime(),
  event: SyncPlayerEventSchema,
  command: SyncCommandSchema,
  /** 事件正文的 SHA-256；服务端重算比对，避免客户端编码漂移被当成同一事件。 */
  digest: ObjectDigestSchema,
}).strict();
export type SyncEventEntry = z.infer<typeof SyncEventEntrySchema>;

/**
 * 推送。每个流显式声明自己认到的云端前缀（`baseSeq` + `baseEventId`）：
 * 服务端只在两者都与实际流头一致时追加，否则整批拒绝并保留冲突候选，
 * 不把两条离线历史拼成一条。
 */
export const SyncPushRequestSchema = z.object({
  workspaceId: UuidSchema,
  batchId: UuidSchema,
  /** 客户端看到的 cloud_version；服务端仅用于提前识别明显过期，权威判断仍是流头。 */
  baseVersion: z.string().regex(/^\d+$/).max(20),
  streams: z.array(z.object({
    streamId: SyncStreamIdSchema,
    baseSeq: z.number().int().nonnegative().max(1_000_000),
    baseEventId: UuidSchema.nullable(),
    events: z.array(SyncEventEntrySchema).min(1).max(CLOUD_LIMITS.eventsPerBatch),
  }).strict()).min(1).max(8),
}).strict().superRefine((value, ctx) => {
  const total = value.streams.reduce((count, stream) => count + stream.events.length, 0);
  if (total > CLOUD_LIMITS.eventsPerBatch) {
    ctx.addIssue({ code: 'custom', path: ['streams'], message: '单次提交事件总数超过上限' });
  }
  if (new Set(value.streams.map((stream) => stream.streamId)).size !== value.streams.length) {
    ctx.addIssue({ code: 'custom', path: ['streams'], message: '同一批次不能重复提交同一流' });
  }
});
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

export const SyncStreamBindingSchema = z.object({
  streamId: SyncStreamIdSchema,
  branchId: SyncStreamIdSchema,
  eventSeq: z.number().int().nonnegative(),
  lastEventId: UuidSchema.nullable(),
}).strict();
export type SyncStreamBinding = z.infer<typeof SyncStreamBindingSchema>;

/**
 * 注册一条新事件流（本机新建的分支）。
 *
 * 流身份与分支 ID 相同；分叉点之前的成员关系由服务端从父流**复制**，
 * 客户端只能声明「从哪条父流、第几条之后分叉」，不能自带前缀——
 * 否则就等于让客户端凭空宣称一段它没推过的历史。
 * 同一个 streamId 重复注册返回同一条绑定；参数不同则拒绝，不静默改绑。
 */
export const RegisterStreamRequestSchema = z.object({
  workspaceId: UuidSchema,
  streamId: SyncStreamIdSchema,
  parentStreamId: SyncStreamIdSchema,
  forkAtSeq: z.number().int().nonnegative().max(1_000_000),
}).strict();
export type RegisterStreamRequest = z.infer<typeof RegisterStreamRequestSchema>;
export const RegisterStreamResponseSchema = z.object({ stream: SyncStreamBindingSchema }).strict();
export type RegisterStreamResponse = z.infer<typeof RegisterStreamResponseSchema>;

export const SyncPushReceiptSchema = z.object({
  batchId: UuidSchema,
  workspaceId: UuidSchema,
  changeSeq: z.number().int().nonnegative(),
  cloudVersion: z.string().regex(/^\d+$/),
  applied: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  streams: z.array(SyncStreamBindingSchema).min(1).max(8),
}).strict();
export type SyncPushReceipt = z.infer<typeof SyncPushReceiptSchema>;
export const SyncPushResponseSchema = z.object({ receipt: SyncPushReceiptSchema });

export const SyncBootstrapSchema = z.object({
  workspaceId: UuidSchema,
  cloudVersion: z.string().regex(/^\d+$/),
  changeSeq: z.number().int().nonnegative(),
  /** 当前头部的拉取游标；首次安装的原始副本从 origin 导入基线开始补拉。 */
  cursor: z.string().min(1).max(512),
  streams: z.array(SyncStreamBindingSchema),
  origin: z.object({
    cursor: z.string().min(1).max(512),
    streams: z.array(SyncStreamBindingSchema),
  }).strict().optional(),
}).strict();
export type SyncBootstrap = z.infer<typeof SyncBootstrapSchema>;

export const SyncBranchManifestSchema = z.object({
  streamId: SyncStreamIdSchema,
  label: z.string().min(1).max(60),
  parentBranchId: SyncStreamIdSchema.nullable(),
  forkAtEventCount: z.number().int().nonnegative().nullable(),
  adopted: z.array(z.object({
    contentId: z.string().regex(/^ent_[0-9a-f-]{36}$/),
    revisionId: z.string().regex(/^rev_[0-9a-f-]{36}$/),
  }).strict()).min(1).max(500),
  catalog: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  commonStreamId: SyncStreamIdSchema.nullable(),
  commonPrefixSeq: z.number().int().nonnegative().max(10_000),
}).strict();
export type SyncBranchManifest = z.infer<typeof SyncBranchManifestSchema>;

export const SyncStreamHistorySchema = z.object({
  stream: SyncStreamBindingSchema,
  branch: SyncBranchManifestSchema,
  events: z.array(SyncEventEntrySchema).max(10_000),
}).strict();
export type SyncStreamHistory = z.infer<typeof SyncStreamHistorySchema>;

export const SyncChangeSchema = z.object({
  seq: z.number().int().positive(),
  batchId: UuidSchema,
  deviceId: UuidSchema,
  streamId: SyncStreamIdSchema,
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().positive(),
  createdAt: z.string().datetime(),
  events: z.array(SyncEventEntrySchema).max(CLOUD_LIMITS.eventsPerBatch),
  branch: SyncBranchManifestSchema.optional(),
}).strict();
export type SyncChange = z.infer<typeof SyncChangeSchema>;

export const SyncPullResponseSchema = z.object({
  changes: z.array(SyncChangeSchema).max(CLOUD_LIMITS.listPageMax),
  nextCursor: z.string().min(1).max(512),
  hasMore: z.boolean(),
  cloudVersion: z.string().regex(/^\d+$/),
}).strict();
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;

/** 冲突原因：流头变化、同一 eventId 正文不同、或事件正文摘要不符。 */
export const SyncConflictSchema = z.object({
  id: UuidSchema,
  workspaceId: UuidSchema,
  streamId: SyncStreamIdSchema,
  deviceId: UuidSchema,
  reason: z.enum(['stream-head-changed', 'event-body-mismatch', 'event-digest-mismatch']),
  status: z.enum(['open', 'discarded', 'preserved']),
  baseSeq: z.number().int().nonnegative(),
  cloudSeq: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  /** 被拒绝的整批候选事件：保留供导出与后续按分支保留，绝不静默应用。 */
  events: z.array(SyncEventEntrySchema).max(CLOUD_LIMITS.eventsPerBatch),
}).strict();
export type SyncConflict = z.infer<typeof SyncConflictSchema>;
export const SyncConflictListSchema = z.object({ conflicts: z.array(SyncConflictSchema) });

/**
 * `discard` 明确放弃本机候选的推送；`keep-branch` 以稳定的新流 ID 保留候选。
 * 独立分支与恢复回执在同一服务端事务提交，本机先保存完整历史与同一恢复请求。
 */
export const ResolveConflictRequestSchema = z.discriminatedUnion('decision', [
  z.object({ workspaceId: UuidSchema, decision: z.literal('discard') }).strict(),
  z.object({
    workspaceId: UuidSchema, decision: z.literal('keep-branch'),
    streamId: SyncStreamIdSchema, baseEventId: UuidSchema.nullable(),
  }).strict(),
]);
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequestSchema>;
export const ResolveConflictResponseSchema = z.object({
  conflict: SyncConflictSchema,
  stream: SyncStreamBindingSchema,
  preserved: SyncStreamBindingSchema.optional(),
  history: SyncStreamHistorySchema.optional(),
}).strict();
export type ResolveConflictResponse = z.infer<typeof ResolveConflictResponseSchema>;

/** 设备级界面状态：只属于该设备，不参与冲突判定，也不进入变更流。 */
export const DeviceStreamStateSchema = z.object({
  streamId: SyncStreamIdSchema,
  currentEpisode: z.string().min(1).max(128),
  largeText: z.boolean(),
  updatedAt: z.string().datetime(),
}).strict();
export type DeviceStreamState = z.infer<typeof DeviceStreamStateSchema>;

export const PutDeviceStreamStateRequestSchema = z.object({
  workspaceId: UuidSchema,
  states: z.array(z.object({
    streamId: SyncStreamIdSchema,
    currentEpisode: z.string().min(1).max(128),
    largeText: z.boolean(),
  }).strict()).min(1).max(16),
}).strict();
export type PutDeviceStreamStateRequest = z.infer<typeof PutDeviceStreamStateRequestSchema>;
export const DeviceStreamStateListSchema = z.object({ states: z.array(DeviceStreamStateSchema) });
