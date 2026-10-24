/**
 * 第二等级（B1）语言包与同主题样刊（M5）。
 *
 * 只开放**一个**新等级：不一次点亮六档。B1 包在 A1–A2 已审核词条之上叠加
 * 12 个手写 B1 词条（自有整理，`own-work`），因此低等级形式仍然允许出现。
 * 同主题样刊保持与 A2 样刊**相同的概念**，只改变语言与任务复杂度，
 * 用于 Q01/Q02/L08 的回归：概念保持、语言真实分级、旧事件仍绑定旧修订。
 */
import { packEntriesFromLexicon, buildLanguagePack, type LanguageEntry, type LanguagePackRevision } from './language.js';
import { newEditionId, type Cefr } from './contract.js';
import { buildEditionProject, type BuiltProject } from './project.js';
import type { ProjectIssueSeed } from './project.js';
import { sampleSpec, type UnitSeed } from './sample.js';
import { loadLexicon } from '@endless/learning';

/** B1 手写词条：形式、词义与例句都随仓库授权；不使用第三方词表或词典例句。 */
export const b1Entries: LanguageEntry[] = [
  ['lx:aroma#n.smell', ['aroma'], '香气', 'The aroma of a warm roast fills the small room.', 'noun'],
  ['lx:roast#n.process', ['roast'], '烘焙', 'They sell a simple roast in the morning.', 'noun'],
  ['lx:afford#v.manage', ['afford'], '买得起', 'Few customers can afford the expensive cup.', 'verb'],
  ['lx:queue#n.line', ['queue', 'queues'], '队伍', 'There is a queue at the counter.', 'noun'],
  ['lx:regular#n.customer', ['regular', 'regulars'], '常客', 'The regulars arrive before the morning queue.', 'noun'],
  ['lx:prefer#v.like', ['prefer', 'prefers'], '更喜欢', 'The regulars prefer warm tea in the morning.', 'verb'],
  ['lx:notice#v.see', ['notice'], '注意到', 'You can notice the price on the wall.', 'verb'],
  ['lx:comfortable#adj.cosy', ['comfortable'], '舒适的', 'The small room is comfortable and quiet.', 'adjective'],
  ['lx:neighbourhood#n.area', ['neighbourhood'], '街区', 'The neighbourhood is quiet in the early morning.', 'noun'],
  ['lx:atmosphere#n.mood', ['atmosphere'], '氛围', 'The atmosphere is warm and simple.', 'noun'],
  ['lx:counter#n.surface', ['counter', 'counters'], '柜台', 'The cups are on the counter.', 'noun'],
  ['lx:brew#v.make', ['brew', 'brews'], '冲泡', 'They brew the coffee slowly.', 'verb'],
].map(([item, forms, glossZh, example, pos]) => ({
  item: item as string,
  kind: 'sense' as const,
  forms: forms as string[],
  glossZh: glossZh as string,
  example: example as string,
  cefr: 'B1' as Cefr,
  pos: pos as string,
  freqBand: 3,
  confusables: [],
  sourceRef: 'b1-pack:hand-authored',
}));

/** A1–A2 已审核词条 + B1 手写词条；等级越高，允许形式越多（累积而非替换）。 */
export function createB1Pack(lexiconYaml: string, now = new Date()): LanguagePackRevision {
  const loaded = loadLexicon(lexiconYaml);
  if (!loaded.lexicon || loaded.issues.length) throw new Error('B1 语言包的词库无法加载');
  const lower = packEntriesFromLexicon(loaded.lexicon, 'A2');
  return buildLanguagePack({
    id: newEditionId('lpk'),
    revisionId: 'b1-pack-1',
    cefr: 'B1',
    frozenAt: now.toISOString(),
    entries: [...lower, ...b1Entries],
    functionWords: [...loaded.lexicon.functionWords],
    properNouns: ['shopkeeper', 'cat', 'guide', 'duck', 'moon', 'badger'],
    // B1 的句子与行更长：16 词的 A2 行宽会把合法的 B1 段落误判为超长
    maxWordsPerLine: 22,
    rights: {
      basis: '仓库内 A1–A2 种子词库 + 手写 B1 词条（项目自有整理）',
      decisionId: null,
      note: '词条、词义与例句均由本仓库编写；未使用第三方词表、词典例句或分级词表',
    },
  });
}

