import { readFileSync } from 'node:fs';
import { contentHash } from '@endless/esl';
import { getOptions, getScenes } from '@endless/player';
import {
  applyPlayerCommand, bridge, commitTicketResult, createContent, createWorkspace,
  reserveTicket, type Workspace,
} from '../src/index.js';

export const cloudTestLexicon = readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
export const cloudTestContent = createContent(cloudTestLexicon);
export const cloudTestTime = '2026-10-24T08:00:00.000Z';

export function cloudTestWorkspace(generated = false): Workspace {
  const content = cloudTestContent;
  let workspace = createWorkspace(content, new Date(cloudTestTime));
  if (!generated) return workspace;
  for (const episode of content.pilot.episodes) {
    workspace = applyPlayerCommand(content, workspace, { type: 'select', episode: episode.id }, new Date(cloudTestTime));
    for (const scene of getScenes(episode)) {
      if (getOptions(scene).length) workspace = applyPlayerCommand(content, workspace, {
        type: 'answer', scene: scene.id, choice: getOptions(scene).findIndex((choice) => choice.correct),
      }, new Date(cloudTestTime));
      workspace = applyPlayerCommand(content, workspace, { type: 'advance', scene: scene.id, skip: false }, new Date(cloudTestTime));
    }
  }
  const { workspace: reserved, ticket } = reserveTicket(workspace, new Date(cloudTestTime));
  const runtime = bridge(content, reserved);
  const task = content.planCreative(runtime.session, runtime.library, new Date(cloudTestTime));
  const intros = task.targets.filter((target) => task.brief.introduce.includes(target.item));
  const exposures = task.targets.filter((target) => target.interaction === null);
  const blocks: string[] = [];
  for (let start = 0; start < intros.length; start += 4) blocks.push(
    `@comic agency_office\n${intros.slice(start, start + 4).map((target) => `duck: The ${target.forms[0]} is here.`).join('\n')}\n@end`,
  );
  blocks.push(`@chat messenger\n${intros.map((target) => `duck: It is a ${target.forms[0]}.`).join('\n')}\ncat: I see a ${exposures.map((target) => target.forms[0]).join(', a ') || 'box'}.\n@end`);
  for (const target of task.targets.filter((entry) => entry.interaction !== null)) blocks.push(
    `@choice ${target.alias}\n? What did you see?\n+ I see the ${target.forms[0]}.\n- I see nothing.\n- It is late.\n- Please wait.\n= ok\n@end`,
  );
  while (blocks.length < 10) blocks.push('@post duck\ntext: Good.\n@end');
  const compiled = content.compileDraft([
    'ENDLESS-DRAFT/1', '@kind story', '@series duck_detective', '@title Cloud fixture',
    '@subtitle Shared content', '@description A synthetic import fixture.', ...blocks,
  ].join('\n'), task, runtime.library, `ai-${ticket.id.slice(4)}`);
  if (!compiled.ok) throw new Error(compiled.issues.map((issue) => issue.message).join('; '));
  return commitTicketResult(content, reserved, ticket.id, {
    version: 1, generatedAt: cloudTestTime, basedOn: { eventCount: ticket.basis.eventCount, hash: ticket.basis.eventHash },
    title: compiled.title, subtitle: compiled.subtitle, description: compiled.description,
    batch: compiled.batch, hash: contentHash(compiled.batch), learningVersion: 4, creation: compiled.creation,
  }, new Date(cloudTestTime));
}
