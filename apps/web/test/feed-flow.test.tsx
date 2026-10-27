import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { IntermissionBridge } from '../src/components/intermission.js';
import { readFileSync } from 'node:fs';
import { createContent } from '@endless/content';
import type { Player } from '../src/player-model.js';

describe('无限流阅读队列与幕间微过渡 (IntermissionBridge)', () => {
  const text = readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
  const content = createContent(text);
  const library = content.pilot;
  const episode = library.episodes[0]!;
  const view = {
    episodes: {
      [episode.id]: {
        cursor: 3,
        scenes: {
          s1: { completed: true },
          s2: { completed: true },
          s3: { completed: true, answer: { choice: 0, correct: true, item: 'lx:behind#prep.location', evidence: null, qualified: true, grade: null, at: '' } },
        },
      },
    },
    srs: {} as any,
    ability: {} as any,
    world: { userFacts: () => [] } as any,
    answers: [],
    completed: 3,
    skipped: 0,
    exposed: new Set<string>(),
  };

  const createMockPlayer = (overrides: Partial<Player> = {}): Player =>
    ({
      workspace: null,
      session: null,
      view,
      library,
      loading: false,
      failure: null,
      notice: null,
      saving: false,
      dispatch: vi.fn(),
      api: null,
      apiError: null,
      refreshApi: vi.fn(),
      generate: vi.fn(),
      generating: false,
      phase: '',
      ticket: null,
      cancelGeneration: vi.fn(),
      readyForGeneration: true,
      apiKey: '',
      setApiKey: vi.fn(),
      canUseModel: true,
      learningNotes: [],
      nextWords: [],
      runtime: null,
      obligations: null,
      fillerCard: null,
      entries: [],
      branches: [],
      volumes: [],
      activeBranchId: 'main',
      switchBranchTo: vi.fn(),
      editDisplay: vi.fn(),
      trash: vi.fn(),
      restore: vi.fn(),
      waive: vi.fn(),
      purge: vi.fn(),
      purgeInfo: vi.fn(),
      previewEdit: vi.fn(),
      adoptEdit: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      suggestions: [],
      backup: vi.fn(),
      previewImport: vi.fn(),
      importBackup: vi.fn(),
      importState: null,
      cloudMode: false,
      cloudView: null,
      cloudSyncing: false,
      cloudCatalog: null,
      cloudRevisions: null,
      cloudMetadata: null,
      cloudLifecycle: null,
      cloudArchives: null,
      syncNow: vi.fn(),
      resolveMetadata: vi.fn(),
      resolveLifecycle: vi.fn(),
      resolveArchive: vi.fn(),
      busy: false,
      ...overrides,
    }) as unknown as Player;

  it('下一集存在且开启自动流转时，呈现倒计时进度条与进入下一集快捷键提示', () => {
    const player = createMockPlayer();
    const html = renderToStaticMarkup(
      createElement(IntermissionBridge, {
        episode,
        episodeNumber: 0,
        view,
        library,
        nextEpisodeId: 'pilot-2',
        player,
        autoAdvanceEnabled: true,
        onToggleAutoAdvance: vi.fn(),
        onSelectNext: vi.fn(),
        onReview: vi.fn(),
        onGenerate: vi.fn(),
      }),
    );

    expect(html).toContain('INTERMISSION · 幕间休息');
    expect(html).toContain('第 1 集阅读达成！');
    expect(html).toContain('本集线索词汇');
    expect(html).toContain('auto-advance-bar');
    expect(html).toContain('秒后自动滑入下一集');
    expect(html).toContain('进入下一集 (Space)');
  });

  it('关闭自动流转时，不展示倒计时但保留快捷键推进与手动进入按钮', () => {
    const player = createMockPlayer();
    const html = renderToStaticMarkup(
      createElement(IntermissionBridge, {
        episode,
        episodeNumber: 0,
        view,
        library,
        nextEpisodeId: 'pilot-2',
        player,
        autoAdvanceEnabled: false,
        onToggleAutoAdvance: vi.fn(),
        onSelectNext: vi.fn(),
        onReview: vi.fn(),
        onGenerate: vi.fn(),
      }),
    );

    expect(html).not.toContain('auto-advance-bar');
    expect(html).not.toContain('秒后自动滑入下一集');
    expect(html).toContain('进入下一集 (Space)');
    expect(html).toContain('回看本集');
  });

  it('后台正在生成下一集时，嵌入派生填缝卡与生成阶段脉冲状态', () => {
    const fillerCard = content.deriveFiller({ events: [] } as any, library);
    const player = createMockPlayer({
      generating: true,
      phase: '正在规划场景与对白',
      fillerCard,
    });

    const html = renderToStaticMarkup(
      createElement(IntermissionBridge, {
        episode,
        episodeNumber: 0,
        view,
        library,
        nextEpisodeId: undefined,
        player,
        autoAdvanceEnabled: true,
        onToggleAutoAdvance: vi.fn(),
        onSelectNext: vi.fn(),
        onReview: vi.fn(),
        onGenerate: vi.fn(),
      }),
    );

    expect(html).toContain('filler-bridge-card');
    expect(html).toContain('线索回顾 · 派生小关卡');
    expect(html).toContain('AI 正在为你准备下一集…');
    expect(html).toContain('正在规划场景与对白');
  });

  it('全部读完且未连接模型时，提供阅读记录与离线回看入口', () => {
    const player = createMockPlayer({
      generating: false,
      canUseModel: false,
    });

    const html = renderToStaticMarkup(
      createElement(IntermissionBridge, {
        episode,
        episodeNumber: 0,
        view,
        library,
        nextEpisodeId: undefined,
        player,
        autoAdvanceEnabled: true,
        onToggleAutoAdvance: vi.fn(),
        onSelectNext: vi.fn(),
        onReview: vi.fn(),
        onGenerate: vi.fn(),
      }),
    );

    expect(html).toContain('查看阅读记录');
    expect(html).toContain('回看本集');
  });
});
