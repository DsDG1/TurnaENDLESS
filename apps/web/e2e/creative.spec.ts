import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { contentHash } from '@endless/esl';
import { bridge, creativeSeries, parseBackup, type CreativeSeriesId, type GeneratedEpisode, type GenerationRequest, type SavedPlayer } from '@endless/content';
import { content } from '../../api/test/fixtures.js';
import { seed } from './workspace-seed.js';

const at = '2026-10-23T08:00:00.000Z';

interface SeriesPlan { kind: string; series: CreativeSeriesId; cast: [string, string]; bg: string; forum?: boolean }
const FLOW: SeriesPlan[] = [
  { kind: 'story', series: 'impossible_store', cast: ['shopkeeper', 'delivery_mouse'], bg: 'shop_counter' },
  { kind: 'daily', series: 'daily_life', cast: ['guide', 'delivery_mouse'], bg: 'cafe', forum: true },
  { kind: 'social', series: 'tiny_posts', cast: ['cat', 'guide'], bg: 'living_room' },
  { kind: 'knowledge', series: 'word_window', cast: ['guide', 'duck'], bg: 'agency_office' },
];
const seriesLabel = (id: CreativeSeriesId) => creativeSeries[id].label;
const advanceName = (kind: string, index: number, total: number) =>
  index === total - 1 ? '看完这一集' : '继续';

