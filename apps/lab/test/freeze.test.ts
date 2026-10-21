/** 提示词冻结（第 8 节冻结纪律）：哈希、清单往返、版本递增、漂移报告。 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PROMPT_FILES,
  diffFrozen,
  driftReport,
  hashPrompts,
  manifestPath,
  nextVersion,
  readFrozen,
  writeFrozen,
} from '../src/freeze.js';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

let dir: string;

/** 只写前 n 个提示词文件，其余保持缺失，用来覆盖 missing 分支。 */
async function seedPrompts(count: number = PROMPT_FILES.length): Promise<void> {
  await mkdir(join(dir, 'prompts'), { recursive: true });
  for (const name of PROMPT_FILES.slice(0, count)) {
    await writeFile(join(dir, 'prompts', `${name}.md`), `# ${name}\n`, 'utf8');
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'endless-freeze-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('hashPrompts', () => {
  it('对每个文件给出内容哈希，缺失文件记为 missing', async () => {
    await seedPrompts(2);
    const hashes = await hashPrompts(dir);
    expect(Object.keys(hashes.files)).toEqual([...PROMPT_FILES]);
    expect(hashes.files['system']).toBe(sha256('# system\n'));
    expect(hashes.files['showrunner']).toBe(sha256('# showrunner\n'));
    expect(hashes.files['judge']).toBe('missing');
    expect(hashes.combined).toMatch(/^[0-9a-f]{64}$/);
  });

  it('任一文件内容变化都会改变合并哈希', async () => {
    await seedPrompts();
    const before = await hashPrompts(dir);
    await writeFile(join(dir, 'prompts', 'writer.md'), '# changed\n', 'utf8');
    const after = await hashPrompts(dir);
    expect(after.files['writer']).not.toBe(before.files['writer']);
    expect(after.combined).not.toBe(before.combined);
    // 未改动的文件哈希保持不变
    expect(after.files['system']).toBe(before.files['system']);
  });
});

describe('writeFrozen / readFrozen', () => {
  it('未冻结时返回 null', async () => {
    await seedPrompts();
    expect(await readFrozen(dir)).toBeNull();
  });

  it('写入后能读回同样的版本、时间与哈希', async () => {
    await seedPrompts();
    const written = await writeFrozen(dir, 'v1', new Date('2026-10-22T00:00:00.000Z'));
    expect(written.version).toBe('v1');
    expect(manifestPath(dir)).toBe(join(dir, 'prompts', 'FROZEN'));
    const read = await readFrozen(dir);
    expect(read).toEqual(written);
    expect(read?.files['system']).toBe(sha256('# system\n'));
  });
});

describe('nextVersion', () => {
  it('无清单时从 v1 起', async () => {
    await seedPrompts();
    expect(await nextVersion(dir)).toBe('v1');
  });

  it('在已有版本上递增', async () => {
    await seedPrompts();
    await writeFrozen(dir, 'v1');
    expect(await nextVersion(dir)).toBe('v2');
    await writeFrozen(dir, 'v9');
    expect(await nextVersion(dir)).toBe('v10');
  });

  it('无法解析的版本号保留为前缀，避免覆盖历史', async () => {
    await seedPrompts();
    await writeFrozen(dir, 'rc-a');
    expect(await nextVersion(dir)).toBe('rc-a+');
  });
});

describe('diffFrozen / driftReport', () => {
  it('内容未变时判定一致且无报告', async () => {
    await seedPrompts();
    const manifest = await writeFrozen(dir, 'v1');
    const drift = diffFrozen(manifest, await hashPrompts(dir));
    expect(drift.same).toBe(true);
    expect(drift.changed).toEqual([]);
    expect(driftReport(manifest, drift)).toEqual([]);
  });

  it('修改文件时报告 changed 并给出纪律提示', async () => {
    await seedPrompts();
    const manifest = await writeFrozen(dir, 'v1');
    await writeFile(join(dir, 'prompts', 'repair.md'), '# new repair\n', 'utf8');
    const drift = diffFrozen(manifest, await hashPrompts(dir));
    expect(drift.same).toBe(false);
    expect(drift.changed).toEqual(['repair']);
    const lines = driftReport(manifest, drift);
    expect(lines[0]).toContain('v1');
    expect(lines.join('\n')).toContain('已修改：repair');
    expect(lines.join('\n')).toContain('run_id');
  });

  it('新增文件计入 added（清单里没有的哈希）', async () => {
    await seedPrompts(2);
    const manifest = await writeFrozen(dir, 'v1');
    await writeFile(join(dir, 'prompts', 'judge.md'), '# judge\n', 'utf8');
    const drift = diffFrozen(manifest, await hashPrompts(dir));
    // judge 在清单里是 missing，因此算「已修改」而不是「新增」
    expect(drift.changed).toContain('judge');
    expect(drift.added).toEqual([]);
    expect(drift.same).toBe(false);
  });
});
