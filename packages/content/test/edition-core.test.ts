import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Batch } from '@endless/esl';
import { loadLexicon } from '@endless/learning';
import { edition } from '../src/index.js';

const lexiconText = readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
const loaded = loadLexicon(lexiconText).lexicon!;

function packOf(id: string) {
  return edition.buildLanguagePack({
    id,
    revisionId: 'pack-1',
    cefr: 'A2',
    frozenAt: '2026-10-24T00:00:00.000Z',
    entries: edition.packEntriesFromLexicon(loaded, 'A2'),
    functionWords: [...loaded.functionWords],
    rights: { basis: 'test', decisionId: null, note: '' },
  });
}

function rightsDecision(patch: Partial<edition.RightsDecision> = {}): edition.RightsDecision {
  const base: edition.RightsDecision = {
    id: 'rdc_00000000-0000-4000-8000-000000000000',
    sourceId: 'src_00000000-0000-4000-8000-000000000000',
    decision: 'approved',
    licenseIdentifier: 'own-work',
    licenseVersion: null,
    licenseUrl: null,
    licenseEvidenceText: '项目自有文本',
    licenseEvidenceDigest: null,
    rightsScope: 'full-text',
    jurisdiction: 'CN',
    allowedUses: ['publish', 'adapt', 'export'],
    exclusions: [],
    reviewer: 'owner',
    reviewedAt: '2026-10-24T00:00:00.000Z',
    reason: '自有内容',
    policyVersion: 'rights-policy-v1',
  };
  return { ...base, ...patch };
}

describe('Edition 摘要与规范化', () => {
  it('SHA-256 与 Node crypto 一致', () => {
    expect(edition.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const text of ['', '咖啡', 'a'.repeat(55), 'a'.repeat(56), 'x'.repeat(1000), '🙂 café']) {
      expect(edition.sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });

  it('规范 JSON 排序键、拒绝非有限值，摘要与键顺序无关', () => {
    expect(edition.canonicalJson({ b: 1, a: [2, 3] })).toBe('{"a":[2,3],"b":1}');
    expect(edition.digestOf({ b: 1, a: 2 })).toBe(edition.digestOf({ a: 2, b: 1 }));
    expect(edition.canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => edition.canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => edition.canonicalJson({ a: new Date() })).toThrow();
    expect(() => edition.canonicalJson({ a: 1n })).toThrow();
  });

  it('语境指纹忽略标点与大小写，但不同句子仍不同', () => {
    expect(edition.contextFingerprint('The coffee is hot.')).toBe(edition.contextFingerprint('the coffee is hot'));
    expect(edition.contextFingerprint('The coffee is hot.')).not.toBe(edition.contextFingerprint('The coffee is cold.'));
  });
});

describe('抓取安全（S01/S02/S03/S04）', () => {
  const hosts = ['example.com'];

  it('拒绝非 HTTPS、用户信息、端口、IP 字面量与清单外主机', () => {
    expect(edition.assertFetchTarget('http://example.com/a', hosts).ok).toBe(false);
    expect(edition.assertFetchTarget('https://user:pass@example.com/a', hosts).ok).toBe(false);
    expect(edition.assertFetchTarget('https://example.com:8443/a', hosts).ok).toBe(false);
    expect(edition.assertFetchTarget('https://127.0.0.1/a', hosts).ok).toBe(false);
    expect(edition.assertFetchTarget('https://evil.test/a', hosts).ok).toBe(false);
    expect(edition.assertFetchTarget('https://example.com/a', hosts).ok).toBe(true);
  });

  it('内网 / 元数据 / IPv6 保留地址一律阻断', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(edition.isBlockedAddress(address)).toBe(true);
    }
    expect(edition.isBlockedAddress('93.184.216.34')).toBe(false);
    expect(edition.assertFetchRedirect('https://example.com/a', 'https://example.com/b', hosts, ['10.0.0.1']).ok).toBe(false);
    expect(edition.assertFetchRedirect('https://example.com/a', 'http://example.com/b', hosts, ['93.184.216.34']).ok).toBe(false);
    expect(edition.assertFetchRedirect('https://example.com/a', 'https://example.com/b', hosts, ['93.184.216.34']).ok).toBe(true);
  });

  it('非法内容类型不会被当作正文', () => {
    expect(edition.isUntrustedContentType('image/png')).toBe(true);
    expect(edition.isUntrustedContentType('text/html; charset=utf-8')).toBe(false);
  });
});

