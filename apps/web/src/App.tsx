import { useEffect, useRef, useState } from 'react';
import { episodeCompletion, getOptions, getScenes, type Episode, type Library, type PlayerView } from '@endless/player';
import { creativeSeries, materialBackgrounds, materialCharacters, materialProps, type CreativeSeriesId } from '@endless/content';
import { BACKDROP_LABEL_BY_ID, CHARACTER_LABEL_BY_ID, Character, PROP_LABEL_BY_ID, PropArt, SeriesArt, StoryArt } from './components/art.js';
import { Brand, Icon, type IconName } from './components/icons.js';
import { SceneRenderer } from './components/scenes.js';
import { EntryMenu, LibraryPage } from './components/library.js';
import { EditionPage } from './edition/page.js';
import { downloadSession } from './storage.js';
import { usePlayer } from './use-player.js';
import { usePwa } from './use-pwa.js';

type Page = 'home' | 'watch' | 'progress' | 'settings' | 'library' | 'edition';
const seriesOf = (episode: Episode) =>
  creativeSeries[(episode.presentation?.series ?? 'duck_detective') as CreativeSeriesId] ?? creativeSeries.duck_detective;
const isPilotStory = (episode: Episode) => !episode.presentation || episode.presentation.series === 'duck_detective';
const pageFromHash = (): Page => {
  const hash = window.location.hash.slice(1);
  return ['watch', 'progress', 'settings', 'library', 'edition'].includes(hash) ? hash as Page : 'home';
};
const navigate = (page: Page) => { window.location.hash = page; };
const localDay = (date: string | Date) => new Date(date).toLocaleDateString('sv-SE');

function Stat({ icon, value, label }: { icon: IconName; value: number | string; label: string }) {
  return <div className="stat"><span className="stat-icon"><Icon name={icon} size={20} /></span><div><strong>{value}</strong><span>{label}</span></div></div>;
}

