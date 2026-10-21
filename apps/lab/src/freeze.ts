/**
 * 提示词冻结（第 8 节「冻结纪律」）：把提示词文件的内容哈希写成 `data/prompts/FROZEN`。
 * 冻结之后修改任何提示词，都必须新增版本（`lab freeze --label vN+1`）并开新的 run_id，
 * 不能覆盖已有运行结果 —— `lab check` 与 `lab run` 用这里的哈希做检查与记录。
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { z } from 'zod';

/** 参与冻结的提示词文件（与 data/prompts/*.md 一一对应）。 */
export const PROMPT_FILES = ['system', 'showrunner', 'writer', 'single', 'repair', 'judge'] as const;
export type PromptFile = (typeof PROMPT_FILES)[number];

export interface PromptHashes {
  files: Record<string, string>;
  /** 全部文件按固定顺序拼接后的整体哈希：一次比较即可判断是否有任何改动 */
  combined: string;
}

export interface FrozenManifest extends PromptHashes {
  version: string;
  frozen_at: string;
}

const FrozenManifestSchema = z.object({
  version: z.string(),
  frozen_at: z.string(),
  combined: z.string(),
  files: z.record(z.string(), z.string()),
});

const FROZEN_FILE = 'FROZEN';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export function manifestPath(dataDir: string): string {
  return join(dataDir, 'prompts', FROZEN_FILE);
}

/** 计算当前提示词内容的哈希；文件缺失记为 missing（与内容哈希区分开）。 */
export async function hashPrompts(dataDir: string): Promise<PromptHashes> {
  const files: Record<string, string> = {};
  for (const name of PROMPT_FILES) {
    const text = await readFile(join(dataDir, 'prompts', `${name}.md`), 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    files[name] = text === null ? 'missing' : sha256(text);
  }
  const combined = sha256(PROMPT_FILES.map((n) => `${n}:${files[n]}`).join('\n'));
  return { files, combined };
}

/** 读取冻结清单；尚未冻结返回 null。 */
export async function readFrozen(dataDir: string): Promise<FrozenManifest | null> {
  const text = await readFile(manifestPath(dataDir), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (text === null) return null;
  return FrozenManifestSchema.parse(parseYaml(text));
}

/** 写入冻结清单（覆盖旧清单，但版本号由调用方决定，便于追溯）。 */
export async function writeFrozen(dataDir: string, version: string, at = new Date()): Promise<FrozenManifest> {
  const current = await hashPrompts(dataDir);
  const manifest: FrozenManifest = { version, frozen_at: at.toISOString(), ...current };
  await writeFile(manifestPath(dataDir), yamlStringify(manifest), 'utf8');
  return manifest;
}

/** 下一个版本号：无清单时 v1，否则在 v<N> 上递增；无法解析的版本号原样保留为前缀。 */
export async function nextVersion(dataDir: string): Promise<string> {
  const frozen = await readFrozen(dataDir);
  if (!frozen) return 'v1';
  const m = /^v(\d+)$/.exec(frozen.version);
  return m ? `v${Number(m[1]) + 1}` : `${frozen.version}+`;
}

export interface PromptDrift {
  /** 与冻结清单一致的哈希数 */
  same: boolean;
  changed: string[];
  added: string[];
  removed: string[];
}

/** 比较冻结清单与当前内容。 */
export function diffFrozen(manifest: FrozenManifest, current: PromptHashes): PromptDrift {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [name, hash] of Object.entries(current.files)) {
    if (!(name in manifest.files)) added.push(name);
    else if (manifest.files[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(manifest.files)) if (!(name in current.files)) removed.push(name);
  return {
    same: manifest.combined === current.combined && changed.length === 0 && added.length === 0 && removed.length === 0,
    changed,
    added,
    removed,
  };
}

/** 漂移的人工可读说明；无漂移返回空数组。 */
export function driftReport(manifest: FrozenManifest, drift: PromptDrift): string[] {
  if (drift.same) return [];
  const lines = [`提示词与冻结版本 ${manifest.version} 不一致：`];
  if (drift.changed.length) lines.push(`  已修改：${drift.changed.join(' / ')}`);
  if (drift.added.length) lines.push(`  新增：${drift.added.join(' / ')}`);
  if (drift.removed.length) lines.push(`  删除：${drift.removed.join(' / ')}`);
  lines.push('  冻结纪律（方案第 8 节）：改提示词必须开新版本并换新的 run_id，不能覆盖已有结果。');
  return lines;
}