/** 同一主题、同一组概念，但语言与任务按 B1 设计。 */
const b1UnitSeeds: UnitSeed[] = [
  {
    key: 'b1-cafe-1',
    title: '香气与烘焙',
    subtitle: 'Aroma and roast',
    description: '同样的早晨，B1 用更长的句子谈香气与烘焙。',
    role: 'introduce',
    concept: 'coffee-temperature-price',
    goal: '用 aroma / roast 描述一杯咖啡的气味与做法',
    segments: [
      'The room is quiet because the morning is early. The shop has the aroma of a simple roast.',
      'A cup costs two coins. The tea is warm and the price is clear.',
    ],
    targets: [
      { alias: 't1', item: 'lx:aroma#n.smell', introduce: true },
      { alias: 't2', item: 'lx:roast#n.process', introduce: true },
    ],
    extra: [
      { form: 'cafe', reason: '专题核心名词，语言包暂无对应条目' },
      { form: 'coffee', reason: '专题核心名词，语言包暂无对应条目' },
      { form: 'tea', reason: '与 coffee 对举的饮品名词' },
    ],
    draft: [
      'EDITION-DRAFT/1',
      '@title 香气与烘焙',
      '@subtitle Aroma and roast',
      '@description 同样的早晨，B1 用更长的句子谈香气与烘焙。',
      '@reading p1',
      '@end',
      '@comic cafe',
      'shopkeeper: The aroma is from a simple roast.',
      'cat: A warm cup, please.',
      '@end',
      '@quiz meaning t1',
      '@end',
      '@quiz meaning t2',
      '@end',
    ].join('\n'),
  },
  {
    key: 'b1-cafe-2',
    title: '常客的选择',
    subtitle: 'What regulars prefer',
    description: '价格相同，常客仍然有自己的选择。',
    role: 'explore',
    concept: 'price-comparison',
    goal: '用 prefer / regular 说明选择与常客',
    segments: [
      'This cup is more expensive than the small one. The regulars prefer the cheaper cup.',
      'Some customers pay five coins for the same cup. They prefer tea in the morning, when the shop is quiet.',
    ],
    targets: [
      { alias: 't1', item: 'lx:prefer#v.like', introduce: true },
      { alias: 't2', item: 'lx:regular#n.customer', introduce: true },
    ],
    extra: [
      { form: 'cafe', reason: '第一期已批准的专题术语' },
      { form: 'coffee', reason: '第一期已批准的专题术语' },
      { form: 'tea', reason: '第一期已批准的专题术语' },
    ],
    draft: [
      'EDITION-DRAFT/1',
      '@title 常客的选择',
      '@subtitle What regulars prefer',
      '@description 价格相同，常客仍然有自己的选择。',
      '@reading p1',
      '@end',
      '@comic cafe',
      'cat: This cup is more expensive than that one.',
      'shopkeeper: The regulars prefer it, but the price is the same.',
      '@end',
      '@quiz meaning t1',
      '@end',
      '@quiz cloze t2',
      '@end',
    ].join('\n'),
  },
  {
    key: 'b1-cafe-3',
    title: '安静的街区',
    subtitle: 'A quiet neighbourhood',
    description: '把前两个单元的语言放回街区与早晨。',
    role: 'recap',
    concept: 'quiet-morning',
    goal: '在连续语境中复现香气、价格与偏好表达',
    segments: [
      'In the morning, the shop is quiet, and the aroma is clear. The regulars arrive early.',
      'They prefer warm tea, but some cups are expensive. Every price is on the wall.',
    ],
    targets: [
      { alias: 't1', item: 'lx:aroma#n.smell', introduce: false },
      { alias: 't2', item: 'lx:prefer#v.like', introduce: false },
    ],
    extra: [
      { form: 'cafe', reason: '本期已批准的专题术语' },
      { form: 'coffee', reason: '本期已批准的专题术语' },
      { form: 'tea', reason: '本期已批准的专题术语' },
      { form: 'roast', reason: '第一期已批准的目标词，在这里复现' },
      { form: 'regulars', reason: '第二期已批准的目标词，在这里复现' },
    ],
    draft: [
      'EDITION-DRAFT/1',
      '@title 安静的街区',
      '@subtitle A quiet neighbourhood',
      '@description 把前两个单元的语言放回街区与早晨。',
      '@reading p1',
      '@end',
      '@comic cafe',
      'guide: The shop is quiet in the morning.',
      'cat: I would like warm tea, please.',
      '@end',
      '@quiz meaning t1',
      '@end',
    ].join('\n'),
  },
];

export interface B1Sample extends BuiltProject {
  cefr: 'B1';
}

/**
 * B1 样刊：与 A2 样刊同一个专题、同一组概念，语言与任务升级。
 * 返回完整项目（含安装包与 Run），可直接用于等级切换与重读去重测试。
 */
export function createB1Sample(lexiconYaml: string, now = new Date('2026-10-24T00:00:00.000Z')): B1Sample {
  const pack = createB1Pack(lexiconYaml, now);
  const issues: ProjectIssueSeed[] = [{
    title: '第一期 · 一杯咖啡（B1）',
    summary: '同样的早晨与价格，换成 B1 的句子长度与任务负担。',
    units: b1UnitSeeds,
  }];
  const built = buildEditionProject({
    lexiconYaml,
    cefr: 'B1',
    pack,
    title: '咖啡与城市生活',
    subtitle: 'A small edition about a daily cup',
    description: '与 A2 样刊同一个专题的第二等级版本：概念不变，语言与任务升级。',
    issues,
    spec: { ...sampleSpec(), cefr: 'B1', audience: 'B1 成人学习者' },
    now,
    allowedCharacters: ['shopkeeper', 'cat', 'guide'],
  });
  return { ...built, cefr: 'B1' };
}
