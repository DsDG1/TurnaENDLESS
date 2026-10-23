import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Batch, batchTextUnits, countBaseScenes, locateForm } from '@endless/esl';
import { createEpisode, createSession, getOptions, getScenes, transition } from '@endless/player';
import { createContent } from '../src/index.js';

const text = readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
const content = createContent(text);
const at = '2026-10-23T08:00:00.000Z';

function completedPilot() {
  let session = createSession(content.pilot);
  for (const episode of content.pilot.episodes) {
    session = transition(session, { type: 'select', episode: episode.id }, content.pilot, at);
    for (const scene of getScenes(episode)) {
      const options = getOptions(scene);
      if (options.length) {
        session = transition(session, { type: 'answer', scene: scene.id, choice: options.findIndex((o) => o.correct) }, content.pilot, at);
      }
      session = transition(session, { type: 'advance', scene: scene.id, skip: false }, content.pilot, at);
    }
  }
  return session;
}

type Task = ReturnType<typeof content.plan>;

/** 模仿写手产出：两次叙述曝光新词 + practice 聊天 + 检测 pick。 */
function narrativeBatch(task: Task): Batch {
  const introduce = task.brief.introduce[0]!;
  const form = content.lexicon.forms.get(introduce)![0]!;
  const target = task.detection[0];
  const distractors = ['box', 'key', 'hat'];
  return Batch.parse({
    batch: 'ai-ex', channel: 'duck_detective', brief: task.brief.brief, cast: ['duck', 'cat'],
    scenes: [
      { id: 's1', type: 'comic', setting: '@tag:agency_office', uses: task.brief.expose.map((entry) => entry.item),
        panels: [{ shot: 'wide', actors: ['@char:duck'], props: [],
          bubbles: [{ speaker: 'duck', text: task.brief.expose.map((entry) => content.lexicon.forms.get(entry.item)![0]).join('. ') || `I will ${form} the box.` }] }] },
      { id: 's2', type: 'comic', setting: '@tag:agency_office', uses: [introduce],
        panels: [{ shot: 'close', actors: ['@char:cat'], props: [], bubbles: [{ speaker: 'cat', text: `You can ${form} it.` }] }] },
      { id: 's3', type: 'chat', skin: 'messenger', uses: [introduce],
        messages: [{ from: 'cat', text: `May I ${form} it too?` }],
        evidence: { item: introduce, type: 'practice' },
        reply: { options: [{ label: 'Yes.', correct: true, effect: 'help' }, { label: 'No.' }],
          on_correct: { from: 'cat', text: 'Thanks.' }, on_wrong: { from: 'cat', text: 'Oh.' } },
        effects: { help: [{ user_fact: { predicate: 'helped', object: 'cat' } }] } },
      ...(target ? [{
        id: 's4', type: 'pick', question: 'Check it.', uses: [],
        evidence: { item: target.item, type: target.type },
        options: [{ label: content.lexicon.forms.get(target.item)![0]!, correct: true }, ...distractors.map((label) => ({ label }))],
        feedback: { on_correct: 'Yes.', on_wrong: 'No.' },
      }] : []),
    ],
  });
}

describe('双层生成的程序练习卡', () => {
  it('拼接 quiz/card 练习卡且完整批次过校验', () => {
    const session = completedPilot();
    const task = content.plan(session, content.pilot, new Date(at));
    const batch = narrativeBatch(task);
    const scenes = content.exerciseScenes(batch, task, content.pilot, 3);
    const added = scenes.filter((s) => !batch.scenes.some((b) => b.id === s.id));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((s) => s.type === 'quiz' || s.type === 'card')).toBe(true);
    // 练习卡不挤占 3–4 个叙事场次的计数
    expect(countBaseScenes({ ...batch, scenes })).toBe(batch.scenes.length);
    const spliced = { ...batch, scenes };
    expect(content.validatePlayable(spliced, task.context).filter((i) => i.level === 'error')).toEqual([]);
    expect(content.learningIssues(spliced, task).filter((i) => i.level === 'error')).toEqual([]);
    // 编译后可按原有事件模型播放（answer / reveal+advance）
    const episode = createEpisode(spliced, task.context, { title: 't', subtitle: 's', description: 'd' });
    for (const scene of getScenes(episode)) {
      if (scene.type === 'quiz') expect(getOptions(scene).length).toBeGreaterThanOrEqual(2);
      if (scene.type === 'card') {
        expect(scene.uses).toContain(scene.item);
        expect(locateForm(scene.front, content.lexicon.forms.get(scene.item)![0]!).length).toBeGreaterThan(0);
      }
    }
  });

  it('练习卡绝不提前泄露被测条目的形式（防启动），单词卡紧跟出处场景', () => {
    const session = completedPilot();
    const task = content.plan(session, content.pilot, new Date(at));
    const batch = narrativeBatch(task);
    const scenes = content.exerciseScenes(batch, task, content.pilot, 3);
    const spliced = { ...batch, scenes };
    const exerciseIds = new Set(scenes.filter((s) => !batch.scenes.some((b) => b.id === s.id)).map((s) => s.id));
    const avoidForms = new Set(
      [...task.brief.review.map((r) => r.item), ...task.detection.map((d) => d.item)]
        .flatMap((item) => content.lexicon.forms.get(item) ?? []),
    );
    for (const unit of batchTextUnits(spliced).filter((u) => exerciseIds.has(u.sceneId))) {
      for (const form of avoidForms) expect(locateForm(unit.text, form)).toHaveLength(0);
    }
    const introduce = task.brief.introduce[0]!;
    const cardIndex = scenes.findIndex((s) => s.type === 'card');
    if (cardIndex >= 0) {
      const forms = content.lexicon.forms.get(introduce)!;
      const sourceIndex = scenes.findIndex((s, i) => i < cardIndex &&
        batchTextUnits(spliced).some((u) => u.sceneId === s.id && u.role === 'narrative' && forms.some((f) => locateForm(u.text, f).length)));
      expect(sourceIndex).toBe(cardIndex - 1);
      expect(scenes[cardIndex]).toMatchObject({ type: 'card', item: introduce, evidence: { item: introduce, type: 'practice' } });
    }
  });
});
