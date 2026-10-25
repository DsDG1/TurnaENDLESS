import { expect, type Page } from '@playwright/test';
import { contentHash } from '@endless/esl';
import { applyPlayerCommand, createWorkspace, type Workspace } from '@endless/content';
import { getOptions, getScenes } from '@endless/player';
import { content } from '../../api/test/fixtures.js';

/** 与旧 complete() 等效的工作区：三集试播全部真实读完。 */
export function playedWorkspace(): Workspace {
  let ws = createWorkspace(content);
  for (const episode of content.pilot.episodes) {
    ws = applyPlayerCommand(content, ws, { type: 'select', episode: episode.id });
    for (const scene of getScenes(episode)) {
      const options = getOptions(scene);
      if (options.length) {
        ws = applyPlayerCommand(content, ws, { type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct) });
      }
      ws = applyPlayerCommand(content, ws, { type: 'advance', scene: scene.id, skip: false });
    }
  }
  return ws;
}

/** 与 WorkspaceRepository.rows() 相同的 store 拆分。 */
export function workspaceRows(ws: Workspace) {
  return {
    meta: {
      key: 'workspace', identity: ws.identity, profile: ws.profile,
      entries: ws.entries, obligations: ws.obligations, activeBranchId: ws.activeBranchId,
      management: ws.management,
    },
    revisions: ws.revisions,
    branches: ws.branches,
    objects: [
      ...ws.volumes.map((v) => ({ kind: 'volume', ...v })),
      ...ws.checkpoints.map((c) => ({ kind: 'checkpoint', ...c })),
      ...ws.tickets.map((t) => ({ kind: 'ticket', ...t })),
    ],
  };
}

/** 打开（必要时创建）endless-workspace 库并写入全部行。 */
export async function writeWorkspace(page: Page, ws: Workspace) {
  const rows = workspaceRows(ws);
  await page.evaluate(async (rows) => {
    // 库版本必须与 WorkspaceRepository 一致（v2 增加 outbox/eventIds/sync）；
    // 用旧版本号打开会被 IndexedDB 直接拒绝，种子就写不进去。
    const stores = ['meta', 'revisions', 'branches', 'objects', 'staging', 'outbox', 'eventIds', 'sync'];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('endless-workspace', 2);
      request.onupgradeneeded = () => {
        for (const name of stores) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects'], 'readwrite');
      // 应用首次加载会自动写入一份工作区；种子必须先清空，避免两套 ID 混排
      for (const name of ['revisions', 'branches', 'objects']) tx.objectStore(name).clear();
      tx.objectStore('meta').put(rows.meta, 'workspace');
      for (const revision of rows.revisions as { id: string }[]) tx.objectStore('revisions').put(revision, revision.id);
      for (const branch of rows.branches as { id: string }[]) tx.objectStore('branches').put(branch, branch.id);
      for (const object of rows.objects as { id: string }[]) tx.objectStore('objects').put(object, object.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, rows);
}

/** 等价于旧 seed()：写入工作区存档后刷新页面。 */
export async function seed(page: Page, ws = playedWorkspace()) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '故事频道。' })).toBeVisible();
  await writeWorkspace(page, ws);
  await page.reload();
}

/** 读取整个 endless-workspace 内容用于断言（如密钥不落盘）。 */
export async function dumpWorkspace(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('endless-workspace', 2);
      request.onsuccess = () => resolve(request.result);
    });
    const all: Record<string, unknown> = {};
    for (const name of ['meta', 'revisions', 'branches', 'objects', 'staging']) {
      all[name] = await new Promise((resolve) => {
        const req = db.transaction(name, 'readonly').objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result);
      });
    }
    db.close();
    return JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, indexed: all });
  });
}

/** v4 生成文档：与 commitTicketResult/accept 的严格校验兼容。 */
export function generatedDocV4(save: Parameters<typeof content.restore>[0], batchId: string, at = '2026-10-24T08:00:00.000Z') {
  const { session, library } = content.restore(save);
  const task = content.planCreative(session, library, new Date(at));
  const intro = task.targets.filter((x) => task.brief.introduce.includes(x.item));
  const expose = task.targets.filter((x) => x.interaction === null);
  const required = task.targets.filter((x) => x.interaction !== null);
  const form = (alias: string) => task.targets.find((x) => x.alias === alias)!.forms[0];
  const chunk = <T,>(list: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  };
  const replyTarget = required[0];
  const linked = (x: { alias: string }) => `@choice ${x.alias}\n? What did you see?\n+ I see the ${form(x.alias)}.\n- I see nothing.\n- It is late.\n- Please wait.\n= ok\n@end`;
  // 本批 2–5 个新词：每个都要在两个正文块出现（comic 每块最多 4 格，chat 每块最多 8 条）
  const comicBlocks = chunk(intro, 4).map((group) =>
    `@comic agency_office\n${group.map((x, i) => `${i % 2 ? 'cat' : 'duck'}: The ${form(x.alias)} is here.`).join('\n')}\n@end`);
  const chatBlocks = chunk(intro, 6).map((group, index) => {
    const lines = group.map((x, i) => `${i % 2 ? 'duck' : 'cat'}: It is a ${form(x.alias)}.`);
    if (index === 0) lines.push(`cat: I see a ${expose.map((x) => x.forms[0]).join(', a ') || 'box'}.`);
    if (index === 0 && replyTarget) {
      return `@chat messenger\n${lines.join('\n')}\n@reply ${replyTarget.alias}\n? What is it?\n+ It is the ${form(replyTarget.alias)}.\n- It is late.\n- I see nothing.\n- Please wait.\n= ok\n@remember\n@end`;
    }
    lines.push('duck: Good.');
    return `@chat messenger\n${lines.join('\n')}\n@end`;
  });
  const blocks = [
    ...comicBlocks,
    ...chatBlocks,
    ...required.slice(replyTarget ? 1 : 0).map(linked),
  ];
  while (blocks.length < 10) blocks.push('@post duck\ntext: Good.\n@end');
  const parts = [
    'ENDLESS-DRAFT/1', '@kind story', '@series duck_detective', '@title 新的线索', '@subtitle A new clue', '@description 鸭侦探收到新线索。',
    ...blocks,
  ];
  const draft = parts.join('\n');
  const compiled = content.compileDraft(draft, task, library, batchId);
  if (!compiled.ok) throw new Error(compiled.issues.map((i) => i.message).join(';'));
  return {
    version: 1 as const, generatedAt: at, basedOn: content.historyKey(session),
    title: compiled.title, subtitle: compiled.subtitle, description: compiled.description,
    batch: compiled.batch, hash: contentHash(compiled.batch), learningVersion: 4 as const, creation: compiled.creation,
  };
}

const advanceName = (kind: string, index: number, total: number) =>
  index === total - 1 ? '看完这一集' : '继续';

/** 确定性播放整集（10–20 节）：选项点正确项、卡片翻面、逐节前进。 */
export async function playDoc(page: Page, document: { batch: { scenes: any[] } }, kind = 'story', from = 0) {
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
        const chosen = Math.max(0, options.findIndex((o: { correct?: boolean }) => o.correct));
        await page.getByRole('button', { name: `${chosen + 1}. ${options[chosen].label}`, exact: true }).click();
      }
    }
    const advance = page.getByRole('button', { name: advanceName(kind, i, scenes.length), exact: true });
    await expect(advance).toBeEnabled();
    await advance.click();
  }
  await expect(page.getByRole('heading', { name: '这一段已读完。' })).toBeVisible();
}
