/** 配置加载（第 7.1 节）：模型与供应商、单价、预算、运行配置。API key 只从环境变量读取。 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Strategy } from '@endless/learning';
import type { PersonaId } from './sim/learner.js';

export interface ModelsConfig {
  provider: {
    name: string;
    base_url: string;
    api_key_env: string;
    /** 推理强度（部分供应商支持 low/medium/high）。推理 token 计入输出上限，长输出任务建议调低。 */
    reasoning_effort?: string;
    /** 单次调用超时（毫秒），默认 300000 */
    timeout_ms?: number;
  };
  models: { fast: string; premium: string };
}

export async function loadModelsConfig(path: string): Promise<ModelsConfig> {
  return ModelsConfigSchema.parse(parseYaml(await readFile(path, 'utf8')));
}
const ModelsConfigSchema = z.object({
  provider: z.object({
    name: z.string(),
    base_url: z.string(),
    api_key_env: z.string(),
    reasoning_effort: z.string().optional(),
    timeout_ms: z.number().int().positive().max(1_800_000).optional(),
  }),
  models: z.object({ fast: z.string(), premium: z.string() }),
});

/** 只从环境变量读取 key；缺失返回空串（调用方决定是否抛错）。绝不写入文件或日志。 */
export function resolveApiKey(cfg: ModelsConfig): string {
  return process.env[cfg.provider.api_key_env] ?? '';
}

export interface PricesConfig {
  prices: Record<'fast' | 'premium', { input_per_mtok: number; output_per_mtok: number }>;
}
export async function loadPricesConfig(path: string): Promise<PricesConfig> {
  return parseYaml(await readFile(path, 'utf8'));
}

export interface BudgetConfig {
  budget: { per_100_cards: number };
}
export async function loadBudgetConfig(path: string): Promise<BudgetConfig> {
  return parseYaml(await readFile(path, 'utf8'));
}

export interface RunConfig {
  run_id: string;
  director: 'two-stage' | 'single';
  world_state: boolean;
  trope_ledger: boolean;
  encoding: 'yaml' | 'json';
  derive: boolean;
  showrunner_tier: 'fast' | 'premium';
  persona: PersonaId;
  batches: number;
  seed: number;
  feedback_lag: number;
  strategy: Strategy;
  llm: 'real' | 'stub';
  stub_script: string | null;
  channel_weights: Record<string, number>;
  /** OOV 告警/阻断阈值（种子词库阶段放大，见结果文档偏差表） */
  oov_warn: number;
  oov_block: number;
}

export async function loadRunConfig(path: string): Promise<RunConfig> {
  return RunConfigSchema.parse(parseYaml(await readFile(path, 'utf8')));
}
const RunConfigSchema = z.object({
  run_id: z.string(),
  director: z.enum(['two-stage', 'single']).default('two-stage'),
  world_state: z.boolean().default(true),
  trope_ledger: z.boolean().default(true),
  encoding: z.enum(['yaml', 'json']).default('yaml'),
  derive: z.boolean().default(false),
  showrunner_tier: z.enum(['fast', 'premium']).default('fast'),
  persona: z.enum(['P1', 'P2', 'P3']).default('P1'),
  batches: z.number().int().min(1).max(200).default(60),
  seed: z.number().int().default(42),
  feedback_lag: z.number().int().min(0).max(5).default(2),
  strategy: z.enum(['S-A', 'S-B', 'S-C']).default('S-B'),
  llm: z.enum(['real', 'stub']).default('real'),
  stub_script: z.string().nullable().default(null),
  channel_weights: z.record(z.string(), z.number()).default({ duck_detective: 0.5, impossible_store: 0.3, improv: 0.2 }),
  oov_warn: z.number().min(0).max(1).default(0.05),
  oov_block: z.number().min(0).max(1).default(0.2),
});
