/**
 * 离线样刊（M1 垂直切片）：1 期 × 3 单元的「咖啡与城市生活」。
 *
 * 这里的内容全部是项目自有文本（`own-work`），因此可以离线构造、离线验证、
 * 离线阅读；不下载网页、不调用模型、不伪造授权证据。规模是**小样**：
 * 完整 3 × 3 与 20 × 10 由同一套引擎支持，但样刊只放一个可验证的最小闭环。
 */
import {
  type Cefr,
  type Edition,
  type EditionSpec,
  type EditorialRevision,
  type EditionRun,
  type IssueRelease,
  type UnitLevelPlan,
  type UnitPlan,
  type UnitRevision,
} from './contract.js';
import type { CorpusRevision } from './sources.js';
import type { LanguagePackRevision } from './language.js';
import type { RightsDecision } from './sources.js';
import type { EditionTarget } from './compile.js';
import type { EditionInstall } from './run.js';
import { buildEditionProject } from './project.js';

export interface UnitSeed {
  key: string;
  title: string;
  subtitle: string;
  description: string;
  role: UnitPlan['role'];
  concept: string;
  goal: string;
  segments: string[];
  targets: { alias: string; item: string; introduce: boolean }[];
  extra: { form: string; reason: string }[];
  draft: string;
}

export const sampleUnitSeeds: UnitSeed[] = [
  {
    key: 'cafe-1',
    title: '走进咖啡馆',
    subtitle: 'In the cafe',
    description: '早上的一杯咖啡：温度、价格，还有第一句点单。',
    role: 'introduce',
    concept: 'coffee-temperature-price',
    goal: '用 hot / cheap 描述一杯饮品',
    segments: [
      'It is morning. The cafe is small and warm. The coffee is hot and cheap. Two coins for a cup.',
      'The tea is not hot. It is cold. The tea is cheap too. The price is on the wall.',
    ],
    targets: [
      { alias: 't1', item: 'lx:hot#adj.temperature', introduce: true },
      { alias: 't2', item: 'lx:cheap#adj.inexpensive', introduce: true },
    ],
    extra: [
      { form: 'cafe', reason: '专题核心名词，语言包暂无对应条目' },
      { form: 'coffee', reason: '专题核心名词，语言包暂无对应条目' },
      { form: 'tea', reason: '与 coffee 对举的饮品名词' },
    ],
    draft: [
      'EDITION-DRAFT/1',
      '@title 走进咖啡馆',
      '@subtitle In the cafe',
      '@description 早上的一杯咖啡：温度、价格，还有第一句点单。',
      '@reading p1',
      '@end',
      '@comic cafe',
      'shopkeeper: Good morning. What would you like?',
      'cat: A cup of coffee, please. Is it hot?',
      'shopkeeper: Yes. The coffee is hot and cheap.',
      '@end',
      '@quiz meaning t1',
      '@end',
      '@quiz meaning t2',
      '@end',
    ].join('\n'),
  },
  {
    key: 'cafe-2',
    title: '两枚硬币',
    subtitle: 'Two coins',
    description: '同样一只杯子，价格可以完全不同。',
    role: 'explore',
    concept: 'price-comparison',
    goal: '用 expensive / price 谈价格差异',
    segments: [
      'This cup is expensive. The price is five coins.',
      'The small cup is not expensive. The price is two coins.',
    ],
    targets: [
      { alias: 't1', item: 'lx:expensive#adj.costly', introduce: true },
      { alias: 't2', item: 'lx:price#n.cost', introduce: true },
    ],
    extra: [],
    draft: [
      'EDITION-DRAFT/1',
      '@title 两枚硬币',
      '@subtitle Two coins',
      '@description 同样一只杯子，价格可以完全不同。',
      '@reading p1',
      '@end',
      '@quiz meaning t1',
      '@end',
      '@quiz cloze t2',
      '@end',
      '@quiz sentence t1',
      '@end',
    ].join('\n'),
  },
  {
    key: 'cafe-3',
    title: '早晨的声音',
    subtitle: 'Morning sounds',
    description: '把前两个单元的词放回一个安静的早晨。',
    role: 'recap',
    concept: 'quiet-morning',
    goal: '在连续语境中复现温度与价格表达',
    segments: [
      'In the morning, the cafe is quiet. The coffee is warm. The tea is hot.',
      'Some cups are cheap and some are expensive. Every cup is warm.',
    ],
    targets: [{ alias: 't1', item: 'lx:hot#adj.temperature', introduce: false }],
    extra: [
      { form: 'cafe', reason: '第一期已批准的专题术语，在这里复现' },
      { form: 'coffee', reason: '第一期已批准的专题术语，在这里复现' },
      { form: 'tea', reason: '第一期已批准的专题术语，在这里复现' },
    ],
    draft: [
      'EDITION-DRAFT/1',
      '@title 早晨的声音',
      '@subtitle Morning sounds',
      '@description 把前两个单元的词放回一个安静的早晨。',
      '@reading p1',
      '@end',
      '@comic cafe',
      'cat: In the morning, the cafe is quiet.',
      'shopkeeper: And the coffee is always warm.',
      '@end',
      '@quiz meaning t1',
      '@end',
    ].join('\n'),
  },
];

