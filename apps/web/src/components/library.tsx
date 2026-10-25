/**
 * 内容管理界面：展示信息编辑、内容修订（草稿编辑 → 编译 → 预览 → 采用）、
 * 回收站、归档卷与完整备份/导入。所有操作走工作区管理命令，不伪造学习事件。
 */
import { useEffect, useRef, useState } from 'react';
import { adoptedRevision, type ContentEntry, type RevisionPreview } from '@endless/content';
import { downloadSession } from '../storage.js';
import { Icon } from './icons.js';
import type { usePlayer } from '../use-player.js';

type Player = ReturnType<typeof usePlayer>;

function Dialog({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="install-dialog library-dialog" onClose={onClose}
    onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <button className="icon-button dialog-close" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
    <h2>{title}</h2>
    {children}
  </dialog>;
}

/** 展示信息编辑（改名/标签/备注，不改正文与已有答案）。 */
export function DisplayEditor({ entry, player, onClose }: { entry: ContentEntry; player: Player; onClose(): void }) {
  const [title, setTitle] = useState(entry.display.title);
  const [tags, setTags] = useState(entry.display.tags.join(', '));
  const [note, setNote] = useState(entry.display.note);
  return <Dialog title="编辑展示信息" onClose={onClose}>
    <p className="section-footnote">只改展示名称、标签和备注；内容本身与已有阅读记录不变。</p>
    <label>显示名称<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} /></label>
    <label>标签（逗号分隔）<input value={tags} onChange={(e) => setTags(e.target.value)} maxLength={200} /></label>
    <label>个人备注<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} /></label>
    <button className="button button-dark" disabled={!title.trim()} onClick={() => void player.editDisplay(entry, {
      title: title.trim(), note,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12),
    }).then((ok) => { if (ok) onClose(); })}>保存展示信息</button>
  </Dialog>;
}

/** 内容修订：编辑 ENDLESS-DRAFT/1 草稿 → 编译校验 → 预览差异 → 确认采用。 */
export function DraftEditor({ entry, player, onClose }: { entry: ContentEntry; player: Player; onClose(): void }) {
  const head = player.workspace ? adoptedRevision(player.workspace, entry.id) : null;
  const [draft, setDraft] = useState(head && head.origin !== 'bundled' ? head.draft : '');
  const [preview, setPreview] = useState<RevisionPreview | null>(null);
  const read = !!player.runtime && player.runtime.branch.session.events.some((e) => e.episode === head?.episodeId);
  return <Dialog title="编辑内容" onClose={onClose}>
    <p className="section-footnote">
      修改 ENDLESS-DRAFT/1 草稿后先「编译并预览」。采用新修订必须满足 10–20 节、素材、词汇与来源约束；
      {read ? ' 本内容已有阅读记录，采用将创建新分支，原分支保留。' : ' 尚无交互记录，采用将原位替换当前修订。'}
    </p>
    <textarea className="draft-editor" value={draft}
      onChange={(e) => { setDraft(e.target.value); setPreview(null); }} rows={16} spellCheck={false} />
    <div className="button-row">
      <button className="button button-outline" onClick={() => setPreview(player.previewEdit(entry, draft))}>编译并预览</button>
      {preview?.ok && preview.revision && <button className="button button-dark"
        onClick={() => void player.adoptEdit(entry, preview.revision!).then((ok) => { if (ok) onClose(); })}>
        {read ? '采用并创建新分支' : '采用此修订'}</button>}
    </div>
    {preview && <div className={`notice${preview.ok ? '' : ' notice-error'}`} role="status">
      {preview.ok
        ? <span>校验通过：{preview.after?.scenes.length ?? 0} 节（原 {preview.before?.scenes.length ?? 0} 节）。</span>
        : <span>校验未通过：{preview.issues.slice(0, 5).map((i) => i.message).join('；')}</span>}
    </div>}
  </Dialog>;
}