/** 用真实任务编译一份 v4 文档（指定系列/形态；真实 planCreative，不改写目标）。 */
function creativeDocument(save: SavedPlayer, requestId: string, plan: SeriesPlan): GeneratedEpisode {
  const { session, library } = content.restore(save);
  const task = content.planCreative(session, library, new Date(at));
  const intro = task.targets.filter((x) => task.brief.introduce.includes(x.item));
  const expose = task.targets.filter((x) => x.interaction === null);
  const required = task.targets.filter((x) => x.interaction !== null);
  const form = (item: string) => content.lexicon.forms.get(item)![0];
  const [a, b] = plan.cast;
  const batchId = `ai-${requestId}`;
  const chunk = <T,>(list: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  };
  const linked = (target: { alias: string; item: string }, remember = false) =>
    `@choice ${target.alias}\n? What did you see?\n+ I see the ${form(target.item)}.\n- I see nothing.\n- It is late.\n- Please wait.\n= 正确答案包含目标词。\n${remember ? '@remember\n' : ''}@end`;

  let bodyBlocks: string[];
  if (plan.kind === 'knowledge') {
    const retrieval = task.targets.find((x) => x.interaction && x.interaction !== 'practice');
    const exposeTargets = task.targets.filter((x) => x.interaction === null && !task.brief.introduce.includes(x.item));
    const introFirst = intro[0]!;
    const core = [
      ...(retrieval ? [`@quiz meaning ${retrieval.alias}\n@end`] : []),
      ...intro.flatMap((x) => [`@fact ${x.alias}\n@end`, `@example ${x.alias}\n@end`]),
      ...intro.map((x) => `@quiz meaning ${x.alias}\n@end`),
      ...exposeTargets.map((x) => `@fact ${x.alias}\n@end`),
      `@card ${introFirst.alias}\n@end`,
    ];
    const padCards = [introFirst, ...exposeTargets].flatMap((x) => [`@card ${x.alias}\n@end`, `@fact ${x.alias}\n@end`]);
    bodyBlocks = [...core];
    for (const card of padCards) {
      if (bodyBlocks.length >= 10) break;
      bodyBlocks.push(card);
    }
  } else {
    // 本批 2–5 个新词：每个都要在两个正文块出现（comic 每块最多 4 格，chat 每块最多 8 条消息）
    const narrative = [
      ...chunk(intro, 4).map((group) => `@comic ${plan.bg}\n${group.map((x, i) => `${i % 2 ? b : a}: The ${form(x.item)} is here.`).join('\n')}\n@end`),
      ...chunk(intro, 6).map((group, index) => {
        const lines = group.map((x, i) => `${i % 2 ? a : b}: It is a ${form(x.item)}.`);
        if (index === 0) lines.push(`${b}: I see a ${expose.map((x) => form(x.item)).join(', a ') || 'box'}.`);
        lines.push(`${a}: Good.`);
        return plan.forum && index === 0
          ? `@chat forum\n${lines.join('\n')}\n@reply ${required[0]!.alias}\n? What came?\n+ The ${form(required[0]!.item)} came.\n- Nothing came.\n- Later.\n- Wait.\n= 正确回复包含目标词。\n@remember\n@end`
          : `@chat messenger\n${lines.join('\n')}\n@end`;
      }),
    ];
    const choices = required
      .filter((target, index) => !(plan.forum && index === 0))
      .map((target, index) => linked(target, index === 0 && !plan.forum));
    const filler = [
      `@post ${b}\ntext: Good.\n@end`,
      `@chat messenger\n${a}: Good.\n${b}: Good.\n@end`,
      `@post ${a}\ntext: Good.\n@end`,
      `@comic ${plan.bg}\n${a}: Good.\n${b}: Good.\n@end`,
      `@post ${b}\ntext: Good.\n@end`,
      `@chat messenger\n${b}: Good.\n${a}: Good.\n@end`,
    ];
    bodyBlocks = [...narrative, ...choices];
    for (const block of filler) {
      if (bodyBlocks.length >= 10) break;
      bodyBlocks.push(block);
    }
  }

  const draft = [
    'ENDLESS-DRAFT/1',
    `@kind ${plan.kind}`,
    `@series ${plan.series}`,
    '@title 新的一页',
    '@subtitle A fresh start',
    '@description 一段新的旅程展开了。',
    '@hook 期待下一段际遇。',
    ...bodyBlocks,
  ].join('\n');
  const compiled = content.compileDraft(draft, task, content.pilot, batchId);
  if (!compiled.ok) {
    throw new Error(`e2e draft 编译失败：${compiled.issues.map((i) => i.message).join('; ')}`);
  }
  return {
    version: 1,
    generatedAt: at,
    basedOn: content.historyKey(session),
    title: '新的一页',
    subtitle: 'A fresh start',
    description: '一段新的旅程展开了。',
    batch: compiled.batch,
    hash: contentHash(compiled.batch),
    learningVersion: 4,
    creation: compiled.creation,
    usage: { inputTokens: 100, outputTokens: 100, calls: 1 },
  };
}

const status = { configured: true, model: 'test-model', token: 'test-token' };

/** 按批次确定性播放一集：正确选项按真实可访问名点击，卡片翻面，前进按钮按场景序号/形态精确定位。 */
async function playEpisode(page: Page, document: GeneratedEpisode, kind: string, from = 0) {
  const scenes = document.batch.scenes;
  for (let i = from; i < scenes.length; i++) {
    const scene = scenes[i]!;
    if (scene.type === 'card') {
      const reveal = page.getByRole('button', { name: '翻面看释义', exact: true });
      await expect(reveal).toBeEnabled();
      await reveal.click();
    } else {
      const options = scene.type === 'chat' ? scene.reply?.options
        : scene.type === 'pick' || scene.type === 'quiz' ? scene.options : undefined;
      if (options?.length) {
        const chosen = Math.max(0, options.findIndex((o) => o.correct));
        await page.getByRole('button', { name: `${chosen + 1}. ${options[chosen]!.label}`, exact: true }).click();
      }
    }
    const advance = page.getByRole('button', { name: advanceName(kind, i, scenes.length), exact: true });
    await expect(advance).toBeEnabled();
    await advance.click();
  }
  await expect(page.getByRole('heading', { name: '这一段已读完。' })).toBeVisible();
  await page.goto('/');
}

