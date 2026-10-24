import { Batch, type ValidationContext } from '@endless/esl';
import { loadLexicon } from '@endless/learning';
import { createEpisode, type Library } from '@endless/player';

const batches = [
  {
    batch: 'pilot-1', channel: 'duck_detective', brief: 'pilot-1', cast: ['duck', 'cat', 'moon'],
    scenes: [
      {
        id: 's1', type: 'comic', cast: ['duck', 'cat', 'moon'],
        setting: '@tag:agency_office', uses: ['lx:behind#prep.location'],
        panels: [
          {
            shot: 'wide', actors: ['@char:moon{expr=sad}', '@char:duck{hat=detective}'], props: [],
            caption: 'Another quiet night at the agency.',
            bubbles: [{ speaker: 'moon', text: 'My favourite hat is gone.' }],
          },
          {
            shot: 'medium', actors: ['@char:cat{expr=nervous}'], props: [],
            bubbles: [{ speaker: 'cat', text: 'I was behind the door. I saw nothing!' }],
          },
          {
            shot: 'close', actors: ['@char:duck{hat=detective}'], props: ['@emoji:magnifying_glass'],
            bubbles: [{ speaker: 'duck', text: 'Nobody asked you, Cat.' }],
          },
        ],
      },
      {
        id: 's2', type: 'chat', skin: 'messenger',
        uses: ['ck:where-is'], evidence: { item: 'ck:where-is', type: 'recognition-4' },
        messages: [
          { from: 'duck', text: 'Our first case. A missing hat.' },
          { from: 'moon', text: 'My best hat. A very important hat.' },
          { from: 'duck', text: 'We need to ask about its last location.' },
        ],
        reply: {
          options: [
            { label: 'Who was your hat last night?' },
            { label: 'Where was your hat last night?', correct: true, effect: 'ask_location' },
            { label: 'When was your hat last night?' },
            { label: 'How was your hat last night?' },
          ],
          on_correct: { from: 'moon', text: 'In my living room. I think.' },
          on_wrong: { from: 'duck', text: 'We need a place, not a person or time.' },
        },
        effects: {
          ask_location: [
            { user_fact: { predicate: 'asked_about', object: 'missing_hat' } },
          ],
        },
      },
      {
        id: 's3', type: 'pick', uses: ['lx:under#prep.location'],
        evidence: { item: 'lx:under#prep.location', type: 'recognition-4' },
        question: 'The hat is ____ the table.',
        options: [
          { label: 'above' }, { label: 'behind' }, { label: 'under', correct: true }, { label: 'next to' },
        ],
        feedback: {
          on_correct: 'Exactly. The hat is under the table.',
          on_wrong: 'Look below the table. The hat is under it.',
        },
      },
    ],
  },
  {
    batch: 'pilot-2', channel: 'duck_detective', brief: 'pilot-2', cast: ['duck', 'cat'],
    scenes: [
      {
        id: 's1', type: 'comic', setting: '@tag:agency_office', uses: ['lx:quiet#adj.silent'],
        panels: [
          {
            shot: 'wide', actors: ['@char:duck{hat=detective}'], props: [],
            caption: 'The next morning.',
            bubbles: [{ speaker: 'duck', text: 'It is too quiet here.' }],
          },
          {
            shot: 'medium', actors: ['@char:cat{expr=nervous}'], props: [],
            bubbles: [{ speaker: 'cat', text: 'I am not here.' }],
          },
          {
            shot: 'close', actors: ['@char:duck{hat=detective}'], props: [],
            bubbles: [{ speaker: 'duck', text: 'A very quiet door. That talks.' }],
          },
        ],
      },
      {
        id: 's2', type: 'pick', uses: ['lx:behind#prep.location'],
        evidence: { item: 'lx:behind#prep.location', type: 'recognition-4' },
        question: 'The cat is ____ the door.',
        options: [
          { label: 'under' }, { label: 'above' }, { label: 'next to' }, { label: 'behind', correct: true },
        ],
        feedback: {
          on_correct: 'Yes. The cat is behind the door.',
          on_wrong: 'The door is in front. The cat is behind it.',
        },
      },
      {
        id: 's3', type: 'chat', skin: 'messenger', uses: ['ck:can-you'],
        evidence: { item: 'ck:can-you', type: 'recognition-4' },
        messages: [
          { from: 'cat', text: 'The door is stuck.' },
          { from: 'duck', text: 'Ask me for help. Politely.' },
        ],
        reply: {
          options: [
            { label: 'Where is your door?' },
            { label: 'What time is it?' },
            { label: 'Can you help me?', correct: true, effect: 'help_cat' },
            { label: 'How much is this door?' },
          ],
          on_correct: { from: 'duck', text: 'Of course. Even doors need a detective.' },
          on_wrong: { from: 'cat', text: 'I need help, not a new door.' },
        },
        effects: {
          help_cat: [{ user_fact: { predicate: 'helped', object: 'cat' } }],
        },
      },
    ],
  },
  {
    batch: 'pilot-3', channel: 'duck_detective', brief: 'pilot-3', cast: ['duck', 'cat', 'moon'],
    scenes: [
      {
        id: 's1', type: 'comic', setting: '@tag:agency_office', uses: ['lx:borrow#v.take-temporarily'],
        panels: [
          {
            shot: 'wide', actors: ['@char:moon'], props: ['@emoji:top_hat'],
            bubbles: [{ speaker: 'moon', text: 'My hat! At last.' }],
          },
          {
            shot: 'medium', actors: ['@char:cat{expr=nervous}'], props: [],
            bubbles: [{ speaker: 'cat', text: 'I only wanted to borrow it.' }],
          },
          {
            shot: 'close', actors: ['@char:duck{hat=detective}'], props: ['@emoji:notebook'],
            bubbles: [
              { speaker: 'duck', text: 'You need to ask before you borrow things.' },
              { speaker: 'cat', text: 'Even a table?' },
            ],
          },
        ],
      },
      {
        id: 's2', type: 'chat', skin: 'messenger', uses: ['ck:thank-you'],
        evidence: { item: 'ck:thank-you', type: 'recognition-4' },
        messages: [
          { from: 'moon', text: 'You found my hat. And my table.' },
          { from: 'duck', text: 'Now, a polite way to show you are grateful?' },
        ],
        reply: {
          options: [
            { label: 'Thank you for your help.', correct: true, effect: 'close_case' },
            { label: 'What time is your hat?' },
            { label: 'Where is the door?' },
            { label: 'I would like a table.' },
          ],
          on_correct: { from: 'moon', text: 'Tea for everyone. Except the table.' },
          on_wrong: { from: 'duck', text: 'Try a little gratitude. It is free.' },
        },
        effects: {
          close_case: [
            { set_fact: { subject: 'moon', predicate: 'owns', object: 'top_hat' } },
            { set_fact: { subject: 'duck', predicate: 'case_status', object: 'closed' } },
            { user_fact: { predicate: 'completed_case', object: 'missing_hat' } },
          ],
        },
      },
      {
        id: 's3', type: 'pick', uses: ['lx:borrow#v.take-temporarily'],
        evidence: { item: 'lx:borrow#v.take-temporarily', type: 'recognition-4' },
        question: 'You take a hat and give it back later. You ____ it.',
        options: [
          { label: 'buy' }, { label: 'lose' }, { label: 'borrow', correct: true }, { label: 'sell' },
        ],
        feedback: {
          on_correct: 'Right. Borrow it, then give it back.',
          on_wrong: 'Borrow means take it now and give it back later.',
        },
      },
    ],
  },
].map((batch) => Batch.parse(batch));

