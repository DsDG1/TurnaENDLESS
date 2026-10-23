/**
 * Stub 导演脚本：无 API key 时驱动端到端冒烟（`lab smoke`）。
 * 产出 5 个互相不同的合法批次（鸭子侦探频道），brief 固定为
 * review = [under, where-is]、expose = [behind]（冒烟运行用 briefOverrides 钉死）。
 * 场景顺序逐批变化以避开 W-SEQUENCE-REPEAT 与防启动窗口。
 */
import type { LlmRequest } from '@endless/director';

const SEQUENCES: string[][] = [
  ['comic', 'hidden_object', 'chat', 'story'],
  ['comic', 'chat', 'hidden_object', 'story'],
  ['comic', 'hidden_object', 'story', 'chat'],
  ['hidden_object', 'comic', 'chat', 'story'],
  ['chat', 'comic', 'hidden_object', 'story'],
];

const TROPE_SETS: string[][] = [
  ['unreliable_witness', 'absurd_client'],
  ['trivial_case_gravitas', 'moon_vanity'],
  ['deadpan_escalation', 'over_seriousness'],
  ['mistaken_identity', 'mundane_solution'],
  ['running_gag', 'silent_reaction'],
];

const LOGLINES: string[] = [
  'The moon hires the duck because her favourite hat is missing.',
  'The duck takes the case of the missing hat very seriously.',
  'A small mystery about a hat becomes a big official case.',
  'The cat says two different things about one night.',
  'Everyone in Apartment 7 has a secret about the hat.',
];

const COMIC_LINES: string[] = [
  'Nobody asked you, cat.',
  'Take a seat, cat.',
  'Drink your coffee, cat.',
  'One moment, cat.',
  'Not now, cat.',
];

const DUCK_ENDINGS: string[] = [
  'For attention. Classic moon.',
  'For the news. Classic moon.',
  'For the show. Classic moon.',
  'For fun. Classic moon.',
  'For practice. Classic moon.',
];

const HOOKS: string[] = [
  "Who stole the moon's hat?",
  "Who took the moon's hat?",
  'Where is the truth?',
  'Who hid the hat?',
  'Who lies about the hat?',
];

const TARGET_SPOTS: string[] = ['table_under', 'sofa_behind', 'lamp_top', 'shelf_top', 'table_under'];

const DISTRACTOR_SETS: string[][] = [
  ['sock', 'banana', 'teapot'],
  ['sock', 'banana', 'bell'],
  ['teapot', 'bell', 'candle'],
  ['sock', 'teapot', 'cheese'],
  ['banana', 'candle', 'plant'],
];

function sceneBlock(type: string, n: number, sceneId: string): string {
  const seqIndex = n - 1;
  if (type === 'comic') {
    return `  - id: ${sceneId}
    type: comic
    cast: [duck, cat, moon]
    uses: [lx:behind#prep.location]
    setting: "@tag:agency_office"
    panels:
      - shot: wide
        actors: ["@char:moon{expr=sad}", "@char:duck{expr=neutral, hat=detective}"]
        bubbles:
          - {speaker: moon, text: "My favourite hat is gone."}
      - shot: close
        actors: ["@char:cat{expr=sweating}"]
        bubbles:
          - {speaker: cat, text: "I was behind the door. I saw nothing!"}
      - shot: close
        actors: ["@char:duck{expr=suspicious, hat=detective}"]
        bubbles:
          - {speaker: duck, text: "${COMIC_LINES[seqIndex]}"}`;
  }
  if (type === 'hidden_object') {
    const target = TARGET_SPOTS[seqIndex]!;
    const others = ['sofa_behind', 'table_under', 'lamp_top', 'shelf_top'].filter((s) => s !== target);
    const [d1, d2, d3] = DISTRACTOR_SETS[seqIndex]!;
    return `  - id: ${sceneId}
    type: hidden_object
    uses: [lx:under#prep.location]
    evidence: {item: lx:under#prep.location, type: recognition-4}
    background: "@tag:living_room"
    instruction: "The hat is under something. Find it."
    spots: [sofa_behind, table_under, lamp_top, shelf_top]
    objects:
      - {asset: "@emoji:top_hat", spot: ${target}, target: true}
      - {asset: "@emoji:${d1}", spot: ${others[0]}}
      - {asset: "@emoji:${d2}", spot: ${others[1]}}
      - {asset: "@emoji:${d3}", spot: ${others[2]}}`;
  }
  if (type === 'chat') {
    return `  - id: ${sceneId}
    type: chat
    skin: messenger
    cast: [duck]
    uses: [ck:where-is]
    evidence: {item: ck:where-is, type: recognition-4}
    messages:
      - {from: duck, text: "Good work. Now I must ask the moon one question."}
      - {from: duck, text: "What do I say?"}
    reply:
      options:
        - {label: "Where was your hat last night?", correct: true}
        - {label: "Who was your hat last night?"}
        - {label: "When was your hat last night?"}
        - {label: "How was your hat last night?"}
      on_correct: {from: duck, text: "Perfect. Very professional."}
      on_wrong:   {from: duck, text: "Hmm. The moon looks confused."}`;
  }
  // story
  const ending = DUCK_ENDINGS[seqIndex]!;
  return `  - id: ${sceneId}
    type: story
    cast: [duck, cat, moon]
    effects:
      accuse_cat:
        - open_thread: {id: cat_alibi_${n}, title: "Was the cat really asleep?", priority: 2, expires_after_cards: 120}
        - set_fact: {subject: cat, predicate: suspect_status, object: prime_suspect}
      accuse_moon:
        - set_fact: {subject: moon, predicate: suspect_status, object: suspect}
        - user_fact: {predicate: accused, object: moon}
    ink: |
      -> accuse
      === accuse ===
      Duck: The hat was under the table. Someone put it there.
      Duck: Who do you think did it?
      * [The cat]
          Cat: Me? I was asleep behind the sofa! # expr:cat:shocked
          Duck: Interesting. Before, you were behind the door. # effect:accuse_cat
      * [The moon]
          Moon: I hid my own hat? Why would I do that? # expr:moon:shocked
          Duck: ${ending} # effect:accuse_moon
      - -> END`;
}

