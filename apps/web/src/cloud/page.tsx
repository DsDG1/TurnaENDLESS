import { useState } from 'react';
import { CLOUD_LIMITS, type CloudImportPreview } from '@endless/cloud-contracts';
import type { CloudState } from './controller.js';
import { useCloud } from './use-cloud.js';
import { Icon } from '../components/icons.js';

/**
 * 云端页面（计划 §15.1 的最小入口，不是 C8 的完整客户端）。
 *
 * 表现规则：只展示服务端事实。预览不叫「已导入」，激活不叫「已同步」，
 * 领取不叫「已可阅读」——云库阅读入口属于后续阶段，界面上必须说明。
 */

export interface CloudActions {
  refresh(): void;
  login(email: string): void;
  verify(code: string, deviceName: string): void;
  logout(): void;
  preview(bytes: ArrayBuffer): void;
  confirm(): void;
  claim(workspaceId: string): void;
  open(workspaceId: string): void;
  openSync(workspaceId: string): void;
  sync(): void;
  pauseSync(paused: boolean): void;
  discardConflict(conflictId: string): void;
}

const RETRY_HINT: Record<string, string> = {
  retry_read: '这是一次幂等读取，可以直接重试。',
  resume_same_request: '请沿用同一请求重试；不会重复创建，也不会重复扣费。',
  resolve_conflict: '需要先解决冲突，系统不会自动覆盖任何一侧。',
  manual_new_generation: '只能由你明确发起新的请求；本轮云服务没有生成能力。',
  contact_support: '请把关联 ID 交给支持人员核对。',
};

const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;

const short = (id: string) => id.slice(0, 8);

/**
 * 导入前的最小检查：字节上限在客户端先挡一次，服务端仍会独立校验长度与摘要。
 * 超过上限时明确说「不截断」，而不是悄悄丢弃一部分存档。
 */
export function importPayload(raw: unknown, limit: number = CLOUD_LIMITS.uploadObjectBytes):
  { ok: true; bytes: ArrayBuffer } | { ok: false; message: string } {
  if (raw == null) return { ok: false, message: '还没有可导入的本机存档。' };
  const encoded = new TextEncoder().encode(JSON.stringify(raw));
  if (encoded.byteLength > limit) {
    return {
      ok: false,
      message: `存档 ${formatBytes(encoded.byteLength)} 超过单次导入上限 ${formatBytes(limit)}；不会截断上传。`,
    };
  }
  return { ok: true, bytes: encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer };
}

function PreviewCard({ preview }: { preview: CloudImportPreview }) {
  const relationship = preview.relationship === 'new' ? '新云工作区'
    : preview.relationship === 'empty-workspace' ? '与已有空工作区关联'
    : '这份存档已经导入过';
  return <div className="cloud-facts" aria-label="导入预览">
    <div><span>内容 / 修订</span><strong>{preview.counts.entries} / {preview.counts.revisions}</strong></div>
    <div><span>分支 / 归档</span><strong>{preview.counts.branches} / {preview.counts.volumes}</strong></div>
    <div><span>事件 / 检查点</span><strong>{preview.eventCount} / {preview.counts.checkpoints}</strong></div>
    <div><span>待处理本机任务</span><strong>{preview.pendingLocalTickets}</strong></div>
    <div><span>上传字节</span><strong>{formatBytes(preview.size)}</strong></div>
    <div><span>与云端关系</span><strong>{relationship}</strong></div>
    <div><span>状态</span><strong>{preview.state === 'activated' ? '已激活' : '仅预览，未写入云端'}</strong></div>
    <div><span>预览有效期</span><strong>{new Date(preview.expiresAt).toLocaleString('zh-CN')}</strong></div>
  </div>;
}

function FailureCard({ failure }: { failure: NonNullable<CloudState['failure']> }) {
  return <div className="notice notice-error" role="alert">
    <Icon name="info" size={18} />
    <span>
      {failure.message}（{failure.code}{failure.correlationId ? ` · ${failure.correlationId}` : ''}）
      {failure.retryAction && RETRY_HINT[failure.retryAction] ? ` ${RETRY_HINT[failure.retryAction]}` : ''}
    </span>
  </div>;
}