export function createPilotContent(lexiconText: string) {
  const loaded = loadLexicon(lexiconText);
  if (!loaded.lexicon || loaded.issues.length) throw new Error('试播词库校验失败');
  const lexicon = loaded.lexicon;
  const extra = 'another agency favourite gone nobody asked best important need its last location place person time exactly below look next morning too stuck politely even grateful gratitude except everyone only wanted before things later means at least talks a very quiet door that free tea for everyone our first case missing hat in my living room i think now not new'.split(' ');
  const allowedForms = new Set([...lexicon.functionWords, ...extra, 'duck', 'cat', 'moon']);
  for (const forms of lexicon.forms.values()) for (const form of forms) allowedForms.add(form);

  const context: ValidationContext = {
    vocab: { allowedForms, oovWarn: 0.02, oovBlock: 0.05, maxWordsPerLine: 16 },
    lexicon: {
      formsOf: (item) => lexicon.forms.get(item),
      confusables: (item) => lexicon.entries.get(item)?.confusables ?? [],
    },
    assets: {
      emojis: new Set(['magnifying_glass', 'notebook', 'top_hat']),
      tags: new Set(['agency_office']),
      chars: new Map(['duck', 'cat', 'moon'].map((id) => [
        id, { expr: ['neutral', 'sad', 'nervous'], hat: ['none', 'detective'], props_allowed: [] },
      ])),
    },
    entities: { exists: (id) => ['duck', 'cat', 'moon'].includes(id) },
    predicates: new Map([['owns', { cardinality: 'multi' }], ['case_status', { cardinality: 'single' }]]),
    canonFacts: [], activeFacts: [], threads: new Map(),
  };

  const metadata = [
    { title: '月亮的帽子不见了', subtitle: 'The missing hat', description: '一顶失踪的帽子，一只急着解释的猫。今晚，你是鸭侦探的搭档。' },
    { title: '一扇会说话的门', subtitle: 'The talking door', description: '猫说它不在这里。不过，门好像有一点不同意见。' },
    { title: '只是借一下而已', subtitle: 'Just borrowing', description: '案子快结束了。先别急——猫还有一张桌子要解释。' },
  ];

  const pilot: Library = {
    version: 'pilot-v1',
    episodes: batches.map((batch, index) => createEpisode(batch, context, {
      ...metadata[index]!,
      presentation: { kind: 'story', series: 'duck_detective', label: '鸭侦探事务所', legacy: true },
    })),
    glossary: Object.fromEntries([...lexicon.entries.values()].map((entry) => [
      entry.id, { label: entry.lemma ?? entry.forms[0] ?? entry.id, gloss: entry.gloss_zh, forms: entry.forms },
    ])),
    entities: ['duck', 'cat', 'moon'].map((id) => ({
      id, name: { duck: 'Duck', cat: 'Cat', moon: 'Moon' }[id] ?? id,
      kind: 'character', home_channel: 'duck_detective', created_card: 0, bible_ref: 'duck_detective',
    })),
    predicates: [...context.predicates],
  };

  return { pilot, lexicon, context };
}
