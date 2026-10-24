/**
 * 规模夹具（M4）：按参数合成 `issues × unitsPerIssue` 的完整 Edition 项目。
 *
 * 用途只有一个——在不联网、不调用模型的前提下，把「语料 → 目录 → 编译 →
 * 逐单元验收 → 逐期发布 → 安装包 → Run → 事件」整条链路压到目标规模，
 * 测量体积与耗时。文本是重复利用的合成语料（同一批自有句子按单元轮换），
 * 因此**它可以验收引擎，不代表教学内容的质量**；真实 20 期仍需人工撰写。
 */
import { sampleSpec, sampleUnitSeeds, type UnitSeed } from './sample.js';
import { buildEditionProject, type BuiltProject } from './project.js';
import type { ProjectIssueSeed, ProjectUnitSeed } from './project.js';
import type { Cefr } from './contract.js';

export interface ScaleOptions {
  issues?: number;
  unitsPerIssue?: number;
  cefr?: Cefr;
  now?: Date;
}

export interface ScaleMeasurement {
  issues: number;
  units: number;
  scenes: number;
  /** 单个安装包（含语言包与全部单元）的 JSON 字节数。 */
  packageBytes: number;
  /** 全部安装包的 JSON 字节数。 */
  packagesBytes: number;
  /** 全部单元修订（含批次）的 JSON 字节数。 */
  unitsBytes: number;
  /** 一期 10 单元的典型安装包字节数。 */
  issuePackageBytes: number;
}

export interface ScaleSample extends BuiltProject {
  measurement: ScaleMeasurement;
}

/** 可复现的合成正文池：只使用样刊已批准的自有句子，不新增超纲词。 */
const recycled: Pick<UnitSeed, 'segments'>[] = sampleUnitSeeds.map((seed) => ({ segments: seed.segments }));

/** 复现单元沿用样刊第三单元的做法：不首次教学，只把已有形式放回语境。 */
const RECYCLE_TARGETS: UnitSeed['targets'] = [
  { alias: 't1', item: 'lx:hot#adj.temperature', introduce: false },
];
const RECYCLE_EXTRA: UnitSeed['extra'] = [
  { form: 'cafe', reason: '规模夹具：复用已批准的自有文本' },
  { form: 'coffee', reason: '规模夹具：复用已批准的自有文本' },
  { form: 'tea', reason: '规模夹具：复用已批准的自有文本' },
];

function recycledSeed(issueIndex: number, unitIndex: number): ProjectUnitSeed {
  const pool = recycled[(issueIndex + unitIndex) % recycled.length]!;
  const key = `scale-i${issueIndex + 1}u${unitIndex + 1}`;
  return {
    key,
    title: `复现 ${issueIndex + 1}.${unitIndex + 1}`,
    subtitle: 'Recycled reading',
    description: `第 ${issueIndex + 1} 期第 ${unitIndex + 1} 单元的合成复现文本，用于规模验收。`,
    // 每期第一个单元没有前置，不能声明为 recap（回顾单元必须有前置）
    role: unitIndex === 0 ? 'explore' : 'recap',
    concept: `scale-concept-${issueIndex + 1}-${unitIndex + 1}`,
    goal: `在复现语境中再次读到温度与价格表达（${issueIndex + 1}.${unitIndex + 1}）`,
    segments: [...pool.segments],
    targets: RECYCLE_TARGETS,
    extra: RECYCLE_EXTRA,
    draft: [
      'EDITION-DRAFT/1',
      `@title 复现 ${issueIndex + 1}.${unitIndex + 1}`,
      '@subtitle Recycled reading',
      `@description 第 ${issueIndex + 1} 期第 ${unitIndex + 1} 单元的合成复现文本，用于规模验收。`,
      '@reading p1',
      '@end',
      '@comic cafe',
      'shopkeeper: In the morning, the cafe is quiet.',
      'cat: And the coffee is warm.',
      '@end',
      '@quiz meaning t1',
      '@end',
    ].join('\n'),
  };
}

/**
 * 20 × 10 合成项目：第 1 期使用样刊的 3 个手写单元（含首次教学目标），
 * 其余 197 个单元是零首次目标的复现单元。这样既覆盖「教新词」也覆盖
 * 「大量复现」两种形态，同时不违反「一个目标只首次教学一次」的规则。
 */
export function createEditionScaleSample(lexiconYaml: string, options: ScaleOptions = {}): ScaleSample {
  const issues = options.issues ?? 20;
  const unitsPerIssue = options.unitsPerIssue ?? 10;
  const cefr = options.cefr ?? 'A2';
  if (unitsPerIssue < sampleUnitSeeds.length) {
    throw new Error(`每期至少 ${sampleUnitSeeds.length} 个单元才能容纳样刊的手写单元`);
  }
  const now = options.now ?? new Date('2026-10-24T00:00:00.000Z');
  const issueSeeds: ProjectIssueSeed[] = [];
  for (let issueIndex = 0; issueIndex < issues; issueIndex++) {
    const units: ProjectUnitSeed[] = [];
    if (issueIndex === 0) {
      units.push(...sampleUnitSeeds);
    } else {
      for (let unitIndex = 0; unitIndex < unitsPerIssue; unitIndex++) units.push(recycledSeed(issueIndex, unitIndex));
    }
    while (units.length < unitsPerIssue) units.push(recycledSeed(issueIndex, units.length));
    issueSeeds.push({
      title: issueIndex === 0 ? '第一期 · 一杯咖啡' : `第 ${issueIndex + 1} 期 · 规模复现`,
      summary: issueIndex === 0
        ? '温度、价格和安静的早晨：三个短单元，一个能读完的小专题。'
        : `合成规模夹具的第 ${issueIndex + 1} 期：只验证引擎与存储，不承诺编辑质量。`,
      units,
    });
  }

  const built = buildEditionProject({
    lexiconYaml,
    cefr,
    title: '规模夹具 · 咖啡与城市生活',
    subtitle: 'Scale fixture',
    description: `${issues} 期 × ${unitsPerIssue} 单元的合成项目，用于规模、体积与恢复测试。`,
    issues: issueSeeds,
    spec: { ...sampleSpec(), cefr, targetIssues: issues, unitsPerIssue },
    now,
    allowedCharacters: ['shopkeeper', 'cat', 'guide'],
  });
  return { ...built, measurement: measureProject(built) };
}

/** 体积测量：只统计会被安装/导出/持久化的那部分，不把临时值算进去。 */
export function measureProject(project: BuiltProject): ScaleMeasurement {
  const scenes = project.units.reduce((sum, unit) => sum + unit.batch.scenes.length, 0);
  const packageBytes = project.installs.map((install) => JSON.stringify(install.package).length);
  return {
    issues: project.releases.length,
    units: project.units.length,
    scenes,
    issuePackageBytes: packageBytes[0] ?? 0,
    packageBytes: Math.max(...packageBytes, 0),
    packagesBytes: packageBytes.reduce((sum, size) => sum + size, 0),
    unitsBytes: project.units.reduce((sum, unit) => sum + JSON.stringify(unit).length, 0),
  };
}
