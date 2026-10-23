/**
 * A1 第 2 步：组件目录（`data/catalog.yaml`）是提示词的单一来源。
 *
 * 判据来自计划文档：目录文件之后，提示词里的组件说明由 `{{catalog_scenes}}` /
 * `{{catalog_effects}}` 渲染，**示例自检改为对目录跑**。所以这里做三件事：
 *   1. 目录里每个场景的 `example` 必须能过校验器（示例自己违反规则就红）；
 *   2. effect 目录的 `example` 必须是「单键、键名等于 id、字段都在 fields 里」——
 *      字段混用（`open_thread` 里写 subject）曾经是整批失败的头号原因；
 *   3. 渲染出的文本要覆盖六种场景与六种 effect，且不可选的项（derive）明确标出来。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { Scene, parseBatch, validateBatch, type Batch } from '@endless/esl';
import { buildValidationContext, loadLabData, renderCatalogEffects, renderCatalogScenes } from '../src/data.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');
const SCENE_TYPES = ['comic', 'chat', 'swipe', 'pick', 'hidden_object', 'story'];
const EFFECT_OPS = ['set_fact', 'end_fact', 'open_thread', 'advance_thread', 'resolve_thread', 'user_fact'];

/** 形状检查用的宽上下文：词表放到最宽、句长不设限，失败只可能是形状错误。 */
async function shapeCtx() {
  const data = await loadLabData(DATA_DIR);
  const knownForms = new Set<string>(data.lexicon.functionWords);
  for (const forms of data.lexicon.forms.values()) for (const f of forms) knownForms.add(f);
  return buildValidationContext(data, {
    knownForms,
    allowedExtra: [],
    entitiesExists: () => true,
    canonFacts: [],
    activeFacts: [],
    threads: new Map(),
    maxWordsPerLine: 999,
    oovWarn: 1,
    oovBlock: 1,
  });
}

async function catalogErrors(): Promise<{ file: string; errors: string[] }[]> {
  const data = await loadLabData(DATA_DIR);
  const ctx = await shapeCtx();
  const fails: { file: string; errors: string[] }[] = [];
  for (const scene of data.catalog.scenes) {
    if (!scene.example) {
      if (scene.writer_selectable) fails.push({ file: scene.id, errors: ['可选的场景类型缺少 example'] });
      continue;
    }
    const parsedBatch = parseBatch(
      `batch: cat-0001
channel: duck_detective
brief: lb-cat
cast: [duck]
scenes:
${scene.example}`,
      'yaml',
    );
    if (!parsedBatch.ok) {
      fails.push({ file: scene.id, errors: parsedBatch.issues.map((i) => `${i.code}: ${i.message}`) });
      continue;
    }
    const batch: Batch = parsedBatch.batch;
    // 合成批次的 cast 取示例里真正出现过的角色（目录给的是逐场景示例，不重复写批次头）
    const cast = new Set<string>(batch.cast);
    for (const s of batch.scenes) {
      for (const id of s.cast ?? []) cast.add(id);
      if (s.type === 'comic') for (const p of s.panels) for (const b of p.bubbles) cast.add(b.speaker);
      if (s.type === 'chat') {
        for (const m of s.messages) cast.add(m.from);
        for (const side of ['on_correct', 'on_wrong'] as const) {
          const from = s.reply?.[side]?.from;
          if (from) cast.add(from);
        }
      }
      if (s.type === 'story') {
        for (const line of s.ink.split('\n')) {
          const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
          if (m) cast.add(m[1]!.toLowerCase());
        }
      }
    }
    batch.cast = [...cast];
    // 单场景合成批次的「3–4 场」不适用：目录给的是逐场景示例
    const errors = validateBatch(batch, ctx).issues
      .filter((i) => i.level === 'error')
      .filter((i) => !(i.code === 'E-SCHEMA' && i.message.includes('基本场景数为')))
      .map((i) => `${i.code}${i.scene ? `@${i.scene}` : ''}: ${i.message}`);
    if (errors.length > 0) fails.push({ file: scene.id, errors });
    // example 的场景类型必须与目录 id 一致（防止复制粘贴串行）
    const scenes = batch.scenes;
    if (!scenes.every((s) => s.type === scene.id)) {
      fails.push({ file: scene.id, errors: [`example 里的场景类型是 ${scenes.map((s) => s.type).join('/')}，与目录 id 不符`] });
    }
  }
  return fails;
}

describe('A1 组件目录', () => {
  it('每个场景示例都能过校验器（示例自己违反规则就红）', async () => {
    const fails = await catalogErrors();
    const detail = fails.map((f) => `${f.file}：\n  ${f.errors.join('\n  ')}`).join('\n');
    expect(fails, `目录示例违反规则：\n${detail}`).toHaveLength(0);
  });

  it('effect 目录的示例是单键、键名等于 id、字段都在声明里', async () => {
    const data = await loadLabData(DATA_DIR);
    for (const e of data.catalog.effects) {
      const parsed = parseYaml(e.example.replace(/^\{\s*/, '').replace(/\s*\}$/, ''));
      const keys = Object.keys(parsed as Record<string, unknown>);
      expect(keys, `${e.id} 的示例应当只有一个顶层键`).toHaveLength(1);
      expect(keys[0], `${e.id} 的示例键名写成了 ${keys[0]}`).toBe(e.id);
      const body = (parsed as Record<string, unknown>)[e.id];
      const used = body && typeof body === 'object' ? Object.keys(body as Record<string, unknown>) : [];
      for (const k of used) {
        expect(e.fields, `${e.id} 的示例用了未声明的字段 ${k}`).toContain(k);
      }
    }
  });

  it('渲染结果覆盖六种场景与六种 effect，且标出写手不可选的项', async () => {
    const data = await loadLabData(DATA_DIR);
    const scenes = renderCatalogScenes(data.catalog);
    const effects = renderCatalogEffects(data.catalog);
    for (const t of SCENE_TYPES) expect(scenes).toContain(`**${t}**`);
    for (const op of EFFECT_OPS) expect(effects).toContain(`**${op}**`);
    expect(scenes).toContain('写手不可选：derive');
    // 渲染结果要短：目录是给模型读的一页纸，不是校验器文档
    expect(scenes.length).toBeLessThan(1200);
    expect(effects.length).toBeLessThan(2000);
  });

  it('目录的必填字段与 Zod 场景模型对得上（用 writer 的完整示例反查）', async () => {
    const data = await loadLabData(DATA_DIR);
    // 目录声明的 required 里出现过的字段，必须在某个合法示例里真的出现过
    const parsed = parseYaml(data.catalog.scenes.find((s) => s.id === 'pick')!.example!) as unknown[];
    const scene = Scene.parse(parsed[0]);
    for (const field of ['question', 'options', 'feedback']) {
      expect(Object.keys(scene)).toContain(field);
    }
  });
});
