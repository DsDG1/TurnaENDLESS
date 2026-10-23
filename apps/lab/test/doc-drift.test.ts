/**
 * 文档漂移守卫：把「文档里的硬事实」钉在代码上。
 *
 * 起因：2026-10-23 审计后加了两个建议级码（`W-NO-WORLD-CHANGE` / `W-NO-DETECTION`），
 * 但 `README.md` 仍写「9 种建议级码」、方案 §5.9.2 的建议级表还只有 9 行。
 * 这类漂移不会让任何测试变红，只会让人按不存在的规则写代码——所以这里补上。
 *
 * 只钉**能被程序验证的断言**（集合相等、算术自洽），不钉散文。
 * 口径：码的权威集合是 `ISSUE_CODES`，文档必须与它逐条对齐。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ISSUE_CODES } from '@endless/esl';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** 方案文档里码表的一行：`| \`E-XXX\` | 含义 |` */
const TABLE_ROW = /^\| `([EW]-[A-Z-]+)`/gm;

function codesInTable(markdown: string): Set<string> {
  const found = new Set<string>();
  for (const m of markdown.matchAll(TABLE_ROW)) found.add(m[1]!);
  return found;
}

const blocking = ISSUE_CODES.filter((c) => c.startsWith('E-'));
const advisory = ISSUE_CODES.filter((c) => c.startsWith('W-'));

describe('方案的校验码表与 ISSUE_CODES 一致', () => {
  const doc = read(join('docs', 'experiments', 'exp-00-director-loop.md'));
  const inDoc = codesInTable(doc);
  const inCode = new Set<string>(ISSUE_CODES);

  it('方案里的每一个码都真实存在', () => {
    const phantom = [...inDoc].filter((c) => !inCode.has(c)).sort();
    expect(phantom, `方案写了实现里没有的码：${phantom.join(', ')}`).toEqual([]);
  });

  it('实现里的每一个码都在方案里有定义', () => {
    const missing = ISSUE_CODES.filter((c) => !inDoc.has(c)).sort();
    expect(missing, `实现新增了码但方案没写：${missing.join(', ')}`).toEqual([]);
  });

  it('阻断级与建议级的数量分别是 17 与 12', () => {
    expect(blocking).toHaveLength(17);
    expect(advisory).toHaveLength(12);
  });
});

describe('README 的计数断言与代码一致', () => {
  const readme = read('README.md');

  it('「N 种阻断码 + M 种建议级码」两个数都对', () => {
    const m = readme.match(/(\d+) 种阻断码 \+ (\d+) 种建议级码/);
    expect(m, 'README 里找不到「N 种阻断码 + M 种建议级码」这句，格式变了就同步改这条测试').not.toBeNull();
    expect(Number(m![1])).toBe(blocking.length);
    expect(Number(m![2])).toBe(advisory.length);
  });

  it('测试总数的分项加起来等于总数', () => {
    const m = readme.match(/全部 (\d+) 个测试（esl (\d+) \/ world (\d+) \/ learning (\d+) \/ director (\d+) \/ lab (\d+)）/);
    expect(m, 'README 里找不到测试数那一行，格式变了就同步改这条测试').not.toBeNull();
    const [total, ...parts] = m!.slice(1).map(Number);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
  });
});

describe('文档引用的源码路径都真实存在', () => {
  /**
   * 只查 `src/` 与 `test/` 下的 `.ts`。
   * 刻意**不查** `config/run-*.yaml`：文档里有「复制成新文件名」这种指向未来的路径，
   * 那本来就不该存在（例如 `run-smoke20p.yaml`）。
   */
  const CODE_PATH = /(?:packages\/[a-z]+\/src|apps\/lab\/src|apps\/lab\/test)\/[A-Za-z0-9_./-]+\.ts/g;
  const DOCS = [
    'README.md',
    join('docs', 'README.md'),
    join('docs', 'research', 'oss-reuse.md'),
    join('docs', 'research', 'reference-borrowing-plan.md'),
    join('docs', 'experiments', 'exp-00-director-loop.md'),
    join('docs', 'experiments', 'exp-00-results.md'),
    join('docs', 'experiments', 'exp-00-audit-fixes.md'),
    join('docs', 'experiments', 'exp-00-goal-readiness-audit.md'),
  ];

  it('没有任何文档写着不存在的源文件', () => {
    const missing: string[] = [];
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(CODE_PATH)) {
        if (!existsSync(join(REPO_ROOT, m[0]))) missing.push(`${doc} → ${m[0]}`);
      }
    }
    expect(missing, `文档引用了不存在的文件：\n${[...new Set(missing)].join('\n')}`).toEqual([]);
  });
});
