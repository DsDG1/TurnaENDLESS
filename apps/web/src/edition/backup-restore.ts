import { edition } from '@endless/content';
import type { EditionStore, InstalledIssue } from './storage.js';

export interface RestoreWrite {
  store: 'objects' | 'references' | 'installs' | 'runs' | 'eventChunks' | 'reviews' | 'projections' | 'management';
  key: string;
  value: unknown;
}

export interface ReaderRestorePlan {
  expectedRevision: number;
  editions: string[];
  writes: RestoreWrite[];
  result: { installs: number; runs: number; skipped: number; ignored: string[] };
}

/** All hashing, graph validation and replay finish before the single write transaction. */
export function prepareReaderRestore(
  current: EditionStore,
  text: string,
  trustReviewed: boolean,
  now = new Date(),
): ReaderRestorePlan {
  const parsed = edition.parseContainer(text);
  // 信任根必须来自本地已知集合：文件自己声明的 trustRoot 不能当作证据
  const knownRoots: readonly string[] = ['local'];
  const trustRoot = parsed.manifest.trustRoot;
  const knownRoot = knownRoots.includes(trustRoot);
  if (trustReviewed && !knownRoot) {
    throw new Error(`未知信任根（${trustRoot}）；已隔离，需人工审阅来源与授权后再导入`);
  }
  // 与 importContainer 的去重键一致：`type:id`；Run 不走去重，走事件前缀合并。
  const existing = new Map<string, string>();
  for (const pkg of current.packages) {
    existing.set(`install:${pkg.release.id}`, edition.digestOf(pkg));
    existing.set(`pack:${pkg.pack.id}`, edition.digestOf(pkg.pack));
  }
  for (const review of current.reviews) existing.set(`review:${review.id}`, edition.digestOf(review));
  for (const row of current.management) existing.set(`management:${row.id}`, edition.digestOf(row));
  const imported = edition.importContainer(text, {
    existing, accept: ['edition-backup/1'],
    trustedRoots: trustReviewed && knownRoot ? [trustRoot] : [],
  });
  if (imported.issues.length) throw new Error(imported.issues.map((issue) => issue.message).join('；'));
  const unsupported = imported.accepted.filter((record) => !['install', 'pack', 'run', 'review', 'management'].includes(record.type));
  if (unsupported.length) throw new Error('此备份含仅供编纂的对象；当前入口只恢复已安装的阅读备份，不会丢弃未支持的数据');
  const packages = imported.accepted.filter((record) => record.type === 'install')
    .map((record) => record.body as edition.EditionPublicationPackage);
  const reviews = imported.accepted.filter((record) => record.type === 'review')
    .map((record) => edition.ReviewRevisionSchema.parse(record.body));
  const management = imported.accepted.filter((record) => record.type === 'management')
    .map((record) => edition.ReaderManagementSchema.parse(record.body));
  const runMap = new Map(current.runs.map((run) => [run.id, edition.readerRun(run)]));
  const changedRuns: edition.EditionRun[] = [];
  let skippedRuns = 0;
  for (const record of imported.accepted.filter((entry) => entry.type === 'run')) {
    const incoming = edition.readerRun(record.body as edition.EditionRun);
    const previous = runMap.get(incoming.id);
    const merged = previous ? edition.mergeReaderRun(previous, incoming) : incoming;
    runMap.set(merged.id, merged);
    if (previous && edition.canonicalJson(merged) === edition.canonicalJson(previous)) skippedRuns += 1;
    else changedRuns.push(merged);
  }
  const allPackages = [...current.packages, ...packages];
  edition.assertReaderState(allPackages, [...runMap.values()], [...current.reviews, ...reviews]);
  for (const record of imported.accepted.filter((entry) => entry.type === 'pack')) {
    if (!allPackages.some((pkg) => pkg.pack.id === record.id && edition.digestOf(pkg.pack) === record.digest)) {
      throw new Error('独立语言包与已安装期刊的语言包依据不一致');
    }
  }
  const writes = new Map<string, RestoreWrite>();
  const put = (store: RestoreWrite['store'], key: string, value: unknown) => {
    const mapKey = `${store}:${key}`;
    const previous = writes.get(mapKey);
    if (previous && edition.digestOf(previous.value) !== edition.digestOf(value)) throw new Error('备份内存在同 ID 异文');
    writes.set(mapKey, { store, key, value });
  };
  const object = (type: string, id: string, digest: string, body: unknown) => {
    const key = `${type}:${id}`;
    put('objects', key, { key, type, id, digest, body });
  };
  const at = now.toISOString();
  for (const pkg of packages) {
    const release = pkg.release;
    const installedAt = management.filter((row) => row.op === 'install' && row.targets.includes(release.id))
      .map((row) => row.at).sort()[0] ?? at;
    const install: InstalledIssue = {
      releaseId: release.id, issueId: release.issueId, editionId: release.editionId,
      editorialRevisionId: release.editorialRevisionId, cefr: release.cefr,
      packageDigest: pkg.digest, installedAt, supersededBy: release.supersededBy,
    };
    put('installs', release.id, install);
    object('package', release.id, pkg.digest, pkg);
    object('release', release.id, release.digest, release);
    object('pack', pkg.pack.id, pkg.pack.digest, pkg.pack);
    for (const unit of pkg.units) {
      const digest = edition.digestOf(unit.batch);
      object('unit', unit.revisionId, digest, unit);
      const key = `${release.id}:${unit.revisionId}`;
      put('references', key, { key, releaseId: release.id, unitId: unit.revisionId, digest });
    }
  }
  for (const run of changedRuns) {
    put('runs', run.id, { ...run, events: [], eventCount: run.events.length, prefixHash: edition.eventPrefixHash(run) });
    for (let start = 0; start < run.events.length; start += 128) {
      const index = start / 128;
      const key = `${run.id}:${String(index).padStart(6, '0')}`;
      put('eventChunks', key, { key, runId: run.id, index, events: run.events.slice(start, start + 128) });
    }
  }
  for (const review of reviews) put('reviews', review.id, review);
  for (const row of management) put('management', row.id, row);
  if (writes.size) {
    const id = `mge_import_${globalThis.crypto.randomUUID()}`;
    put('management', id, {
      id, at, op: 'import', targets: [...packages.map((pkg) => pkg.release.id), ...changedRuns.map((run) => run.id)].slice(0, 80),
      detail: `${packages.length} 个安装包，${changedRuns.length} 条阅读记录；原事件 ID 保留`,
    } satisfies edition.ReaderManagement);
  }
  return {
    expectedRevision: current.revision,
    editions: [...new Set(allPackages.map((pkg) => pkg.release.editionId))],
    writes: [...writes.values()],
    result: { installs: packages.length, runs: changedRuns.length, skipped: imported.skipped.length + skippedRuns, ignored: [] },
  };
}