function SyncCard({ sync, enabled, busy, actions }: {
  sync: NonNullable<CloudState['sync']>; enabled: boolean; busy: boolean; actions: CloudActions;
}) {
  return <section className="surface">
    <div className="section-heading"><div><span className="eyebrow">SYNC</span><h2>增量同步</h2></div><Icon name="cloud" /></div>
    {!enabled && <p className="muted-copy">这个部署没有启用增量同步，按钮不会假装可用。</p>}
    <div className="cloud-facts" aria-label="同步状态">
      <div><span>本机待推送</span><strong>{sync.pending} 条事件</strong></div>
      <div><span>云端已确认版本</span><strong>{sync.cloudVersion ?? '尚未建立绑定'}</strong></div>
      <div><span>上次同步</span><strong>{sync.lastSyncedAt ? new Date(sync.lastSyncedAt).toLocaleString('zh-CN') : '还没有成功同步过'}</strong></div>
      <div><span>状态</span><strong>{sync.paused ? '已暂停（事件继续排队）' : '运行中'}</strong></div>
    </div>
    <div className="button-row">
      <button className="button button-dark" disabled={busy || !enabled || sync.paused} onClick={() => actions.sync()}>
        <Icon name="arrow" size={17} />立即同步
      </button>
      <button className="button button-outline" disabled={busy || !enabled} onClick={() => actions.pauseSync(!sync.paused)}>
        {sync.paused ? '恢复同步' : '暂停同步'}
      </button>
      <span className="generation-note">先推送本机事件，再拉取云端变更；冲突不会自动合并。</span>
    </div>
    {sync.report && <p className="generation-phase" role="status">{sync.report}</p>}
    {sync.lastError && <p className="error-text" role="alert">{sync.lastError}</p>}
    {!!sync.needsRebase.length && <p className="error-text" role="alert">
      有 {sync.needsRebase.length} 个分支的本机历史被整体替换过，已停止推送：不会把替换后的历史当成「追加」上传。
    </p>}
    {!!sync.conflicts.length && <ul className="cloud-list" aria-label="同步冲突">
      {sync.conflicts.map((conflict) => <li key={conflict.id}>
        <span>冲突 · 分支 {short(conflict.streamId)}</span>
        <small>本机前缀 {conflict.baseSeq}{conflict.cloudSeq >= 0 ? ` / 云端 ${conflict.cloudSeq}` : ''}</small>
        <button className="text-button" disabled={busy} onClick={() => actions.discardConflict(conflict.id)}>放弃本机候选</button>
      </li>)}
    </ul>}
    <p className="section-footnote">
      同步只搬运真实阅读事件：同一批次只会生效一次，事件身份在本地提交时分配，重试沿用同一个。
      跨设备「把云端事件应用到本机阅读器」还缺云库阅读入口；标题、标签、回收站等元数据同步和
      「保留为独立分支」也尚未实现——这里不会显示成已完成。
    </p>
  </section>;
}

