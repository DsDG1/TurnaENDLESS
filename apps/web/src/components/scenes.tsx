import { getOptions, type EpisodePresentation, type Library, type PlayableScene, type SceneProgress } from '@endless/player';
import { CHARACTER_NAME_BY_ID, Character, ClueArt, PropArt, SceneBackdrop } from './art.js';
import { Icon } from './icons.js';

const names: Record<string, string> = Object.fromEntries(CHARACTER_NAME_BY_ID);

/**
 * ENDLESS 与 Edition 的正文称谓必须分开，否则 Edition 阅读器会自称「故事」。
 * ENDLESS：故事类内容说「故事」，日常/短帖/知识类说「内容」。
 * Edition：一律说「正文」，其层级用期/单元，与 ENDLESS 的集/段不混用。
 */
const bodyWord = (kind?: string): '故事' | '内容' | '正文' =>
  kind === 'edition' || kind === 'review' ? '正文'
    : kind === 'daily' || kind === 'social' || kind === 'knowledge' ? '内容'
      : '故事';

const quizKind: Record<string, [string, string]> = {
  cloze: ['FILL THE BLANK', '这句在{B}刚出现过，缺了一个词。'],
  meaning: ['WORD CHECK', '{B}出现过这个词，选一个意思。'],
  sentence: ['PICK THE LINE', '哪一句在{B}出现过？'],
  find: ['FIND IT', '把词和对应的图对上。'],
};

const chatSkins: Record<string, [string, string]> = {
  messenger: ['消息', '聊天记录'],
  dating: ['约会对话', '轻松聊天'],
  forum: ['社区帖子', '公开的帖子'],
  news_comments: ['评论区', '读完可以回复'],
};

function Actor({ reference }: { reference: string }) {
  const parsed = reference.match(/^@char:([a-z_]+)(?:\{expr=([a-z]+)\})?/);
  return parsed ? <Character kind={parsed[1]!} expression={parsed[2]} className="panel-actor" /> : null;
}

