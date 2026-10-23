/**
 * 原料指纹（C2，借 ScrollToStudy 把 `source_content` 与产物同表持久化、Sekai 的版本血缘）。
 *
 * 运行只记提示词哈希时，两次运行之间若夹着词库扩容，事后无法判断差异来自提示词还是数据
 * （结果 §5 #9 的 20n → 20o 就是这种情况）。这里给每个原料文件一个内容哈希，
 * 写在运行目录的 `data-fingerprint.json`：
 *   - 已有产物且指纹变化 → 拒绝覆盖（除非显式 --force），避免把两套原料混进同一个 run_id；
 *   - 比较两次运行时能直接列出「除提示词外还有哪些数据变了」。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { contentHash } from '@endless/esl';

/** 参与指纹的原料文件（相对 dataDir）。频道目录逐文件展开，新增频道自动纳入。 */
export async function dataFilesOf(dataDir: string): Promise<string[]> {
  const files = [
    join('lexicon', 'a1_a2.yaml'),
    join('assets', 'manifest.yaml'),
    join('assets', 'characters.yaml'),
    'predicates.yaml',
    'tropes.yaml',
    'sifting_patterns.yaml',
  ];
  const channels = await readdir(join(dataDir, 'channels')).catch(() => [] as string[]);
  for (const f of channels.filter((f) => f.endsWith('.yaml')).sort()) files.push(join('channels', f));
  return files;
}

export interface DataFingerprint {
  generated_at: string;
  /** 相对路径 → 内容哈希（16 位十六进制） */
  files: Record<string, string>;
  /** 全部文件按固定顺序拼接后的整体哈希：一次比较即可判断原料有没有变 */
  combined: string;
}

export async function computeDataFingerprint(dataDir: string, at = new Date()): Promise<DataFingerprint> {
  const files: Record<string, string> = {};
  for (const rel of await dataFilesOf(dataDir)) {
    const text = await readFile(join(dataDir, rel), 'utf8').catch(() => null);
    files[rel.replace(/\\/g, '/')] = text === null ? 'missing' : contentHash(text);
  }
  const combined = contentHash(Object.entries(files).map(([k, v]) => `${k}:${v}`).join('\n'));
  return { generated_at: at.toISOString(), files, combined };
}

export interface FingerprintDiff {
  same: boolean;
  changed: string[];
  added: string[];
  removed: string[];
}

export function diffFingerprint(before: DataFingerprint, after: DataFingerprint): FingerprintDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [name, hash] of Object.entries(after.files)) {
    if (!(name in before.files)) added.push(name);
    else if (before.files[name] !== hash) changed.push(name);
  }
  for (const name of Object.keys(before.files)) if (!(name in after.files)) removed.push(name);
  return {
    same: before.combined === after.combined && changed.length === 0 && added.length === 0 && removed.length === 0,
    changed,
    added,
    removed,
  };
}

/** 人读的差异说明；无差异返回空数组。 */
export function fingerprintReport(before: DataFingerprint, diff: FingerprintDiff): string[] {
  if (diff.same) return [];
  const lines = [`原料指纹与已有产物不一致（原指纹 ${before.generated_at}）：`];
  if (diff.changed.length) lines.push(`  已修改：${diff.changed.join(' / ')}`);
  if (diff.added.length) lines.push(`  新增：${diff.added.join(' / ')}`);
  if (diff.removed.length) lines.push(`  删除：${diff.removed.join(' / ')}`);
  lines.push('  这是「除提示词外还有哪些数据变了」的答案：同一 run_id 混两套原料会让差异归因失效。');
  return lines;
}
