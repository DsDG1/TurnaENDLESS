import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { materialBackgrounds, materialCharacters, materialProps } from '@endless/content';
import { Character, PropArt, SceneBackdrop } from '../src/components/art.js';
import { SceneRenderer } from '../src/components/scenes.js';
import type { PlayableScene } from '@endless/player';
import { createElement } from 'react';
import fs from 'node:fs';
import path from 'node:path';

const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe('素材注册表渲染完整性', () => {
  it('每个登记角色都有原创且互不相同的 SVG，未知 ID 明确报错', () => {
    const markups = new Map<string, string>();
    for (const c of materialCharacters) {
      const html = render(<Character kind={c.id} />);
      expect(html).toContain('<svg');
      markups.set(c.id, html);
    }
    expect(new Set(markups.values()).size).toBe(materialCharacters.length);
    expect(() => render(<Character kind="dragon" />)).toThrow(/未登记/);
  });

  it('表情确实改变脸部标记，不只是元数据', () => {
    const neutral = render(<Character kind="shopkeeper" />);
    const happy = render(<Character kind="shopkeeper" expression="happy" />);
    const sad = render(<Character kind="shopkeeper" expression="sad" />);
    expect(happy).not.toBe(neutral);
    expect(sad).not.toBe(happy);
  });

  it('每个登记背景都渲染且互不相同，未知背景明确报错', () => {
    const markups = new Set<string>();
    for (const b of materialBackgrounds) {
      const html = render(<SceneBackdrop tag={`@tag:${b.id}`} />);
      expect(html).toContain('<svg');
      markups.add(html);
    }
    expect(markups.size).toBe(materialBackgrounds.length);
    expect(() => render(<SceneBackdrop tag="@tag:volcano" />)).toThrow(/未登记/);
  });

  it('每个登记道具都渲染为带可访问标签的原创 SVG，未知道具明确报错', () => {
    const markups = new Set<string>();
    for (const p of materialProps) {
      const html = render(<PropArt reference={`@emoji:${p.id}`} />);
      expect(html).toContain('<svg');
      expect(html).toContain(p.label);
      markups.add(html);
    }
    expect(markups.size).toBe(materialProps.length);
    expect(() => render(<PropArt reference="@emoji:dragon" />)).toThrow(/未登记/);
  });

  it('所有素材都有对应的独立 .svg 文件且清单元数据完整', () => {
    const manifestPath = path.resolve(__dirname, '../public/materials/manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.counts.characters).toBe(materialCharacters.length);
    expect(manifest.counts.backgrounds).toBe(materialBackgrounds.length);
    expect(manifest.counts.props).toBe(materialProps.length);
    expect(manifest.total).toBe(materialCharacters.length + materialBackgrounds.length + materialProps.length);

    for (const item of manifest.materials) {
      const svgFile = path.resolve(__dirname, '../public/materials', item.svgPath);
      expect(fs.existsSync(svgFile)).toBe(true);
      const content = fs.readFileSync(svgFile, 'utf-8');
      expect(content).toContain('<svg');
    }
  });
});

describe('论坛/评论外观与来源标注', () => {
  const forumScene = {
    id: 's1', type: 'chat', skin: 'forum',
    messages: [{ from: 'cat', text: 'A small package came.' }, { from: 'guide', text: 'Open it slowly.' }],
    reply: {
      prompt: 'How do you answer?',
      options: [{ label: 'I open the box.', correct: true }, { label: 'I run.' }],
      on_correct: { from: 'cat', text: 'Good choice.' },
      on_wrong: { from: 'cat', text: 'Think again.' },
    },
    uses: [],
  } as unknown as PlayableScene;

  it('forum 皮肤按帖子渲染，显示题干、所选回复与角色回应', () => {
    const html = render(<SceneRenderer
      scene={forumScene}
      state={{ answer: { choice: 0, correct: true, qualified: false, evidence: 'practice', grade: null, at: 't' } }}
      glossary={{}}
      readingItems={[]}
      busy={false}
      review={false}
      presentation={{ kind: 'social', series: 'tiny_posts', label: '小小留言板' }}
      onAnswer={() => {}}
      onReveal={() => {}}
    />);
    expect(html).toContain('forum-post');
    expect(html).toContain('How do you answer?');
    expect(html).toContain('I open the box.');
    expect(html).toContain('Good choice.');
    expect(html).toContain('小小留言板');
    expect(html).not.toContain('Duck Detective');
  });

  it('来源标注显示在单词卡上，不冒充故事', () => {
    const cardScene = { id: 's2', type: 'card', item: 'lx:answer#v.reply', front: 'answer — 回答', uses: [] } as unknown as PlayableScene;
    const html = render(<SceneRenderer
      scene={cardScene}
      state={{ revealed: true }}
      glossary={{ 'lx:answer#v.reply': { label: 'answer', gloss: '回答', forms: ['answer'] } }}
      readingItems={[]}
      busy={false}
      review={false}
      presentation={{ kind: 'knowledge', series: 'word_window', label: '表达小窗口', sceneSources: { s2: '本地词库 · 词义' } }}
      onAnswer={() => {}}
      onReveal={() => {}}
    />);
    expect(html).toContain('本地词库 · 词义');
    expect(html).not.toContain('在故事里出现过');
    expect(html).toContain('释义和例句来自本地词库');
  });
});

describe('ENDLESS 与 Edition 的正文用词分离', () => {
  const quizScene = { id: 's1', type: 'quiz', kind: 'cloze', item: 'lx:hot#adj.temperature', prompt: 'The coffee is ____.', options: [], uses: [] } as unknown as PlayableScene;
  const renderQuiz = (kind: string) => render(<SceneRenderer
    scene={quizScene}
    state={{}}
    glossary={{}}
    readingItems={[]}
    busy={false}
    review={false}
    presentation={{ kind, series: 'x', label: '测试' }}
    onAnswer={() => {}}
    onReveal={() => {}}
  />);

  it('ENDLESS 故事类说「故事」，日常与知识类说「内容」', () => {
    expect(renderQuiz('story')).toContain('这句在故事刚出现过');
    expect(renderQuiz('daily')).toContain('这句在内容刚出现过');
    expect(renderQuiz('knowledge')).toContain('这句在内容刚出现过');
  });

  it('Edition 一律说「正文」，不自称故事', () => {
    const editionHtml = renderQuiz('edition');
    expect(editionHtml).toContain('这句在正文刚出现过');
    expect(editionHtml).not.toContain('故事');
    const reviewHtml = renderQuiz('review');
    expect(reviewHtml).toContain('这句在正文刚出现过');
    expect(reviewHtml).not.toContain('故事');
  });

  it('词汇侧栏按内容类型命名，Edition 不叫「故事里的表达」', () => {
    const withItems = (kind: string) => render(<SceneRenderer
      scene={quizScene}
      state={{}}
      glossary={{ 'lx:hot#adj.temperature': { label: 'hot', gloss: '热的', forms: ['hot'] } }}
      readingItems={['lx:hot#adj.temperature']}
      busy={false}
      review={false}
      presentation={{ kind, series: 'x', label: '测试' }}
      onAnswer={() => {}}
      onReveal={() => {}}
    />);
    expect(withItems('story')).toContain('故事里的表达');
    expect(withItems('edition')).toContain('正文里的表达');
    expect(withItems('edition')).not.toContain('故事里的表达');
  });
});