describe('来源与权利（R01/R02/R04）', () => {
  it('只接受自有 / 公有领域 / CC0', () => {
    expect(edition.checkRights(rightsDecision(), 'publish').ok).toBe(true);
    const nc = edition.checkRights(rightsDecision({ licenseIdentifier: 'cc-by-nc-4.0' }), 'publish');
    expect(nc.ok).toBe(false);
    expect(nc.code).toBe('E-RIGHTS-LICENSE');
  });

  it('模型单独判定不能推进状态，缺证据也不行', () => {
    expect(edition.checkRights(rightsDecision({ reviewer: 'model' }), 'publish').code).toBe('E-RIGHTS-REVIEW');
    expect(edition.checkRights(rightsDecision({ licenseEvidenceText: null }), 'publish').code).toBe('E-RIGHTS-EVIDENCE');
    expect(edition.checkRights(rightsDecision({ decision: 'pending' }), 'publish').code).toBe('E-RIGHTS-STATUS');
    expect(edition.checkRights(rightsDecision({ allowedUses: ['publish'] }), 'export').code).toBe('E-RIGHTS-SCOPE');
  });

  it('撤销审核停新发布并列出影响面，不删已安装内容', () => {
    const impact = edition.revocationImpact(['src_a'], [
      { id: 'rel_a', issueId: 'iss_a', cefr: 'A2', sourceIds: ['src_a'] },
      { id: 'rel_b', issueId: 'iss_b', cefr: 'A2', sourceIds: ['src_b'] },
    ]);
    expect(impact.affected.map((entry) => entry.releaseId)).toEqual(['rel_a']);
    expect(impact.blockNewPublication).toBe(true);
    expect(impact.removeInstalled).toBe(false);
  });

  it('来源状态机只允许声明过的迁移', () => {
    expect(edition.canTransitionSource('discovered', 'screened')).toBe(true);
    expect(edition.canTransitionSource('discovered', 'approved')).toBe(false);
    expect(edition.canTransitionSource('approved', 'suspended')).toBe(true);
    expect(edition.canTransitionSource('rejected', 'approved')).toBe(false);
  });

  it('镜像/重复抓取识别为同一候选', () => {
    const snapshot = (id: string, text: string): edition.SourceSnapshot => ({
      id, sourceId: 'src_00000000-0000-4000-8000-000000000000', title: id,
      canonicalUrl: 'https://local.edition/a', finalUrl: 'https://local.edition/a',
      retrievedAt: '2026-10-24T00:00:00.000Z', extractorVersion: 'edition-extractor-1',
      spanIndexVersion: 'unicode-codepoint-1', encoding: 'utf-8',
      text, textDigest: edition.digestOf(text), paragraphCount: 1,
    });
    const groups = edition.duplicateSnapshotGroups([
      snapshot('snp_00000000-0000-4000-8000-000000000001', 'Same   text'),
      snapshot('snp_00000000-0000-4000-8000-000000000002', 'same text'),
    ]);
    expect(groups).toHaveLength(1);
  });
});

