import { Icon } from '../components/icons.js';
import type { CloudReadView } from '../use-player.js';

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

export function CloudReadBanner({ view, syncing, onSync, exitHref, branches = [], activeBranchId, onBranch }: {
  view: CloudReadView | null;
  syncing: boolean;
  onSync(): void;
  exitHref: string;
  branches?: readonly { id: string; label: string }[];
  activeBranchId?: string;
  onBranch?(id: string): void;
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
      </div>
      {view.stopped && <p className="error-text" role="alert">{STOP_TEXT[view.stopped]}</p>}
      {view.needsRebase > 0 && <p className="error-text" role="alert">
        有 {view.needsRebase} 个分支的本机历史被整体替换过，已停止推送。本机事件没有删除。
      </p>}
      {view.note && <p className="generation-phase" role="status">{view.note}</p>}
      <div className="button-row">
        <button className="button button-dark" disabled={syncing || view.paused} onClick={onSync}>
          <Icon name="arrow" size={17} />{syncing ? '正在同步…' : '立即同步'}
        </button>
        <a className="button button-outline" href={exitHref}>退出云端阅读</a>
        <span className="generation-note">只同步阅读事件；AI 生成与内容元数据（标题、标签、回收站）都还没接。</span>
      </div>
    </>}
  </section>;
}