/** 生成条目的管理菜单。 */
export function EntryMenu({ entry, player }: { entry: ContentEntry; player: Player }) {
  const [open, setOpen] = useState(false);
  const [display, setDisplay] = useState(false);
  const [body, setBody] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const info = player.purgeInfo(entry);
  const blocked = !!info && (info.usedByEvents.length + info.usedByBasis.length + info.usedByTickets.length > 0);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  if (entry.sourceKind !== 'generated') return null;
  const busy = player.busy;
  return <span className="entry-menu" ref={root}>
    <button className="icon-button" aria-label="管理此内容" aria-haspopup="menu" aria-expanded={open}
      onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><Icon name="settings" size={16} /></button>
    {open && <div className="entry-menu-list" role="menu" onClick={(e) => e.stopPropagation()}>
      <button role="menuitem" disabled={busy} onClick={() => { setDisplay(true); setOpen(false); }}>编辑展示信息</button>
      <button role="menuitem" disabled={busy} onClick={() => { setBody(true); setOpen(false); }}>编辑内容</button>
      {entry.lifecycle !== 'trashed' &&
        <button role="menuitem" disabled={busy} onClick={() => void player.trash(entry).then(() => setOpen(false))}>移入回收站</button>}
      {entry.lifecycle === 'trashed' && <>
        <button role="menuitem" disabled={busy} onClick={() => void player.restore(entry).then(() => setOpen(false))}>恢复</button>
        <button role="menuitem" disabled={busy || blocked} onClick={() => setConfirmPurge(true)}>
          {blocked ? '仍被引用，不能彻底删除' : '彻底删除'}
        </button>
      </>}
    </div>}
    {display && <DisplayEditor entry={entry} player={player} onClose={() => setDisplay(false)} />}
    {body && <DraftEditor entry={entry} player={player} onClose={() => setBody(false)} />}
    {confirmPurge && <Dialog title="彻底删除" onClose={() => setConfirmPurge(false)}>
      <p>将从本机移除该内容与修订，已产生的记录不会被删除。</p>
      <button className="button button-dark" onClick={() => void player.purge(entry).then((ok) => { if (ok) setConfirmPurge(false); })}>确认删除</button>
    </Dialog>}
  </span>;
}

/** 「管理」页：归档卷、回收站、完整备份与导入。 */
export function LibraryPage({ player }: { player: Player }) {
  const [importError, setImportError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const trashed = player.entries.filter((e) => e.lifecycle === 'trashed');
  const obligationIds = new Set(player.obligations.map((o) => o.contentId));
  const importFile = (file: File) => {
    if (file.size > 20 * 1024 * 1024) { setImportError('文件过大'); return; }
    void file.text().then((text) => {
      try {
        const preview = player.previewImport(JSON.parse(text));
        if (!window.confirm(`导入将写入 ${preview.backup.manifest.counts.entries} 条内容、${preview.backup.manifest.counts.branches} 条分支。继续？`)) return;
        void player.importBackup(preview).then((ok) => setImportError(ok ? '' : '导入未提交'));
      } catch (error) {
        setImportError(error instanceof Error ? error.message : '备份文件无法识别');
      }
    });
  };
  return <>
    <section className="page-heading"><div><span className="eyebrow">LIBRARY</span><h1>归档与回收站<span className="heading-dot">。</span></h1></div></section>
    <section className="surface"><div className="section-heading"><h2>归档卷</h2></div>
      {!player.volumes.length && <p className="muted-copy">还没有归档。{player.suggestions.length ? '有内容可以成卷：' : '完成更多集后可以按系列成卷。'}</p>}
      {player.suggestions.map((s, i) => <div key={i} className="volume-row">
        <span>{s.reason}（{s.contentIds.length} 集）</span>
        <button className="text-button" onClick={() => void player.archive(s.contentIds)}>成卷归档</button>
      </div>)}
      {player.volumes.map((v) => <div key={v.id} className="volume-row">
        <div><strong>{v.title}</strong><small>{v.members.length} 集 · {v.narrative}</small></div>
        <button className="text-button" onClick={() => void player.unarchive(v)}>移出归档</button>
      </div>)}
    </section>
    <section className="surface"><div className="section-heading"><h2>回收站</h2></div>
      {!trashed.length && <p className="muted-copy">回收站是空的。移入回收站不会移除已有历史。</p>}
      {trashed.map((entry) => <div key={entry.id} className="volume-row">
        <div><strong>{entry.display.title}</strong><small>{obligationIds.has(entry.id) ? '仍有阅读义务' : '无阅读义务'}</small></div>
        <div className="button-row">
          <button className="text-button" onClick={() => void player.restore(entry)}>恢复</button>
          {obligationIds.has(entry.id) && <button className="text-button" onClick={() => void player.waive(entry)}>撤销阅读义务</button>}
          <EntryMenu entry={entry} player={player} />
        </div>
      </div>)}
    </section>
    <section className="surface"><div className="section-heading"><h2>完整备份</h2></div>
      <p className="muted-copy">导出包含原件、修订、分支、事件与归档，不含临时 Key 或服务器配置。</p>
      <div className="button-row">
        <button className="button button-outline" onClick={() => { const b = player.backup(); if (b) downloadSession(b); }}><Icon name="download" size={17} />导出完整备份</button>
        <button className="button button-outline" onClick={() => fileRef.current?.click()}>导入备份</button>
        <input ref={fileRef} type="file" accept=".json,.endless.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
      </div>
      {importError && <p className="error-text" role="alert">{importError}</p>}
    </section>
    <section className="surface"><div className="section-heading"><h2>分支</h2></div>
      {player.branches.map((b) => <div key={b.id} className="volume-row">
        <div><strong>{b.label}</strong><small>{b.session.events.length} 条事件{b.id === player.workspace?.activeBranchId ? ' · 当前' : ''}</small></div>
        {b.id !== player.workspace?.activeBranchId && <button className="text-button" onClick={() => void player.switchBranchTo(b.id)}>切换到此分支</button>}
      </div>)}
    </section>
  </>;
}
