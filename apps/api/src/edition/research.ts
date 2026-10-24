/**
 * 研究适配器（设计文档 §4.3、M3）。
 *
 * 只有用户明确启动研究任务时才发起网络访问；模型没有任意 fetch 权限。
 * 搜索服务单独配置：未配置就明确「不可用」，并提供已批准资料包导入，
 * 绝不假装已经搜索过。查询只包含主题/语言/授权条件，不含学习历史或凭据。
 */
import { edition } from '@endless/content';

type Cefr = edition.Cefr;
type EditionSpec = edition.EditionSpec;
const { assertFetchTarget } = edition;

export class SearchUnavailableError extends Error {
  constructor(message = '未配置搜索服务。可导入已批准的本地资料包，或先配置搜索适配器后再研究。') {
    super(message);
  }
}

export interface SourceQuery {
  topic: string;
  language: 'en';
  license: 'public-domain' | 'cc0-1.0' | 'own-work';
  exclusions: string[];
  /** 只用于过滤结果，不发给搜索服务。 */
  cefr: Cefr;
}

export interface SearchHit {
  url: string;
  title: string;
  snippet?: string;
  /** 搜索结果自述的授权信息：不可信，必须另行核验。 */
  licenseHint?: string | null;
}

export interface SearchAdapter {
  readonly name: string;
  available(): boolean;
  search(query: SourceQuery, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchHit[]>;
}

/**
 * 查询里的每一项都必须能被用户当面看到：主题、语言、授权条件与排除项。
 * 不带学习历史、笔记、凭据或 provider Key。
 */
export function buildSourceQuery(spec: Pick<EditionSpec, 'topic' | 'cefr' | 'exclusions'>, license: SourceQuery['license'] = 'public-domain'): SourceQuery {
  return {
    topic: spec.topic,
    language: 'en',
    license,
    exclusions: [...spec.exclusions],
    cefr: spec.cefr,
  };
}

/** 未配置搜索服务时的适配器：`available()` 为 false，调用即报错。 */
export class UnconfiguredSearchAdapter implements SearchAdapter {
  readonly name = 'unconfigured';
  available() { return false; }
  async search(): Promise<SearchHit[]> {
    throw new SearchUnavailableError();
  }
}

/** 已批准资料目录：把仓库内/人工核验的条目当作「搜索结果」，用于离线流程与测试。 */
export class CatalogSearchAdapter implements SearchAdapter {
  readonly name = 'approved-catalog';
  constructor(private hits: readonly SearchHit[]) {}
  available() { return true; }
  async search(query: SourceQuery, options: { limit?: number } = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? 20;
    const excluded = query.exclusions.map((entry) => entry.toLowerCase());
    return this.hits
      .filter((hit) => !excluded.some((entry) => hit.title.toLowerCase().includes(entry)))
      .slice(0, limit);
  }
}

export interface SourcePolicy {
  /** 允许抓取的主机（预配置，不接受任意域名）。 */
  allowedHosts: readonly string[];
  /** 已核验的授权标识：只接受自有/公有领域/CC0。 */
  licenseEvidence: Readonly<Record<string, { license: string; licenseUrl: string | null; evidence: string }>>;
}

export interface ScreenedCandidate {
  url: string;
  title: string;
  state: 'screened';
  license: string;
  licenseUrl: string | null;
  evidence: string;
}

export interface RejectedCandidate {
  url: string;
  title: string;
  state: 'rejected' | 'rights_pending';
  code: string;
  reason: string;
}

export interface ScreenResult {
  candidates: ScreenedCandidate[];
  rejected: RejectedCandidate[];
  /** 同内容镜像合并后只剩一条独立证据。 */
  duplicates: number;
}

/**
 * 先筛查再抓取：未知授权、NC/ND、非预配置主机、非 HTTPS 一律不进入抓取队列。
 * 网页自称「无版权」但没有可核验证据时停在 rights_pending，不自动通过（R02）。
 */
export function screenCandidates(hits: readonly SearchHit[], policy: SourcePolicy): ScreenResult {
  const accepted: ScreenedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const hit of hits) {
    const target = assertFetchTarget(hit.url, policy.allowedHosts);
    if (!target.ok) {
      rejected.push({ url: hit.url, title: hit.title, state: 'rejected', code: target.code, reason: target.message });
      continue;
    }
    const evidence = policy.licenseEvidence[normalizeKey(hit.url)];
    if (!evidence) {
      const hint = (hit.licenseHint ?? '').toLowerCase();
      const looksFree = hint.includes('public domain') || hint.includes('cc0') || hint.includes('无版权') || hint.includes('free');
      rejected.push({
        url: hit.url, title: hit.title, state: 'rights_pending', code: 'R02',
        reason: looksFree
          ? '搜索结果自称可自由使用，但没有可核验的许可证据；停在 rights_pending，需人工核验'
          : '缺少许可证据，不能进入正式语料',
      });
      continue;
    }
    if (!['own-work', 'public-domain', 'cc0-1.0'].includes(evidence.license)) {
      rejected.push({
        url: hit.url, title: hit.title, state: 'rejected', code: 'R01',
        reason: `许可 ${evidence.license} 不在首版准入清单（只接受自有/公有领域/CC0）`,
      });
      continue;
    }
    const key = `${normalizeKey(hit.url)}|${evidence.evidence}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    accepted.push({
      url: hit.url, title: hit.title, state: 'screened',
      license: evidence.license, licenseUrl: evidence.licenseUrl, evidence: evidence.evidence,
    });
  }
  return { candidates: accepted, rejected, duplicates };
}

function normalizeKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

/** 研究任务结果：候选 + 拒绝原因 + 是否可用。没有搜索服务时明确返回不可用。 */
export interface ResearchOutcome {
  available: boolean;
  reason?: string;
  candidates: ScreenedCandidate[];
  rejected: RejectedCandidate[];
  duplicates: number;
}

export async function runResearch(
  adapter: SearchAdapter,
  input: { spec: Pick<EditionSpec, 'topic' | 'cefr' | 'exclusions'>; policy: SourcePolicy; license?: SourceQuery['license']; signal?: AbortSignal },
): Promise<ResearchOutcome> {
  if (!adapter.available()) {
    return {
      available: false,
      reason: '未配置搜索服务；可导入已批准的本地资料包，或先配置搜索适配器。',
      candidates: [], rejected: [], duplicates: 0,
    };
  }
  const query = buildSourceQuery(input.spec, input.license ?? 'public-domain');
  const hits = await adapter.search(query, { signal: input.signal });
  const screened = screenCandidates(hits, input.policy);
  return { available: true, ...screened };
}
