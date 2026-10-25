/**
 * 来源准入、权利闭包与抓取安全（设计文档 §4、§5）。
 *
 * 本文件只放**纯函数与数据规则**：没有 HTTP、没有文件系统、没有 LLM。
 * 抓取器必须独立于模型，因此这里给出的是抓取器「必须拒绝什么」的判定，
 * 真正的 socket 固定与 DNS 校验在 `apps/api` 侧执行，但判定逻辑只有一份。
 */
import { z } from 'zod';
import { digestOf, normalizeForDigest } from './digest.js';
import { EditionRefSchema } from './contract.js';

export const RIGHTS_POLICY_VERSION = 'rights-policy-v1' as const;
export const SOURCE_EXTRACTOR_VERSION = 'edition-extractor-1' as const;
export const SPAN_INDEX_VERSION = 'unicode-codepoint-1' as const;

// ---------- 4.1 权利策略 ----------

/**
 * 首版只接受自有、明确公有领域或 CC0。CC BY / BY-SA / NC / ND 一律不进入正式语料：
 * 它们不是「差一点」，而是需要署名、传染性、用途限制或禁止改编的独立义务。
 */
export const acceptedLicenses = ['own-work', 'public-domain', 'cc0-1.0'] as const;
export type AcceptedLicense = (typeof acceptedLicenses)[number];

export const rejectedLicenses = ['cc-by-4.0', 'cc-by-sa-4.0', 'cc-by-nc-4.0', 'cc-by-nd-4.0', 'unknown'] as const;

export const RightsUse = z.enum(['publish', 'adapt', 'export']);
export type RightsUse = z.infer<typeof RightsUse>;

export const RightsDecisionSchema = z.object({
  id: EditionRefSchema,
  sourceId: EditionRefSchema,
  decision: z.enum(['pending', 'approved', 'rejected', 'suspended']),
  licenseIdentifier: z.string().min(1).max(60),
  licenseVersion: z.string().max(20).nullable(),
  licenseUrl: z.string().url().nullable(),
  /** 许可证据（原文摘录或人工审核记录引用）。模型建议与网页自述不能冒充证据。 */
  licenseEvidenceText: z.string().max(2000).nullable(),
  licenseEvidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  rightsScope: z.enum(['full-text', 'excerpt', 'facts-only']),
  jurisdiction: z.string().min(2).max(40),
  allowedUses: z.array(RightsUse).max(3),
  exclusions: z.array(z.string().max(200)).max(20),
  /** 审核者：`editor:<name>` / `owner`；`model` 永远不能推进状态。 */
  reviewer: z.string().min(1).max(80),
  reviewedAt: z.string().datetime().nullable(),
  reason: z.string().min(1).max(500),
  policyVersion: z.literal(RIGHTS_POLICY_VERSION),
});
export type RightsDecision = z.infer<typeof RightsDecisionSchema>;

export interface RightsCheck { ok: boolean; code: string; message: string }

/** 权利准入判定：许可、用途、证据、审核者四项都满足才算 approved 可用。 */
export function checkRights(decision: RightsDecision, use: RightsUse): RightsCheck {
  if (decision.policyVersion !== RIGHTS_POLICY_VERSION) {
    return { ok: false, code: 'E-RIGHTS-POLICY', message: '权利记录来自其他政策版本，不能用于新发布' };
  }
  if (decision.decision !== 'approved') {
    return { ok: false, code: 'E-RIGHTS-STATUS', message: `权利状态为 ${decision.decision}，不能用于${use}` };
  }
  if (!(acceptedLicenses as readonly string[]).includes(decision.licenseIdentifier)) {
    return { ok: false, code: 'E-RIGHTS-LICENSE', message: `许可 ${decision.licenseIdentifier} 不在首版准入清单` };
  }
  if (!decision.allowedUses.includes(use)) {
    return { ok: false, code: 'E-RIGHTS-SCOPE', message: `权利范围不含 ${use}` };
  }
  if (!decision.reviewer || decision.reviewer === 'model' || !decision.reviewedAt) {
    return { ok: false, code: 'E-RIGHTS-REVIEW', message: '缺少人工审核记录；模型单独判定不能推进权利状态' };
  }
  if (!decision.licenseEvidenceDigest && !decision.licenseEvidenceText) {
    return { ok: false, code: 'E-RIGHTS-EVIDENCE', message: '缺少许可证据；网页自述不是授权' };
  }
  return { ok: true, code: 'OK', message: '权利记录允许该用途' };
}

