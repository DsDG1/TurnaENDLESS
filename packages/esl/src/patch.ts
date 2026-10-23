/**
 * ESL 批次补丁（C1）：改值，不重新生成。
 *
 * 借 Sekai 的「编辑即数据」：二创和轻编辑都是改值，平台只按 id 找条目。
 * 这里给批次一个定义好的补丁格式（路径 + 新值），字段分三类：
 *   - `asset`：素材引用、表情、配件 —— 可改，改完重新校验即可；
 *   - `text`：台词、旁白、题干、选项文字 —— 可改，但必须重跑词汇检查（影响 OOV 与 uses 定位）；
 *   - `locked`：`evidence`、`uses`、条目 id、`effects`、`correct` —— 不可改，改了就是另一个检测。
 *
 * 口径：人工补丁属于人工干预，**不计入 V2**，单列（`calls.jsonl` 之外由 CLI 报告）。
 * A2 的别名替换在语义上就是一类 `asset` 补丁，日志格式统一为 `<位置>：<旧> → <新>`。
 *
 * `derive` 场景不参与补丁：它是程序产物，改它没有意义。
 */
import { Batch, Scene } from './model.js';

export type PatchClass = 'asset' | 'text' | 'locked';

export interface EslPatch {
  /** 目前只有 replace；留着 op 字段，将来加 insert/remove 不必改格式 */
  op?: 'replace';
  /** 目标路径，例如 `scenes[s1].setting`、`batch.cast`、`scenes[s2].options[1].label` */
  path: string;
  value: unknown;
  /** 人写的说明，进日志 */
  note?: string;
}

export interface PatchOutcome {
  ok: boolean;
  batch: Batch;
  applied: { path: string; cls: PatchClass; from: unknown; to: unknown; note?: string }[];
  rejected: { path: string; cls: PatchClass; reason: string }[];
}

/** 路径分类：先看是不是锁定字段，再看是不是纯文本。 */
export function classifyPath(path: string): PatchClass {
  const tokens = pathTokens(path);
  // `panels[0].props[1]` 的叶子是下标：分类要看被索引的那个字段（props），不是数字本身
  let i = tokens.length - 1;
  while (i > 0 && /^[0-9]+$/.test(tokens[i]!)) i--;
  const leaf = tokens[i] ?? '';
  const joined = tokens.join('.');
  // locked：检测口径本身。改这些等于换了一道题，不叫「编辑」。
  if (['evidence', 'uses', 'effects', 'correct', 'item', 'type', 'kind'].includes(leaf)) return 'locked';
  if (joined.startsWith('scenes.') && leaf === 'id') return 'locked';
  // asset：名字类（角色、素材、背景、位置）。改名不改变题目，只改变指向。
  // 注意 `from` 在 chat 里是说话者、在 derive 里是出处；derive 场景不接受补丁（程序产物），所以按说话者处理。
  if (['cast', 'scene', 'speaker', 'from', 'setting', 'background', 'props', 'asset', 'actors', 'cards', 'spot', 'objects'].includes(leaf)) {
    return 'asset';
  }
  // text：会被学习者读到的文字。改完必须重跑词汇检查。
  if (['text', 'caption', 'question', 'prompt', 'label', 'instruction', 'hook_out', 'logline', 'hint', 'title'].includes(leaf)) {
    return 'text';
  }
  // 未知路径按锁定处理：宁可拒绝，也不要悄悄改到不该改的字段
  return 'locked';
}

/** `scenes[s1].panels[0].props[1]` → ['scenes','s1','panels','0','props','1'] */
export function pathTokens(path: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  for (const ch of path) {
    if (ch === '.') {
      if (buf) tokens.push(buf);
      buf = '';
    } else if (ch === '[' || ch === ']') {
      if (buf) tokens.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

export function applyPatch(batch: Batch, patches: EslPatch[]): PatchOutcome {
  const next = structuredClone(batch);
  const applied: PatchOutcome['applied'] = [];
  const rejected: PatchOutcome['rejected'] = [];

  for (const p of patches) {
    const cls = classifyPath(p.path);
    if (cls === 'locked') {
      rejected.push({
        path: p.path,
        cls,
        reason: 'locked 字段不可补丁：evidence / uses / 条目 id / effects / correct 改了就是另一个检测',
      });
      continue;
    }
    const tokens = pathTokens(p.path);
    const target = resolveContainer(next, tokens);
    if (!target) {
      rejected.push({ path: p.path, cls, reason: '路径不存在（先看 batch 的实际结构，不要猜下标）' });
      continue;
    }
    const { container, key } = target;
    const from = (container as Record<string, unknown>)[key];
    (container as Record<string, unknown>)[key] = p.value;
    applied.push({ path: p.path, cls, from, to: p.value, ...(p.note ? { note: p.note } : {}) });
  }

  // 补丁后必须仍是合法批次结构：Schema 不过就整体拒绝（宁可什么都不改）
  const parsed = Batch.safeParse(next);
  if (!parsed.success) {
    return {
      ok: false,
      batch,
      applied: [],
      rejected: [
        ...rejected,
        ...parsed.error.issues.map((i) => ({ path: i.path.join('.'), cls: 'locked' as PatchClass, reason: `补丁后不符合 ESL schema：${i.message}` })),
      ],
    };
  }
  return { ok: rejected.length === 0, batch: parsed.data, applied, rejected };
}

/** 定位到「容器 + 键」；`batch.xxx` 指向批次顶层，`scenes[s1].a.b` 指向该场景内的字段。 */
function resolveContainer(batch: Batch, tokens: string[]): { container: unknown; key: string } | null {
  if (tokens.length < 2) return null;
  let cursor: unknown;
  let rest: string[];
  if (tokens[0] === 'batch') {
    cursor = batch;
    rest = tokens.slice(1);
  } else if (tokens[0] === 'scenes') {
    const id = tokens[1];
    const scene = batch.scenes.find((s) => s.id === id);
    if (!scene) return null;
    cursor = scene;
    rest = tokens.slice(2);
  } else {
    return null;
  }
  if (rest.length === 0) return null;
  for (let i = 0; i < rest.length - 1; i++) {
    const key = rest[i]!;
    if (cursor === null || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  if (cursor === null || typeof cursor !== 'object') return null;
  return { container: cursor, key: rest[rest.length - 1]! };
}

/** 补丁的日志格式（与 autofix 的别名替换统一）。 */
export function patchLogLine(a: PatchOutcome['applied'][number]): string {
  return `[patch] ${a.path}：${JSON.stringify(a.from)} → ${JSON.stringify(a.to)}${a.note ? `（${a.note}）` : ''}`;
}

/** 快速判断批次里有没有 derive 场景（派生卡是程序产物，不接受补丁）。 */
export function hasDerivedScenes(batch: Batch): boolean {
  return batch.scenes.some((s: Scene) => s.type === 'derive');
}