export function CloudPage({ state, actions, backup }: {
  state: CloudState; actions: CloudActions; backup(): unknown | null;
}) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [localError, setLocalError] = useState('');

  const startPreview = () => {
    const payload = importPayload(backup());
    if (!payload.ok) { setLocalError(payload.message); return; }
    setLocalError('');
    actions.preview(payload.bytes);
  };

  return <>
    <section className="page-heading">
      <div><span className="eyebrow">CLOUD</span><h1>云端副本<span className="heading-dot">。</span></h1>
        <p>把当前设备的存档复制到云端，再在另一台设备领取同一份副本。</p></div>
      <span className="outline-badge"><span className={`status-dot${state.status === 'signed-in' ? '' : ' status-muted'}`} />{state.status === 'signed-in' ? '已登录云账号' : state.status === 'signed-out' ? '未登录' : state.status === 'unavailable' ? '此部署未启用' : '读取中'}</span>
    </section>

    {state.failure && <FailureCard failure={state.failure} />}
    {state.phase && <p className="generation-phase" role="status">{state.phase}</p>}

    {state.status === 'loading' && <section className="surface">
      <div className="section-heading"><div><h2>正在读取云端状态</h2></div><Icon name="cloud" /></div>
      <p className="muted-copy">这里只探测云服务能力，不会上传任何内容；本机阅读不受影响。</p>
    </section>}

    {state.status === 'unavailable' && <section className="surface">
      <div className="section-heading"><div><h2>这个部署没有启用云功能</h2></div><Icon name="cloud" /></div>
      <p className="muted-copy">{state.capabilities ? '云 API 可访问，但账号与导入能力未开启。' : '无法读取云服务能力，可能没有连接云 API。'}本机的阅读、进度和生成完全不受影响；页面不会用假数据代替云端状态。</p>
      <button className="text-button" onClick={() => actions.refresh()}>重新检查<Icon name="arrow" size={15} /></button>
    </section>}

    {state.status === 'signed-out' && <section className="surface">
      <div className="section-heading"><div><span className="eyebrow">SIGN IN</span><h2>用邮箱验证码登录</h2></div><Icon name="cloud" /></div>
      <p className="muted-copy">登录只用于云端副本；游客内容、本机进度和这页输入的 Key 都不会被上传。首个渠道是邮箱一次性验证码。</p>
      <div className="session-key-field">
        <label htmlFor="cloud-email">邮箱</label>
        <div className="session-key-controls">
          <input id="cloud-email" type="email" autoComplete="email" value={email} maxLength={320}
            onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" disabled={state.busy} />
          <button className="button button-outline" disabled={state.busy || !email.trim()} onClick={() => actions.login(email)}>发送验证码</button>
        </div>
        <p className="section-footnote">响应不透露该邮箱是否注册过；验证码短时有效且只能使用一次。</p>
      </div>
      {state.challenge && <div className="session-key-field">
        <label htmlFor="cloud-code">验证码</label>
        <div className="session-key-controls">
          <input id="cloud-code" inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={16}
            onChange={(event) => setCode(event.target.value)} placeholder="填写邮件里的验证码" disabled={state.busy} />
          <input aria-label="设备名称" value={deviceName} maxLength={80} onChange={(event) => setDeviceName(event.target.value)}
            placeholder="设备名称（可选）" disabled={state.busy} />
          <button className="button button-dark" disabled={state.busy || !code.trim()} onClick={() => actions.verify(code, deviceName)}>验证并登录</button>
        </div>
        <p className="section-footnote">登录会撤销同账号的旧会话；已登录设备可在下面查看或撤销。</p>
      </div>}
      {localError && <p className="error-text" role="alert">{localError}</p>}
    </section>}

    {state.status === 'signed-in' && state.me && <>
      <section className="surface">
        <div className="section-heading"><div><span className="eyebrow">ACCOUNT</span><h2>账号与设备</h2></div>
          <button className="text-button" disabled={state.busy} onClick={() => actions.logout()}>退出登录</button></div>
        <div className="cloud-facts">
          <div><span>账号</span><strong>{short(state.me.account.id)}</strong></div>
          <div><span>账号状态</span><strong>{state.me.account.status === 'active' ? '正常' : state.me.account.status}</strong></div>
          <div><span>环境</span><strong>{state.me.context.environment}</strong></div>
          <div><span>当前设备</span><strong>{state.me.device.name}</strong></div>
          <div><span>设备数</span><strong>{state.devices.filter((device) => !device.revokedAt).length}</strong></div>
          <div><span>有效权益</span><strong>{state.me.entitlements.length ? state.me.entitlements.map((entry) => entry.kind).join('、') : '无（本轮没有付费权益）'}</strong></div>
        </div>
        {!!state.devices.length && <ul className="cloud-list">{state.devices.map((device) => <li key={device.id}>
          <span>{device.name}{device.current ? '（当前）' : ''}</span>
          <small>{device.revokedAt ? '已撤销' : `最近活动 ${new Date(device.lastSeenAt).toLocaleString('zh-CN')}`}</small>
        </li>)}</ul>}
      </section>

      <section className="surface">
        <div className="section-heading"><div><span className="eyebrow">IMPORT</span><h2>把本机存档导入云端</h2></div><Icon name="download" /></div>
        {!state.capabilities?.features.import && <p className="muted-copy">这个部署没有启用导入能力，按钮不会假装可用。</p>}
        <p className="muted-copy">只上传当前设备存档的副本：内容、修订、分支事件、归档与检查点。不含模型 Key、登录令牌、支付信息或服务器配置。</p>
        <div className="button-row">
          <button className="button button-dark" disabled={state.busy || !state.capabilities?.features.import} onClick={startPreview}>
            <Icon name="download" size={17} />生成导入预览
          </button>
          <span className="generation-note">预览只做校验与清单，不写入云端。</span>
        </div>
        {localError && <p className="error-text" role="alert">{localError}</p>}
        {state.preview && <PreviewCard preview={state.preview} />}
        {state.preview && state.preview.state !== 'activated' && <div className="button-row">
          <button className="button button-dark" disabled={state.busy} onClick={() => actions.confirm()}>确认导入（激活云端副本）</button>
          <span className="generation-note">确认后才会建立云工作区；本机原存档保持不变。</span>
        </div>}
        {state.receipt && <div className="cloud-facts" aria-label="云端副本回执">
          <div><span>云工作区</span><strong>{short(state.receipt.workspaceId)}</strong></div>
          <div><span>副本创建时间</span><strong>{new Date(state.receipt.copyCreatedAt).toLocaleString('zh-CN')}</strong></div>
          <div><span>内容 / 修订</span><strong>{state.receipt.contentIds.length} / {state.receipt.revisionIds.length}</strong></div>
          <div><span>副本策略</span><strong>{state.receipt.copyPolicy}</strong></div>
        </div>}
        <p className="section-footnote">这一轮只建立云副本。云端生成、额度与付费都还没实现，界面不会暗示它们已可用。</p>
      </section>

      <section className="surface">
        <div className="section-heading"><div><span className="eyebrow">WORKSPACES</span><h2>云端工作区</h2></div><span className="section-count">{String(state.workspaces.length).padStart(2, '0')}</span></div>
        {!state.workspaces.length ? <p className="muted-copy">还没有云端工作区。先导入一份本机存档。</p> :
          <ul className="cloud-list">{state.workspaces.map((workspace) => <li key={workspace.id}>
            <span>{short(workspace.id)} · {workspace.contract}</span>
            <small>{workspace.status === 'active' ? '已激活' : workspace.status} · 云版本 {workspace.cloudVersion}</small>
            {workspace.status === 'active' && <button className="text-button" disabled={state.busy || !state.capabilities?.features.import}
              onClick={() => actions.claim(workspace.id)}>领取到这台设备</button>}
            {workspace.status === 'active' && <button className="text-button" disabled={state.busy || !state.capabilities?.features.sync}
              onClick={() => actions.openSync(workspace.id)}>同步状态</button>}
            {workspace.status === 'active' && state.installed.includes(workspace.id)
              && <button className="text-button" disabled={state.busy} onClick={() => actions.open(workspace.id)}>打开云端副本</button>}
          </li>)}</ul>}
        {state.installation && <p className="generation-phase" role="status">安装回执已保存：{new Date(state.installation.installedAt).toLocaleString('zh-CN')} · 设备 {short(state.installation.deviceId)}</p>}
        <p className="section-footnote">领取会把同一份副本写进这台设备的独立云库，不覆盖游客存档，也不覆盖本机后续进度。领取后可用「打开云端副本」继续阅读，读到的进度会走增量同步；标题、标签、回收站等元数据还没有同步通道。</p>
      </section>

      {state.sync && <SyncCard sync={state.sync} enabled={!!state.capabilities?.features.sync} busy={state.busy} actions={actions} />}
    </>}
  </>;
}

/** 路由壳：只有这里碰 hook，页面本体是纯展示，便于静态渲染测试。 */
export function CloudRoute({ backup }: { backup(): unknown | null }) {
  const { state, controller } = useCloud();
  return <CloudPage state={state} backup={backup} actions={{
    refresh: () => void controller.refresh(),
    login: (email) => void controller.login(email),
    verify: (code, deviceName) => void controller.verify(code, deviceName),
    logout: () => void controller.logout(),
    preview: (bytes) => void controller.previewImport(bytes),
    confirm: () => void controller.confirmImport(),
    claim: (workspaceId) => void controller.claim(workspaceId),
    open: (workspaceId) => {
      const hash = controller.readingHash(workspaceId);
      if (hash) window.location.hash = hash;
    },
    openSync: (workspaceId) => void controller.openSync(workspaceId),
    sync: () => void controller.runSync(),
    pauseSync: (paused) => void controller.setSyncPaused(paused),
    discardConflict: (conflictId) => void controller.discardConflict(conflictId),
  }} />;
}
