import { Icon } from '../components/icons.js';
import type { CloudReadView } from '../use-player.js';
import type { MetadataState } from './metadata.js';
import type { LifecycleState } from './lifecycle.js';
import type { ArchiveView } from './archives.js';

/**
 * 云副本阅读状态条。
 *
 * 只写能被本机证明的事实：待推送条数、上次成功时间、是否暂停、冲突候选。
 * 没有待推送事件时也不能写成「已同步全部内容」——那需要知道其他设备的状态，
 * 而这一轮没有这样的接口。
 */

const STOP_TEXT: Record<NonNullable<CloudReadView['stopped']>, string> = {
  conflict: '云端历史与本机提交不在同一前缀：这批事件整批未上传，候选已保留。到「云端副本」页决定如何处理。',
  cursor: '本机同步游标已过期：未同步事件不会被云端快照覆盖，请在云端副本页重新引导。',
  replay: '云端有一条变更无法在本机重放成同一事件，已停在该处；本机存档未被修改。',
  ticket: '本机还有进行中的生成任务，暂时不应用云端事件。',
  prefix: '有分支的本机历史被整体替换过，已停止推送；不会把替换后的历史当成「追加」。',
};

export function CloudReadBanner({ view, syncing, onSync, exitHref, branches = [], activeBranchId, onBranch, metadata, onResolveMetadata, lifecycle, onResolveLifecycle, archives, onResolveArchive }: {
  view: CloudReadView | null;
  syncing: boolean;
  onSync(): void;
  exitHref: string;
  branches?: readonly { id: string; label: string }[];
  activeBranchId?: string;
  onBranch?(id: string): void;
  metadata?: MetadataState | null;
  onResolveMetadata?(contentId: string, decision: 'local' | 'cloud', commandId: string, version: number): void;
  lifecycle?: LifecycleState | null;
  onResolveLifecycle?(contentId: string, decision: 'local' | 'cloud', commandId: string, version: number): void;
  archives?: ArchiveView | null;
  onResolveArchive?(decision: 'retry' | 'cloud', commandId: string, version: number): void;
}) {
  return <section className="surface cloud-reader" aria-label="云端副本同步状态">
    <div className="section-heading">
      <div><span className="eyebrow">CLOUD COPY</span><h2>正在读云端副本</h2></div>
      <Icon name="cloud" />
    </div>
    {branches.length > 1 && <label>当前阅读分支（仅这台设备）
      <select aria-label="当前阅读分支" value={activeBranchId} disabled={syncing} onChange={(event) => onBranch?.(event.target.value)}>
        {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.label}</option>)}
      </select>
    </label>}
    {!view ? <p className="muted-copy">正在读取本机同步状态…</p> : <>
      <div className="cloud-facts">
        <div><span>本机待推送</span><strong>{view.pending ? `${view.pending} 条事件` : '没有待推送事件'}</strong></div>
        <div><span>上次成功同步</span><strong>{view.lastSyncedAt ? new Date(view.lastSyncedAt).toLocaleString('zh-CN') : '还没有成功同步过'}</strong></div>
        <div><span>状态</span><strong>{view.paused ? '已暂停（事件继续排队）' : syncing ? '正在同步' : '运行中'}</strong></div>
        <div><span>冲突候选</span><strong>{view.conflicts ? `${view.conflicts} 个待处理` : '无'}</strong></div>
        <div><span>展示信息</span><strong>{view.metadataPending ?? 0} 条待同步 · {view.metadataConflicts ?? 0} 个冲突</strong></div>
        <div><span>回收站</span><strong>{view.lifecyclePending ?? 0} 条待同步 · {view.lifecycleConflicts ?? 0} 个冲突</strong></div>
      </div>
      {view.stopped && <p className="error-text" role="alert">{STOP_TEXT[view.stopped]}</p>}
      {view.needsRebase > 0 && <p className="error-text" role="alert">
        有 {view.needsRebase} 个分支的本机历史被整体替换过，已停止推送。本机事件没有删除。
      </p>}
      {view.note && <p className="generation-phase" role="status">{view.note}</p>}
      {archives?.pending && <section className="surface" aria-label="归档请求状态">
        <h3>{archives.pending.resolution ? '归档请求需要处理' : '归档请求待确认'}</h3>
        <p>{archives.pending.request.type === 'archive' ? `创建「${archives.pending.request.title}」` : '取消归档'} · {archives.pending.request.members.length} 项内容。内容与阅读历史继续保留。</p>
        {archives.pending.resolution ? <>
          <p>{archives.pending.resolution.outcome === 'conflict' ? '其他设备已修改相关内容或归档，请查看当前状态后选择。'
            : archives.pending.resolution.reason === 'capacity' ? '本次归档超过当前容量，原卷保留。'
              : archives.pending.resolution.reason === 'basis' ? '阅读前缀尚未在云端确认或无法验证，请先完成阅读同步。' : '归档成员或位置已变化，请重新选择内容。'}</p>
          <div className="button-row">
            <button className="button button-outline" disabled={syncing} onClick={() => onResolveArchive?.('retry', archives.pending!.request.commandId, archives.known!.version)}>按最新版本重新提交</button>
            <button className="button button-outline" disabled={syncing} onClick={() => onResolveArchive?.('cloud', archives.pending!.request.commandId, archives.known!.version)}>采用云端归档状态</button>
          </div><small>原请求留存在本机恢复记录中；重新提交仍使用原阅读前缀，不会补造阅读。</small>
        </> : <p>离线或未收到响应时会恢复同一请求，尚未标记为归档成功。</p>}
      </section>}
      {Object.values(metadata?.pending ?? {}).filter((entry) => entry.conflict).map(({ request }) => {
        const known = metadata!.known[request.contentId]!;
        const remote = known.value;
        return <section className="surface" key={request.commandId} aria-label="展示信息冲突">
          <h3>展示信息有并发修改</h3>
          <p>本机：{request.value.title} · 标签：{request.value.tags.join('、') || '无'} · 备注：{request.value.note || '无'}</p>
          <p>云端：{remote.title} · 标签：{remote.tags.join('、') || '无'} · 备注：{remote.note || '无'}</p>
          <div className="button-row">
            <button className="button button-outline" disabled={syncing} onClick={() => onResolveMetadata?.(request.contentId, 'local', request.commandId, known.version)}>保留本机修改并重新提交</button>
            <button className="button button-outline" disabled={syncing} onClick={() => onResolveMetadata?.(request.contentId, 'cloud', request.commandId, known.version)}>采用云端展示信息</button>
          </div>
          <small>原命令和冲突版本会留存在本机恢复记录中。再次并发修改会重新提示。</small>
        </section>;
      })}
      {Object.values(lifecycle?.pending ?? {}).filter((entry) => entry.conflict).map(({ request }) => {
        const known = lifecycle!.known[request.contentId]!;
        const title = metadata?.known[request.contentId]?.value.title ?? request.contentId;
        return <section className="surface" key={request.commandId} aria-label="回收站冲突">
          <h3>回收站状态有并发修改</h3><p>{title}</p>
          <p>本机请求：{request.type === 'trash' ? '移入回收站' : '恢复'}；云端：{known.value.lifecycle === 'trashed' ? '已在回收站' : '正常内容'}</p>
          <div className="button-row">
            <button className="button button-outline" disabled={syncing} onClick={() => onResolveLifecycle?.(request.contentId, 'local', request.commandId, known.version)}>重新提交本机操作</button>
            <button className="button button-outline" disabled={syncing} onClick={() => onResolveLifecycle?.(request.contentId, 'cloud', request.commandId, known.version)}>采用云端回收站状态</button>
          </div>
          <small>原候选保留；不会删除内容原件、阅读事件或阅读义务。</small>
        </section>;
      })}
      <div className="button-row">
        <button className="button button-dark" disabled={syncing || view.paused} onClick={onSync}>
          <Icon name="arrow" size={17} />{syncing ? '正在同步…' : '立即同步'}
        </button>
        <a className="button button-outline" href={exitHref}>退出云端阅读</a>
        <span className="generation-note">同步阅读事件、展示信息、回收站和归档；AI 生成与采用修订尚未接入。回收不解除阅读义务。</span>
      </div>
    </>}
  </section>;
}
