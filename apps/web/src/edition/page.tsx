import { useMemo, useState } from 'react';
import { getOptions, getScenes, type SceneProgress } from '@endless/player';
import { edition } from '@endless/content';
import { Icon } from '../components/icons.js';
import { SceneRenderer } from '../components/scenes.js';
import { SAMPLE_PUBLICATION, useEditionStore } from './use-edition.js';

const download = (text: string, name: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/**
 * Edition 书架 + 阅读器（设计文档 §15）。
 *
 * 和 ENDLESS 的关系：独立入口、独立存储、独立学习记录；不读写 `endless-workspace`，
 * 也不把 Edition 的阅读算进 ENDLESS 的进度。
 */
export function EditionPage() {
  const local = useEditionStore();
  const packages = local.store?.packages ?? [];
  // 只保存 ID；Run / 复习修订对象从最新 store 派生，跨标签页落库后自动更新阅读器。
  const [runId, setRunId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [unitIndex, setUnitIndex] = useState(0);
  const [reading, setReading] = useState(false);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);

  const run = useMemo(() => local.store?.runs.find((entry) => entry.id === runId) ?? null, [local.store, runId]);
  const review = useMemo(() => local.store?.reviews.find((entry) => entry.id === reviewId) ?? null, [local.store, reviewId]);
  const install = useMemo(() => {
    const releaseId = selectedReleaseId ?? run?.adoptedReleases[0]?.releaseId;
    return packages.find((entry) => entry.release.id === releaseId) ?? null;
  }, [packages, run, selectedReleaseId]);
  const installs = useMemo(() => packages.map((pkg) => ({ release: pkg.release, package: pkg })), [packages]);
  const reviews = useMemo(() => [
    ...(local.store?.reviews ?? []).filter((entry) => entry.runId === run?.id && entry.id !== review?.id), ...(review ? [review] : []),
  ], [local.store?.reviews, review, run?.id]);

  const built = useMemo((): { library: ReturnType<typeof edition.runLibrary>; projection: edition.RunProjection } | { error: string } | null => {
    if (!install || !run) return null;
    try {
      return {
        library: edition.runLibrary(run, installs, reviews),
        projection: edition.projectRun(run, installs, reviews),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : '无法重建阅读进度' };
    }
  }, [install, installs, reviews, run]);
  const library = built && 'library' in built ? built.library : null;
  const projection = built && 'projection' in built ? built.projection : null;
  const projectionError = built && 'error' in built ? built.error : '';

  const unit = install?.units[unitIndex] ?? null;
  const episodeId = review ? review.id : unit?.revisionId;
  const episode = library?.episodes.find((entry) => entry.id === episodeId) ?? null;
  const scenes = episode ? getScenes(episode) : [];
  const cursor = projection?.view.episodes[episode?.id ?? '']?.cursor ?? 0;
  const scene = scenes[cursor] ?? null;
  const state: SceneProgress = episode && scene ? projection?.view.episodes[episode.id]?.scenes[scene.id] ?? {} : {};

  const installSample = () => local.run(
    (repo) => repo.activateInstall(SAMPLE_PUBLICATION, local.store?.revision ?? 0),
    '样刊已安装到本机，断网也能读。',
  );

  const importBackup = async (file: File) => {
    if (file.size > edition.CONTAINER_LIMITS.maxTotalBytes) {
      local.setError('阅读备份超过导入体积上限；原有内容未被修改');
      return;
    }
    if (!window.confirm('仅导入你自己导出或已人工核验来源与授权的阅读备份。文件中的 local 标签和摘要不能证明其可信。确认信任此备份并继续？')) return;
    const text = await file.text();
    const result = await local.run((repo) => repo.importBackup(text, { trustReviewed: true }), '');
    if (result) local.setNotice(`导入完成：${result.installs} 个安装包、${result.runs} 条阅读记录；跳过 ${result.skipped} 条重复对象。${result.ignored.length ? ` ${result.ignored.join('；')}` : ''}`);
  };

  const exportBackup = async () => {
    const text = await local.run((repo) => repo.exportBackup());
    if (text) download(text, `endless-edition-backup-${new Date().toISOString().slice(0, 10)}.edition.json`);
  };

  const startReading = async (pkg: edition.EditionPublicationPackage) => {
    const existing = local.store?.runs.find((entry) => entry.editionId === pkg.release.editionId);
    if (existing) {
      const adopted = existing.adoptedReleases.find((entry) => entry.issueId === pkg.release.issueId);
      let next = existing;
      if (adopted?.releaseId !== pkg.release.id) {
        const saved = await local.run(async (repo) => {
          const updated = edition.scheduleLevel(existing, installs, pkg.release, pkg.release.cefr);
          await repo.commitRun(updated, local.store?.revision ?? 0);
          return updated;
        });
        if (!saved) return;
        next = saved;
      }
      // 定位要用这个 Run 自己的完整复习修订；缺了它们，含复习事件的 Run 会无法投影。
      const runReviews = (local.store?.reviews ?? []).filter((entry) => entry.runId === next.id);
      let first: number;
      try {
        first = firstUnread(next, installs, runReviews, pkg);
      } catch (error) {
        local.setError(`无法恢复阅读位置：${error instanceof Error ? error.message : '进度投影失败'}；原始阅读记录未被修改。`);
        return;
      }
      setRunId(next.id);
      setSelectedReleaseId(pkg.release.id);
      setUnitIndex(first);
      setReading(true);
      setReviewId(null);
      return;
    }
    const created = edition.createRun({
      editionId: pkg.release.editionId,
      editorialRevisionId: pkg.release.editorialRevisionId,
      releases: [pkg.release],
    });
    const saved = await local.run(async (repo) => {
      await repo.commitRun(created, local.store?.revision ?? 0);
      return created;
    });
    if (saved) {
      setRunId(saved.id);
      setSelectedReleaseId(pkg.release.id);
      setUnitIndex(0);
      setReading(true);
      setReviewId(null);
    }
  };

  const push = async (input: edition.EventInput) => {
    if (!run || !install) return false;
    const next = await local.run(async (repo) => {
      const appended = edition.appendRunEvent(run, installs, input, reviews);
      await repo.commitRun(appended.run, local.store?.revision ?? 0, { reviews });
      return appended.run;
    });
    if (next) setRunId(next.id);
    return next !== null;
  };

  const startReview = async () => {
    if (!run || !install) return;
    const basis = edition.buildReviewBasis(run, installs, install.pack, install.release.issueId, new Date(), reviews);
    const built = edition.buildReviewRevision(basis, install.pack);
    const saved = await local.run(async (repo) => {
      await repo.commitRun(run, local.store?.revision ?? 0, { reviews: [built.revision] });
      return built.revision;
    });
    if (saved) {
      setReviewId(saved.id);
      local.setNotice(built.hasGradedItems ? '这次复习有合格条目，独立检索会计入 Edition 的复习进度。' : '这次没有合格条目，只作为练习显示，不写记录。');
    }
  };

  if (local.error && !local.store) {
    return <section className="page-heading"><span className="eyebrow">EDITION</span><h1>Edition 暂时打不开<span className="heading-dot">。</span></h1>
      <p role="alert">{local.error}</p>
      <p className="muted-copy">这只影响 Edition 书架，原有 ENDLESS 的内容和进度不会被修改。</p>
      <button className="button button-dark" onClick={() => void local.reload()}>重新读取</button></section>;
  }

  if (!reading || !run || !install) {
    return <section className="edition-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">A FINITE EDITION</span>
          <h1>有限专题，读完为止<span className="heading-dot">。</span></h1>
          <p>每期都有固定目录、已审阅正文和一个终点。不追加同刊，目录预览不计为已读。</p>
        </div>
      </div>
      {local.notice && <div className="notice" role="status"><Icon name="check" size={18} /><span>{local.notice}</span></div>}
      {local.error && <div className="notice notice-error" role="alert"><Icon name="info" size={18} /><span>{local.error}</span></div>}
      <div className="edition-actions">
        {!packages.some((pkg) => pkg.release.id === SAMPLE_PUBLICATION.release.id) &&
          <button className="button button-dark" disabled={local.busy} onClick={() => void installSample()}><Icon name="download" size={17} />安装离线样刊</button>}
        <label className="button button-outline edition-file">
          <Icon name="book" size={17} />导入阅读备份
          <input type="file" accept=".json,.edition.json,application/json" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importBackup(file);
            event.target.value = '';
          }} />
        </label>
        {!!packages.length && <button className="button button-outline" disabled={local.busy} onClick={() => void exportBackup()}><Icon name="download" size={17} />导出阅读备份</button>}
      </div>
      {!packages.length
        ? <section className="surface"><p className="muted-copy">还没有安装任何一期。可以先安装随包附带的 A2 样刊，或导入一份 `edition-backup/1` 阅读备份。</p>
          <p className="section-footnote">样刊只包含自有文本与仓库自带词库，不联网、不调用模型。</p></section>
        : <div className="edition-shelf">{packages.map((pkg) => {
          const existing = local.store?.runs.find((entry) => entry.editionId === pkg.release.editionId);
          // 投影失败要单独标出：不能把失败伪装成空进度，也不能让整页崩溃。
          let done: edition.UnitProgress[] | null = null;
          let progressError = '';
          if (existing) {
            try {
              const runReviews = (local.store?.reviews ?? []).filter((entry) => entry.runId === existing.id);
              const unitsByRevision = new Map(
                edition.projectRun(existing, installs, runReviews).units.map((entry) => [entry.revisionId, entry]),
              );
              done = pkg.units
                .map((unit) => unitsByRevision.get(unit.revisionId))
                .filter((entry): entry is edition.UnitProgress => !!entry);
            } catch (error) {
              progressError = error instanceof Error ? error.message : '无法重建阅读进度';
            }
          }
          const read = done?.filter((entry) => entry.status === 'read').length ?? 0;
          const started = done?.some((entry) => entry.status !== 'unread') ?? false;
          const statusOf = (revisionId: string) => done?.find((entry) => entry.revisionId === revisionId)?.status;
          return <article key={pkg.release.id} className="surface edition-card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">{pkg.release.cefr} · {pkg.release.manifest.counts.units} 单元 · 约 {Math.round(pkg.units.reduce((sum, entry) => sum + entry.estimatedMinutes, 0))} 分钟</span>
                <h2>{pkg.display?.issueTitle ?? pkg.release.issueId}</h2>
                <p>{pkg.display?.editionTitle ?? pkg.release.editionId}</p>
              </div>
              <Icon name="book" />
            </div>
            {progressError
              ? <p className="error-text" role="alert">无法恢复这一期的阅读进度：{progressError}；原始记录未被修改。</p>
              : <ul className="edition-unit-list">{pkg.units.map((entry, index) => {
                const status = statusOf(entry.revisionId);
                return <li key={entry.revisionId}>
                  <span className="edition-unit-index">{String(index + 1).padStart(2, '0')}</span>
                  <span>{entry.title}</span>
                  <span className={`subtle-badge${status === 'read' ? ' badge-ready' : ''}`}>
                    {status === 'read' ? '已读' : status === 'finished_with_skips' ? '含跳过' : status === 'reading' ? '进行中' : '未读'}
                  </span>
                </li>;
              })}</ul>}
            <div className="edition-card-foot">
              <span className="section-footnote">{progressError ? '进度不可用' : `${read}/${pkg.units.length} 单元读完`} · 来源 {pkg.release.manifest.sourceAcks.length} 项 · 离线可用</span>
              <button className="button button-dark" onClick={() => void startReading(pkg)} disabled={local.busy || !!progressError}>
                <Icon name="play" size={16} />{started ? '继续阅读' : '开始阅读'}
              </button>
            </div>
          </article>;
        })}</div>}
      <p className="section-footnote">Edition 的记录与 ENDLESS 分开保存，进度不合并。清理浏览器数据会移除本地期刊，请先导出备份。</p>
    </section>;
  }

  const isReadingScene = scene?.type === 'comic' && scene.panels.length > 0 && scene.panels.every((panel) => !panel.bubbles.length && !panel.actors.length);
  const sceneLabel = review ? '复习' : (unit?.title ?? install.display?.issueTitle ?? 'Edition');
  const presentation = { kind: review ? 'review' : 'edition', series: 'edition', label: sceneLabel, sceneSources: unit?.sceneSources };
  const finishUnit = () => {
    if (review) {
      setReviewId(null);
      setReading(false);
      return;
    }
    if (unitIndex + 1 < install.units.length) setUnitIndex(unitIndex + 1);
    else { setReading(false); local.setNotice('这一期读完了。可以进入复习，或回到书架查看阅读覆盖和跳过记录。'); }
  };

  return <section className="edition-page edition-reader">
    <div className="watch-heading">
      <button className="text-button back-button" onClick={() => { setReading(false); setReviewId(null); }}><Icon name="back" size={17} />返回书架</button>
      <span>{review ? '复习 · 只使用真正读过的内容' : `${install.display?.editionTitle ?? 'Edition'} · ${install.display?.issueTitle ?? ''}`}</span>
      <span className="save-status" role="status">{local.busy ? '正在保存…' : '本地自动保存'}<Icon name={local.busy ? 'clock' : 'check'} size={14} /></span>
    </div>
    <div className="watch-title">
      <span className="eyebrow">{review ? 'REVIEW' : `UNIT ${String(unitIndex + 1).padStart(2, '0')} / ${String(install.units.length).padStart(2, '0')}`}</span>
      <h1>{review ? '考一考真正读过的词' : episode?.title ?? ''}</h1>
      <span lang="en">{review ? `取材于已读正文 · ${review.basis.dueItems.length} 个候选` : episode?.subtitle ?? ''}</span>
    </div>
    {local.error && <div className="notice notice-error" role="alert"><Icon name="info" size={18} /><span>{local.error}</span></div>}
    <div className="watch-main">
      {projectionError && <section className="surface"><p role="alert">无法恢复这一期的阅读进度：{projectionError}</p>
        <p className="muted-copy">原始阅读记录与复习修订未被修改；可能缺少对应的复习修订或数据受损。</p>
        <div className="button-row"><button className="button button-dark" onClick={() => { setReading(false); setReviewId(null); }}>返回书架</button></div></section>}
      {!projectionError && !scene && <section className="surface"><p>这一单元已经结束。</p><div className="button-row">
        {!review && <button className="button button-dark" onClick={() => void startReview()}>进入复习</button>}
        <button className="button button-outline" onClick={finishUnit}>返回</button>
      </div></section>}
      {!projectionError && scene && <section className="scene-card" key={`${episode?.id}-${scene.id}-${review ? 'r' : 'u'}`}>
        <div className="scene-card-header">
          <span><Icon name={isReadingScene ? 'book' : scene.type === 'chat' ? 'chat' : 'target'} size={17} />{isReadingScene ? '已审阅正文' : review ? '合格检索 / 练习' : '读到这里'}</span>
          <span>{String(cursor + 1).padStart(2, '0')} / {String(scenes.length).padStart(2, '0')}</span>
        </div>
        <div className="scene-progress" aria-label={`第 ${cursor + 1} 小节，共 ${scenes.length} 小节`}>{scenes.map((_, index) => <span key={index} className={index <= cursor ? 'filled' : ''} />)}</div>
        {isReadingScene ? <article className="edition-article">
          {scene.type === 'comic' && scene.panels.map((panel, index) => panel.caption ? <p key={index}>{panel.caption}</p> : null)}
          <footer className="edition-source">
            <Icon name="leaf" size={14} />
            <span>{unit?.sceneSources[scene.id] ?? '已审阅正文'}</span>
          </footer>
        </article> : <SceneRenderer scene={scene} state={state} glossary={library?.glossary ?? {}} presentation={presentation}
          readingItems={[]} busy={local.busy} review={false}
          onAnswer={(choice) => void push({
            revisionId: review ? review.id : unit!.revisionId,
            unitId: review ? `review:${review.id}` : unit!.unitId,
            sceneId: scene.id, action: 'answer', payload: { choice },
          })}
          onReveal={() => void push({
            revisionId: review ? review.id : unit!.revisionId,
            unitId: review ? `review:${review.id}` : unit!.unitId,
            sceneId: scene.id, action: 'reveal', payload: {},
          })} />}
        <div className="button-row edition-nav">
          <button className="button button-dark" disabled={local.busy || (getOptions(scene).length > 0 && !state.answer)} onClick={() => void push({
            revisionId: review ? review.id : unit!.revisionId,
            unitId: review ? `review:${review.id}` : unit!.unitId,
            sceneId: scene.id, action: 'advance', payload: { skip: false },
            at: new Date().toISOString(),
          }).then((saved) => { if (saved && cursor + 1 >= scenes.length) finishUnit(); })}>
            <Icon name="arrow" size={16} />{review ? '下一题' : '读完了，继续'}
          </button>
          <button className="button button-outline" disabled={local.busy} onClick={() => void push({
            revisionId: review ? review.id : unit!.revisionId,
            unitId: review ? `review:${review.id}` : unit!.unitId,
            sceneId: scene.id, action: 'advance', payload: { skip: true },
          }).then((saved) => { if (saved && cursor + 1 >= scenes.length) finishUnit(); })}>跳过这一小节</button>
          {!review && !state.answer && getOptions(scene).length > 0 && <span className="section-footnote">跳过不会记为完成，也不会产生曝光。</span>}
        </div>
      </section>}
    </div>
    <p className="section-footnote">阅读正文用「继续」推进；跳过会单独统计为 finished_with_skips，不计为读完。复习按钮只在有真实阅读记录后出现。</p>
  </section>;
}

/**
 * 定位第一个未读完单元。必须拿到这个 Run 的完整 installs 与复习修订——
 * 复习事件的存在会让缺料的投影直接抛错。进度按 revisionId 对齐，
 * 不依赖数组下标；投影失败向外抛，由调用方决定不进入阅读位置。
 */
function firstUnread(
  run: edition.EditionRun,
  installs: readonly edition.EditionInstall[],
  reviews: readonly edition.ReviewRevision[],
  pkg: edition.EditionPublicationPackage,
): number {
  const unitsByRevision = new Map(
    edition.projectRun(run, installs, reviews).units.map((entry) => [entry.revisionId, entry]),
  );
  const index = pkg.units.findIndex((unit) => (unitsByRevision.get(unit.revisionId)?.status ?? 'unread') !== 'read');
  return index < 0 ? 0 : index;
}
