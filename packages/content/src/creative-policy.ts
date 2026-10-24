import { locateForm, tokenize } from '@endless/esl';

export const creativeKinds = ['story', 'daily', 'social', 'knowledge'] as const;
export type CreativeKind = (typeof creativeKinds)[number];

export const creativeKindLabels: Record<CreativeKind, string> = {
  story: '系列故事',
  daily: '生活场景',
  social: '短帖与趣味',
  knowledge: '表达小知识',
};

export const creativeSeries = {
  duck_detective: {
    kind: 'story',
    label: '鸭侦探事务所',
    premise: '一本正经的鸭侦探、紧张的猫和爱帽子的月亮。承接本系列实际读过的内容和选择，不把其他系列的事件移入本世界。',
    cast: ['duck', 'cat', 'moon', 'owl', 'dog'],
    backgrounds: ['agency_office', 'living_room', 'park', 'rooftop', 'street', 'library'],
  },
  impossible_store: {
    kind: 'story',
    label: '不可能商店',
    premise: '獾店主经营一家小商店，快递鼠送来出人意料的包裹。幽默来自普通物品和不合常理的顾客要求，不涉及真实品牌、暴力或危险行为。',
    cast: ['shopkeeper', 'delivery_mouse', 'rabbit', 'bear'],
    backgrounds: ['shop_counter', 'living_room', 'park', 'bakery', 'garden', 'rooftop'],
  },
  warm_bakery: {
    kind: 'story',
    label: '暖心烘焙坊',
    premise: '兔烘焙师与熊咖啡师一起经营一间小巷烘焙屋，客人们带来各色温馨的小故事。主题围绕美食、友谊、分享与温暖心意，没有任何案件、侦探或悬疑情节。',
    cast: ['rabbit', 'bear', 'delivery_mouse', 'fox', 'penguin'],
    backgrounds: ['bakery', 'cafe', 'garden', 'street', 'park'],
  },
  harbor_station: {
    kind: 'story',
    label: '海港旧驿站',
    premise: '企鹅站长在海港小火车站接待来自各地的旅行者，警犬巡警维护小镇秩序，猫头鹰学者记录沿途见闻与风土人情。以旅行见闻、寄信与重逢为主线，不涉及侦探破案或犯罪。',
    cast: ['penguin', 'dog', 'owl', 'fox', 'guide'],
    backgrounds: ['harbor', 'station', 'street', 'rooftop', 'library'],
  },
  daily_life: {
    kind: 'daily',
    label: '日常一刻',
    premise: '用短对话、便条和小漫画呈现购物、喝咖啡、等车、问路等日常交流。不必制造案件、悬念或连续剧情。',
    cast: ['shopkeeper', 'delivery_mouse', 'guide', 'rabbit', 'bear', 'penguin', 'dog'],
    backgrounds: ['cafe', 'station', 'shop_counter', 'park', 'bakery', 'street', 'garden', 'library'],
  },
  garden_journal: {
    kind: 'daily',
    label: '花房小记',
    premise: '阳光玻璃温室里的草木日常、养护心得、植物小故事与来访邻居的交流，轻松自然。',
    cast: ['owl', 'rabbit', 'bear', 'guide'],
    backgrounds: ['garden', 'park', 'rooftop', 'living_room'],
  },
  tiny_posts: {
    kind: 'social',
    label: '小小留言板',
    premise: '虚构角色发布短帖、留言、轻松段子或小谜语。不冒充真实用户、真实新闻或已证实的现实事实。',
    cast: ['cat', 'delivery_mouse', 'guide', 'owl', 'fox', 'rabbit'],
    backgrounds: ['living_room', 'cafe', 'park', 'rooftop', 'street', 'garden'],
  },
  word_window: {
    kind: 'knowledge',
    label: '表达小窗口',
    premise: '只使用本地词库中有来源的词义和例句。事实正文由 fact/example 组件取材生成，不让模型自由编写科普、文化或新闻事实。',
    cast: ['guide', 'owl'],
    backgrounds: ['living_room', 'library', 'garden'],
  },
} as const satisfies Record<string, {
  kind: CreativeKind;
  label: string;
  premise: string;
  cast: readonly string[];
  backgrounds: readonly string[];
}>;

