/** 校验器测试夹具：基准批次取自实验方案第 5.8.5 节的完整示例（dd-0042）。 */
import type { Batch } from '../src/model.js';
import type { ValidationContext } from '../src/validate.js';
import { parseBatch } from '../src/parse.js';

export const LEXICON: Record<string, { forms: string[]; confusables: string[] }> = {
  'lx:behind#prep.location': {
    forms: ['behind'],
    confusables: ['lx:under#prep.location', 'lx:in-front-of#prep.location'],
  },
  'lx:under#prep.location': {
    forms: ['under'],
    confusables: ['lx:behind#prep.location', 'lx:in-front-of#prep.location'],
  },
  'lx:in-front-of#prep.location': {
    forms: ['in front of'],
    confusables: ['lx:behind#prep.location', 'lx:under#prep.location'],
  },
  'ck:where-is': {
    forms: ['where is', "where's", 'where are', 'where was', 'where were'],
    confusables: [],
  },
  'pt:there-is-are': {
    forms: ['there is', 'there are', 'there was', 'there were'],
    confusables: [],
  },
  'lx:borrow#v.take-temporarily': {
    forms: ['borrow', 'borrows', 'borrowed', 'borrowing'],
    confusables: [],
  },
};

const FUNCTION_WORDS = [
  'a', 'an', 'the', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'is', 'am', 'are',
  'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'will',
  'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must', 'of', 'in', 'on', 'at', 'by',
  'for', 'with', 'about', 'to', 'from', 'into', 'onto', 'and', 'but', 'or', 'so', 'if', 'then',
  'than', 'as', 'not', 'no', 'yes', 'here', 'there', 'what', 'who', 'when', 'where', 'why', 'how',
  'which', 'whose', 'one', 'two', 'some', 'any', 'all', 'each', 'every', 'now', 'just', 'very',
  'really', 'please', 'ok', 'okay', 'hmm', 'ah', 'oh', 'hey', 'hi', 'hello', 'good', 'bad', 'big',
  'small', 'little', 'new', 'old', 'something', 'nothing', 'night', 'last', 'me', 's', 'again',
  'back', 'ask',
];

const ALLOWED_EXTRA = [
  'hat', 'sofa', 'table', 'moon', 'sleep', 'find', 'steal', 'favourite', 'gone', 'saw', 'nobody',
  'asked', 'work', 'question', 'say', 'perfect', 'professional', 'confused', 'someone', 'put',
  'think', 'asleep', 'interesting', 'before', 'hid', 'own', 'attention', 'classic', 'detective',
  'door', 'looks',
];

const PROPER_NOUNS = ['duck', 'cat', 'moon'];

export const BASE_BATCH_YAML = `
batch: dd-0042
channel: duck_detective
brief: lb-0042
cast: [duck, cat, moon]
hook_out: "Who stole the moon's hat?"

scenes:
  - id: s1
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
          - {speaker: duck, text: "Nobody asked you, cat."}

  - id: s2
    type: hidden_object
    uses: [lx:under#prep.location]
    evidence: {item: lx:under#prep.location, type: recognition-4}
    background: "@tag:living_room"
    instruction: "The hat is under something. Find it."
    spots: [sofa_behind, table_under, lamp_top, shelf_top]
    objects:
      - {asset: "@emoji:top_hat", spot: table_under, target: true}
      - {asset: "@emoji:sock",    spot: sofa_behind}
      - {asset: "@emoji:banana",  spot: lamp_top}
      - {asset: "@emoji:teapot",  spot: shelf_top}

  - id: s3
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
      on_wrong:   {from: duck, text: "Hmm. The moon looks confused."}

  - id: s4
    type: story
    cast: [duck, cat, moon]
    effects:
      accuse_cat:
        - open_thread: {id: cat_alibi, title: "Was the cat really asleep?", priority: 2, expires_after_cards: 120}
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
          Duck: For attention. Classic moon. # effect:accuse_moon
      - -> END
`;

export function loadBaseBatch(): Batch {
  const res = parseBatch(BASE_BATCH_YAML, 'yaml');
  if (!res.ok) throw new Error(`基准批次解析失败：${res.issues.map((i) => i.message).join('; ')}`);
  return res.batch;
}

export function makeCtx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  const allowedForms = new Set<string>([...FUNCTION_WORDS, ...ALLOWED_EXTRA, ...PROPER_NOUNS]);
  for (const entry of Object.values(LEXICON)) for (const f of entry.forms) allowedForms.add(f);
  const chars = new Map([
    ['duck', { expr: ['neutral', 'happy', 'suspicious', 'smug', 'nervous', 'shocked', 'sad'], hat: ['none', 'detective', 'crown', 'chef'], props_allowed: ['magnifying_glass', 'notebook', 'coffee'] }],
    ['cat', { expr: ['neutral', 'nervous', 'sweating', 'shocked', 'sad'], hat: ['none'], props_allowed: [] }],
    ['moon', { expr: ['neutral', 'happy', 'vain', 'sad', 'shocked'], hat: ['none', 'crown', 'top'], props_allowed: [] }],
  ]);
  return {
    vocab: { allowedForms, oovWarn: 0.02, oovBlock: 0.05, maxWordsPerLine: 12 },
    brief: {
      id: 'lb-0042',
      review: [
        { item: 'lx:under#prep.location', facet: 'meaning', minEvidence: 'recognition-4' },
        { item: 'ck:where-is', facet: 'meaning', minEvidence: 'recognition-4' },
      ],
      expose: [{ item: 'lx:behind#prep.location' }],
      introduce: [],
      avoidBeforeTest: ['under', 'where is'],
    },
    lexicon: {
      formsOf: (item) => LEXICON[item]?.forms,
      confusables: (item) => LEXICON[item]?.confusables ?? [],
    },
    assets: {
      emojis: new Set(['top_hat', 'sock', 'banana', 'teapot', 'duck', 'cat', 'moon']),
      tags: new Set(['agency_office', 'living_room']),
      chars,
    },
    entities: { exists: (id) => ['duck', 'cat', 'moon', 'agency_office', 'living_room'].includes(id) },
    predicates: new Map([
      ['role', { cardinality: 'single' }],
      ['location', { cardinality: 'single' }],
      ['status', { cardinality: 'single' }],
      ['suspect_status', { cardinality: 'single' }],
      ['owes', { cardinality: 'multi' }],
      ['relationship', { cardinality: 'multi' }],
      ['owns', { cardinality: 'multi' }],
    ]),
    canonFacts: [{ subject: 'duck', predicate: 'role', object: 'detective' }],
    activeFacts: [{ subject: 'cat', predicate: 'location', object: 'living_room', standing: 'stated' }],
    threads: new Map(),
    exposureCounts: new Map(),
    channelIsImprov: false,
    recentSceneSequences: [],
    recentCastCounts: new Map(),
    ...overrides,
  };
}

/** 深拷贝基准批次并做修改，返回可断言对象。 */
export function mutate(fn: (b: Batch) => void): Batch {
  const base = loadBaseBatch();
  const copy: Batch = structuredClone(base);
  fn(copy);
  return copy;
}