// ---------- 4.2 来源状态机 ----------

export const SourceStatus = z.enum([
  'discovered', 'screened', 'fetched', 'extracted', 'rights_pending', 'approved', 'rejected', 'suspended',
]);
export type SourceStatus = z.infer<typeof SourceStatus>;

const sourceTransitions: Record<SourceStatus, readonly SourceStatus[]> = {
  discovered: ['screened'],
  screened: ['fetched'],
  fetched: ['extracted'],
  extracted: ['rights_pending'],
  rights_pending: ['approved', 'rejected', 'suspended'],
  approved: ['suspended'],
  rejected: [],
  suspended: ['approved'],
};

export function canTransitionSource(from: SourceStatus, to: SourceStatus): boolean {
  return sourceTransitions[from].includes(to);
}

/** 已知预授权来源可以先核验权利再抓取；其他来源只能做获准的最小检查。 */
export const preauthorizedLicenses: readonly string[] = ['own-work', 'public-domain', 'cc0-1.0'];

export function requiresRightsBeforeFetch(licenseIdentifier: string): boolean {
  return !preauthorizedLicenses.includes(licenseIdentifier);
}

/**
 * 撤销审核不会删除旧出版依据：停止新发布并给出受影响 Release 清单，
 * 是否下线由用户决定，不能无提示删除已安装内容或学习依据。
 */
export function revocationImpact(
  revokedSourceIds: readonly string[],
  releases: readonly { id: string; issueId: string; cefr: string; sourceIds: readonly string[] }[],
) {
  const revoked = new Set(revokedSourceIds);
  const affected = releases.filter((release) => release.sourceIds.some((id) => revoked.has(id)));
  return {
    affected: affected.map((release) => ({ releaseId: release.id, issueId: release.issueId, cefr: release.cefr })),
    blockNewPublication: true as const,
    removeInstalled: false as const,
  };
}

// ---------- 4.4 抓取器限额与地址校验 ----------

/** 首版建议参数：解压后 2 MiB、提取文本 100,000 字符、20 秒、3 次重定向、每主机 2 秒 1 次。 */
export const FETCH_LIMITS = {
  version: 'edition-fetch-1',
  maxDecodedBytes: 2 * 1024 * 1024,
  maxTextCharacters: 100_000,
  timeoutMs: 20_000,
  maxRedirects: 3,
  hostIntervalMs: 2_000,
  allowedPorts: [443] as readonly number[],
  allowedContentTypes: ['text/html', 'text/plain', 'text/markdown', 'application/xhtml+xml'] as readonly string[],
} as const;

export interface FetchTarget { protocol: 'https:'; host: string; port: 443; path: string }

/** 保留 / 私网 / 链路本地 / 元数据地址：IPv4 与 IPv6 都拦。 */
export function isBlockedAddress(address: string): boolean {
  const raw = address.trim().toLowerCase();
  if (!raw) return true;
  if (raw.includes(':')) return isBlockedIpv6(raw);
  const parts = raw.split('.');
  if (parts.length !== 4) return true;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播 / 保留 / 广播
  return false;
}

