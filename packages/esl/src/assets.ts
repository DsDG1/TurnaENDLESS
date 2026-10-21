/** 素材引用语法（第 5.8.3 节）：@emoji / @tag / @char。 */
import type { Batch, Scene } from './model.js';

export type AssetRefParsed =
  | { kind: 'emoji'; name: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'char'; entity: string; attrs: Record<string, string> };

export function parseAssetRef(ref: string): AssetRefParsed | null {
  if (ref.startsWith('@emoji:')) return { kind: 'emoji', name: ref.slice(7) };
  if (ref.startsWith('@tag:')) return { kind: 'tag', tag: ref.slice(5) };
  if (ref.startsWith('@char:')) {
    const rest = ref.slice(6);
    const brace = rest.indexOf('{');
    const entity = brace === -1 ? rest : rest.slice(0, brace);
    const attrs: Record<string, string> = {};
    if (brace !== -1) {
      const inner = rest.slice(brace + 1, rest.endsWith('}') ? -1 : rest.length);
      if (inner) {
        for (const pair of inner.split(',')) {
          const eq = pair.indexOf('=');
          if (eq === -1) attrs[pair.trim()] = 'true';
          else attrs[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
      }
    }
    return { kind: 'char', entity, attrs };
  }
  return null;
}

export interface AssetRefSite {
  sceneId: string;
  path: string;
  ref: string;
}

/** 收集一个批次里全部素材引用（按场景类型逐字段走查）。 */
export function collectAssetRefs(batch: Batch): AssetRefSite[] {
  const out: AssetRefSite[] = [];
  const push = (sceneId: string, path: string, ref: string | undefined) => {
    if (ref && ref.startsWith('@')) out.push({ sceneId, path, ref });
  };
  for (const scene of batch.scenes as Scene[]) {
    switch (scene.type) {
      case 'comic':
        push(scene.id, 'setting', scene.setting);
        scene.panels.forEach((p, pi) => {
          p.actors.forEach((a, ai) => push(scene.id, `panels[${pi}].actors[${ai}]`, a));
          p.props.forEach((a, ai) => push(scene.id, `panels[${pi}].props[${ai}]`, a));
        });
        break;
      case 'swipe':
        scene.cards.forEach((c, ci) => push(scene.id, `cards[${ci}].asset`, c.asset));
        break;
      case 'pick':
        scene.options.forEach((o, oi) => push(scene.id, `options[${oi}].asset`, o.asset));
        break;
      case 'hidden_object':
        push(scene.id, 'background', scene.background);
        scene.objects.forEach((o, oi) => push(scene.id, `objects[${oi}].asset`, o.asset));
        break;
      default:
        break;
    }
  }
  return out;
}
