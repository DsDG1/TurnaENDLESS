/**
 * 预留能力的端口与禁用实现（W8）。
 * 正式组合根只注入 Disabled*：返回 FEATURE_DISABLED，不返回假用户、
 * 假云文件或「同步成功」。内存实现只放在测试目录。
 */

export const FEATURE_DISABLED = 'FEATURE_DISABLED' as const;
export type FeatureDisabled = { ok: false; code: typeof FEATURE_DISABLED; feature: string };

const disabled = (feature: string): FeatureDisabled => ({ ok: false, code: FEATURE_DISABLED, feature });

export interface PreparedFeatures {
  accounts: boolean;
  cloudSync: boolean;
  usageLedger: boolean;
  pricing: boolean;
  payments: boolean;
}

/** 本阶段运行约束：全部默认关闭。 */
export const preparedFeatures: PreparedFeatures = {
  accounts: false, cloudSync: false, usageLedger: false, pricing: false, payments: false,
};

// ---------- 账号 ----------

export interface IdentityPort {
  current(): Promise<FeatureDisabled | { ok: true; accountId: string }>;
  signIn(credentials: unknown): Promise<FeatureDisabled | { ok: true; accountId: string }>;
  signOut(): Promise<FeatureDisabled | { ok: true }>;
}

export class DisabledIdentity implements IdentityPort {
  async current() { return disabled('accounts'); }
  async signIn() { return disabled('accounts'); }
  async signOut() { return disabled('accounts'); }
}

// ---------- 云同步 ----------

export interface CloudSyncPort {
  pull(cursor: string | null): Promise<FeatureDisabled | { ok: true; cursor: string; objects: unknown[] }>;
  push(objects: unknown[], idempotencyKey: string): Promise<FeatureDisabled | { ok: true; accepted: number }>;
}

export class DisabledCloudSync implements CloudSyncPort {
  async pull() { return disabled('cloudSync'); }
  async push() { return disabled('cloudSync'); }
}

// ---------- 用量账本 ----------

export type UsagePurpose = 'generate' | 'repair' | 'ai-edit' | 'archive-summary';
export type UsageQuality = 'reported' | 'estimated' | 'unknown';

export interface UsageAttempt {
  attemptId: string;
  jobId: string;
  ordinal: number;
  purpose: UsagePurpose;
  provider: string;
  model: string;
  startedAt: string;
  endedAt?: string;
  finishReason?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  quality: UsageQuality;
  status: 'finished' | 'failed' | 'interrupted';
  failureCategory?: string;
  keyMode: 'user-key' | 'server-config' | 'unknown';
  rateCardVersion?: string;
}

export interface UsageSink {
  attemptStarted(attempt: Omit<UsageAttempt, 'status'>): Promise<FeatureDisabled | { ok: true }>;
  attemptFinished(attemptId: string, update: Partial<UsageAttempt>): Promise<FeatureDisabled | { ok: true }>;
  list(jobId?: string): Promise<FeatureDisabled | { ok: true; attempts: UsageAttempt[] }>;
}

export class DisabledUsageSink implements UsageSink {
  async attemptStarted() { return disabled('usageLedger'); }
  async attemptFinished() { return disabled('usageLedger'); }
  async list() { return disabled('usageLedger'); }
}

// ---------- 价格 ----------

export interface RateCard {
  version: string;
  provider: string;
  model: string;
  currency: string;
  effectiveAt: string;
  /** 每百万 token 最小货币单位价格；推理 token 是否含输出计费按供应商规则另记 */
  inputPerMTok: number;
  cachedInputPerMTok: number | null;
  outputPerMTok: number;
}

export type CostResult =
  | { ok: true; amount: number; currency: string; rateCardVersion: string; quality: UsageQuality }
  | { ok: false; code: 'NO_RATECARD' | 'UNKNOWN_USAGE' | typeof FEATURE_DISABLED };

export interface PricingPort {
  rateFor(provider: string, model: string, at: string): Promise<FeatureDisabled | { ok: true; rate: RateCard | null }>;
  estimate(attempt: UsageAttempt): Promise<CostResult>;
}

export class DisabledPricing implements PricingPort {
  async rateFor() { return disabled('pricing'); }
  async estimate(): Promise<CostResult> { return { ok: false, code: FEATURE_DISABLED }; }
}

// ---------- 支付 ----------

export interface PaymentPort {
  createOrder(input: unknown): Promise<FeatureDisabled>;
  refund(orderId: string): Promise<FeatureDisabled>;
}

export class DisabledPayments implements PaymentPort {
  async createOrder() { return disabled('payments'); }
  async refund() { return disabled('payments'); }
}
