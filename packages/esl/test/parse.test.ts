/** 表层解析：思考块剥离 + 两种编码（第 5.8.6 节）。 */
import { describe, expect, it } from 'vitest';
import { detectFormat, parseBatch, stripThinking } from '@endless/esl';
import { BASE_BATCH_YAML } from './fixture.js';

describe('stripThinking', () => {
  it('剥掉带闭合标记的思考块（M3 的实际输出形态）', () => {
    const text = 'ThinkingWe need output JSON exactly? User says output {"ok":true}. Need comply.</think>\n\n{"ok":true}';
    expect(stripThinking(text)).toBe('{"ok":true}');
  });

  it('剥掉 <thinking> 标签形式', () => {
    const text = '<thinking>\n先想一下…\n</thinking>\nscenes:\n  - id: s1';
    expect(stripThinking(text)).toBe('scenes:\n  - id: s1');
  });

  it('没有闭合标记时从「像答案开头」的那一行切', () => {
    const text = 'Thinking:\n用户要一个批次。先定 channel。\n\nbatch: dd-0042\ncast: [duck]';
    expect(stripThinking(text)).toBe('batch: dd-0042\ncast: [duck]');
  });

  it('没有闭合标记时也能切到代码围栏', () => {
    const text = 'Thinking:\n思考中…\n```yaml\nbatch: dd-0042\n```';
    expect(stripThinking(text)).toBe('```yaml\nbatch: dd-0042\n```');
  });

  it('正常输出原样返回 null（调用方用原文解析）', () => {
    expect(stripThinking('batch: dd-0042\ncast: [duck]')).toBeNull();
    expect(stripThinking('{"batch":"dd-0042"}')).toBeNull();
  });

  it('有思考标记但找不到答案开头时返回 null，不瞎猜', () => {
    expect(stripThinking('Thinking: 我还没想好要写什么')).toBeNull();
  });
});

describe('parseBatch', () => {
  it('YAML 与 JSON 解析出同一规范模型', () => {
    const yaml = parseBatch(BASE_BATCH_YAML);
    expect(yaml.ok).toBe(true);
    if (!yaml.ok) return;
    const json = parseBatch(JSON.stringify(yaml.batch), 'json');
    expect(json.ok).toBe(true);
    if (!json.ok) return;
    expect(json.batch).toEqual(yaml.batch);
  });

  it('内联思考的批次输出也能解析（不指望模型关得掉思考）', () => {
    const text = `Thinking:\n这批要写 duck 的案子。\n\n${BASE_BATCH_YAML}`;
    const parsed = parseBatch(text, 'yaml');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.batch.batch).toBe('dd-0042');
  });

  it('按开头字符判断编码', () => {
    expect(detectFormat('  {"batch":"x"}')).toBe('json');
    expect(detectFormat('batch: x')).toBe('yaml');
  });

  it('真解析不了时报 E-PARSE，不静默通过', () => {
    const parsed = parseBatch('{{{ 这不是 YAML', 'yaml');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]!.code).toBe('E-PARSE');
  });
});
