import { getOptions, type Library, type PlayableScene, type SceneProgress } from '@endless/player';
import { Character, ClueArt, PropArt } from './art.js';
import { Icon } from './icons.js';

const names: Record<string, string> = { duck: 'Duck', cat: 'Cat', moon: 'Moon' };

const quizKind: Record<string, [string, string]> = {
  cloze: ['FILL THE BLANK', '这句话刚在故事里读过——缺了一个词。'],
  meaning: ['WORD CHECK', '故事里遇见过它——挑一个意思。'],
  sentence: ['PICK THE LINE', '哪一句在故事里说得对？'],
  find: ['FIND IT', '把词和图案对上。'],
};

function Actor({ reference }: { reference: string }) {
  const name = reference.match(/^@char:([a-z_]+)/)?.[1];
  return name ? <Character kind={name} className="panel-actor" /> : null;
}

export function SceneRenderer({
  scene, state, glossary, readingItems, busy, review, onAnswer, onReveal,
}: {
  scene: PlayableScene;
  state: SceneProgress;
  glossary: Library['glossary'];
  readingItems: string[];
  busy: boolean;
  review: boolean;
  onAnswer(choice: number): void;
  onReveal(): void;
}) {
  const options = getOptions(scene);
  const answer = state.answer;
  const showSolution = !!answer || review;
  const entry = scene.evidence ? glossary[scene.evidence.item] : undefined;

  return <div className={`scene-body scene-${scene.type}`}>
    {scene.type === 'comic' && <>
      <div className="scene-intro"><h2>每个小谜题，都从一句话开始。</h2><p>慢慢读就好，不用记住每个单词。</p></div>
      <div className="comic-panels">
        {scene.panels.map((panel, index) => <div className={`comic-panel panel-${index}`} key={index}>
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
    {scene.type === 'chat' && <div className="chat-window">
      <div className="chat-window-header"><div className="avatar avatar-duck"><Character kind="duck" /></div><div><strong>Duck Detective</strong><span>案件讨论组 · 你也是搭档</span></div><span className="live-dot" /></div>
      <div className="chat-messages" lang="en">
        {scene.messages.map((message, index) => <div className={`chat-message from-${message.from}`} key={index}>
          <div className={`avatar avatar-${message.from}`}><Character kind={message.from} /></div>
          <div><span className="message-name">{names[message.from] ?? message.from}</span><p>{message.text}</p></div>
        </div>)}
        {answer && <div className="chat-message sent"><div><span className="message-name">You</span><p>{options[answer.choice]?.label}</p></div></div>}
        {answer && scene.reply && <div className="chat-message response"><div className="avatar"><Character kind={answer.correct ? scene.reply.on_correct.from : scene.reply.on_wrong.from} /></div><div><span className="message-name">{names[answer.correct ? scene.reply.on_correct.from : scene.reply.on_wrong.from]}</span><p>{answer.correct ? scene.reply.on_correct.text : scene.reply.on_wrong.text}</p></div></div>}
      </div>
    </div>}
    {scene.type === 'pick' && <>
      <div className="clue-frame"><span className="eyebrow">A LITTLE CLUE</span><ClueArt variant={scene.evidence?.item === 'lx:under#prep.location' ? 'table' : scene.evidence?.item === 'lx:behind#prep.location' ? 'door' : 'borrow'} /></div>
      <h2 className="pick-question" lang="en">{scene.question}</h2>
      <p className="question-caption">跟着线索，选一个最合适的表达。</p>
    </>}
    {scene.type === 'quiz' && <>
      <div className="clue-frame"><span className="eyebrow">{quizKind[scene.kind]?.[0] ?? 'PRACTICE'}</span><ClueArt variant={scene.kind === 'find' ? 'door' : scene.kind === 'cloze' ? 'table' : 'borrow'} /></div>
      <h2 className="pick-question" lang={scene.kind === 'cloze' ? 'en' : 'zh'}>
        {scene.prompt.split('____').map((part, i, arr) => <span key={i}>{part}{i < arr.length - 1 && <span className="quiz-blank" aria-label="空"> </span>}</span>)}
      </h2>
      <p className="question-caption">{quizKind[scene.kind]?.[1] ?? '练一练。'}</p>
    </>}
    {scene.type === 'card' && <div className={`word-card${state.revealed || review ? ' flipped' : ''}`}>
      <span className="eyebrow">WORD CARD · 单词卡</span>
      <p className="word-card-front" lang="en">{scene.front}</p>
      {state.revealed || review
        ? <div className="word-card-back">{entry && <><strong lang="en">{entry.label}</strong><span>{entry.gloss}</span></>}
            <small>这句话在故事里出现过——混个脸熟，之后才会考你。</small></div>
        : <button className="text-button hint-button" disabled={busy} onClick={onReveal}><Icon name="eye" size={16} />翻面看释义</button>}
    </div>}
    {!!options.length && <>
      {scene.type === 'chat' && <div className="reply-label"><Icon name="chat" size={17} /><span>轮到你了 · 选择一句回复</span></div>}
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
          <div><strong>{answer.correct ? '就是这个意思。' : '没关系，又认识了一种表达。'}</strong>
            {(scene.type === 'pick' || scene.type === 'quiz') && <p lang={scene.type === 'quiz' && scene.kind !== 'cloze' ? 'zh' : 'en'}>{answer.correct ? scene.feedback.on_correct : scene.feedback.on_wrong}</p>}
            {entry && <p className="word-explanation"><span lang="en">{entry.label}</span><span>{entry.gloss}</span></p>}
            <small>{answer.qualified ? '首次独立作答已记入学习记录，复习时间由 FSRS 安排。' : '这次是练习，不推进间隔复习记录。'}</small>
          </div>
        </div> : !review && entry && <div className="hint-area">
          {state.revealed ? <p className="hint-text"><Icon name="book" size={16} /><span><strong>{entry.label}</strong> · {entry.gloss}。看过提示后，这一题会记为练习。</span></p> : <button className="text-button hint-button" disabled={busy} onClick={onReveal}><Icon name="eye" size={16} />需要一点提示？</button>}
        </div>}
      </div>
    </>}
    {!!readingItems.length && (!scene.evidence || scene.evidence.type === 'practice' || showSolution) &&
      <aside className="scene-vocabulary" aria-label="故事里的表达"><strong><Icon name="book" size={16} />故事里的表达</strong>
        {readingItems.map((item) => glossary[item] && <div key={item}><span lang="en">{glossary[item]!.label}</span><span>{glossary[item]!.gloss}</span></div>)}
        <small>先理解，不急着记住。读完本片段后会记入学习足迹。</small>
      </aside>}
  </div>;
}
