import { content, type complete } from './fixtures.js';

/**
 * 由当前学习任务构造一份合法 v4 草稿（正确选项包含目标形式，与 packages/content 编译器测试同构）。
 * 生成器与执行端口的测试共用这份草稿，避免两处夹具漂移。
 */
export function draftFor(save: ReturnType<typeof complete>) {
  const { session, library } = content.restore(save);
  const task = content.planCreative(session, library, new Date());
  const intro = task.targets.filter((x) => task.brief.introduce.includes(x.item));
  const expose = task.targets.filter((x) => x.interaction === null);
  const required = task.targets.filter((x) => x.interaction !== null);
  const form = (item: string) => content.lexicon.forms.get(item)![0];
  const chunk = <T,>(list: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  };
  // 本批 2–5 个新词：每个都要在两个正文块出现，chat 首块兼任 expose 覆盖
  const blocks = [
    ...chunk(intro, 4).map((group) => `@comic agency_office\n${group.map((x, i) => `${i % 2 ? 'cat' : 'duck'}: The ${form(x.item)} is here.`).join('\n')}\n@end`),
    ...chunk(intro, 6).map((group, index) => {
      const lines = group.map((x, i) => `${i % 2 ? 'duck' : 'cat'}: It is a ${form(x.item)}.`);
      if (index === 0) lines.push(`cat: I see a ${expose.map((x) => form(x.item)).join(', a ') || 'box'}.`);
      lines.push('duck: Good.');
      return `@chat messenger\n${lines.join('\n')}\n@end`;
    }),
    ...required.map((target) => `@choice ${target.alias}\n? What did you see?\n+ I see the ${form(target.item)}.\n- I see nothing.\n- It is late.\n- Please wait.\n= 正确答案包含目标词。\n@end`),
  ];
  while (blocks.length < 10) blocks.push('@post duck\ntext: Good.\n@end');
  return [
    'ENDLESS-DRAFT/1', '@kind story', '@series duck_detective', '@title 新线索', '@subtitle A new lead', '@description 鸭侦探收到一条新线索。',
    ...blocks,
  ].join('\n');
}
