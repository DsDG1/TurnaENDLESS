/**
 * LLM 评审（第 5.12 节 Critic 第 2 部分）：对 runs/<id>/render/*.md 逐批调用评审模型
 * （与导演不同档位、温度 0），按评分表打分并列出疑似矛盾（须引用 fact_id）。
 * 评审模型需先在人工盲评样本上校准（Spearman ρ ≥ 0.5 才参与判定）。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Batch } from '@endless/esl';
import { AiSdkLlmClient } from '@endless/director';
import { renderTemplate } from '@endless/director';
import { loadLabData } from '../data.js';
import { loadModelsConfig, resolveApiKey } from '../config.js';
import { SqliteWorldStore } from '../storage/sqlite.js';
import { parse } from 'yaml';

const HERE = import.meta.dirname;
const LAB_ROOT = resolve(HERE, '..');
const DATA_DIR = join(LAB_ROOT, 'data');
const CONFIG_DIR = join(LAB_ROOT, 'config');
const RUNS_DIR = join(LAB_ROOT, 'runs');

export interface JudgeVerdict {
  batchFile: string;
  scores?: Record<string, number>;
  tropes?: string[];
  contradictions?: { scene: string; quote: string; fact_id: number; why: string }[];
  ambiguities?: { scene: string; why: string }[];
  parseError?: string;
}

/** 事实表（含已结束事实，标明 valid_from/valid_to）。 */
function factTable(store: SqliteWorldStore): string {
  const rows = store.allFacts();
  return rows.map((f) => `${f.id}: ${f.subject} ${f.predicate} ${f.object} [${f.valid_from_card}→${f.valid_to_card ?? 'now'}] (${f.standing})`).join('\n');
}

export async function runJudge(runDir: string, tier: 'fast' | 'premium' = 'premium'): Promise<JudgeVerdict[]> {
  const data = await loadLabData(DATA_DIR);
  const models = await loadModelsConfig(join(CONFIG_DIR, 'models.yaml'));
  const key = resolveApiKey(models);
  if (!key) throw new Error(`缺少环境变量 ${models.provider.api_key_env}（评审也需要 API key）`);
  const llm = new AiSdkLlmClient({ baseURL: models.provider.base_url, apiKey: key, providerName: models.provider.name, models: models.models });
  const store = new SqliteWorldStore(join(runDir, 'world.sqlite'));
  const renderDir = join(runDir, 'render');
  const files = (await readdir(renderDir)).filter((f) => f.endsWith('.md')).sort();
  const verdicts: JudgeVerdict[] = [];
  await mkdir(join(runDir, 'judge'), { recursive: true });
  for (const file of files) {
    const render = await readFile(join(renderDir, file), 'utf8');
    const prompt = renderTemplate(data.prompts.judge, {
      fact_table: factTable(store),
      tropes: data.tropes.join(', '),
      render,
    });
    const res = await llm.complete({ stage: 'judge', system: 'You are a strict content judge. Temperature 0.', prompt, modelTier: tier, temperature: 0 });
    await writeFile(join(runDir, 'judge', file.replace('.md', '.raw.txt')), res.text);
    const verdict = parseVerdict(res.text, file);
    verdicts.push(verdict);
    await writeFile(join(runDir, 'judge', file.replace('.md', '.json')), JSON.stringify(verdict, null, 2));
  }
  await writeFile(join(runDir, 'judge', 'judge.jsonl'), verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n');
  store.close();
  return verdicts;
}

function parseVerdict(text: string, file: string): JudgeVerdict {
  const stripped = text.replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```\s*$/i, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return { batchFile: file, parseError: '输出不是 JSON' };
  try {
    const obj = parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    return { batchFile: file, scores: obj.scores as Record<string, number>, tropes: obj.tropes as string[], contradictions: obj.contradictions as JudgeVerdict['contradictions'], ambiguities: obj.ambiguities as JudgeVerdict['ambiguities'] };
  } catch (e) {
    return { batchFile: file, parseError: (e as Error).message };
  }
}

export type { Batch };