describe('语言分级与编辑编排（Q02/Q03）', () => {
  it('语言包自检、开放等级与 A2 目标', () => {
    const pack = packOf('lpk_00000000-0000-4000-8000-000000000001');
    expect(edition.languagePackIssues(pack)).toEqual([]);
    expect(edition.isOpenLevel('A2')).toBe(true);
    expect(edition.isOpenLevel('B1')).toBe(true);
    expect(edition.isOpenLevel('B2')).toBe(false);
    expect(pack.entries.length).toBeGreaterThan(100);
  });

  it('OOV 超阈值阻断，中文不进入分母', () => {
    const pack = packOf('lpk_00000000-0000-4000-8000-000000000002');
    const allowed = new Set(pack.baselineForms);
    const batch = {
      batch: 'b1', channel: 'edition', brief: 'x', cast: ['guide'],
      scenes: [{
        id: 's1', type: 'card', item: 'lx:hot#adj.temperature',
        front: 'the coffee is hot and plugh xyzzy frobnicate quux corge grault garply waldo fred plugh xyzzy',
        uses: ['lx:hot#adj.temperature'],
      }],
    } as unknown as Batch;
    const metrics = edition.measureDifficulty(batch, allowed, pack);
    expect(metrics.status).toBe('blocked');
    expect(edition.difficultyIssues(metrics, pack)[0]?.code).toBe('E-EDITION-OOV');
    const chinese = edition.measureDifficulty(
      { ...batch, scenes: [{ ...(batch.scenes[0] as object), front: '这是一句中文题干' }] } as unknown as Batch,
      allowed, pack,
    );
    expect(chinese.totalTokens).toBe(0);
  });

  it('依赖成环与顺序缺失会被拒绝', () => {
    const unit = (id: string, order: number, dependencyIds: string[]): edition.UnitPlan => ({
      id, order, title: id, role: 'introduce', goals: ['g'], conceptRefs: ['c'],
      dependencyIds, claimRefs: ['clm_00000000-0000-4000-8000-000000000001'], estimatedMinutes: 8,
    });
    const revision = {
      id: 'edr_00000000-0000-4000-8000-000000000001',
      editionId: 'edn_00000000-0000-4000-8000-000000000001',
      parentId: null, revision: 1,
      spec: {
        topic: 't', angles: [], exclusions: [], audience: 'a', cefr: 'A2',
        targetIssues: 1, unitsPerIssue: 2, minutesPerIssue: 20,
        preferences: [], sourcePolicy: 'local-pack-only', networkAuthorized: false,
      },
      corpusRevisionId: 'crp_00000000-0000-4000-8000-000000000001',
      issues: [{
        id: 'iss_00000000-0000-4000-8000-000000000001', order: 1, title: 'i', summary: 's',
        unitIds: ['unt_00000000-0000-4000-8000-000000000001', 'unt_00000000-0000-4000-8000-000000000002'],
        targetMinutes: 20, conceptScope: ['c'],
      }],
      units: [
        unit('unt_00000000-0000-4000-8000-000000000001', 1, ['unt_00000000-0000-4000-8000-000000000002']),
        unit('unt_00000000-0000-4000-8000-000000000002', 2, ['unt_00000000-0000-4000-8000-000000000001']),
      ],
      coverage: [
        { concept: 'c', issueId: 'iss_00000000-0000-4000-8000-000000000001', unitId: 'unt_00000000-0000-4000-8000-000000000001', angle: 'a1' },
        { concept: 'c2', issueId: 'iss_00000000-0000-4000-8000-000000000001', unitId: 'unt_00000000-0000-4000-8000-000000000002', angle: 'a2' },
      ],
      status: 'approved',
      capacity: { state: 'sufficient', supportedIssues: 1, requestedIssues: 1, gaps: [], suggestions: [] },
      approvedBy: 'owner', approvedAt: '2026-10-24T00:00:00.000Z', digest: '', createdAt: '2026-10-24T00:00:00.000Z',
    } as unknown as edition.EditorialRevision;
    const issues = edition.editorialPlanIssues(revision);
    expect(issues.some((issue) => issue.code === 'E-PLAN-CYCLE')).toBe(true);
  });

  it('资料不足返回 needs_sources，不承诺 20 期', () => {
    const corpus = {
      claims: [{
        id: 'clm_00000000-0000-4000-8000-000000000001', revisionId: 'c1', statement: 's',
        sourceSpanIds: ['spn_00000000-0000-4000-8000-000000000001'], claimType: 'fact',
        qualifiers: [], timeScope: null, locationScope: null, uncertainty: 'certain',
        reviewStatus: 'approved', reviewer: 'owner', reviewedAt: '2026-10-24T00:00:00.000Z',
        reviewPolicyVersion: 'rights-policy-v1',
      }],
      passages: [{
        id: 'psg_00000000-0000-4000-8000-000000000001', revisionId: 'p1', cefr: 'A2', title: 't',
        textSegments: [{
          text: 'text', claimRevisionIds: ['clm_00000000-0000-4000-8000-000000000001'],
          sourceSpanIds: ['spn_00000000-0000-4000-8000-000000000001'], adaptationKind: 'original',
        }],
        languagePackRevisionId: 'lpk_00000000-0000-4000-8000-000000000001',
        difficultyReport: null,
        semanticReview: { reviewer: 'owner', reviewedAt: '2026-10-24T00:00:00.000Z', status: 'approved', note: '' },
        rightsBindings: ['rdc_00000000-0000-4000-8000-000000000001'],
      }],
      spans: [{ id: 'spn_00000000-0000-4000-8000-000000000001' }],
    } as unknown as edition.CorpusRevision;
    const units: edition.UnitPlan[] = Array.from({ length: 10 }, (_, index) => ({
      id: `unt_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      order: index + 1, title: 'u', role: 'introduce', goals: [],
      conceptRefs: [`c${index}`], dependencyIds: [],
      claimRefs: ['clm_00000000-0000-4000-8000-000000000001'], estimatedMinutes: 8,
    }));
    const coverage: edition.CoverageEntry[] = units.map((unit, index) => ({
      concept: `c${index}`, issueId: 'iss_00000000-0000-4000-8000-000000000001', unitId: unit.id, angle: `a${index}`,
    }));
    const result = edition.checkCapacity({
      spec: {
        topic: 't', angles: [], exclusions: [], audience: 'a', cefr: 'A2', targetIssues: 20, unitsPerIssue: 10,
        minutesPerIssue: 30, preferences: [], sourcePolicy: 'local-pack-only', networkAuthorized: false,
      },
      corpus, coverage, units,
    });
    expect(result.state).toBe('needs_sources');
    expect(result.suggestions.length).toBeGreaterThan(1);
    expect(result.supportedIssues).toBeLessThan(20);
  });
});

describe('EDITION-DRAFT/1 解析（C04）', () => {
  it('拒绝 JSON、未知组件、缺 @end 与缺元数据', () => {
    expect(edition.parseEditionDraft('{"batch":"x"}').ok).toBe(false);
    expect(edition.parseEditionDraft('EDITION-DRAFT/1\n@title t\n@image x\n@end').ok).toBe(false);
    expect(edition.parseEditionDraft('EDITION-DRAFT/1\n@title t\n@subtitle s\n@description d\n@reading p1').ok).toBe(false);
    const missing = edition.parseEditionDraft('EDITION-DRAFT/1\n@subtitle s\n@description d\n@reading p1\n@end');
    expect(missing.ok).toBe(false);
  });

  it('@reading 不接受模型附加正文', () => {
    const parsed = edition.parseEditionDraft('EDITION-DRAFT/1\n@title t\n@subtitle s\n@description d\n@reading p1\nsome text\n@end');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.components[0]?.lines).toHaveLength(1);
  });
});