/** 把 IPv6 文本（含压缩、内嵌 IPv4、扩展前导零）规范化为 16 字节；解析失败返回 null。 */
function parseIpv6Bytes(address: string): number[] | null {
  const bare = address.replace(/^\[|\]$/g, '');
  if (!bare || bare.length > 45) return null;
  const halves = bare.split('::');
  if (halves.length > 2) return null;
  const expandTail = (group: string): string[] | null => {
    if (!group.includes('.')) return group ? group.split(':') : [];
    const parts = group.split(':');
    const v4 = parts.pop()!.split('.');
    if (v4.length !== 4) return null;
    const octets = v4.map((part) => Number(part));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    return [...parts, (octets[0]! << 8 | octets[1]!).toString(16), (octets[2]! << 8 | octets[3]!).toString(16)];
  };
  const left = expandTail(halves[0]!);
  if (left === null) return null;
  let hextets: string[];
  if (halves.length === 2) {
    const right = expandTail(halves[1]!);
    if (right === null || left.length + right.length >= 8) return null;
    hextets = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right];
  } else {
    if (left.length !== 8) return null;
    hextets = left;
  }
  const bytes: number[] = [];
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null;
    const value = parseInt(hextet, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

/** 私网 / 保留 / 内嵌 IPv4 的 IPv6 一律拦截；无法解析的地址也拦。 */
function isBlockedIpv6(address: string): boolean {
  const bytes = parseIpv6Bytes(address);
  if (!bytes) return true;
  const hextet = (index: number) => bytes[index * 2]! << 8 | bytes[index * 2 + 1]!;
  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true; // ::1
  // IPv4 映射 / 兼容：前 10 字节为 0，按内嵌 IPv4 规则判断
  if (bytes.slice(0, 10).every((byte) => byte === 0)) {
    if (bytes[10] === 0xff && bytes[11] === 0xff) {
      return isBlockedAddress([bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!].join('.'));
    }
    if (hextet(6) !== 0 || hextet(7) !== 0) {
      return isBlockedAddress([bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!].join('.'));
    }
  }
  const first = hextet(0);
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true; // 链路本地 fe80::/10、站点本地 fec0::/10
  if (first === 0x64 && hextet(1) === 0xff9b) return true; // NAT64 64:ff9b::/96
  if (first === 0x2001 && hextet(1) === 0x0db8) return true; // 文档保留 2001:db8::/32
  if (first === 0x2001 && hextet(1) === 0x0000) return true; // Teredo 2001::/32
  if (first === 0x2002) return true; // 6to4 2002::/16 内嵌 IPv4
  if (bytes[0] === 0xff) return true; // 组播 ff00::/8
  if (first === 0x0100) return true; // discard 100::/64
  return false;
}

/**
 * 抓取前的 URL 校验：只允许预配置主机的 HTTPS + 443，拒绝用户信息、非 HTTP 协议、
 * IP 字面量、内网与本机地址。返回解析结果或安全错误码。
 */
export function assertFetchTarget(rawUrl: string, allowedHosts: readonly string[]):
  { ok: true; target: FetchTarget } | { ok: false; code: string; message: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: 'E-FETCH-URL', message: 'URL 无法解析' };
  }
  if (url.protocol !== 'https:') return { ok: false, code: 'E-FETCH-PROTOCOL', message: '只允许 HTTPS' };
  if (url.username || url.password) return { ok: false, code: 'E-FETCH-USERINFO', message: 'URL 不能包含用户信息' };
  if (url.port && !FETCH_LIMITS.allowedPorts.includes(Number(url.port))) {
    return { ok: false, code: 'E-FETCH-PORT', message: '只允许默认 443 端口' };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    return { ok: false, code: 'E-FETCH-IP-LITERAL', message: '不接受 IP 字面量主机' };
  }
  const allowed = allowedHosts.map((entry) => entry.toLowerCase());
  const matches = allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!matches) return { ok: false, code: 'E-FETCH-HOST', message: '主机不在预配置清单' };
  // 域名只拦截本机/内部命名空间；解析后的 IP 由 `assertFetchRedirect` 逐跳检查
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, code: 'E-FETCH-PRIVATE', message: '目标是本机或内部域名' };
  }
  return { ok: true, target: { protocol: 'https:', host, port: 443, path: `${url.pathname}${url.search}` } };
}

