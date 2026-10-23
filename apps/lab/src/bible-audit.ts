/**
 * 频道圣经 × 素材清单对齐检查（A3，借 ScrollToStudy「生成约束反向对齐渲染能力」）。
 *
 * 校验器对齐了素材清单，圣经没有：`duck_detective.yaml` 的 premise 写着 `Apartment 7`，
 * 而该频道合法背景只有 `agency_office / living_room / rooftop`。模型反复写 `@tag:apartment`，
 * 很可能就是被这句 premise 带出来的（结果 §5 #11 把它归因于模型先验，而这份先验正是圣经递过去的）。
 *
 * 只报不改（阶段 0 的纪律）：`lab check` 打印建议级条目，不影响退出码。
 *    warn = 完全解析不到：模型照抄就必然 `E-ASSET-MISSING`
 *    info = 命中别名：模型可能照写别名，由 autofix 的别名替换兜住（V0 按替换前口径计）
 */
import type { LabData } from './data.js';
import { resolveBackground, resolveProp } from './resolve.js';

export interface BibleAuditIssue {
  channel: string;
  field: 'premise' | 'locations' | 'set_pieces';
  token: string;
  level: 'warn' | 'info';
  message: string;
}

/** 句首大写不算专名；这些词本来就不是素材。 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'so', 'yet', 'for', 'nor',
  'i', 'he', 'she', 'it', 'we', 'they', 'you', 'his', 'her', 'its', 'their', 'our',
  'this', 'that', 'these', 'those', 'there', 'here', 'what', 'who', 'when', 'where', 'why', 'how',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'every', 'each', 'some', 'any', 'no', 'all', 'one', 'two', 'three',
]);

/** 从 premise 里挑「句中出现的大写词」（句首大写多半只是句法）。 */
export function properNounsOf(text: string): string[] {
  const out: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    words.forEach((raw, i) => {
      const word = raw.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
      if (!word || word.length < 2) return;
      if (i === 0) return; // 句首
      if (!/^[A-Z]/.test(word)) return;
      const lower = word.toLowerCase();
      // 复数/所有格也按词根判停用词（Mondays / Friday's 不是素材名）
      const stem = lower.replace(/'s$/, '').replace(/s$/, '');
      if (STOPWORDS.has(lower) || STOPWORDS.has(stem)) return;
      out.push(word);
    });
  }
  return out;
}

export function auditChannelBibles(data: LabData): BibleAuditIssue[] {
  const issues: BibleAuditIssue[] = [];
  for (const bible of data.channels.values()) {
    // 1) locations 必须能解析到背景（标签或别名）
    for (const loc of bible.locations) {
      const res = resolveBackground(data, loc);
      if (!res.ok) {
        issues.push({ channel: bible.id, field: 'locations', token: loc, level: 'warn', message: `locations 里的「${loc}」不是合法背景：${res.reason}` });
      } else if (res.via === 'alias') {
        issues.push({
          channel: bible.id,
          field: 'locations',
          token: loc,
          level: 'info',
          message: `locations 里的「${loc}」是别名，实际背景是 ${res.value}；建议直接写合法标签`,
        });
      }
    }

    // 2) premise 里出现的专名：地点/物品名词必须能落到背景、emoji、标签或别名上
    for (const noun of properNounsOf(bible.premise)) {
      if (bible.cast.some((c) => c.id === noun.toLowerCase())) continue;
      if (bible.title.toLowerCase().includes(noun.toLowerCase())) continue;
      const bg = resolveBackground(data, noun);
      if (bg.ok) {
        if (bg.via === 'alias') {
          issues.push({
            channel: bible.id,
            field: 'premise',
            token: noun,
            level: 'info',
            message: `premise 用了别名「${noun}」→ ${bg.value}；模型可能照写 @tag:${noun.toLowerCase()}，由 autofix 别名替换兜住`,
          });
        }
        continue;
      }
      const prop = resolveProp(data, noun);
      if (prop.ok) {
        if (prop.via === 'alias') {
          issues.push({
            channel: bible.id,
            field: 'premise',
            token: noun,
            level: 'info',
            message: `premise 用了别名「${noun}」→ ${prop.value}；不在写手可见的短清单里，模型照写会被 autofix 替换`,
          });
        }
        continue;
      }
      issues.push({
        channel: bible.id,
        field: 'premise',
        token: noun,
        level: 'warn',
        message: `premise 里的「${noun}」在背景 / emoji / 标签 / 别名表里都查不到：模型照抄就会 E-ASSET-MISSING`,
      });
    }

    // set_pieces（interrogation / false_ending…）是叙事套路而不是可渲染素材，不参与素材对齐：
    // 把它们当成「名字」检查只会给每个频道刷四条假阳性，把真信号淹掉。
  }
  return issues;
}

/** 人读输出：0 条时也打一行，否则「没输出」会被误读成「检查没跑」。 */
export function bibleAuditReport(issues: BibleAuditIssue[]): string[] {
  if (issues.length === 0) return ['频道圣经与素材清单对齐：0 条（背景 / 地点名都能解析到合法名字或别名） ✅'];
  const lines = [`频道圣经与素材清单对齐（建议级，${issues.length} 条）：`];
  for (const i of issues) {
    lines.push(`  ${i.level === 'warn' ? '⚠' : '·'} ${i.channel}.${i.field}「${i.token}」：${i.message}`);
  }
  lines.push('  处理方式都是数据改动：给背景/emoji/角色加别名，或把圣经改写成清单里有的名字。');
  return lines;
}
