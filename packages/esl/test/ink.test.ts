/** ink 子集规则与路径穷举的独立测试（第 5.8.4 节第 6 种场景）。 */
import { describe, expect, it } from 'vitest';
import { checkInk, staticInkChecks } from '../src/ink.js';

const VALID = `-> start
=== start ===
Duck: Hello.
* [Ask more]
  Duck: Fine. # effect:more
- -> END
`;

describe('staticInkChecks 禁则', () => {
  it('合法脚本通过', () => {
    expect(staticInkChecks(VALID).errors).toEqual([]);
  });

  it.each([
    ['VAR trust = 1\n' + VALID, 'VAR'],
    ['CONST k = 2\n' + VALID, 'CONST'],
    ['~ x = 3\n' + VALID, '~ 赋值'],
    ['INCLUDE other.ink\n' + VALID, 'INCLUDE'],
    ['EXTERNAL fn()\n' + VALID, 'EXTERNAL'],
    [VALID.replace('- -> END', '- ->-> tunnel'), '隧道'],
    [VALID.replace('- -> END', '- <- thread'), '线程'],
    [VALID.replace('Duck: Hello.', 'Duck: {~ one | two}'), '随机序列'],
  ])('禁止：%s 的 %.20s…', (src) => {
    expect(staticInkChecks(src as string).errors.length).toBeGreaterThan(0);
  });

  it('标签白名单外的标签被拒绝', () => {
    const src = VALID.replace('# effect:more', '# teleport:moon');
    expect(staticInkChecks(src).errors.some((e) => e.includes('白名单'))).toBe(true);
  });

  it('非访问计数的内联条件被拒绝', () => {
    const src = VALID.replace('Duck: Hello.', 'Duck: {x > 3: Hello.}');
    expect(staticInkChecks(src).errors.some((e) => e.includes('访问计数'))).toBe(true);
  });

  it('divert 指向未知 knot 被拒绝', () => {
    const src = VALID.replace('-> start\n', '-> nowhere\n');
    expect(staticInkChecks(src).errors.some((e) => e.includes('不存在的 knot'))).toBe(true);
  });
});

describe('checkInk 编译与路径穷举', () => {
  it('收集全部路径及其 effect', () => {
    const res = checkInk(VALID);
    expect(res.ok).toBe(true);
    expect(res.paths).toHaveLength(1);
    expect(res.paths[0]!.effects).toEqual(['more']);
    expect(res.paths[0]!.reachesEnd).toBe(true);
  });

  it('二分支两条路径，各带各的 effect', () => {
    const src = `-> top
=== top ===
Duck: Choose.
* [A]
  A. # effect:a
  -> END
* [B]
  B. # effect:b
  -> END
`;
    const res = checkInk(src);
    expect(res.ok).toBe(true);
    expect(res.paths).toHaveLength(2);
    expect(res.paths.map((p) => p.effects)).toContainEqual(['a']);
    expect(res.paths.map((p) => p.effects)).toContainEqual(['b']);
  });

  it('语法坏脚本编译失败', () => {
    const res = checkInk('-> a\n=== a ===\n{ broken\n');
    expect(res.ok).toBe(false);
  });

  it('运行到内容耗尽（缺 -> END）返回校验错误而不是抛异常', () => {
    // 真实跑批里模型写出这种 ink 时，校验器必须给出 E-INK 并让修复循环接手
    const src = `-> top
=== top ===
Duck: No ending here.
`;
    expect(() => checkInk(src)).not.toThrow();
    const res = checkInk(src);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/ran out of content|END/);
  });
});
