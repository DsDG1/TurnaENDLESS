import { useEffect, useMemo, useRef, useState } from 'react';
import type { Episode, Library, PlayerView } from '@endless/player';
import type { FillerCard } from '@endless/content';
import { Icon, type IconName } from './icons.js';
import { content } from '../content/catalog.js';
import type { Player } from '../player-model.js';

export function Stat({ icon, value, label }: { icon: IconName; value: number | string; label: string }) {
  return <div className="stat"><span className="stat-icon"><Icon name={icon} /></span><div><strong>{value}</strong><span>{label}</span></div></div>;
}

export function FillerBridgeCard({
  filler,
  generating,
  phase,
  nextReady,
}: {
  filler: FillerCard;
  generating: boolean;
  phase: string;
  nextReady: boolean;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const isAnswered = chosen !== null;
  const isCorrect = chosen !== null && filler.options[chosen]?.correct;

  return (
    <div className="filler-bridge-card" role="region" aria-label="线索回顾小关卡">
      <div className="filler-bridge-header">
        <span className="eyebrow">线索回顾 · 派生小关卡</span>
        <span className="source-badge">回顾自：{filler.sourceEpisodeTitle}</span>
      </div>
      <p className="filler-bridge-prompt" lang="en">
        {filler.clozePrompt.split('____').map((part, i, arr) => (
          <span key={i}>
            {part}
            {i < arr.length - 1 && <span className="quiz-blank" aria-label="待填空" />}
          </span>
        ))}
      </p>
      <p className="filler-bridge-caption">在之前的故事里出现过这句话，选出正确的单词。</p>
      <div className="filler-options" role="group" aria-label="答案选项">
        {filler.options.map((option, idx) => {
          const selected = chosen === idx;
          const showCorrect = isAnswered && option.correct;
          const showWrong = selected && !option.correct;
          return (
            <button
              key={idx}
              type="button"
              className={`answer-option${selected ? ' selected' : ''}${showCorrect ? ' correct' : ''}${showWrong ? ' incorrect' : ''}`}
              disabled={isAnswered}
              onClick={() => setChosen(idx)}
              aria-label={option.label}
            >
              <span className="option-index">{idx + 1}</span>
              <span lang="en">{option.label}</span>
            </button>
          );
        })}
      </div>
      {isAnswered && (
        <div className={`filler-feedback ${isCorrect ? 'correct' : 'incorrect'}`} role="status">
          <Icon name={isCorrect ? 'check' : 'info'} size={15} />
          <span>{isCorrect ? filler.feedback.on_correct : filler.feedback.on_wrong}</span>
        </div>
      )}
      <div className="filler-status">
        <span className={`status-dot${generating ? ' status-pulse' : ''}`} />
        <span>
          {nextReady
            ? '✨ 下一集故事已准备就绪，可以随时启程！'
            : generating
            ? `AI 正在根据你的进展续写下一集（${phase || '构思剧情中…'}）`
            : '已读完现有全部内容，可以随时回看。'}
        </span>
      </div>
    </div>
  );
}

export function IntermissionBridge({
  episode,
  episodeNumber,
  view,
  library,
  nextEpisodeId,
  player,
  autoAdvanceEnabled,
  onToggleAutoAdvance,
  onSelectNext,
  onReview,
  onViewProgress,
}: {
  episode: Episode;
  episodeNumber: number;
  view: PlayerView;
  library: Library;
  nextEpisodeId?: string;
  player: Player;
  autoAdvanceEnabled: boolean;
  onToggleAutoAdvance(): void;
  onSelectNext(): void;
  onReview(): void;
  onViewProgress(): void;
}) {
  const [countdown, setCountdown] = useState<number>(3);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  // 回调经由 ref 转发：App 传入的是内联箭头，身份随渲染变化，
  // 直接放进依赖会让倒计时 interval 被反复重建拖慢。
  const selectNextRef = useRef(onSelectNext);
  const firedRef = useRef(false);

  useEffect(() => {
    selectNextRef.current = onSelectNext;
  }, [onSelectNext]);

  // 倒计时 interval 只负责递减；真正的换集触发在下面的独立 effect 里。
  useEffect(() => {
    if (!nextEpisodeId || !autoAdvanceEnabled || isPaused) {
      setCountdown(3);
      firedRef.current = false;
      return;
    }
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [nextEpisodeId, autoAdvanceEnabled, isPaused]);

  // 走到 0 才触发；保存/同步进行中先等待（与手动按钮的 busy 保护一致）。
  // firedRef 兼容 StrictMode 下同一渲染的 effect 双跑，避免连点两次换集。
  useEffect(() => {
    if (countdown !== 0 || !nextEpisodeId || !autoAdvanceEnabled || isPaused || player.busy || firedRef.current) return;
    firedRef.current = true;
    selectNextRef.current();
  }, [countdown, nextEpisodeId, autoAdvanceEnabled, isPaused, player.busy]);

  // 填缝卡只在幕间（结算态）挂载时才派生，避免每次作答/推进都全量重算词库与历史
  const fillerCard = useMemo<FillerCard | null>(() => {
    if (player.cloudMode || !player.session) return null;
    try {
      return content.deriveFiller(player.session, library);
    } catch {
      return null;
    }
  }, [player.cloudMode, player.session, library]);

  const episodeWords = [...new Set(episode.ast.targets.map((t) => t.itemId))]
    .map((id) => library.glossary[id])
    .filter((g): g is NonNullable<typeof g> => !!g);

  const completedScenes = Object.values(view.episodes[episode.id]?.scenes ?? {}).filter((s) => s.completed).length;
  const answeredScenes = Object.values(view.episodes[episode.id]?.scenes ?? {}).filter((s) => s.answer).length;

  return (
    <section className="surface intermission-bridge" role="region" aria-label="幕间过渡与本集回顾">
      <div className="intermission-header">
        <span className="eyebrow">INTERMISSION · 幕间休息</span>
        <div className="auto-advance-toggle">
          <label className="toggle-label">
            <span>连续流转</span>
            <button
              type="button"
              role="switch"
              aria-checked={autoAdvanceEnabled}
              className={`toggle-pill${autoAdvanceEnabled ? ' on' : ''}`}
              onClick={onToggleAutoAdvance}
              title={autoAdvanceEnabled ? '点击关闭自动连播' : '点击开启自动连播'}
            >
              <span className="toggle-thumb" />
            </button>
          </label>
        </div>
      </div>

      <div className="intermission-banner">
        <span className="completion-symbol"><Icon name="check" size={32} /></span>
        <div className="intermission-title">
          <h2>第 {episodeNumber + 1} 集阅读达成！</h2>
          <p>{episode.title} · {episode.subtitle}</p>
        </div>
      </div>

      {episodeWords.length > 0 && (
        <div className="intermission-words" aria-label="本集核心词汇">
          <span className="words-badge">本集线索词汇</span>
          <div className="words-chips">
            {episodeWords.map((w, idx) => (
              <span key={idx} className="word-chip">
                <strong lang="en">{w.label}</strong>
                <span>{w.gloss}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="completion-stats">
        <Stat icon="comic" value={completedScenes} label="读完的片段" />
        <Stat icon="chat" value={answeredScenes} label="互动尝试" />
      </div>

      {fillerCard && (!nextEpisodeId || player.generating) && (
        <FillerBridgeCard
          filler={fillerCard}
          generating={player.generating}
          phase={player.phase}
          nextReady={!!nextEpisodeId}
        />
      )}

      {nextEpisodeId ? (
        <div className="intermission-flow-action">
          {autoAdvanceEnabled && !isPaused && countdown > 0 && (
            <div className="auto-advance-bar-container" aria-live="polite">
              <div className="auto-advance-bar" style={{ animationDuration: '3s' }} />
              <div className="auto-advance-info">
                <span>⏱️ {countdown} 秒后自动滑入下一集（按 Space 直接进）</span>
                <button type="button" className="pause-btn" onClick={() => setIsPaused(true)}>暂停</button>
              </div>
            </div>
          )}
          {autoAdvanceEnabled && isPaused && (
            <div className="auto-advance-paused-info">
              <span>已暂停自动连播</span>
              <button type="button" className="resume-btn" onClick={() => setIsPaused(false)}>继续连播</button>
            </div>
          )}
          <div className="completion-buttons">
            <button className="button button-lime action-next" disabled={player.busy} onClick={onSelectNext}>
              <Icon name="play" size={17} />
              <span>进入下一集 (Space)</span>
              <Icon name="arrow" size={17} />
            </button>
            <button className="button button-outline" onClick={onReview}>
              <Icon name="repeat" size={16} />
              <span>回看本集</span>
            </button>
          </div>
        </div>
      ) : player.generating ? (
        <div className="completion-buttons">
          <button className="button button-dark" disabled aria-busy="true">
            <Icon name="spark" size={17} />
            <span>AI 正在为你准备下一集…</span>
          </button>
          <button className="button button-outline" onClick={onReview}>
            <Icon name="repeat" size={16} />
            <span>回看本集</span>
          </button>
        </div>
      ) : (
        <div className="completion-buttons">
          <button className="button button-dark" onClick={onViewProgress}>
            <Icon name="book" size={17} />
            <span>查看阅读记录</span>
            <Icon name="arrow" size={17} />
          </button>
          <button className="button button-outline" onClick={onReview}>
            <Icon name="repeat" size={16} />
            <span>回看本集</span>
          </button>
        </div>
      )}

      <span className="completion-note">
        {player.generating
          ? '后台正在静默生成新故事；生成完成后可立即无缝阅读。'
          : nextEpisodeId
          ? '也可以按键盘快捷键 Space 或触屏向上轻扫直接进入下一集。'
          : '已保存的内容可以随时回看；AI 新内容需要联网生成。'}
      </span>
    </section>
  );
}
