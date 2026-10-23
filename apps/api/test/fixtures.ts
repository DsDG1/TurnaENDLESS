import { readFileSync } from 'node:fs';
import { Batch, contentHash } from '@endless/esl';
import { createContent, type GeneratedEpisode, type SavedPlayer } from '@endless/content';
import { createSession, getOptions, getScenes, transition } from '@endless/player';

export const content = createContent(readFileSync(new URL('../../lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8'));

export function complete(save?: SavedPlayer) {
  const restored = save ? content.restore(save) : { session: createSession(content.pilot), generated: [], library: content.pilot };
  let session = restored.session;
  for (const episode of restored.library.episodes) {
    session = transition(session, { type: 'select', episode: episode.id }, restored.library);
    for (const scene of getScenes(episode).slice(content.stateContext(session, restored.library).view.episodes[episode.id]!.cursor)) {
      const options = getOptions(scene);
      if (options.length) session = transition(session, { type: 'answer', scene: scene.id, choice: options.findIndex((option) => option.correct) }, restored.library);
      session = transition(session, { type: 'advance', scene: scene.id, skip: false }, restored.library);
    }
  }
  return content.snapshot(session, restored.generated);
}

export function generated(save: SavedPlayer, id: string, now = new Date(), learningVersion: 1 | 2 | 3 = 3): GeneratedEpisode {
  const { session, library } = content.restore(save);
  const plan = content.plan(session, library, now, learningVersion);
  const target = plan.detection[0]!;
  const form = content.lexicon.forms.get(target.item)![0]!;
  const distractors = ['hat', 'cat', 'door', 'table', 'moon', 'tea'].filter((word) => word !== form).slice(0, 3);
  const practice = plan.practice[0];
  const practiceForm = practice ? content.lexicon.forms.get(practice.item)![0]! : undefined;
  const batch = Batch.parse({
    batch: id, channel: 'duck_detective', brief: plan.brief.brief, cast: ['duck', 'cat'], hook_out: 'Where is the cat?',
    scenes: [
      { id: 's1', type: 'comic', setting: '@tag:agency_office', uses: plan.brief.expose.map((entry) => entry.item),
        panels: [{ shot: 'wide', actors: ['@char:duck'], props: [],
          bubbles: [{ speaker: 'duck', text: plan.brief.expose.map((entry) => content.lexicon.forms.get(entry.item)![0]).join('. ') || 'Hello.' }] }] },
      { id: 's2', type: 'chat', skin: 'messenger', uses: practice ? [practice.item] : [],
        messages: [{ from: 'cat', text: practiceForm ?? 'Hello.' }],
        ...(practice ? { evidence: practice } : {}),
        reply: { options: [{ label: practiceForm ?? 'Yes.', correct: true, effect: 'clue' }, { label: 'No.' }],
          on_correct: { from: 'cat', text: 'Thank you.' }, on_wrong: { from: 'cat', text: 'Oh.' } },
        effects: { clue: [{ user_fact: { predicate: 'noticed', object: id } }] } },
      { id: 's3', type: 'pick', question: 'What is this?', uses: [],
        evidence: { item: target.item, type: target.type },
        options: [{ label: form, correct: true }, ...distractors.map((label) => ({ label }))],
        feedback: { on_correct: 'Yes.', on_wrong: 'No.' } },
    ],
  });
  return {
    version: 1, generatedAt: now.toISOString(), basedOn: content.historyKey(session),
    ...(learningVersion >= 2 ? { learningVersion: learningVersion as 2 | 3 } : {}),
    title: '新的线索', subtitle: 'A new clue', description: '鸭侦探遇到了一个新谜题。',
    batch, hash: contentHash(batch),
  };
}