test('v4 混合内容流：四个系列连续生成、实际交互、来源标注、导出与离线回放', async ({ page, context }, testInfo) => {
  const documents: GeneratedEpisode[] = [];
  await page.route('**/api/**', async (route) => {
    if (route.request().url().endsWith('/api/status')) {
      await route.fulfill({ json: status });
      return;
    }
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const input = route.request().postDataJSON() as GenerationRequest;
    const document = creativeDocument(input.save, input.requestId, FLOW[Math.min(documents.length, FLOW.length - 1)]!);
    documents.push(document);
    await route.fulfill({ json: { id: input.requestId, status: 'succeeded', phase: '已完成', result: document } });
  });
  await seed(page);
  await expect(page.locator('.material-preview')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('material-preview-desktop.png') });

  for (let i = 0; i < FLOW.length; i++) {
    const plan = FLOW[i]!;
    await page.getByRole('button', { name: 'AI 生成下一集', exact: true }).click();
    await expect.poll(() => documents.length).toBe(i + 1);
    const document = documents[i]!;
    // 顶部：系列标签在 .watch-heading，标题在 .watch-title
    await expect(page.locator('.watch-heading')).toContainText(seriesLabel(plan.series));
    await expect(page.locator('.watch-title h1')).toHaveText('新的一页');
    if (plan.series === 'impossible_store') {
      await expect(page.getByRole('img', { name: '獾店主' }).first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('impossible-store-comic.png') });
    }
    if (plan.forum) {
      const chatIndex = document.batch.scenes.findIndex((s) => s.type === 'chat' && s.skin === 'forum');
      expect(chatIndex).toBeGreaterThan(0);
      const chat = document.batch.scenes[chatIndex]!;
      expect(chat.type === 'chat' && chat.reply !== undefined).toBe(true);
      if (chat.type !== 'chat' || !chat.reply) throw new Error('forum 场景缺失 reply');
      for (let si = 0; si < chatIndex; si++) {
        const scene = document.batch.scenes[si]!;
        const options = scene.type === 'pick' || scene.type === 'quiz' ? scene.options : undefined;
        if (options?.length) {
          const idx = Math.max(0, options.findIndex((o) => o.correct));
          await page.getByRole('button', { name: `${idx + 1}. ${options[idx]!.label}`, exact: true }).click();
        }
        const advance = page.getByRole('button', { name: advanceName(plan.kind, si, document.batch.scenes.length), exact: true });
        await expect(advance).toBeEnabled();
        await advance.click();
      }
      await expect(page.locator('.forum-thread')).toBeVisible();
      await expect(page.locator('.reply-label')).toContainText(chat.reply.prompt ?? '');
      const correct = Math.max(0, chat.reply.options.findIndex((o) => o.correct));
      await page.getByRole('button', { name: `${correct + 1}. ${chat.reply.options[correct]!.label}`, exact: true }).click();
      await expect(page.locator('.forum-post-mine')).toContainText(chat.reply.options[correct]!.label);
      await expect(page.locator('.forum-post-response')).toContainText(chat.reply.on_correct.text);
      await page.screenshot({ path: testInfo.outputPath('forum-response.png') });
      const advance = page.getByRole('button', { name: advanceName(plan.kind, chatIndex, document.batch.scenes.length), exact: true });
      await expect(advance).toBeEnabled();
      await advance.click();
      await playEpisode(page, document, plan.kind, chatIndex + 1);
      continue;
    }
    if (plan.kind === 'knowledge') {
      const cardIndex = document.batch.scenes.findIndex((s) => s.type === 'card');
      expect(cardIndex).toBeGreaterThan(0);
      for (let si = 0; si < cardIndex; si++) {
        const scene = document.batch.scenes[si]!;
        const options = scene.type === 'pick' || scene.type === 'quiz' ? scene.options : undefined;
        if (options?.length) {
          const idx = Math.max(0, options.findIndex((o) => o.correct));
          await page.getByRole('button', { name: `${idx + 1}. ${options[idx]!.label}`, exact: true }).click();
        }
        const advance = page.getByRole('button', { name: advanceName(plan.kind, si, document.batch.scenes.length), exact: true });
        await expect(advance).toBeEnabled();
        await advance.click();
      }
      await expect(page.locator('.source-badge').first()).toContainText('本地词库');
      await page.screenshot({ path: testInfo.outputPath('knowledge-source.png') });
      await playEpisode(page, document, plan.kind, cardIndex);
      continue;
    }
    await playEpisode(page, document, plan.kind);
  }

  // 4 集全部读完并回到首页：导出备份验证
  await page.goto('/#settings');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出完整备份', exact: true }).click(),
  ]);
  const tmp = mkdtempSync(join(tmpdir(), 'creative-backup-'));
  const filePath = join(tmp, 'save.json');
  await download.saveAs(filePath);
  const parsed = parseBackup(JSON.parse(readFileSync(filePath, 'utf-8')));
  const generatedEntries = parsed.backup.workspace.data.entries.filter((e) => e.sourceKind === 'generated');
  expect(generatedEntries).toHaveLength(4);
  expect(generatedEntries.map((e) => e.series)).toEqual([
    'impossible_store', 'daily_life', 'tiny_posts', 'word_window',
  ]);
  expect(generatedEntries.every((e) => e.sourceKind === 'generated')).toBe(true);

  // 离线冷启动：第 4 集（知识形态）回看仍有来源标注
  await context.setOffline(true);
  await page.goto('/');
  await expect(page.locator('.hero-card')).toBeVisible();
  const fourthCard = page.locator('.episode-card-6');
  await expect(fourthCard).toBeVisible();
  await fourthCard.click();
  await expect(page.locator('.completion-card')).toBeVisible();
  const review = page.getByRole('button', { name: '回看本集', exact: true });
  await expect(review).toBeEnabled();
  await review.click();
  for (let step = 0; step < documents[3]!.batch.scenes.length; step++) {
    if (await page.locator('.source-badge').count()) break;
    const next = page.getByRole('button', { name: '继续回看', exact: true });
    await expect(next).toBeEnabled();
    await next.click();
  }
  await expect(page.locator('.source-badge').first()).toContainText('本地词库');
  await page.screenshot({ path: testInfo.outputPath('knowledge-source-offline.png') });
  await context.setOffline(false);
});