/** 每一跳重新做协议 / 域名 / DNS / 目标 IP 校验；连接固定在已校验 IP 上，Host/SNI 保持原域名。 */
export function assertFetchRedirect(
  from: string,
  to: string,
  allowedHosts: readonly string[],
  resolvedAddresses: readonly string[],
): { ok: true } | { ok: false; code: string; message: string } {
  const target = assertFetchTarget(to, allowedHosts);
  if (!target.ok) return target;
  if (!resolvedAddresses.length) return { ok: false, code: 'E-FETCH-DNS', message: 'DNS 未返回地址' };
  const blocked = resolvedAddresses.filter((address) => isBlockedAddress(address));
  if (blocked.length) return { ok: false, code: 'E-FETCH-DNS-PRIVATE', message: 'DNS 结果包含私网/保留地址' };
  void from;
  return { ok: true };
}

/** 网页正文永远是不可信数据：脚本、工具命令与「忽略前文」都不能成为指令。 */
export function isUntrustedContentType(contentType: string): boolean {
  return !FETCH_LIMITS.allowedContentTypes.some((allowed) => contentType.toLowerCase().startsWith(allowed));
}

// ---------- 5.1 不可变资料快照 ----------

export const SourceSnapshotSchema = z.object({
  id: EditionRefSchema,
  sourceId: EditionRefSchema,
  title: z.string().min(1).max(300),
  canonicalUrl: z.string().url(),
  finalUrl: z.string().url(),
  retrievedAt: z.string().datetime(),
  extractorVersion: z.literal(SOURCE_EXTRACTOR_VERSION),
  spanIndexVersion: z.literal(SPAN_INDEX_VERSION),
  encoding: z.string().min(1).max(40),
  /** 提取后的规范文本：运行时不回访 URL，网页更新产生新 snapshot。 */
  text: z.string().min(1).max(100_000),
  textDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  paragraphCount: z.number().int().positive(),
});
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;

/** 码点切片：不混用 JavaScript UTF-16 下标。 */
export function codepointSlice(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join('');
}

export function codepointLength(text: string): number {
  return [...text].length;
}

export const SourceSpanSchema = z.object({
  id: EditionRefSchema,
  snapshotId: EditionRefSchema,
  paragraph: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  /** 原文摘录摘要：用于“最终显示的是被审核的那一段”的可验证绑定。 */
  excerptDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  excerpt: z.string().min(1).max(2000),
  spanIndexVersion: z.literal(SPAN_INDEX_VERSION),
});
export type SourceSpan = z.infer<typeof SourceSpanSchema>;

export function makeSpan(snapshot: SourceSnapshot, id: string, paragraph: number, start: number, end: number): SourceSpan {
  const excerpt = codepointSlice(snapshot.text, start, end);
  return {
    id, snapshotId: snapshot.id, paragraph, start, end,
    excerpt, excerptDigest: digestOf(excerpt), spanIndexVersion: SPAN_INDEX_VERSION,
  };
}

export function assertSpanWithinSnapshot(snapshot: SourceSnapshot, span: SourceSpan): void {
  if (span.snapshotId !== snapshot.id) throw new Error('片段不属于该快照');
  const length = codepointLength(snapshot.text);
  if (span.start < 0 || span.end <= span.start || span.end > length) throw new Error('片段范围越界');
  if (codepointSlice(snapshot.text, span.start, span.end) !== span.excerpt) throw new Error('片段摘录与快照正文不一致');
  if (digestOf(span.excerpt) !== span.excerptDigest) throw new Error('片段摘要不匹配');
}