function InstallDialog({ onClose, pwa }: { onClose(): void; pwa: ReturnType<typeof usePwa> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [prompting, setPrompting] = useState(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="install-dialog" onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <button className="icon-button dialog-close" onClick={onClose} aria-label="关闭安装说明"><Icon name="close" /></button>
    <span className="dialog-art"><Brand small /></span>
    <span className="eyebrow">A LITTLE SPACE FOR YOUR STORIES</span>
    <h2>给故事，一个自己的窗口。</h2>
    <p>将 ENDLESS 安装到 Windows。无需安装包，从桌面打开，缓存就绪后断网也能继续试播故事。</p>
    <ol className="install-steps"><li><span>1</span><div><strong>使用 Edge 或 Chrome 打开</strong><p>正式部署需要 HTTPS，本机预览可用 localhost。</p></div></li><li><span>2</span><div><strong>点击地址栏中的安装图标</strong><p>也可以在浏览器菜单中找到“安装此应用”。</p></div></li><li><span>3</span><div><strong>下次，直接从桌面继续</strong><p>手机可通过浏览器菜单“添加到主屏幕”。</p></div></li></ol>
    {pwa.canInstall && <button className="button button-dark full-width" disabled={prompting} onClick={() => {
      setPrompting(true);
      void pwa.install().then((accepted) => { if (accepted) onClose(); }).catch(() => setError('暂时无法唤起安装，请使用浏览器地址栏或菜单安装。')).finally(() => setPrompting(false));
    }}><Icon name="download" />{prompting ? '正在打开安装窗口…' : '安装 ENDLESS'}</button>}
    <div className="dialog-note"><Icon name={pwa.ready ? 'check' : 'info'} size={16} /><span>{pwa.installed ? '你已经在应用独立窗口中。' : pwa.ready ? '离线内容已缓存，可以安心关闭这个窗口。' : import.meta.env.DEV ? '开发模式未启用离线缓存。构建并预览后可测试安装和离线。' : '请保持联网，等待离线缓存准备完成。'}</span></div>
    {error && <p className="error-text" role="alert">{error}</p>}
  </dialog>;
}

function GenerationPanel({ player, onGenerate }: { player: ReturnType<typeof usePlayer>; onGenerate(): void }) {
  return <section className="surface generation-panel" aria-label="AI 故事续写">
    <div className="section-heading"><div><span className="eyebrow">LET THE NEXT STORY HAPPEN.</span><h2>故事，不只三集。</h2></div><Icon name="spark" /></div>
    <p>每次点生成，都会得到一份新内容：可能是温暖烘焙坊的治愈物语、海港车站的旅人见闻、不可能商店的幽默日常、生活对话、趣味短帖，或是有出处的词汇小卡片。AI 在多宇宙故事与丰富形态中自由创作，不再局限于单一的侦探案情；答案、练习和学习记录仍由程序把关。生成后先校验、再保存，不会改写已经看过的内容。</p>
    <div className="material-preview" aria-label="素材预览"><span className="eyebrow">新伙伴与新场景 · ENDLESS 原创小插画</span><div className="material-row">
      {materialCharacters.map((c) => <figure key={c.id}><Character kind={c.id} /><figcaption>{CHARACTER_LABEL_BY_ID.get(c.id)}</figcaption></figure>)}
    </div><div className="material-row material-row-props">
      {['notebook', 'umbrella', 'envelope', 'bicycle', 'gift', 'coin', 'jar', 'lamp', 'camera', 'tea'].map((prop) => <figure key={prop}><PropArt reference={`@emoji:${prop}`} /><figcaption>{PROP_LABEL_BY_ID.get(prop)}</figcaption></figure>)}
    </div><small>{materialCharacters.length} 位角色、{materialBackgrounds.length} 个场景（{[...BACKDROP_LABEL_BY_ID.values()].join('、')}）、{materialProps.length} 件小道具，随本页离线打包；内容只围绕这些材料展开，不生成任意界面或音频。</small></div>
    {!!player.nextWords.length && <div className="next-words"><strong>下一集的新词</strong>{player.nextWords.map((entry) =>
      <span key={entry.item}><span lang="en">{entry.label}</span> · {entry.gloss}</span>)}<small>先在故事中理解并练习，充分接触后再独立检索，不把第一次见到算成掌握。</small></div>}
    <div className="generation-status"><span className={`status-dot${player.canUseModel ? '' : ' status-muted'}`} /><span>{player.api
      ? `${player.api.model} · ${player.apiKey.trim() && player.api.acceptsUserKey ? '使用本页 Key' : player.api.configured ? '使用服务端密钥' : '可输入自己的 Key'}`
      : '本机 AI 服务未连接'}</span>
      <button className="text-button" onClick={() => void player.refreshApi()}>刷新连接状态</button></div>
    {!player.api && player.apiError && <p className="section-footnote">{player.apiError}</p>}
    <div className="session-key-field">
      <label htmlFor="session-provider-key">MiniMax API Key（仅本页内存）</label>
      <div className="session-key-controls"><input id="session-provider-key" data-session-provider-key
        type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={4096}
        value={player.apiKey} onChange={(event) => player.setApiKey(event.target.value)}
        aria-describedby="session-key-note" placeholder="输入你自己的 MiniMax API Key"
        disabled={!player.api?.acceptsUserKey} />
        <button className="button button-outline" disabled={!player.apiKey} onClick={() => player.setApiKey('')}>清除 Key</button></div>
      <p id="session-key-note" className="section-footnote">只保留在当前页面内存中，刷新、离开或关闭页面后需重新输入。不写入浏览器存储、任务缓存或导出文件。清除 Key 不会终止已经提交的生成任务。</p>
      {player.api && !player.api.acceptsUserKey && <p className="section-footnote">当前服务端尚不支持网页临时 Key，请更新并重启服务。</p>}
    </div>
    <p className="section-footnote">点击生成后，Key 与学习、剧情上下文会经本机服务发送给 MiniMax；本机服务仅在该任务执行期间持有网页 Key，不记录密钥。模型按实际 token 计费。</p>
    {!player.readyForGeneration && !player.ticket && <p className="generation-guidance">先看完已有故事，再让 AI 根据完整进度续写。</p>}
    <div className="button-row"><button className="button button-dark" aria-busy={player.generating}
      disabled={player.generating || player.saving || (!player.ticket && (!player.readyForGeneration || !player.canUseModel))}
      onClick={onGenerate}><Icon name="spark" size={17} />{player.generating ? 'AI 正在续写…' : player.ticket ? '恢复生成任务' : 'AI 生成下一集'}</button>
      <span className="generation-note">一份新内容，手动生成，不会自动连播。</span>
      {player.ticket && <button className="text-button" onClick={() => void player.cancelGeneration()}>停止等待（不终止服务端调用）</button>}</div>
    {player.phase && <p className="generation-phase" role="status">{player.phase}</p>}
  </section>;
}

function Home({ view, current, busy, onSelect, library, player, onGenerate }: {
  view: PlayerView; current: Episode; busy: boolean; onSelect(episode: Episode): void;
  library: Library; player: ReturnType<typeof usePlayer>; onGenerate(): void;
}) {
  const entryOf = (episode: Episode) => player.runtime?.owners.get(episode.id)?.entry;
  const cursor = view.episodes[current.id]?.cursor ?? 0;
  const started = cursor > 0 || !!view.episodes[current.id]?.scenes.s1;
  return <>
    <section className="page-heading"><div><span className="eyebrow">GOOD STORIES. LITTLE BY LITTLE.</span><h1>让英语，接着发生<span className="heading-dot">。</span></h1><p>不必先有学习的心情。先看看，后来发生了什么。</p></div><span className="outline-badge"><span className="status-dot" />AI 续写 · A1–A2</span></section>
    <section className="hero-card">
      <div className="hero-copy"><span className="hero-kicker"><span />你的第一个故事频道</span><div className="channel-title"><span>DUCK</span><span>DETECTIVE<span className="title-spark">✦</span></span></div><p className="hero-chinese">鸭侦探事务所</p><p className="hero-description">案子很小，疑点很多。<br />和一只过分认真的鸭子，一起把英语用起来。</p></div>
      <div className="hero-illustration"><StoryArt /><span className="art-stamp"><span>EVERY STORY</span><strong>COUNTS.</strong></span></div>
      <div className="hero-action"><button className="button button-lime" disabled={busy} onClick={() => onSelect(current)}><Icon name="play" size={17} />{started ? '继续上次的故事' : '进入故事'}<Icon name="arrow" size={18} /></button><span className="hero-footnote">3 集试播 · 漫画、聊天与一点小互动</span></div>
    </section>
    <div className="home-note"><span className="note-symbol"><Icon name="leaf" size={20} /></span><p><strong>不用背下一切。</strong> 故事会留下线索，学习记录会记住你的每一次尝试。</p><span className="quiet-label">慢慢来，也会走很远</span></div>
    <GenerationPanel player={player} onGenerate={onGenerate} />
    <section className="episode-section"><div className="section-heading"><div><span className="eyebrow">YOUR STORY COLLECTION</span><h2>从一个小谜题开始</h2></div><span className="section-count">01 — {String(library.episodes.length).padStart(2, '0')}</span></div>
      <div className="episode-grid">{library.episodes.map((episode, index) => {
        const progress = view.episodes[episode.id];
        const total = getScenes(episode).length;
        // 跳过也会推进 cursor：只有真正读完（无跳过）才算「已看完」
        const completed = episodeCompletion(progress, total).read;
        const underway = (progress?.cursor ?? 0) > 0;
        return <button className={`episode-card episode-card-${index}`} key={episode.id} onClick={() => onSelect(episode)} disabled={busy} aria-label={`${completed ? '查看' : '播放'}第 ${index + 1} 集：${episode.title}`}>
          <div className="episode-art">{isPilotStory(episode) ? <StoryArt variant={index % 3} /> : <SeriesArt cast={seriesOf(episode).cast} backdrop={seriesOf(episode).backgrounds[0]} />}<span className="episode-number">{index < 3 ? 'EP.' : 'AI'} {String(index + 1).padStart(2, '0')}</span><span className="episode-play"><Icon name={completed ? 'check' : 'play'} size={16} /></span></div>
          <div className="episode-copy"><span className="episode-subtitle" lang="en">{episode.subtitle}</span><h3>{episode.title}</h3><p>{episode.description}</p><div className="episode-meta"><span>{episode.presentation ? `${episode.presentation.label} · ` : ''}{completed ? '已看完 · 可以回看' : underway ? `继续 · ${progress?.cursor}/${total} 段` : `${total} 段故事 · A1–A2`}</span><Icon name="arrow" size={17} />{(() => { const e = entryOf(episode); return e ? <EntryMenu entry={e} player={player} /> : null; })()}</div></div>
        </button>;
      })}</div>
    </section>
    <footer className="page-footer"><span>一点好奇，一点英语。没有连续打卡的压力。</span><span>ENDLESS / PILOT 001</span></footer>
  </>;
}

function Progress({ view, onDiscover, notes }: {
  view: PlayerView; onDiscover(): void; notes: ReturnType<typeof usePlayer>['learningNotes'];
}) {
  const qualified = view.answers.filter((answer) => answer.qualified);
  return <>
    <section className="page-heading"><div><span className="eyebrow">SMALL STEPS, REAL PROGRESS.</span><h1>故事走过的地方<span className="heading-dot">。</span></h1><p>不是一张成绩单，是你和英语相遇的痕迹。</p></div><span className="outline-badge"><Icon name="desktop" size={15} />仅保存在此设备</span></section>
    <section className="stats-grid"><Stat icon="comic" value={view.completed} label="已读故事片段" /><Stat icon="chat" value={view.answers.length} label="真实互动尝试" /><Stat icon="book" value={qualified.length} label="有效检索记录" /><Stat icon="leaf" value={view.exposed.size} label="遇见的词与表达" /></section>
    <section className="surface progress-surface"><div className="section-heading"><div><span className="eyebrow">YOUR LEARNING NOTES</span><h2>留下来的表达</h2></div><span className="subtle-badge">FSRS · S-B</span></div>
      {!notes.length ? <div className="empty-state"><span className="empty-icon"><Icon name="book" size={32} /></span><h3>你的第一条学习记录，还在故事里。</h3><p>读完故事中的表达就会留下足迹。先理解、再练习，后续独立作答才进入间隔复习。</p><button className="button button-dark" onClick={onDiscover}>去看一个故事<Icon name="arrow" size={17} /></button></div> :
        <div className="learning-list">{notes.map((entry) =>
          <div className="learning-row" key={entry.item} data-learning-item={entry.item}><span className="word-mark"><Icon name="book" size={18} /></span>
            <div><strong lang="en">{entry.label ?? entry.item}</strong><span>{entry.gloss}</span><small>已读 {entry.exposures} 个片段 · {entry.attempts} 次互动</small></div>
            <div className="learning-due">{entry.due ? <><span className="subtle-badge">已安排复习</span><small>下一次：{entry.due.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></>
              : <><span className="subtle-badge badge-practice">{entry.status === 'practice' ? '情境练习' : '已遇见 · 待练习'}</span><small>未推进间隔复习</small></>}</div></div>
        )}</div>}
      <p className="section-footnote"><Icon name="info" size={15} />AI 续写会读取到期复习和实际曝光记录。提示、重复内容和未到期的互动仍只记练习。</p>
    </section>
    <section className="surface world-surface"><div className="section-heading"><div><span className="eyebrow">THE STORY REMEMBERS</span><h2>故事也记得你</h2></div><Icon name="spark" /></div>{!view.world.userFacts().length ? <p className="muted-copy">试着在聊天里回应角色。只有你实际选中的回复，才会改变故事记录。</p> : <ul className="world-list">{view.world.userFacts().map((fact) => <li key={fact.id}><span className="status-dot" /><span>{fact.predicate === 'asked_about' ? '你问起了那顶失踪帽子的去向。' : fact.predicate === 'helped' ? '你帮猫向鸭侦探发出了求助。' : fact.predicate === 'completed_case' ? '你和鸭侦探一起，给帽子案画上了句号。' : `${fact.predicate} · ${fact.object}`}</span></li>)}</ul>}</section>
  </>;
}

export default function App() {
  const player = usePlayer();
  const pwa = usePwa();
  const [page, setPage] = useState<Page>(pageFromHash);
  const [installOpen, setInstallOpen] = useState(false);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const heading = useRef<HTMLElement>(null);
  const session = player.session;
  const view = player.view;
  const library = player.library;
  const episode = library.episodes.find((e) => e.id === session?.current) ?? library.episodes[0]!;
  const scenes = getScenes(episode);
  const cursor = view?.episodes[episode.id]?.cursor ?? 0;
  const scene = scenes[reviewIndex ?? cursor];
  const state = scene ? view?.episodes[episode.id]?.scenes[scene.id] ?? {} : {};
  const canAdvance = !!scene && (reviewIndex !== null || (getOptions(scene).length
    ? !!state.answer
    : scene.type === 'card' ? !!state.revealed : true));
  const today = session?.events.filter((event) => event.type === 'advance' && !event.skip && localDay(event.at) === localDay(new Date())).length ?? 0;

  useEffect(() => {
    const changed = () => { setPage(pageFromHash()); setReviewIndex(null); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  useEffect(() => {
    if (!player.loading) heading.current?.focus({ preventScroll: true });
  }, [page, player.loading]);

  useEffect(() => {
    document.title = `${page === 'watch' ? episode.title : page === 'progress' ? '学习足迹' : page === 'settings' ? '偏好设置' : '让英语接着发生'} · ENDLESS`;
  }, [page, episode.title]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (page !== 'watch' || !scene || player.busy || reviewIndex !== null || state.answer || document.querySelector('dialog[open]')) return;
      if (event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]'))) return;
      if (/^[1-4]$/.test(event.key) && getOptions(scene)[Number(event.key) - 1]) {
        event.preventDefault();
        void player.dispatch({ type: 'answer', scene: scene.id, choice: Number(event.key) - 1 });
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [page, scene, state.answer, player.busy, reviewIndex, player.dispatch]);

  async function select(selected: Episode) {
    if (await player.dispatch({ type: 'select', episode: selected.id })) {
      setReviewIndex(null);
      navigate('watch');
      window.scrollTo(0, 0);
    }
  }

  async function advance(skip = false) {
    if (!scene) return;
    if (reviewIndex !== null) setReviewIndex(reviewIndex + 1 >= scenes.length ? null : reviewIndex + 1);
    else await player.dispatch({ type: 'advance', scene: scene.id, skip });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  async function generate() {
    if (await player.generate()) {
      setReviewIndex(null);
      navigate('watch');
      window.scrollTo(0, 0);
    }
  }

  if (player.loading) return <div className="boot-screen"><Brand /><span className="loading-line" /><p>把上次的故事找回来…</p></div>;
  if (player.failure || !session || !view) return <div className="boot-screen failure-screen"><Brand /><h1>先等一下，存档还没准备好。</h1><p role="alert">{player.failure || '无法读取本地进度。'}</p><p>不会清除或覆盖你已有的数据。请检查浏览器存储权限后重试。</p><div className="button-row"><button className="button button-dark" onClick={() => location.reload()}>重新读取</button>{player.raw != null && <button className="button button-outline" onClick={() => downloadSession(player.raw)}>下载原始存档</button>}</div></div>;

  return <div className={`app-shell${session.largeText ? ' large-text' : ''}`}>
    <a href="#main-content" className="skip-link" onClick={(event) => { event.preventDefault(); heading.current?.focus(); }}>跳到主要内容</a>
    <aside className="sidebar"><a href="#home" className="brand-link" aria-label="ENDLESS 首页"><Brand /></a><span className="sidebar-caption">STAY FOR THE STORY.</span><nav aria-label="主要导航">{([
      ['home', 'discover', '发现故事'], ['library', 'book', '内容管理'], ['edition', 'spark', 'Edition 专题'], ['progress', 'progress', '学习足迹'], ['settings', 'settings', '偏好设置'],
    ] as const).map(([destination, icon, label]) => <a key={destination} href={`#${destination}`} className={`nav-link${page === destination || (destination === 'home' && page === 'watch') ? ' active' : ''}`} aria-current={page === destination || (destination === 'home' && page === 'watch') ? 'page' : undefined}><Icon name={icon} /><span>{label}</span>{destination === 'home' && <span className="nav-dot" />}</a>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="little-spark"><Icon name="spark" size={24} /></span><p>追一个故事，<br />顺便遇见英语。</p><span>NO STREAKS. JUST STORIES.</span></div><button className="install-sidebar" onClick={() => setInstallOpen(true)}><Icon name="download" size={18} /><span>{pwa.installed ? '已安装到此设备' : '安装到桌面'}</span><Icon name="arrow" size={16} /></button><div className="local-status"><span className="status-dot" />单设备 · 本地存档</div></div>
    </aside>
    <div className="workspace"><header className="topbar"><a href="#home" className="mobile-brand" aria-label="ENDLESS 首页"><Brand small /></a><span className="topbar-greeting">一点点好奇，就够了。</span><div className="topbar-right"><span className="connection-state"><Icon name={pwa.offline ? 'cloud' : 'leaf'} size={15} />{pwa.offline ? '正在离线体验' : '你的轻量英语时刻'}</span><span className="topbar-divider" /><span className="user-avatar" aria-label="本地用户">你</span></div></header>
      <main id="main-content" className="main-content" ref={heading} tabIndex={-1}>
        {player.notice && <div className="notice notice-error" role="alert"><Icon name="info" size={18} /><span>{player.notice}</span></div>}
        {pwa.updateAvailable && <div className="notice"><Icon name="spark" size={18} /><span>有新版本可用。当前进度已保存后再更新。</span><button className="text-button" disabled={player.saving} onClick={() => void pwa.update()?.catch(() => {})}>更新应用<Icon name="arrow" size={15} /></button></div>}
        {page === 'home' && <Home view={view} current={episode} busy={player.busy} onSelect={(selected) => void select(selected)} library={library} player={player} onGenerate={() => void generate()} />}
        {page === 'library' && <LibraryPage player={player} />}
        {page === 'edition' && <EditionPage />}
        {page === 'progress' && <Progress view={view} onDiscover={() => navigate('home')} notes={player.learningNotes} />}
        {page === 'settings' && <>
          <section className="page-heading"><div><span className="eyebrow">MAKE YOURSELF AT HOME.</span><h1>按你的节奏来<span className="heading-dot">。</span></h1><p>少一点设置，多一点轻松。</p></div></section>
          <section className="surface settings-surface"><div className="section-heading"><h2>阅读与设备</h2><Icon name="settings" /></div><div className="setting-row"><div><strong>更大的故事文字</strong><p>让对白和选项再清楚一点。</p></div><button role="switch" aria-checked={session.largeText} aria-label="更大的故事文字" className={`toggle${session.largeText ? ' on' : ''}`} disabled={player.saving} onClick={() => void player.dispatch({ type: 'text', large: !session.largeText })}><span /></button></div>
            <div className="setting-row"><div><strong>离线内容</strong><p>{pwa.workerError ? '离线缓存注册失败，请检查浏览器设置后刷新。' : pwa.ready ? '试播故事和界面已缓存，断网也可以继续。' : import.meta.env.DEV ? '开发模式不启用离线缓存，请使用生产构建预览验证。' : '正在准备缓存，请保持联网。'}</p></div><span className={`subtle-badge${pwa.ready ? ' badge-ready' : ''}`}>{pwa.ready ? '已就绪' : pwa.workerError ? '待重试' : '准备中'}</span></div>
            <div className="setting-row"><div><strong>独立应用窗口</strong><p>固定到桌面或任务栏，下次直接继续。</p></div><button className="text-button" onClick={() => setInstallOpen(true)}>{pwa.installed ? '查看安装说明' : '安装说明'}<Icon name="arrow" size={16} /></button></div>
          </section>
          <section className="surface settings-surface"><div className="section-heading"><h2>你的数据，由你保管</h2><Icon name="desktop" /></div><p className="muted-copy">进度和已生成故事保存在当前浏览器。点击 AI 生成时，会将学习与剧情记录发送到本机服务，所需上下文会发送给模型供应商；服务端缓存生成任务与结果。不提供账号或跨设备同步。清理站点数据会移除本地存档，可以先下载备份。</p><button className="button button-outline" onClick={() => { const b = player.backup(); if (b) downloadSession(b); }}><Icon name="download" size={17} />导出完整备份</button><p className="section-footnote">备份包含 AI 内容原件、修订、分支事件与归档；在「内容管理」页可导入恢复。</p></section>
          <GenerationPanel player={player} onGenerate={() => void generate()} />
          <div className="about-pilot"><Brand small /><span>LOCAL AI MVP · 本机 AI 续写版</span><p>三个预置故事作为起点。后续由 AI 续写，校验后保存；生成新内容需要联网并运行本机服务。</p></div>
        </>}
        {page === 'watch' && <>
          <div className="watch-heading"><button className="text-button back-button" onClick={() => navigate('home')}><Icon name="back" size={17} />返回频道</button><span>{reviewIndex !== null ? '回看模式 · 不重复记录学习' : episode.presentation ? `${episode.presentation.series === 'duck_detective' ? 'DUCK DETECTIVE / ' : ''}${episode.presentation.label}` : 'DUCK DETECTIVE / 鸭侦探事务所'}</span><span className="save-status" role="status">{player.saving ? '正在保存…' : '本地自动保存'}<Icon name={player.saving ? 'clock' : 'check'} size={14} /></span></div>
          <div className="watch-title"><span className="eyebrow">EPISODE {String(library.episodes.indexOf(episode) + 1).padStart(2, '0')}</span><h1>{episode.title}</h1><span lang="en">{episode.subtitle}</span></div>
          <div className="watch-grid"><div className="watch-main">
            {scene ? <section className="scene-card" key={`${episode.id}-${scene.id}-${reviewIndex !== null}`}>
              <div className="scene-card-header"><span><Icon name={scene.type === 'comic' ? 'comic' : scene.type === 'chat' ? 'chat' : 'target'} size={17} />{scene.type === 'comic' ? '故事正在发生' : scene.type === 'chat' ? '加入这段对话' : '发现一个小线索'}</span><span>{String((reviewIndex ?? cursor) + 1).padStart(2, '0')} / {String(scenes.length).padStart(2, '0')}</span></div>
              <div className="scene-progress" aria-label={`本集第 ${(reviewIndex ?? cursor) + 1} 段，共 ${scenes.length} 段`}>{scenes.map((_, index) => <span key={index} className={index <= (reviewIndex ?? cursor) ? 'filled' : ''} />)}</div>
              <SceneRenderer scene={scene} state={state} glossary={library.glossary} presentation={episode.presentation}
                readingItems={[...new Set(episode.ast.targets.filter((target) => target.sceneId === scene.id && /^(panels|messages)\[/.test(target.path)).map((target) => target.itemId))]}
                busy={player.saving} review={reviewIndex !== null} onAnswer={(choice) => void player.dispatch({ type: 'answer', scene: scene.id, choice })} onReveal={() => void player.dispatch({ type: 'reveal', scene: scene.id })} />
              <div className="scene-actions"><span className="keyboard-note">{scene.type === 'comic' ? '读完了，就接着往下看。' : reviewIndex !== null ? '回看不会重复评分或改写剧情。' : state.answer ? '你的尝试，已经留下来了。' : '也可按数字键 1–4 选择'}</span><div>{!canAdvance && <button className="text-button skip-button" disabled={player.saving} onClick={() => void advance(true)}>先跳过</button>}<button className="button button-dark" disabled={player.saving || !canAdvance} onClick={() => void advance()}>{reviewIndex !== null ? '继续回看' : cursor === scenes.length - 1 ? '看完这一集' : episode.presentation && episode.presentation.kind !== 'story' ? '继续' : '继续故事'}<Icon name="arrow" size={17} /></button></div></div>
            </section> : <>
              <section className="surface completion-card"><span className="completion-symbol"><Icon name="check" size={36} /></span><span className="eyebrow">A LITTLE STORY, WELL SPENT.</span><h2>{episode.presentation && episode.presentation.kind !== 'story' ? '这一段内容，留下来了。' : '这一段故事，留下来了。'}</h2><p>你不需要记住所有细节。<br />一次阅读、一次回应，都是真实的一小步。</p>
                <div className="completion-stats"><Stat icon="comic" value={Object.values(view.episodes[episode.id]?.scenes ?? {}).filter((s) => s.completed).length} label="读完的片段" /><Stat icon="chat" value={Object.values(view.episodes[episode.id]?.scenes ?? {}).filter((s) => s.answer).length} label="互动尝试" /></div>
                <div className="completion-buttons">{library.episodes[library.episodes.indexOf(episode) + 1]
                  ? <button className="button button-dark" disabled={player.busy} onClick={() => void select(library.episodes[library.episodes.indexOf(episode) + 1]!)}>去看下一集<Icon name="arrow" size={17} /></button>
                  : <button className="button button-dark" onClick={() => navigate('progress')}>看看学习足迹<Icon name="arrow" size={17} /></button>}
                  <button className="button button-outline" onClick={() => setReviewIndex(0)}><Icon name="repeat" size={16} />回看本集</button></div>
                <span className="completion-note">已保存的故事可以随时回看；AI 新内容需要联网生成。</span>
              </section>
              {(player.readyForGeneration || player.ticket) && <GenerationPanel player={player} onGenerate={() => void generate()} />}
            </>}
            <p className="watch-bottom-note"><Icon name="leaf" size={15} />不追求全对，只保持好奇。</p>
          </div><aside className="story-rail"><div className="rail-channel"><div className="rail-characters">{seriesOf(episode).cast.slice(0, 3).map((kind) => <Character key={kind} kind={kind} />)}</div><span className="eyebrow">YOUR STORY CHANNEL</span><h3>{isPilotStory(episode) ? <>认真办案，<br />顺便学点英语。</> : <>{seriesOf(episode).label}，<br />顺便学点英语。</>}</h3><p>{isPilotStory(episode) ? '跟随角色、看看线索，再给出你的回应。不是考试，不用着急。' : '跟着内容慢慢读，再给出你的回应。不是考试，不用着急。'}</p><span className="subtle-badge">日常英语 · A1–A2</span></div><div className="rail-note"><span className="eyebrow">TODAY, LITTLE BY LITTLE</span><div className="rail-today"><strong>{today}</strong><span>段故事，已读完</span></div><p>进度会自动保存在此设备。<br />随时停下，下次再继续。</p></div><div className="rail-tip"><Icon name="book" size={18} /><p>需要时放心看提示。我们会把它记作练习，而不是一次“已经记住”。</p></div></aside></div>
        </>}
      </main>
    </div>
    <nav className="mobile-nav" aria-label="移动导航">{([['home', 'discover', '发现'], ['library', 'book', '管理'], ['progress', 'progress', '足迹'], ['settings', 'settings', '设置']] as const).map(([destination, icon, label]) => <a key={destination} href={`#${destination}`} className={page === destination || (destination === 'home' && page === 'watch') ? 'active' : ''} aria-current={page === destination || (destination === 'home' && page === 'watch') ? 'page' : undefined}><Icon name={icon} size={21} /><span>{label}</span></a>)}</nav>
    {installOpen && <InstallDialog pwa={pwa} onClose={() => setInstallOpen(false)} />}
  </div>;
}
