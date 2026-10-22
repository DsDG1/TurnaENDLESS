/**
 * 为 promptfoo 矩阵补上「流水线会填、配置里没填」的提示词变量。
 *
 * 背景：`single.md` 有 16 个占位符，矩阵只在 `defaultTest.vars` 里给了 9 个，
 * `backgrounds` / `learning_checklist` / `allowed_words` / `retry_note` 一直以字面量
 * `{{...}}` 送进模型——等于量的是「缺一半上下文的提示词」。这个脚本按流水线
 * （`pipeline.ts` 的 `buildVars`）完全相同的规则算出这四个变量，打印成可直接粘进
 * `promptfooconfig.yaml` 的 YAML 片段，避免手抄词表时和 manifest / 词库漂移。
 *
 * 用法（在 apps/lab 下）：
 *   pnpm exec tsx promptfoo/render-vars.ts            # 打印全部片段
 *   pnpm exec tsx promptfoo/render-vars.ts --check    # 只检查配置里的四个变量齐不齐
 *
 * 只读解析配置，不回写——YAML 里的注释比生成器更值得保留。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import { AbilityEstimator, knownWordSet } from '@endless/learning';
import { buildValidationContext, loadLabData } from '../src/data.js';

const here = dirname(fileURLToPath(import.meta.url));
const LAB_DIR = join(here, '..');
const CONFIG = join(here, 'promptfooconfig.yaml');

/** 与 pipeline 的冷启动一致：BKT 先验、没有历史证据 ⇒ 已知词只有功能词 + 专名。 */
const ability = new AbilityEstimator();

interface Fixture {
  description: string;
  vars: { brief?: string; channel?: string; level?: string };
}

/** 解析 brief YAML 文本（配置里以 `brief: |` 块给出）。 */
const parseBrief = (text: string | undefined) => {
  if (!text) return undefined;
  const doc = yamlParse(text) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    id: (doc.brief as string) ?? 'lb-0000',
    level: (doc.level as string) ?? 'A1',
    introduce: list(doc.introduce) as string[],
    expose: list(doc.expose) as { item: string }[],
    review: list(doc.review) as { item: string; min_evidence?: string }[],
    avoidBeforeTest: list(doc.avoid_before_test) as string[],
    allowedExtra: ((doc.vocab as { allowed_extra?: string[] } | undefined)?.allowed_extra ?? []) as string[],
    maxWords: ((doc.vocab as { max_words_per_line?: number } | undefined)?.max_words_per_line ?? 9) as number,
  };
};

/** 与 director.ts 的 learningChecklist 同规则（矩阵是单段式，没有 showrunner 计划）。 */
const checklist = (b: NonNullable<ReturnType<typeof parseBrief>>): string => {
  const lines: string[] = [];
  for (const e of b.expose) lines.push(`- ${e.item}：曝光 → 写进某个场景的 uses，不要写 evidence`);
  for (const r of b.review) lines.push(`- ${r.item}：检测 → 写 evidence: {item: ${r.item}, type: ${r.min_evidence ?? 'recognition-2'}}`);
  return lines.length > 0 ? lines.join('\n') : '（本批没有学习任务）';
};

const main = async () => {
  const data = await loadLabData(join(LAB_DIR, 'data'));
  const config = yamlParse(readFileSync(CONFIG, 'utf8')) as {
    tests?: Fixture[];
    defaultTest?: { vars?: Record<string, string> };
  };
  const tests = config.tests ?? [];
  const defaults = config.defaultTest?.vars ?? {};

  // 背景清单：与 pipeline.buildVars 的 backgrounds 完全一致
  const backgrounds = [...data.backgrounds.values()]
    .map((bg) => `@tag:${bg.tag}（${bg.description}；spots: ${bg.spots.join(' / ')}）`)
    .join('\n');

  const missing: string[] = [];
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    for (const key of ['backgrounds', 'retry_note']) {
      if (!(key in defaults)) missing.push(`defaultTest.vars.${key}`);
    }
  }

  const blocks: string[] = [];
  for (const t of tests) {
    const brief = parseBrief(t.vars.brief);
    if (!brief) continue;
    // 冷启动：已知词只有功能词 + 专名（矩阵里没有 world_state，故专名为空）
    const knownForms = knownWordSet(data.lexicon, { ability: (i) => ability.get(i) });
    const ctx = buildValidationContext(data, {
      brief: {
        id: brief.id,
        review: brief.review.map((r) => ({ item: r.item, minEvidence: r.min_evidence })),
        expose: brief.expose.map((e) => ({ item: e.item })),
        introduce: brief.introduce,
        avoidBeforeTest: brief.avoidBeforeTest,
      },
      knownForms,
      allowedExtra: brief.allowedExtra,
      entitiesExists: () => true,
      canonFacts: [],
      activeFacts: [],
      threads: new Map(),
      channelIsImprov: t.vars.channel === 'improv',
      maxWordsPerLine: brief.maxWords,
    });

    const allowedWords = [...ctx.vocab.allowedForms].sort().join(', ');
    const vars: Record<string, string> = {
      learning_checklist: checklist(brief),
      allowed_words: allowedWords,
    };
    if (checkOnly) {
      for (const [k, v] of Object.entries(vars)) {
        if (!(k in t.vars) && !(k in defaults)) missing.push(`${t.description} → ${k}`);
      }
      continue;
    }
    blocks.push(
      `# ${t.description}\n` +
        Object.entries(vars)
          .map(([k, v]) =>
            k === 'learning_checklist'
              ? `      ${k}: |\n` + v.split('\n').map((l) => `        ${l}`).join('\n')
              : `      ${k}: '${v.replace(/'/g, "''")}'`,
          )
          .join('\n'),
    );
  }

  if (checkOnly) {
    if (missing.length === 0) {
      console.log('四个变量都齐了 ✅');
      return;
    }
    console.error(`缺 ${missing.length} 处，模型的提示词里会留字面量 {{...}}：\n  ` + missing.join('\n  '));
    process.exitCode = 1;
    return;
  }

  console.log(`# backgrounds（放进 defaultTest.vars，v9 起 single.md 依赖它）\n      backgrounds: |`);
  for (const line of backgrounds.split('\n')) console.log(`        ${line}`);
  console.log(`      retry_note: ''   # 首轮没有上一批的问题单`);
  console.log(`\n# 下面每段粘进对应 test 的 vars（冷启动 A1 的真实允许词表）\n`);
  console.log(blocks.join('\n\n'));
};

void main();