export interface EditionSample {
  edition: Edition;
  editorial: EditorialRevision;
  corpus: CorpusRevision;
  rights: RightsDecision[];
  pack: LanguagePackRevision;
  units: UnitRevision[];
  /** 每个 UnitRevision 对应的分级教学计划与目标短名，供界面/测试复核。 */
  levelPlans: UnitLevelPlan[];
  unitPlans: UnitPlan[];
  targets: Record<string, EditionTarget[]>;
  release: IssueRelease;
  install: EditionInstall;
  run: EditionRun;
}

export interface SampleOptions {
  cefr?: Cefr;
  now?: Date;
  /** 保留参数：样刊始终带一个可读 Run，缺口省时为 false。 */
  includeRun?: boolean;
}

/**
 * 离线样刊（M1 垂直切片）：1 期 × 3 单元的「咖啡与城市生活」。
 *
 * 单元种子是项目自有文本，因此可以离线构造、离线验证、离线阅读；
 * 不下载网页、不调用模型、不伪造授权证据。更大规模与第二等级分别由
 * `scale.ts` / `level-b1.ts` 复用同一个构建器。
 */
export function createEditionSample(lexiconYaml: string, options: SampleOptions = {}): EditionSample {
  const cefr = options.cefr ?? 'A2';
  if (cefr !== 'A2') throw new Error('样刊只提供经过验证的 A2 档；第二等级见 createB1Sample');
  const built = buildEditionProject({
    lexiconYaml,
    cefr,
    title: '咖啡与城市生活',
    subtitle: 'A small edition about a daily cup',
    description: '一个有限专题：从温度与价格开始，读完一期就结束，不无限生成同一本书。',
    issues: [{
      title: '第一期 · 一杯咖啡',
      summary: '温度、价格和安静的早晨：三个短单元，一个能读完的小专题。',
      units: sampleUnitSeeds,
    }],
    spec: sampleSpec(),
    now: options.now,
    allowedCharacters: ['shopkeeper', 'cat', 'guide'],
  });
  return {
    edition: built.edition,
    editorial: built.editorial,
    corpus: built.corpus,
    rights: built.rights,
    pack: built.pack,
    units: built.units,
    levelPlans: built.levelPlans,
    unitPlans: built.unitPlans,
    targets: built.targets,
    release: built.releases[0]!,
    install: built.installs[0]!,
    run: built.run,
  };
}

export function sampleSpec(): EditionSpec {
  return {
    topic: '咖啡与城市生活',
    angles: ['一杯饮品的温度', '价格与选择', '安静的城市早晨'],
    exclusions: ['医疗、法律、投资建议', '实时新闻'],
    audience: 'A2 成人学习者',
    cefr: 'A2' as Cefr,
    targetIssues: 1,
    unitsPerIssue: 3,
    minutesPerIssue: 26,
    preferences: ['documentary', 'interactive'] as ('documentary' | 'dialogue' | 'story' | 'interactive')[],
    sourcePolicy: 'local-pack-only' as const,
    networkAuthorized: false,
  };
}