export type CreativeSeriesId = keyof typeof creativeSeries;

export const creativeComponents = [
  { id: 'comic', syntax: '@comic <background>', label: '漫画', body: '<character>[.<expression>]: <English>; prop: <prop>; @end' },
  { id: 'chat', syntax: '@chat <messenger|dating|forum|news_comments>', label: '对话', body: '<character>: <English>; optional @reply <target> followed by ?/+/-/= lines; @end' },
  { id: 'post', syntax: '@post <character>', label: '短帖', body: 'text: <English>, one or more lines; @end' },
  { id: 'choice', syntax: '@choice <target>', label: '自主创作选择题', body: '? <question>; + <correct>; - <distractor>, repeated; = <feedback>; optional @remember; @end' },
  { id: 'quiz', syntax: '@quiz <meaning|cloze|sentence|find> <target>', label: '程序练习', body: '@end; material and answers are constructed by the program, not written by the model' },
  { id: 'card', syntax: '@card <target>', label: '翻词卡', body: '@end; use a preceding actual line containing the target' },
  { id: 'fact', syntax: '@fact <target>', label: '有来源的词义', body: '@end; program copies the approved local lexicon definition' },
  { id: 'example', syntax: '@example <target>', label: '有来源的例句', body: '@end; program copies the approved local lexicon example' },
] as const;

/** 一次生成最终交付 10–20 节（含边界）；练习场景计入，前后端与恢复共用此口径。 */
export const creativeScenePolicy = { min: 10, max: 20, includeExercises: true } as const;

/** 一次生成引入的新词/知识点数量：每次 2–5 个，按批次轮转，避免每集数量相同。 */
export const creativeIntroductionPolicy = { min: 2, max: 5 } as const;

export function creativeIntroductionCount(seq: number): number {
  const { min, max } = creativeIntroductionPolicy;
  return min + (Math.max(1, seq) - 1) % (max - min + 1);
}
export const creativeDiversityWindow = 6;
export const creativeHistoryPolicy = { episodesPerSeries: 3, maxCharsPerScene: 600, maxCharsPerEpisode: 1800 } as const;
export const creativeProperNames = ['badger', 'mouse', 'guide'] as const;

/**
 * 选出本批引入的新条目。
 * 优先选「例句可直接取材」的 sense（knowledge 形态要求 fact+example 两个语境都成立），
 * 数量不足时再补其余 sense；count 由 creativeIntroductionCount 给出（2–5）。
 */
export function selectCreativeIntroductions(
  candidates: readonly string[],
  entryFor: (item: string) => { kind: string; forms: readonly string[]; example?: string } | undefined,
  allowedForms: ReadonlySet<string>,
  count: number,
): string[] {
  const senses = candidates.filter((item) => entryFor(item)?.kind === 'sense');
  const usable = senses.filter((item) => {
    const entry = entryFor(item)!;
    return !!entry.example &&
      entry.forms.some((form) => locateForm(entry.example!, form).length > 0) &&
      tokenize(entry.example).every((token) => allowedForms.has(token));
  });
  const ordered = [...usable, ...senses.filter((item) => !usable.includes(item))];
  return ordered.slice(0, Math.max(0, count));
}

export interface CreativeHistory {
  kind: CreativeKind;
  series: CreativeSeriesId;
  components: readonly string[];
}

export function rankCreativeOptions(history: readonly CreativeHistory[]) {
  const recent = history.slice(-creativeDiversityWindow);
  const rank = <T extends string>(values: readonly T[], field: 'kind' | 'series') =>
    [...values].sort((a, b) => {
      const count = (value: string) => recent.filter((entry) => entry[field] === value).length;
      const last = (value: string) => recent.reduce((found, entry, index) => entry[field] === value ? index : found, -1);
      return count(a) - count(b) || last(a) - last(b) || values.indexOf(a) - values.indexOf(b);
    });
  return {
    kinds: rank(creativeKinds, 'kind'),
    series: rank(Object.keys(creativeSeries) as CreativeSeriesId[], 'series'),
    recentSignatures: recent.map((entry) => entry.components.join('/')),
  };
}