test('非侦探故事系列生成：暖心烘焙坊正常生成、独立角色与场景展示', async ({ page }) => {
  let doc: GeneratedEpisode | null = null;
  const bakeryPlan: SeriesPlan = {
    kind: 'story', series: 'warm_bakery', cast: ['rabbit', 'bear'], bg: 'bakery',
  };
  await page.route('**/api/**', async (route) => {
    if (route.request().url().endsWith('/api/status')) {
      await route.fulfill({ json: status });
      return;
    }
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const input = route.request().postDataJSON() as GenerationRequest;
    doc = creativeDocument(input.save, input.requestId, bakeryPlan);
    await route.fulfill({ json: { id: input.requestId, status: 'succeeded', phase: '已完成', result: doc } });
  });
  await seed(page);

  await page.getByRole('button', { name: 'AI 生成下一集', exact: true }).click();
  await expect.poll(() => doc !== null).toBe(true);
  await expect(page.locator('.watch-heading')).toContainText('暖心烘焙坊');
  await expect(page.getByRole('img', { name: '兔烘焙师' }).first()).toBeVisible();
  await playEpisode(page, doc!, 'story');
  await expect(page.locator('.episode-card-3')).toContainText('暖心烘焙坊');
});

test('素材预览在 320px 宽度下不溢出', async ({ page }, testInfo) => {
  await seed(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.locator('.material-preview')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath('material-preview-mobile.png') });
});
