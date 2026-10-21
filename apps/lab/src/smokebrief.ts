/** 冒烟用的固定 brief（与 stub 批次严格对应；CLI 与测试共用）。 */
import type { LearningBrief } from '@endless/learning';

export function smokeBrief(): LearningBrief {
  return {
    brief: 'lb-9001',
    level: 'A1+',
    introduce: [],
    expose: [{ item: 'lx:behind#prep.location', exposures_so_far: 3, need: 2 }],
    review: [
      { item: 'lx:under#prep.location', facet: 'meaning', min_evidence: 'recognition-4' },
      { item: 'ck:where-is', facet: 'meaning', min_evidence: 'recognition-4' },
    ],
    vocab: {
      allowed_extra: [
        'hat', 'sofa', 'table', 'moon', 'sleep', 'find', 'steal', 'door',
        'favourite', 'gone', 'nobody', 'asked', 'seat', 'moment', 'coffee', 'drink',
        'work', 'question', 'perfect', 'professional', 'confused', 'someone', 'put',
        'hid', 'own', 'attention', 'classic', 'detective', 'interesting', 'before',
        'asleep', 'news', 'show', 'fun', 'practice',
      ],
      max_words_per_line: 12,
      oov_budget: 0.02,
    },
    avoid_before_test: ['under', 'where is', "where's", 'where are', 'where was', 'where were'],
  };
}