export function SceneRenderer({
  scene, state, glossary, readingItems, busy, review, presentation, onAnswer, onReveal,
}: {
  scene: PlayableScene;
  state: SceneProgress;
  glossary: Library['glossary'];
  readingItems: string[];
  busy: boolean;
  review: boolean;
  presentation?: EpisodePresentation;
  onAnswer(choice: number): void;
  onReveal(): void;
}) {
  const options = getOptions(scene);
  const answer = state.answer;
  const showSolution = !!answer || review;
  const entry = scene.evidence ? glossary[scene.evidence.item] : undefined;
  const sourceLabel = presentation?.sceneSources?.[scene.id];
  const channelLabel = presentation?.label ?? '鸭侦探事务所';
  const skin = scene.type === 'chat' ? scene.skin : 'messenger';
  const isForumLike = skin === 'forum' || skin === 'news_comments';
  const body = bodyWord(presentation?.kind);
  const quizCaption = (text: string) => text.replaceAll('{B}', body);

  return <div className={`scene-body scene-${scene.type}`}>
    {scene.type === 'comic' && <>
      <div className="scene-intro"><h2>{!presentation || presentation.legacy ? '每个小谜题都从一句话开始。' : body === '正文' ? '这一段正文从一句话开始。' : '这一段内容从一句话开始。'}</h2><p>读不懂的地方可以先跳过。</p></div>
      <div className="comic-panels">
        {scene.panels.map((panel, index) => <div className={`comic-panel panel-${index}`} key={index}>
          {index === 0 && <SceneBackdrop tag={scene.setting} />}
          <span className="panel-number">{String(index + 1).padStart(2, '0')}</span>
          {panel.caption && <p className="panel-caption" lang="en">{panel.caption}</p>}
          <div className="panel-dialogue" lang="en">
            {panel.bubbles.map((bubble, bi) => <div className={`speech speech-${bubble.speaker}`} key={bi}>
              <span>{names[bubble.speaker] ?? bubble.speaker}</span>
              <p>{bubble.text}</p>
            </div>)}
          </div>
          <div className="panel-stage">{panel.actors.map((actor, ai) => <Actor key={ai} reference={actor} />)}{!!panel.props.length && <div className="panel-props">{panel.props.map((prop, pi) => <PropArt key={pi} reference={prop} />)}</div>}</div>
          <div className="panel-floor" />
        </div>)}
      </div>
    </>}
    {scene.type === 'chat' && <div className={`chat-window chat-skin-${skin}`}>
      <div className="chat-window-header"><div className={`avatar avatar-${scene.messages[0]?.from ?? 'duck'}`}><Character kind={scene.messages[0]?.from ?? 'duck'} /></div><div><strong>{channelLabel}</strong><span>{chatSkins[skin]?.join(' · ') ?? '聊天'}</span></div><span className="live-dot" /></div>
      {isForumLike
        ? <div className="forum-thread" lang="en">
            {scene.messages.map((message, index) => <article className="forum-post" key={index}>
              <header><div className={`avatar avatar-${message.from}`}><Character kind={message.from} /></div><div><span className="message-name">{names[message.from] ?? message.from}</span><small>{skin === 'forum' ? (index === 0 ? '楼主 · 帖子' : `回复 #${index}`) : `评论 #${index + 1}`}</small></div></header>
              <p>{message.text}</p>
            </article>)}
            {answer && <article className="forum-post forum-post-mine"><header><div><span className="message-name">You</span><small>你的回复</small></div></header><p>{options[answer.choice]?.label}</p></article>}
            {answer && scene.reply && <article className="forum-post forum-post-response"><header><div className={`avatar avatar-${answer.correct ? scene.reply.on_correct.from : scene.reply.on_wrong.from}`}><Character kind={answer.correct ? scene.reply.on_correct.from : scene.reply.on_wrong.from} /></div><div><span className="message-name">{names[answer.correct ? scene.reply.on_correct.from : scene.reply.on_wrong.from]}</span></div></header><p>{answer.correct ? scene.reply.on_correct.text : scene.reply.on_wrong.text}</p></article>}
          </div>
        : <div className="chat-messages" lang="en">
            {scene.messages.map((message, index) => <div className={`chat-message from-${message.from}`} key={index}>
              <div className={`avatar avatar-${message.from}`}><Character kind={message.from} /></div>
              <div><span className="message-name">{names[message.from] ?? message.from}</span><p>{message.text}</p></div>
            </div>)}
            {answer && <div className="chat-message sent"><div><span className="message-name">You</span><p>{options[answer.choice]?.label}</p></div></div>}
            {answer && scene.reply && <div className="chat-message response"><div className="avatar"><Character kind={answer.correct ? scene.reply.on_correct.from : scene.reply.on_wrong.from} /></div><div><span className="message-name">{names[answer.correct ? scene.reply.on_correct.from : scene.reply.on_wrong.from]}</span><p>{answer.correct ? scene.reply.on_correct.text : scene.reply.on_wrong.text}</p></div></div>}
          </div>}
    </div>}
    {scene.type === 'pick' && <>
      <div className="clue-frame"><span className="eyebrow">A LITTLE CLUE</span>
        {!presentation || presentation.legacy === true
          ? <ClueArt variant={scene.evidence?.item === 'lx:under#prep.location' ? 'table' : scene.evidence?.item === 'lx:behind#prep.location' ? 'door' : 'borrow'} />
          : <div className="clue-prop"><PropArt reference="@emoji:magnifying_glass" /></div>}
      </div>
      <h2 className="pick-question" lang="en">{scene.question}</h2>
      <p className="question-caption">{presentation?.kind === 'knowledge' ? '根据标注的出处，选出正确的表达。' : '根据上下文，选一个合适的表达。'}</p>
    </>}
    {scene.type === 'quiz' && <>
      <div className="clue-frame"><span className="eyebrow">{quizKind[scene.kind]?.[0] ?? 'PRACTICE'}</span>
        <div className="clue-prop"><PropArt reference="@emoji:magnifying_glass" /></div>
        {sourceLabel && <span className="source-badge">{sourceLabel}</span>}
      </div>
      <h2 className="pick-question" lang={scene.kind === 'cloze' || scene.kind === 'sentence' ? 'en' : 'zh'}>
        {scene.prompt.split('____').map((part, i, arr) => <span key={i}>{part}{i < arr.length - 1 && <span className="quiz-blank" aria-label="空"> </span>}</span>)}
      </h2>
      <p className="question-caption">{quizCaption(quizKind[scene.kind]?.[1] ?? '做一道练习题。')}</p>
    </>}
    {scene.type === 'card' && <div className={`word-card${state.revealed || review ? ' flipped' : ''}`}>
      <span className="eyebrow">WORD CARD · 单词卡</span>
      <p className="word-card-front" lang="en">{scene.front}</p>
      {sourceLabel && <span className="source-badge">来源：{sourceLabel}</span>}
      {state.revealed || review
        ? <div className="word-card-back">{entry && <><strong lang="en">{entry.label}</strong><span>{entry.gloss}</span></>}
            <small>{presentation?.kind === 'knowledge'
              ? '释义和例句来自本地词库。'
              : `这句话在${body}里出现过，之后会再考你一次。`}</small></div>
        : <button className="text-button hint-button" disabled={busy} onClick={onReveal}><Icon name="eye" size={16} />翻面看释义</button>}
    </div>}
    {!!options.length && <>
      {scene.type === 'chat' && <div className="reply-label"><Icon name="chat" size={17} /><span>{scene.reply?.prompt ? scene.reply.prompt : '轮到你了 · 选择一句回复'}</span></div>}
      <div className="answer-options" role="group" aria-label="回答选项">
        {options.map((option, index) => {
          const selected = answer?.choice === index;
          const correct = showSolution && option.correct === true;
          return <button
            type="button"
            className={`answer-option${selected ? ' selected' : ''}${correct ? ' correct' : ''}${selected && !answer?.correct ? ' incorrect' : ''}`}
            key={index}
            disabled={busy || showSolution}
            aria-label={`${index + 1}. ${option.label}`}
            aria-pressed={selected}
            onClick={() => onAnswer(index)}
          ><span className="option-index">{correct ? <Icon name="check" size={15} /> : selected ? <Icon name="close" size={15} /> : index + 1}</span>{option.asset && <PropArt reference={option.asset} />}<span lang={scene.type === 'quiz' && (scene.kind === 'meaning' || scene.kind === 'find') ? 'zh' : 'en'}>{option.label}</span>{correct && <span className="correct-label">正确表达</span>}</button>;
        })}
      </div>
      <div aria-live="polite" className="feedback-region">
        {answer ? <div className={`answer-feedback ${answer.correct ? 'feedback-good' : 'feedback-try'}`}>
          <Icon name={answer.correct ? 'check' : 'leaf'} size={19} />
          <div><strong>{answer.correct ? '回答正确。' : '答错了。'}</strong>
            {(scene.type === 'pick' || scene.type === 'quiz') && <p lang={scene.type === 'quiz' && scene.kind !== 'cloze' ? 'zh' : 'en'}>{answer.correct ? scene.feedback.on_correct : scene.feedback.on_wrong}</p>}
            {entry && <p className="word-explanation"><span lang="en">{entry.label}</span><span>{entry.gloss}</span></p>}
            <small>{answer.qualified ? '首次独立作答已记入学习记录，复习时间由 FSRS 安排。' : '这次是练习，不推进间隔复习记录。'}</small>
          </div>
        </div> : !review && presentation?.kind !== 'review' && entry && <div className="hint-area">
          {state.revealed ? <p className="hint-text"><Icon name="book" size={16} /><span><strong>{entry.label}</strong> · {entry.gloss}。看过提示后，这一题会记为练习。</span></p> : <button className="text-button hint-button" disabled={busy} onClick={onReveal}><Icon name="eye" size={16} />需要一点提示？</button>}
        </div>}
      </div>
    </>}
    {!!readingItems.length && (!scene.evidence || scene.evidence.type === 'practice' || showSolution) &&
      <aside className="scene-vocabulary" aria-label={`${body}里的表达`}><strong><Icon name="book" size={16} />{body}里的表达</strong>
        {readingItems.map((item) => glossary[item] && <div key={item}><span lang="en">{glossary[item]!.label}</span><span>{glossary[item]!.gloss}</span></div>)}
        <small>读完本片段后，这些表达会计入阅读记录。</small>
      </aside>}
  </div>;
}
