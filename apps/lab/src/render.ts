/** 文本渲染器（第 7.4 节呈现）：ESL → Markdown，emoji 示意画面，尽量接近最终观感。 */
import type { Batch, RuntimeAst } from '@endless/esl';
import { parseAssetRef } from '@endless/esl';
import { pickEmojiByTag, type LabData } from './data.js';

function glyph(data: LabData, ref: string, salt: string): string {
  const parsed = parseAssetRef(ref);
  if (!parsed) return '▫️';
  if (parsed.kind === 'emoji') return data.glyphs.get(parsed.name) ?? '▫️';
  if (parsed.kind === 'tag') {
    const bg = data.backgrounds.get(parsed.tag);
    if (bg) return data.glyphs.get(bg.emoji) ?? '▫️';
    const name = pickEmojiByTag(data, parsed.tag, salt);
    return (name && data.glyphs.get(name)) ?? '▫️';
  }
  const base = data.charSpecs.get(parsed.entity)?.base;
  const baseName = base?.startsWith('@emoji:') ? base.slice(7) : undefined;
  const face = { neutral: '', happy: '🙂', suspicious: '🤨', smug: '😏', nervous: '😅', sweating: '💦', shocked: '😲', sad: '🙁', vain: '😎', tired: '😪', polite: '🤝', angry: '😠' }[parsed.attrs.expr ?? ''] ?? '';
  const hat = { detective: '🕵️', crown: '👑', chef: '🧑‍🍳', cap: '🧢', top: '🎩', none: '' }[parsed.attrs.hat ?? 'none'] ?? '';
  const g = (baseName && data.glyphs.get(baseName)) ?? '🧑';
  return `${g}${face}${hat}`;
}

function spotHint(spot: string): string {
  // 位置名不显示给用户；渲染稿用可读的相对位置描述代替
  if (spot.endsWith('_behind')) return '（在某物后面）';
  if (spot.endsWith('_under')) return '（在某物下面）';
  if (spot.endsWith('_top')) return '（在某物上面）';
  if (spot.endsWith('_in')) return '（在某物里面）';
  if (spot.endsWith('_front')) return '（在前面）';
  return '';
}

export function renderBatch(batch: Batch, ast: RuntimeAst, data: LabData): string {
  const channel = data.channels.get(batch.channel);
  const lines: string[] = [];
  lines.push(`## ${batch.batch} · ${channel?.title ?? batch.channel}`);
  lines.push('');
  if (batch.hook_out) {
    lines.push(`> ${batch.hook_out}`);
    lines.push('');
  }
  for (const scene of batch.scenes) {
    lines.push(`### ${scene.id} · ${scene.type}`);
    lines.push('');
    switch (scene.type) {
      case 'comic': {
        lines.push(`背景：${glyph(data, scene.setting, scene.id)}`);
        scene.panels.forEach((p, pi) => {
          const actors = p.actors.map((a) => glyph(data, a, `${scene.id}-${pi}`)).join(' ');
          const props = p.props.map((a) => glyph(data, a, `${scene.id}-${pi}-p`)).join(' ');
          if (p.caption) lines.push(`*（旁白）${p.caption}*`);
          lines.push(`**第 ${pi + 1} 格** ${actors} ${props}`.trimEnd());
          for (const b of p.bubbles) lines.push(`> **${b.speaker}**：${b.text}`);
          lines.push('');
        });
        break;
      }
      case 'chat': {
        lines.push(`〔${scene.skin} 界面〕`);
        for (const m of scene.messages) lines.push(`💬 **${m.from}**：${m.text}`);
        lines.push('');
        if (scene.reply) {
          lines.push('请回复：');
          scene.reply.options.forEach((o, i) => lines.push(`${i + 1}. ${o.label}${o.correct ? ' ✅' : ''}`));
          lines.push(`（答对 → ${scene.reply.on_correct.from}：${scene.reply.on_correct.text}）`);
          lines.push(`（答错 → ${scene.reply.on_wrong.from}：${scene.reply.on_wrong.text}）`);
          lines.push('');
        }
        break;
      }
      case 'swipe': {
        lines.push(`${scene.prompt}（${scene.mode === 'judge' ? '判断左右滑' : '表达喜好'}）`);
        scene.cards.forEach((c) => lines.push(`- ${glyph(data, c.asset, scene.id)} ${c.caption} → ${c.side === 'left' ? '⬅️ 左' : '右 ➡️'}`));
        lines.push('');
        break;
      }
      case 'pick': {
        lines.push(`❓ ${scene.question}${scene.hint ? `（提示：${scene.hint}）` : ''}`);
        scene.options.forEach((o, i) => lines.push(`${i + 1}. ${o.asset ? glyph(data, o.asset, scene.id) + ' ' : ''}${o.label}${o.correct ? ' ✅' : ''}`));
        lines.push(`（答对 → ${scene.feedback.on_correct}；答错 → ${scene.feedback.on_wrong}）`);
        lines.push('');
        break;
      }
      case 'hidden_object': {
        const bg = data.backgrounds.get(scene.background.replace('@tag:', ''));
        lines.push(`🔍 ${scene.instruction}`);
        lines.push(`背景：${glyph(data, scene.background, scene.id)}${bg ? `（${bg.description}）` : ''}`);
        const shuffled = [...scene.objects].sort((a, b) => a.asset.localeCompare(b.asset));
        for (const o of shuffled) lines.push(`- ${glyph(data, o.asset, scene.id)} ${spotHint(o.spot)}`);
        lines.push('');
        break;
      }
      case 'story': {
        lines.push('```ink');
        lines.push(scene.ink.trimEnd());
        lines.push('```');
        const inkInfo = ast.ink.find((x) => x.sceneId === scene.id);
        if (inkInfo) {
          lines.push(`*（${inkInfo.paths.length} 条分支路径）*`);
        }
        lines.push('');
        break;
      }
      case 'derive': {
        const d = ast.derived.find((x) => x.sceneId === scene.id);
        if (d) {
          lines.push(`🧩 补全句子（来自本批内容）：`);
          lines.push(`> ${d.clozeText}`);
          d.options.forEach((o, i) => lines.push(`${i + 1}. ${o}${o === d.correct ? ' ✅' : ''}`));
        }
        lines.push('');
        break;
      }
    }
  }
  return lines.join('\n');
}