/** 镜像 / 重定向 / 重复抓取识别为同一候选，不冒充多个独立证据。 */
export function duplicateSnapshotGroups(snapshots: readonly SourceSnapshot[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const snapshot of snapshots) {
    const key = digestOf(normalizeForDigest(snapshot.text).toLowerCase());
    groups.set(key, [...(groups.get(key) ?? []), snapshot.id]);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}

// ---------- 5.2 主张 ----------

export const ClaimRevisionSchema = z.object({
  id: EditionRefSchema,
  revisionId: z.string().min(1).max(80),
  statement: z.string().min(1).max(600),
  sourceSpanIds: z.array(EditionRefSchema).min(1).max(12),
  claimType: z.enum(['fact', 'attributed_opinion', 'language_usage']),
  /** 限定条件：不能省去原文的“通常、可能、某地区、某年份”。 */
  qualifiers: z.array(z.string().max(120)).max(12),
  timeScope: z.string().max(120).nullable(),
  locationScope: z.string().max(120).nullable(),
  uncertainty: z.enum(['certain', 'usually', 'sometimes', 'contested']),
  reviewStatus: z.enum(['draft', 'approved', 'disputed', 'rejected']),
  reviewer: z.string().max(80).nullable(),
  reviewedAt: z.string().datetime().nullable(),
  reviewPolicyVersion: z.literal(RIGHTS_POLICY_VERSION),
});
export type ClaimRevision = z.infer<typeof ClaimRevisionSchema>;

/** 有冲突的材料进入 disputed，模型不能随便选一边当确定事实。 */
export function conflictingClaims(claims: readonly ClaimRevision[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const claim of claims.filter((entry) => entry.claimType === 'fact')) {
    const key = normalizeForDigest(claim.statement).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), claim.id]);
  }
  const disputed = claims.filter((claim) => claim.reviewStatus === 'disputed').map((claim) => claim.id);
  return [[...groups.values()].filter((ids) => ids.length > 1).flat(), ...(disputed.length ? [disputed] : [])].filter((ids) => ids.length);
}

// ---------- 5.3 分级正文资产 ----------

export const PassageSegmentSchema = z.object({
  text: z.string().min(1).max(2000),
  claimRevisionIds: z.array(EditionRefSchema).max(12),
  sourceSpanIds: z.array(EditionRefSchema).max(12),
  /** original = 原文引用；adapted = 按等级改写；translated = 其他语言；teaching = 自有教学文字 */
  adaptationKind: z.enum(['original', 'adapted', 'translated', 'teaching']),
});
export type PassageSegment = z.infer<typeof PassageSegmentSchema>;

export const PassageRevisionSchema = z.object({
  id: EditionRefSchema,
  revisionId: z.string().min(1).max(80),
  cefr: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']),
  title: z.string().min(1).max(160),
  textSegments: z.array(PassageSegmentSchema).min(1).max(24),
  languagePackRevisionId: EditionRefSchema,
  difficultyReport: z.object({
    policyVersion: z.string().min(1),
    totalTokens: z.number().int().nonnegative(),
    oovTokens: z.number().int().nonnegative(),
    oovRatio: z.number().min(0).max(1),
    longestSentenceWords: z.number().int().nonnegative(),
    status: z.enum(['ok', 'warn', 'blocked']),
  }).nullable(),
  semanticReview: z.object({
    reviewer: z.string().min(1).max(80),
    reviewedAt: z.string().datetime(),
    status: z.enum(['pending', 'approved', 'rejected']),
    /** 语料忠实度不是哈希能保证的：保留人工结论与备注。 */
    note: z.string().max(600),
  }),
  rightsBindings: z.array(EditionRefSchema).min(1).max(12),
});
export type PassageRevision = z.infer<typeof PassageRevisionSchema>;

export function passageText(passage: PassageRevision): string {
  return passage.textSegments.map((segment) => segment.text).join(' ');
}

// ---------- 5.4 冻结语料 ----------

