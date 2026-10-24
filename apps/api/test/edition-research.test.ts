import { describe, expect, it } from 'vitest';
import {
  CatalogSearchAdapter, UnconfiguredSearchAdapter, buildSourceQuery, runResearch, screenCandidates,
} from '../src/edition/research.js';

const policy = {
  allowedHosts: ['archive.example', 'texts.example'],
  licenseEvidence: {
    'archive.example/public-domain-piece': {
      license: 'public-domain',
      licenseUrl: 'https://archive.example/licence',
      evidence: '1972 年出版物，作者 1950 年去世；公有领域，已人工核验',
    },
    'texts.example/cc0-piece': {
      license: 'cc0-1.0', licenseUrl: null, evidence: 'CC0 1.0 声明页快照，已人工核验',
    },
    'archive.example/nc-piece': {
      license: 'cc-by-nc-4.0', licenseUrl: 'https://archive.example/nc', evidence: '禁商用',
    },
  },
} as const;

const hits = [
  { url: 'https://archive.example/public-domain-piece', title: 'Old essay' },
  { url: 'https://texts.example/cc0-piece', title: 'CC0 text' },
  { url: 'https://archive.example/nc-piece', title: 'NC essay' },
  { url: 'https://unknown.example/free', title: 'Free but unknown', licenseHint: 'no copyright, free to use' },
];

describe('研究适配器（M3 / R01–R02）', () => {
  it('未配置搜索服务时明确不可用，不假装搜索过', async () => {
    const outcome = await runResearch(new UnconfiguredSearchAdapter(), {
      spec: { topic: 'coffee', cefr: 'A2', exclusions: [] }, policy,
    });
    expect(outcome.available).toBe(false);
    expect(outcome.candidates).toEqual([]);
    expect(outcome.reason).toMatch(/未配置/);
  });

  it('R01：NC/ND 与未知主机不进入正式语料', () => {
    const result = screenCandidates(hits, policy);
    expect(result.candidates.map((entry) => entry.url)).toEqual([
      'https://archive.example/public-domain-piece',
      'https://texts.example/cc0-piece',
    ]);
    const nc = result.rejected.find((entry) => entry.url.includes('nc-piece'));
    expect(nc?.code).toBe('R01');
    const unknown = result.rejected.find((entry) => entry.url.includes('unknown.example'));
    expect(unknown?.code).toBe('E-FETCH-HOST');
  });

  it('R02：网页自称无版权但没有证据 → rights_pending', () => {
    const result = screenCandidates(
      [{ url: 'https://archive.example/unlisted', title: 'Says free', licenseHint: 'public domain' }],
      policy,
    );
    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ state: 'rights_pending', code: 'R02' });
  });

  it('镜像与重复抓取合并为一条独立证据', () => {
    const mirrored = [
      { url: 'https://archive.example/public-domain-piece', title: 'Old essay' },
      { url: 'https://archive.example/public-domain-piece/', title: 'Old essay (mirror)' },
    ];
    const result = screenCandidates(mirrored, policy);
    expect(result.candidates).toHaveLength(1);
    expect(result.duplicates).toBe(1);
  });

  it('查询只含主题/语言/授权条件，不含学习历史或凭据', () => {
    const query = buildSourceQuery({ topic: 'coffee', cefr: 'A2', exclusions: ['medical'] });
    expect(Object.keys(query).sort()).toEqual(['cefr', 'exclusions', 'language', 'license', 'topic']);
    expect(JSON.stringify(query)).not.toMatch(/api[_-]?key|token|history|note/i);
  });

  it('已批准资料目录可以离线跑完整研究流程', async () => {
    const adapter = new CatalogSearchAdapter(hits);
    const outcome = await runResearch(adapter, {
      spec: { topic: 'coffee', cefr: 'A2', exclusions: [] }, policy,
    });
    expect(outcome.available).toBe(true);
    expect(outcome.candidates).toHaveLength(2);
  });

  it('只差 query 的 URL 不能继承同一份许可证据', () => {
    const result = screenCandidates([
      { url: 'https://archive.example/public-domain-piece', title: '已核验' },
      { url: 'https://archive.example/public-domain-piece?page=unreviewed', title: '未核验的变体' },
    ], policy);
    expect(result.candidates.map((entry) => entry.url)).toEqual(['https://archive.example/public-domain-piece']);
    expect(result.rejected.map((entry) => entry.url)).toContain('https://archive.example/public-domain-piece?page=unreviewed');
  });
});