export function stubBatchYaml(n: number): string {
  const seq = SEQUENCES[(n - 1) % SEQUENCES.length]!;
  const scenes = seq.map((type, i) => sceneBlock(type, n, `s${i + 1}`)).join('\n');
  return `
batch: dd-900${n}
channel: duck_detective
brief: lb-9001
cast: [duck, cat, moon]
hook_out: "${HOOKS[(n - 1) % HOOKS.length]!.replace(/"/g, '')}"

scenes:
${scenes}
`;
}

export function stubPlanYaml(n: number): string {
  const seq = SEQUENCES[(n - 1) % SEQUENCES.length]!;
  const beats = seq
    .map((type, i) => {
      const gist =
        type === 'comic'
          ? 'The moon arrives. The cat acts strangely.'
          : type === 'hidden_object'
            ? 'User searches the room.'
            : type === 'chat'
              ? 'Duck asks user one question.'
              : 'The accusation.';
      return `  - {n: ${i + 1}, scene: ${type}, gist: "${gist}"}`;
    })
    .join('\n');
  const underBeat = seq.indexOf('hidden_object') + 1;
  const whereBeat = seq.indexOf('chat') + 1;
  const behindBeat = seq.indexOf('comic') + 1;
  const tropes = TROPE_SETS[(n - 1) % TROPE_SETS.length]!.join(', ');
  // 世界状态改变（审计 §3）：stub 的 story 场景本来就写 effect，这里把编剧室的声明补上，
  // 让「预检 → 写手」这条链在冒烟里真的走一遍带 world_change 的分支
  const storyBeat = seq.indexOf('story') + 1;
  return `
logline: "${LOGLINES[(n - 1) % LOGLINES.length]}"
channel: duck_detective
cast: [duck, cat, moon]
beats:
${beats}
world_change:
  kind: open_thread
  carrier: ${storyBeat}
  note: "结尾指认一个人，留下新伏笔"
tropes: [${tropes}]
punchline: deadpan
learning_placement:
  - {item: lx:behind#prep.location, beat: ${behindBeat}, as: exposure}
  - {item: lx:under#prep.location, beat: ${underBeat}, as: recognition-4}
  - {item: ck:where-is, beat: ${whereBeat}, as: recognition-4}
hook_out: "${HOOKS[(n - 1) % HOOKS.length]!.replace(/'/g, '')}"
`;
}

/** Stub LLM 脚本：showrunner/writer/single 按各自调用次数轮换 5 个变体。 */
export function makeStubScript(): (req: LlmRequest, index: number) => string | undefined {
  const counts: Record<string, number> = {};
  return (req) => {
    counts[req.stage] = (counts[req.stage] ?? 0) + 1;
    const n = ((counts[req.stage]! - 1) % 5) + 1;
    if (req.stage === 'showrunner') return stubPlanYaml(n);
    if (req.stage === 'writer' || req.stage === 'single') return stubBatchYaml(n);
    if (req.stage === 'repair') return ''; // stub 批次不应触发修复
    return undefined;
  };
}