export const CorpusRevisionSchema = z.object({
  id: EditionRefSchema,
  revisionId: z.string().min(1).max(80),
  frozenAt: z.string().datetime(),
  sourceIds: z.array(EditionRefSchema).min(1).max(200),
  snapshotIds: z.array(EditionRefSchema).max(200),
  spans: z.array(SourceSpanSchema).max(2000),
  claims: z.array(ClaimRevisionSchema).max(2000),
  passages: z.array(PassageRevisionSchema).max(500),
  rightsDecisionIds: z.array(EditionRefSchema).min(1).max(400),
  approvedBy: z.string().min(1).max(80),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type CorpusRevision = z.infer<typeof CorpusRevisionSchema>;

/** 语料闭包：每个片段指向快照、每个主张指向片段、每段正文指向主张与权利。 */
export function corpusClosureIssues(corpus: CorpusRevision, rights: readonly RightsDecision[]): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  const snapshots = new Set(corpus.snapshotIds);
  const spans = new Map(corpus.spans.map((span) => [span.id, span]));
  const claims = new Map(corpus.claims.map((claim) => [claim.id, claim]));
  const decisions = new Map(rights.map((decision) => [decision.id, decision]));
  for (const span of corpus.spans) {
    if (!snapshots.has(span.snapshotId)) issues.push({ code: 'E-CORPUS-SPAN', message: `片段 ${span.id} 指向未冻结的快照` });
  }
  for (const claim of corpus.claims) {
    if (!claim.sourceSpanIds.length || claim.sourceSpanIds.some((id) => !spans.has(id))) {
      issues.push({ code: 'E-CORPUS-CLAIM', message: `主张 ${claim.id} 的来源片段缺失` });
    }
    if (claim.reviewStatus !== 'approved') {
      issues.push({ code: 'E-CORPUS-CLAIM-REVIEW', message: `主张 ${claim.id} 未通过审阅（${claim.reviewStatus}）` });
    }
  }
  for (const passage of corpus.passages) {
    if (passage.semanticReview.status !== 'approved') {
      issues.push({ code: 'E-CORPUS-PASSAGE-REVIEW', message: `正文 ${passage.id} 未通过语义审阅` });
    }
    if (!passage.rightsBindings.length) issues.push({ code: 'E-CORPUS-RIGHTS', message: `正文 ${passage.id} 缺少权利绑定` });
    for (const id of passage.rightsBindings) {
      const decision = decisions.get(id);
      if (!decision) { issues.push({ code: 'E-CORPUS-RIGHTS', message: `正文 ${passage.id} 绑定了不存在的权利决策` }); continue; }
      const check = checkRights(decision, 'adapt');
      if (!check.ok) issues.push({ code: check.code, message: `${passage.id}：${check.message}` });
    }
    for (const segment of passage.textSegments) {
      for (const claimId of segment.claimRevisionIds) {
        if (!claims.has(claimId)) issues.push({ code: 'E-CORPUS-PASSAGE', message: `${passage.id} 引用了未冻结的主张 ${claimId}` });
      }
      for (const spanId of segment.sourceSpanIds) {
        if (!spans.has(spanId)) issues.push({ code: 'E-CORPUS-PASSAGE', message: `${passage.id} 引用了未冻结的片段 ${spanId}` });
      }
      if (segment.adaptationKind !== 'teaching' && !segment.sourceSpanIds.length && !segment.claimRevisionIds.length) {
        issues.push({ code: 'E-CORPUS-ORIGIN', message: `${passage.id} 的纪实段落缺少来源映射` });
      }
    }
  }
  return issues;
}

export function corpusDigest(corpus: Omit<CorpusRevision, 'digest'>): string {
  return digestOf({
    revisionId: corpus.revisionId, frozenAt: corpus.frozenAt, sourceIds: corpus.sourceIds,
    snapshotIds: corpus.snapshotIds, spans: corpus.spans, claims: corpus.claims,
    passages: corpus.passages, rightsDecisionIds: corpus.rightsDecisionIds, approvedBy: corpus.approvedBy,
  });
}
