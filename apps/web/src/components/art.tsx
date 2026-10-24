import type { ReactElement } from 'react';
import { materialBackgrounds, materialCharacters, materialProps } from '@endless/content';

const CHARACTER_IDS = new Set(materialCharacters.map((c) => c.id));
const PROP_IDS = new Set(materialProps.map((p) => p.id));
const BACKDROP_IDS = new Set(materialBackgrounds.map((b) => b.id));
export const PROP_LABEL_BY_ID = new Map(materialProps.map((p) => [p.id, p.label]));
export const BACKDROP_LABEL_BY_ID = new Map(materialBackgrounds.map((b) => [b.id, b.label]));
export const CHARACTER_LABEL_BY_ID = new Map(materialCharacters.map((c) => [c.id, c.label]));
export const CHARACTER_NAME_BY_ID = new Map(materialCharacters.map((c) => [c.id, c.name]));

/** 表情的脸部锚点：在角色脸部位置叠加嘴部/眉眼/装饰，让 expr 真正改变表情而不是空元数据。 */
const FACE_ANCHORS: Record<string, { x: number; y: number; scale?: number }> = {
  duck: { x: 88, y: 88, scale: 1.15 },
  cat: { x: 84, y: 86 },
  moon: { x: 62, y: 92 },
  shopkeeper: { x: 80, y: 88 },
  delivery_mouse: { x: 80, y: 88 },
  guide: { x: 80, y: 82 },
  owl: { x: 80, y: 82 },
  dog: { x: 80, y: 86 },
  rabbit: { x: 80, y: 80 },
  bear: { x: 80, y: 86, scale: 1.1 },
  fox: { x: 80, y: 84 },
  penguin: { x: 80, y: 82 },
};

function Expression({ kind, expression }: { kind: string; expression?: string }) {
  if (!expression || expression === 'neutral') return null;
  const at = FACE_ANCHORS[kind] ?? { x: 80, y: 86 };
  const s = at.scale ?? 1;
  return <g transform={`translate(${at.x} ${at.y}) scale(${s})`}>
    {expression === 'happy' && <>
      <path d="M-14 2c4 8 24 8 28 0" stroke="#4a3b30" strokeWidth="3" strokeLinecap="round" fill="none" />
      <path d="M-16-14c3-4 8-4 11-1M5-15c3-3 8-3 11 1" stroke="#4a3b30" strokeWidth="2.5" strokeLinecap="round" fill="none" />
    </>}
    {expression === 'sad' && <>
      <path d="M-14 8c4-7 24-7 28 0" stroke="#4a3b30" strokeWidth="3" strokeLinecap="round" fill="none" />
      <path d="M-17-16l11 4M16-16l-11 4" stroke="#4a3b30" strokeWidth="2.5" strokeLinecap="round" />
    </>}
    {expression === 'nervous' && <>
      <path d="M-15 4c4-3 6 3 10 0s6 3 10 0 6 3 10 0" stroke="#4a3b30" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <path d="M-18-15l10 4M18-15l-10 4" stroke="#4a3b30" strokeWidth="2" strokeLinecap="round" />
      <path d="M22-4c3 5-1 9-4 7-3-1-2-6 4-7Z" fill="#9db8c9" />
    </>}
    {expression === 'surprised' && <>
      <ellipse cx="0" cy="6" rx="5" ry="7" fill="#4a3b30" />
      <path d="M-16-18c4-4 9-4 12-1M4-19c4-3 9-3 12 1" stroke="#4a3b30" strokeWidth="2.5" strokeLinecap="round" fill="none" />
    </>}
    {expression === 'thinking' && <>
      <path d="M-12 5h24" stroke="#4a3b30" strokeWidth="3" strokeLinecap="round" />
      <path d="M-14-14c3-3 7-3 10-1M6-15c3-2 7-2 10 0" stroke="#4a3b30" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <circle cx="24" cy="-14" r="2" fill="#8a9b7a" /><circle cx="30" cy="-22" r="2.6" fill="#8a9b7a" />
    </>}
  </g>;
}

export function Character({ kind, className = '', expression }: { kind: string; className?: string; expression?: string }) {
  if (!CHARACTER_IDS.has(kind)) throw new Error(`未登记的角色素材：${kind}`);
  return <svg className={className} viewBox="0 0 160 160" fill="none" role="img" aria-label={CHARACTER_LABEL_BY_ID.get(kind) ?? kind}>
    {kind === 'duck' ? <>
      <ellipse cx="79" cy="146" rx="49" ry="7" fill="#273b36" opacity=".12" />
      <path d="M39 139c-1-35 11-62 39-63 30-1 48 26 46 63H39Z" fill="#c2b99e" />
      <path d="m63 89 16 23 18-23 6 50H58l5-50Z" fill="#fcf8e9" />
      <path d="m74 110 10 1 4 28H70l4-29Z" fill="#314b41" />
      <path d="m63 87-17 28 20-2-7 11 18 15 2-30-16-22Zm34 0 17 28-19-2 7 11-18 15-5-30 18-22Z" fill="#a69c81" />
      <ellipse cx="80" cy="65" rx="34" ry="32" fill="#fffdf2" />
      <path d="M89 69c16-5 36-2 37 7 0 8-17 13-38 8l1-15Z" fill="#eeb55c" />
      <path d="m70 51 11-2m10-1 10 4" stroke="#2b3c35" strokeWidth="3" strokeLinecap="round" />
      <path d="M54 33 61 10h38l10 25H54Z" fill="#365343" />
      <path d="M58 25h46l4 12H54l4-12Z" fill="#688065" />
      <path d="M43 37c14-10 57-11 76 0-18 8-59 9-76 0Z" fill="#2b4439" />
      <circle cx="79" cy="62" r="3" fill="#263830" />
      <circle cx="99" cy="62" r="3" fill="#263830" />
      <path d="m112 115 16-19" stroke="#b6a98a" strokeWidth="12" strokeLinecap="round" />
      <circle cx="130" cy="86" r="17" fill="#d9e9da" fillOpacity=".7" stroke="#3e5a4c" strokeWidth="5" />
      <path d="m139 101 10 16" stroke="#3e5a4c" strokeWidth="7" strokeLinecap="round" />
    </> : kind === 'cat' ? <>
      <ellipse cx="80" cy="146" rx="48" ry="7" fill="#644a38" opacity=".12" />
      <path d="M115 129c39-8 26-38 12-32" stroke="#d59256" strokeWidth="12" strokeLinecap="round" />
      <path d="M46 140c-2-43 9-68 35-68 28 0 38 27 35 68H46Z" fill="#d9a776" />
      <ellipse cx="82" cy="122" rx="20" ry="23" fill="#f2d6b1" />
      <path d="M46 61 45 19l31 22 20-2 29-23-4 48c3 28-20 40-38 40S43 88 46 61Z" fill="#e0ad78" />
      <path d="m53 45-1-15 18 13m34-1 14-13-1 18" fill="#cb826a" />
      <path d="m76 41 4 14m8-14-1 14" stroke="#c58b59" strokeWidth="5" strokeLinecap="round" />
      <ellipse cx="68" cy="67" rx="4" ry="6" fill="#3d4034" />
      <ellipse cx="100" cy="67" rx="4" ry="6" fill="#3d4034" />
      <path d="m79 80 5 5 5-5H79Z" fill="#986556" />
      <path d="m84 85-6 5m6-5 6 5m-32-9-23-4m22 10-22 3m77-9 22-4m-22 10 22 3" stroke="#79573f" strokeWidth="2" strokeLinecap="round" />
    </> : kind === 'shopkeeper' ? <>
      <ellipse cx="80" cy="146" rx="48" ry="7" fill="#3a3a33" opacity=".12" />
      <path d="M44 140c-2-40 10-66 36-66s38 26 36 66H44Z" fill="#6f6a5c" />
      <ellipse cx="80" cy="120" rx="18" ry="20" fill="#cfc8ae" />
      <path d="M48 66c-6-18 4-28 12-20m52 20c6-18-4-28-12-20" stroke="#6f6a5c" strokeWidth="10" strokeLinecap="round" />
      <ellipse cx="80" cy="64" rx="36" ry="34" fill="#7d7666" />
      <path d="M62 40c-6 22-4 44 6 60-12-3-18-16-17-34 0-12 4-21 11-26Zm36 0c6 22 4 44-6 60 12-3 18-16 17-34 0-12-4-21-11-26Z" fill="#f2ecdc" />
      <ellipse cx="68" cy="66" rx="4" ry="5" fill="#33322b" />
      <ellipse cx="92" cy="66" rx="4" ry="5" fill="#33322b" />
      <path d="m74 80 6 4 6-4c0 6-3 9-6 9s-6-3-6-9Z" fill="#3c3830" />
      <path d="M56 112h48l-3 26H59l-3-26Z" fill="#4c5c50" />
      <path d="M56 112h48" stroke="#d3c58e" strokeWidth="4" />
    </> : kind === 'delivery_mouse' ? <>
      <ellipse cx="80" cy="146" rx="44" ry="7" fill="#5c5648" opacity=".12" />
      <path d="M50 140c-1-38 8-62 30-62s32 24 30 62H50Z" fill="#a9a294" />
      <path d="M52 104l56-20" stroke="#7b6145" strokeWidth="7" />
      <rect x="96" y="86" width="30" height="24" rx="5" fill="#b98d5f" />
      <path d="M96 98h30" stroke="#7b6145" strokeWidth="3" />
      <circle cx="56" cy="38" r="17" fill="#a9a294" /><circle cx="104" cy="38" r="17" fill="#a9a294" />
      <circle cx="56" cy="38" r="9" fill="#d8b1a4" /><circle cx="104" cy="38" r="9" fill="#d8b1a4" />
      <ellipse cx="80" cy="66" rx="30" ry="28" fill="#b3ac9d" />
      <ellipse cx="68" cy="64" rx="3.5" ry="4.5" fill="#3d3a32" />
      <ellipse cx="92" cy="64" rx="3.5" ry="4.5" fill="#3d3a32" />
      <ellipse cx="80" cy="76" rx="5" ry="4" fill="#b56a5f" />
      <path d="m80 80-5 4m5-4 5 4" stroke="#6b6154" strokeWidth="2" strokeLinecap="round" />
      <path d="m60 74-20-3m20 9-19 4m60-10 20-3m-20 9 19 4" stroke="#8b8474" strokeWidth="1.8" strokeLinecap="round" />
    </> : kind === 'guide' ? <>
      <ellipse cx="80" cy="146" rx="44" ry="7" fill="#3c4a44" opacity=".12" />
      <rect x="44" y="92" width="72" height="48" rx="14" fill="#5f7468" />
      <rect x="56" y="104" width="48" height="18" rx="6" fill="#31473d" />
      <path d="M64 113h12m8 0h12" stroke="#d8e6bd" strokeWidth="3" strokeLinecap="round" />
      <rect x="46" y="34" width="68" height="58" rx="20" fill="#77917f" />
      <path d="M80 34V14m0 0" stroke="#5f7468" strokeWidth="4" />
      <circle cx="80" cy="12" r="5" fill="#d3c58e" />
      <circle cx="66" cy="62" r="8" fill="#2e4238" /><circle cx="94" cy="62" r="8" fill="#2e4238" />
      <circle cx="68" cy="60" r="3" fill="#e6f2c8" /><circle cx="96" cy="60" r="3" fill="#e6f2c8" />
      <path d="M70 78h20" stroke="#2e4238" strokeWidth="4" strokeLinecap="round" />
    </> : kind === 'owl' ? <>
      <ellipse cx="80" cy="146" rx="46" ry="7" fill="#3b483c" opacity=".12" />
      <path d="M42 140c-2-42 12-70 38-70s40 28 38 70H42Z" fill="#3b5148" />
      <ellipse cx="80" cy="118" rx="20" ry="22" fill="#e8dfc7" />
      <path d="M72 110c4 4 12 4 16 0m-18 10c5 4 14 4 20 0" stroke="#b0a589" strokeWidth="2.5" strokeLinecap="round" />
      <ellipse cx="80" cy="62" rx="36" ry="34" fill="#556c5e" />
      <path d="M48 38 42 18l20 16m38-16 18-2 6 22" fill="#3b5148" stroke="#3b5148" strokeWidth="3" />
      <circle cx="66" cy="62" r="14" fill="#fcf8e9" /><circle cx="94" cy="62" r="14" fill="#fcf8e9" />
      <circle cx="66" cy="62" r="14" stroke="#d3c58e" strokeWidth="3" fill="none" /><circle cx="94" cy="62" r="14" stroke="#d3c58e" strokeWidth="3" fill="none" /><path d="M80 62h0" stroke="#d3c58e" strokeWidth="4" />
      <circle cx="66" cy="62" r="5" fill="#263830" /><circle cx="68" cy="60" r="1.8" fill="#fff" /><circle cx="94" cy="62" r="5" fill="#263830" /><circle cx="96" cy="60" r="1.8" fill="#fff" />
      <path d="m76 72 4 10 4-10c0-2-8-2-8 0Z" fill="#d9a76b" />
    </> : kind === 'dog' ? <>
      <ellipse cx="80" cy="146" rx="46" ry="7" fill="#4a3e30" opacity=".12" />
      <path d="M44 140c-1-40 10-66 36-66s37 26 36 66H44Z" fill="#9c7a52" />
      <ellipse cx="80" cy="122" rx="18" ry="20" fill="#f4e4cf" />
      <path d="m62 96 18 16 18-16-18-4-18 4Z" fill="#35483f" />
      <circle cx="80" cy="110" r="4" fill="#d3c58e" />
      <ellipse cx="80" cy="66" rx="34" ry="30" fill="#b08b5e" />
      <path d="M46 54c-8 16-6 36 2 40 6 3 10-12 10-24Zm68 0c8 16 6 36-2 40-6 3-10-12-10-24Z" fill="#755234" />
      <ellipse cx="80" cy="78" rx="15" ry="13" fill="#f4e4cf" />
      <ellipse cx="80" cy="73" rx="5" ry="4" fill="#2c221a" /><path d="m80 77v4m-4 2 4-2 4 2" stroke="#2c221a" strokeWidth="2" strokeLinecap="round" />
      <ellipse cx="68" cy="62" rx="3.5" ry="5" fill="#2c221a" /><circle cx="70" cy="60" r="1.2" fill="#fff" /><ellipse cx="92" cy="62" rx="3.5" ry="5" fill="#2c221a" /><circle cx="94" cy="60" r="1.2" fill="#fff" />
      <path d="M52 44 60 22h40l8 22H52Z" fill="#2b4439" /><path d="M46 44h68l2 6H44l2-6Z" fill="#1b2a23" /><circle cx="80" cy="34" r="3.5" fill="#d3c58e" />
    </> : kind === 'rabbit' ? <>
      <ellipse cx="80" cy="146" rx="44" ry="7" fill="#4a423b" opacity=".12" />
      <path d="M48 140c-1-38 8-62 32-62s33 24 32 62H48Z" fill="#f7f4ea" />
      <path d="M56 104h48l-4 36H60l-4-36Z" fill="#d4ab7c" /><path d="M66 94h28v10H66V94Z" fill="#d4ab7c" />
      <ellipse cx="80" cy="66" rx="30" ry="26" fill="#f7f4ea" />
      <path d="M62 48c-6-26 4-42 10-42s10 16 6 42Zm36 0c6-26-4-42-10-42s-10 16-6 42Z" fill="#f7f4ea" /><path d="M64 42c-3-18 2-30 6-30s6 12 4 30Zm32 0c3-18-2-30-6-30s-6 12-4 30Z" fill="#f0bebe" />
      <ellipse cx="70" cy="65" rx="3" ry="4" fill="#3b322e" /><ellipse cx="90" cy="65" rx="3" ry="4" fill="#3b322e" />
      <ellipse cx="80" cy="73" rx="3" ry="2.5" fill="#e89898" /><path d="m80 75.5v3m-3 2 3-2 3 2" stroke="#68564e" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M62 38h36v8H62z" fill="#fcf8e9" stroke="#cfc5a9" strokeWidth="2" /><path d="M58 38c-8-12 2-24 16-20 6-8 20-8 26 0 14-4 24 8 16 20H58Z" fill="#fcf8e9" />
    </> : kind === 'bear' ? <>
      <ellipse cx="80" cy="146" rx="52" ry="8" fill="#3b2d24" opacity=".12" />
      <path d="M40 140c-2-44 12-72 40-72s42 28 40 72H40Z" fill="#755236" />
      <path d="M52 98h56l-3 42H55l-3-42Z" fill="#3b5148" /><path d="M64 84h32v14H64V84Z" fill="#3b5148" />
      <path d="m74 84-8-6v12Zm12 0 8-6v12Z" fill="#b35a4a" /><circle cx="80" cy="84" r="3" fill="#8f3e30" />
      <ellipse cx="80" cy="62" rx="38" ry="34" fill="#845e40" />
      <circle cx="48" cy="38" r="14" fill="#755236" /><circle cx="48" cy="38" r="7" fill="#b38965" /><circle cx="112" cy="38" r="14" fill="#755236" /><circle cx="112" cy="38" r="7" fill="#b38965" />
      <ellipse cx="80" cy="72" rx="18" ry="15" fill="#ebd6b8" />
      <ellipse cx="80" cy="67" rx="7" ry="5" fill="#2b1c14" /><path d="m80 72v5m-6 3c2-3 6-3 6-3s4 0 6 3" stroke="#2b1c14" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="67" cy="56" r="3.5" fill="#2b1c14" /><circle cx="93" cy="56" r="3.5" fill="#2b1c14" />
    </> : kind === 'fox' ? <>
      <ellipse cx="80" cy="146" rx="46" ry="7" fill="#4d301b" opacity=".12" />
      <path d="M110 134c26-10 36-38 20-56-14-15-28 6-30 20" stroke="#d96b27" strokeWidth="18" strokeLinecap="round" /><path d="M128 78c6 10 2 20-4 24" stroke="#fffdf2" strokeWidth="12" strokeLinecap="round" />
      <path d="M46 140c-2-40 10-66 34-66s36 26 34 66H46Z" fill="#d96b27" />
      <path d="M68 94c8 16 12 28 12 40 0-12 4-24 12-40-12 4-12 4-24 0Z" fill="#fffdf2" />
      <ellipse cx="80" cy="65" rx="32" ry="28" fill="#e07530" />
      <path d="M50 72c10 8 20 8 30 0-10-4-20-4-30 0Zm60 0c-10 8-20 8-30 0 10-4 20-4 30 0Z" fill="#fffdf2" />
      <path d="M52 46 42 16l24 18Zm56 0 10-30-24 18Z" fill="#d96b27" /><path d="M52 42 46 22l16 14Zm56 0 6-20-16 14Z" fill="#3d2010" />
      <ellipse cx="86" cy="38" rx="24" ry="12" fill="#35483f" transform="rotate(-12 86 38)" /><circle cx="86" cy="27" r="2.5" fill="#24342d" />
      <path d="M64 62c4-3 10-1 10 3m12 0c0-4 6-6 10-3" stroke="#2c1a0e" strokeWidth="2.5" strokeLinecap="round" fill="none" /><ellipse cx="80" cy="74" rx="4" ry="3" fill="#2c1a0e" />
    </> : kind === 'penguin' ? <>
      <ellipse cx="80" cy="146" rx="48" ry="7" fill="#263430" opacity=".12" />
      <path d="M44 140c-3-46 10-76 36-76s39 30 36 76H44Z" fill="#263430" /><path d="M38 90c-8 16-6 36 2 44m82-44c8 16 6 36-2 44" stroke="#263430" strokeWidth="10" strokeLinecap="round" />
      <ellipse cx="80" cy="112" rx="24" ry="28" fill="#fffdf2" />
      <ellipse cx="64" cy="144" rx="10" ry="4" fill="#eeb55c" /><ellipse cx="96" cy="144" rx="10" ry="4" fill="#eeb55c" />
      <path d="m75 80-6-5v10Zm10 0 6-5v10Z" fill="#c95244" /><circle cx="80" cy="80" r="2.5" fill="#9e3529" />
      <ellipse cx="68" cy="58" rx="3.5" ry="5" fill="#fff" /><circle cx="68" cy="58" r="2.5" fill="#1b2422" /><ellipse cx="92" cy="58" rx="3.5" ry="5" fill="#fff" /><circle cx="92" cy="58" r="2.5" fill="#1b2422" />
      <path d="m72 66 8 7 8-7c0-3-16-3-16 0Z" fill="#eeb55c" />
      <path d="M54 36 60 18h40l6 18H54Z" fill="#2d4439" /><path d="M48 36h64l2 6H46l2-6Z" fill="#1a2b23" /><path d="M54 34h52" stroke="#d3c58e" strokeWidth="3" />
    </> : <>
      <ellipse cx="80" cy="146" rx="46" ry="7" fill="#9c9464" opacity=".12" />
      <path d="M104 22c-33-9-63 15-63 51 0 40 32 65 70 52-22-9-35-30-35-53 0-22 11-40 28-50Z" fill="#f0d689" />
      <path d="M102 28C80 45 76 85 97 110" stroke="#e5c16b" strokeWidth="3" strokeLinecap="round" />
      <path d="m56 71 5-3m-7 17 5 2" stroke="#a5905c" strokeWidth="2" strokeLinecap="round" />
      <circle cx="61" cy="76" r="3" fill="#555a41" />
      <path d="m58 91 9 2" stroke="#555a41" strokeWidth="2" strokeLinecap="round" />
      <path d="m114 39 3 9 9 3-9 3-3 9-3-9-9-3 9-3 3-9Zm13 46 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z" fill="#f0d689" />
    </>}
    <Expression kind={kind} expression={expression} />
  </svg>;
}

const PROP_ART: Record<string, ReactElement> = {
  top_hat: <>
    <path d="m19 57 6-36h31l6 36H19Z" fill="#35483f" />
    <path d="M24 47h34" stroke="#d3c58e" strokeWidth="7" />
    <rect x="11" y="56" width="61" height="9" rx="4" fill="#35483f" />
  </>,
  notebook: <>
    <rect x="18" y="12" width="46" height="58" rx="5" fill="#ae8a63" />
    <path d="M27 12v58" stroke="#7b6145" strokeWidth="3" />
    <path d="M35 28h20m-20 9h20m-20 9h13" stroke="#f4e6bf" strokeWidth="2" strokeLinecap="round" />
  </>,
  magnifying_glass: <>
    <circle cx="34" cy="31" r="21" fill="#dce9d4" fillOpacity=".8" stroke="#52694c" strokeWidth="6" />
    <path d="m50 48 18 22" stroke="#52694c" strokeWidth="10" strokeLinecap="round" />
    <path d="M23 29c0-7 5-12 12-12" stroke="#fffdf3" strokeWidth="3" strokeLinecap="round" />
  </>,
  key: <>
    <circle cx="30" cy="30" r="16" stroke="#b8915a" strokeWidth="8" fill="none" />
    <path d="M41 41 62 62m-8-2 6-6m-12-3 6-6" stroke="#b8915a" strokeWidth="7" strokeLinecap="round" />
  </>,
  box: <>
    <rect x="14" y="24" width="52" height="44" rx="4" fill="#b98d5f" />
    <path d="M14 24h52M40 24v44" stroke="#8a6a45" strokeWidth="4" />
    <path d="M40 24c-9-1-13-8-8-12s15 2 8 12Zm0 0c9-1 13-8 8-12s-15 2-8 12Z" fill="#d3c58e" />
  </>,
  bag: <>
    <path d="M22 30h36l6 40H16l6-40Z" fill="#7d8b6e" />
    <path d="M28 30c0-14 24-14 24 0" stroke="#5c6b4f" strokeWidth="5" fill="none" />
    <path d="M24 44h32" stroke="#5c6b4f" strokeWidth="3" />
  </>,
  umbrella: <>
    <path d="M40 10v50" stroke="#4c5c50" strokeWidth="4" />
    <path d="M40 60c0 8-10 8-10 2" stroke="#4c5c50" strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M10 32c0-14 13-24 30-24s30 10 30 24c-8-5-12-5-15 0-3-5-12-5-15 0-3-5-12-5-15 0-3-5-7-5-15 0Z" fill="#6f8a74" />
  </>,
  coffee: <>
    <path d="M20 30h34v22c0 10-8 16-17 16s-17-6-17-16V30Z" fill="#a9794f" />
    <path d="M54 34h8c6 0 8 4 8 8s-3 8-9 8h-5" stroke="#a9794f" strokeWidth="5" fill="none" />
    <path d="M28 12c0 5 5 5 5 10m8-12c0 5 5 5 5 10" stroke="#8a6a45" strokeWidth="3" strokeLinecap="round" />
  </>,
  envelope: <>
    <rect x="12" y="22" width="56" height="38" rx="4" fill="#efe6c8" stroke="#a99b72" strokeWidth="3" />
    <path d="m14 24 26 20 26-20" stroke="#a99b72" strokeWidth="3" fill="none" />
  </>,
  clock: <>
    <circle cx="40" cy="42" r="26" fill="#f4eed8" stroke="#4c5c50" strokeWidth="5" />
    <path d="M40 28v14l10 6" stroke="#4c5c50" strokeWidth="4" strokeLinecap="round" />
    <path d="M28 68l-6 8m44-8 6 8" stroke="#4c5c50" strokeWidth="4" strokeLinecap="round" />
  </>,
  book: <>
    <path d="M16 16h20c6 0 10 4 10 10v40c-4-4-8-6-14-6H16V16Z" fill="#6f8a74" />
    <path d="M64 16H44c-6 0-10 4-10 10v40c4-4 8-6 14-6h16V16Z" fill="#8ba283" />
    <path d="M22 26h10m-10 8h10m-10 8h8m26-16h10m-10 8h10m-10 8h8" stroke="#f4eed8" strokeWidth="2" />
  </>,
  apple: <>
    <path d="M40 26c-14-8-28 4-24 20s18 26 24 22c6 4 20-8 24-22s-10-28-24-20Z" fill="#b35a4a" />
    <path d="M40 26c0-8 4-12 10-14" stroke="#5c6b4f" strokeWidth="4" strokeLinecap="round" />
    <path d="M46 14c6-4 12-2 14 2-6 4-12 2-14-2Z" fill="#6f8a74" />
  </>,
  bread: <>
    <path d="M12 42c0-10 10-18 28-18s28 8 28 18v22H12V42Z" fill="#d9a76b" />
    <path d="M18 42c6-3 12-3 16 0m8 0c4-3 10-3 14 0" stroke="#b07f4e" strokeWidth="3" />
  </>,
  cup: <>
    <path d="M22 26h32v26c0 9-7 14-16 14s-16-5-16-14V26Z" fill="#e8e0c4" stroke="#8a8262" strokeWidth="3" />
    <path d="M54 30h8c5 0 7 3 7 7s-3 7-8 7h-4" stroke="#8a8262" strokeWidth="4" fill="none" />
    <ellipse cx="38" cy="30" rx="13" ry="3" fill="#a9794f" />
  </>,
  ticket: <>
    <rect x="10" y="26" width="60" height="28" rx="5" fill="#efe6c8" stroke="#a99b72" strokeWidth="3" />
    <path d="M30 26v28" stroke="#a99b72" strokeWidth="3" strokeDasharray="4 4" />
    <path d="M40 34h22m-22 8h22" stroke="#8a8262" strokeWidth="3" />
  </>,
  bicycle: <>
    <circle cx="22" cy="54" r="14" stroke="#4c5c50" strokeWidth="4" fill="none" />
    <circle cx="58" cy="54" r="14" stroke="#4c5c50" strokeWidth="4" fill="none" />
    <path d="m22 54 14-24h10l12 24m-36 0 22-18h14M46 30l-4-8m4 8h12" stroke="#4c5c50" strokeWidth="3.5" fill="none" strokeLinecap="round" />
  </>,
  plant: <>
    <path d="M28 44h24l-4 30H32l-4-30Z" fill="#b07f4e" />
    <path d="M40 44V26m0 18c-10 0-16-8-16-16 10 0 16 8 16 16Zm0-10c8-2 14-10 12-18-8 2-12 10-12 18Z" fill="#6f8a74" />
  </>,
  gift: <>
    <rect x="16" y="34" width="48" height="36" rx="4" fill="#b35a4a" />
    <rect x="12" y="24" width="56" height="12" rx="4" fill="#c96e5c" />
    <path d="M40 24v46" stroke="#f0d689" strokeWidth="6" />
    <path d="M40 24c-10 0-14-10-6-12s9 6 6 12Zm0 0c10 0 14-10 6-12s-9 6-6 12Z" fill="#f0d689" />
  </>,
  coin: <>
    <circle cx="40" cy="40" r="24" fill="#eeb55c" stroke="#b88a3b" strokeWidth="4" />
    <circle cx="40" cy="40" r="17" stroke="#b88a3b" strokeWidth="2" strokeDasharray="3 3" fill="none" />
    <path d="m40 29 3 7 8 1-6 6 2 8-7-4-7 4 2-8-6-6 8-1 3-7Z" fill="#b88a3b" />
  </>,
  jar: <>
    <rect x="24" y="24" width="32" height="42" rx="8" fill="#d9ebd8" fillOpacity=".8" stroke="#52705e" strokeWidth="4" />
    <rect x="28" y="16" width="24" height="10" rx="3" fill="#b08658" />
    <rect x="30" y="38" width="20" height="14" rx="2" fill="#fffdf2" stroke="#b5a988" strokeWidth="2" />
    <path d="M34 44h12m-12 4h8" stroke="#8a7e5f" strokeWidth="2" />
  </>,
  photo: <>
    <rect x="18" y="14" width="44" height="52" rx="4" fill="#fffdf2" stroke="#cfc5a9" strokeWidth="3" />
    <rect x="24" y="20" width="32" height="30" fill="#3b5148" />
    <circle cx="44" cy="28" r="4" fill="#f0d689" />
    <path d="m26 46 10-12 8 8 6-6 6 10H26Z" fill="#77917f" />
  </>,
  lamp: <>
    <path d="M22 34c0-12 8-18 18-18s18 6 18 18H22Z" fill="#355243" />
    <path d="M40 34v26m-14 0h28" stroke="#d3c58e" strokeWidth="5" strokeLinecap="round" />
    <path d="M26 34h28" stroke="#f0d689" strokeWidth="3" />
  </>,
  camera: <>
    <rect x="14" y="24" width="52" height="38" rx="6" fill="#4a5f54" stroke="#2e3d36" strokeWidth="3" />
    <rect x="22" y="16" width="16" height="8" rx="2" fill="#2e3d36" />
    <circle cx="40" cy="43" r="14" fill="#2e3d36" />
    <circle cx="40" cy="43" r="10" fill="#6f8a74" stroke="#d3c58e" strokeWidth="2" />
    <circle cx="56" cy="30" r="3" fill="#eeb55c" />
  </>,
  mirror: <>
    <ellipse cx="40" cy="32" rx="18" ry="22" fill="#dfebe8" stroke="#a58963" strokeWidth="4" />
    <path d="m40 54 4 18h-8l4-18Z" fill="#8a6a45" />
    <path d="M34 22c-4 5-4 12 0 16" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
  </>,
  newspaper: <>
    <rect x="14" y="20" width="52" height="42" rx="3" fill="#f4eed8" stroke="#9e9477" strokeWidth="3" />
    <path d="M14 28h52M20 38h20m-20 6h20m-20 6h40m-40 6h40" stroke="#6f6a5c" strokeWidth="2.5" strokeLinecap="round" />
    <rect x="44" y="34" width="16" height="14" fill="#cfc5a9" />
  </>,
  phone: <>
    <rect x="20" y="30" width="40" height="34" rx="8" fill="#35483f" />
    <path d="M12 22c10-4 46-4 56 0l-6 10c-10-3-34-3-44 0l-6-10Z" fill="#263430" />
    <circle cx="40" cy="46" r="9" fill="#fcf8e9" stroke="#263430" strokeWidth="2" />
    <circle cx="40" cy="46" r="3" fill="#263430" />
  </>,
  tea: <>
    <ellipse cx="40" cy="46" rx="22" ry="18" fill="#3b5148" />
    <path d="M18 42c-8-4-10-10-6-14 5-5 10 2 8 8" stroke="#3b5148" strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M58 42c6-3 10-2 12 4s-4 10-10 8" stroke="#3b5148" strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M30 28h20l-2-6h-16l-2 6Z" fill="#d3c58e" />
    <circle cx="40" cy="20" r="3" fill="#d3c58e" />
  </>,
  cake: <>
    <path d="M14 52 40 22l26 30H14Z" fill="#f7f0df" stroke="#b08658" strokeWidth="3" />
    <path d="M14 52h52v12H14V52Z" fill="#a57242" />
    <path d="M22 42l24-14 18 14" stroke="#b35a4a" strokeWidth="4" strokeLinecap="round" />
    <circle cx="40" cy="20" r="6" fill="#b35a4a" />
  </>,
  glasses: <>
    <circle cx="27" cy="40" r="13" stroke="#b88a3b" strokeWidth="4" fill="none" />
    <circle cx="53" cy="40" r="13" stroke="#b88a3b" strokeWidth="4" fill="none" />
    <path d="M40 37c2-3 4-3 6 0M14 36l-8-4m68 4l8-4" stroke="#b88a3b" strokeWidth="3" strokeLinecap="round" />
  </>,
  badge: <>
    <path d="M40 14 62 26v24c0 14-12 22-22 26-10-4-22-12-22-26V26l22-12Z" fill="#35483f" stroke="#d3c58e" strokeWidth="3" />
    <path d="m40 28 3 8 8 1-6 6 2 8-7-4-7 4 2-8-6-6 8-1 3-7Z" fill="#d3c58e" />
  </>,
  bell: <>
    <path d="M20 48c0-16 10-22 20-22s20 6 20 22H20Z" fill="#d3c58e" stroke="#9e8544" strokeWidth="3" />
    <rect x="14" y="48" width="52" height="8" rx="3" fill="#684f37" />
    <path d="M40 26V18m-4 0h8" stroke="#9e8544" strokeWidth="4" strokeLinecap="round" />
  </>,
  flower: <>
    <path d="M40 68V34m0 20c-6-2-14-10-14-18 8 2 14 8 14 18Zm0 6c6-2 14-10 14-18-8 2-14 8-14 18Z" stroke="#4c6652" strokeWidth="3.5" fill="#6f8a74" strokeLinecap="round" />
    <path d="M30 32c0-12 10-18 10-18s10 6 10 18c-4-4-10-4-10 0 0-4-6-4-10 0Z" fill="#c96e5c" stroke="#9e4838" strokeWidth="2" />
  </>,
  candle: <>
    <ellipse cx="40" cy="58" rx="22" ry="8" fill="#b88a3b" stroke="#8a6727" strokeWidth="3" />
    <rect x="34" y="32" width="12" height="26" fill="#fcf8e9" stroke="#d6ccb0" strokeWidth="2" />
    <path d="M40 32v-6" stroke="#4a3b30" strokeWidth="2" />
    <path d="M40 26c-4-4-2-12 0-14 2 2 4 10 0 14Z" fill="#eeb55c" />
  </>,
  feather: <>
    <path d="M22 66C30 50 48 24 64 14c-4 12-10 24-22 36l-8 8" stroke="#2b4439" strokeWidth="3" fill="#4c6652" />
    <path d="m20 68 8-8" stroke="#d3c58e" strokeWidth="3" strokeLinecap="round" />
    <rect x="14" y="56" width="16" height="14" rx="3" fill="#35483f" />
  </>,
  compass: <>
    <circle cx="40" cy="40" r="24" fill="#f4eed8" stroke="#b88a3b" strokeWidth="5" />
    <path d="M40 22v36M22 40h36" stroke="#b8a879" strokeWidth="2" />
    <path d="M40 40 34 30l6-8 6 8-6 10Z" fill="#b35a4a" />
    <path d="M40 40 46 50l-6 8-6-8 6-10Z" fill="#35483f" />
    <circle cx="40" cy="14" r="4" stroke="#b88a3b" strokeWidth="3" fill="none" />
  </>,
  cookie: <>
    <circle cx="40" cy="40" r="22" fill="#d9a76b" stroke="#9e7340" strokeWidth="3" />
    <circle cx="32" cy="32" r="3" fill="#52361b" /><circle cx="48" cy="30" r="2.5" fill="#52361b" />
    <circle cx="42" cy="44" r="3.5" fill="#52361b" /><circle cx="28" cy="46" r="2" fill="#52361b" />
  </>,
  map: <>
    <path d="M16 18h44l4 44H20l-4-44Z" fill="#eeddb8" stroke="#9e8555" strokeWidth="3" />
    <path d="M24 28c8 4 12 14 20 12s8-8 12-4" stroke="#b35a4a" strokeWidth="3" strokeDasharray="4 3" fill="none" />
    <path d="m48 46 3 6 6 1-5 4 2 6-6-3-6 3 2-6-5-4 6-1 3-6Z" fill="#35483f" />
  </>,
  basket: <>
    <path d="M16 38h48l-6 28H22l-6-28Z" fill="#a58155" stroke="#755631" strokeWidth="3" />
    <path d="M22 38c0-16 36-16 36 0" stroke="#755631" strokeWidth="4" fill="none" />
    <path d="M16 44h48m-44 8h40m-36 8h32" stroke="#755631" strokeWidth="2" />
    <path d="M28 38 38 28h12l6 10" fill="#b35a4a" />
  </>,
  scarf: <>
    <path d="M22 30c6-6 30-6 36 0 6 8 4 20-4 24l-6 18h-12l4-18c-10-2-22-10-18-24Z" fill="#35483f" stroke="#24342d" strokeWidth="3" />
    <path d="M28 32c4-3 20-3 24 0m-22 10c4-2 18-2 22 0" stroke="#f4eed8" strokeWidth="3" />
    <path d="M36 72v4m4-4v4m4-4v4" stroke="#d3c58e" strokeWidth="2" />
  </>,
  guitar: <>
    <ellipse cx="40" cy="52" rx="16" ry="14" fill="#b07f4e" stroke="#704e2b" strokeWidth="3" />
    <ellipse cx="40" cy="38" rx="11" ry="10" fill="#b07f4e" stroke="#704e2b" strokeWidth="3" />
    <circle cx="40" cy="46" r="4" fill="#3b2410" />
    <rect x="37" y="14" width="6" height="24" fill="#704e2b" />
    <rect x="34" y="10" width="12" height="7" rx="2" fill="#52361b" />
    <path d="M39 12v38m2-38v38" stroke="#f4eed8" strokeWidth="1.5" />
  </>,
};

export function PropArt({ reference }: { reference: string }) {
  const name = reference.replace('@emoji:', '');
  const art = PROP_ART[name];
  const label = PROP_LABEL_BY_ID.get(name);
  if (!art || !label || !PROP_IDS.has(name)) throw new Error(`未登记的道具素材：${reference}`);
  return <svg viewBox="0 0 80 80" fill="none" role="img" aria-label={label}>{art}</svg>;
}

/** 场景背景：@tag 引用真正渲染，且不同背景画出来不一样。 */
export function SceneBackdrop({ tag }: { tag: string }) {
  const name = tag.replace('@tag:', '');
  const label = BACKDROP_LABEL_BY_ID.get(name);
  if (!label || !BACKDROP_IDS.has(name)) throw new Error(`未登记的场景素材：${tag}`);
  return <svg className="panel-backdrop" viewBox="0 0 320 180" fill="none" role="img" aria-label={`背景：${label}`} preserveAspectRatio="xMidYMax slice">
    <rect x="0" y="0" width="320" height="180" fill="#f2ecd9" />
    {name === 'agency_office' && <>
      <rect x="30" y="20" width="90" height="110" rx="4" fill="#dfe8d0" stroke="#8ba283" strokeWidth="3" />
      <path d="M75 20v110M30 75h90" stroke="#8ba283" strokeWidth="3" />
      <rect x="180" y="96" width="120" height="14" rx="4" fill="#a58963" />
      <path d="m196 110-8 56m96-56 8 56" stroke="#a58963" strokeWidth="6" />
      <rect x="196" y="60" width="34" height="36" rx="3" fill="#3b5148" />
      <path d="M213 60c0-14 14-14 14 0" stroke="#3b5148" strokeWidth="4" fill="none" />
      <path d="M206 96h60" stroke="#314b41" strokeWidth="4" />
    </>}
    {name === 'living_room' && <>
      <rect x="60" y="70" width="140" height="56" rx="12" fill="#8ba283" />
      <rect x="52" y="92" width="156" height="40" rx="10" fill="#77917f" />
      <rect x="66" y="56" width="40" height="34" rx="8" fill="#a8bc9b" />
      <rect x="116" y="56" width="40" height="34" rx="8" fill="#a8bc9b" />
      <path d="M246 130V56m0 0c-18 0-24 10-24 10h48s-6-10-24-10Z" stroke="#8a6a45" strokeWidth="4" fill="#f0d689" />
      <rect x="30" y="22" width="60" height="76" rx="4" fill="#dfe8d0" stroke="#8ba283" strokeWidth="3" />
      <path d="M60 22v76M30 60h60" stroke="#8ba283" strokeWidth="3" />
    </>}
    {name === 'shop_counter' && <>
      <rect x="20" y="18" width="280" height="60" rx="4" fill="#d8ceb0" />
      <path d="M20 42h280M20 60h280" stroke="#b9ad8a" strokeWidth="3" />
      <rect x="34" y="26" width="18" height="14" rx="2" fill="#8ba283" /><rect x="66" y="26" width="18" height="14" rx="2" fill="#b98d5f" /><rect x="98" y="26" width="18" height="14" rx="2" fill="#c9b06e" />
      <rect x="150" y="26" width="18" height="14" rx="2" fill="#8ba283" /><rect x="182" y="26" width="18" height="14" rx="2" fill="#b98d5f" /><rect x="214" y="26" width="18" height="14" rx="2" fill="#c9b06e" />
      <rect x="40" y="96" width="240" height="20" rx="6" fill="#a58963" />
      <rect x="40" y="116" width="240" height="50" fill="#b99a6f" />
      <path d="M40 136h240" stroke="#a58963" strokeWidth="3" />
    </>}
    {name === 'cafe' && <>
      <circle cx="160" cy="112" r="56" fill="#a58963" />
      <ellipse cx="160" cy="106" rx="56" ry="12" fill="#b99a6f" />
      <path d="M160 118v48m-26 0h52" stroke="#8a6a45" strokeWidth="6" />
      <path d="M128 96h18v14c0 6-4 8-9 8s-9-2-9-8V96Z" fill="#e8e0c4" stroke="#8a8262" strokeWidth="2" />
      <path d="M176 96h18v14c0 6-4 8-9 8s-9-2-9-8V96Z" fill="#e8e0c4" stroke="#8a8262" strokeWidth="2" />
      <rect x="230" y="30" width="70" height="90" rx="4" fill="#dfe8d0" stroke="#8ba283" strokeWidth="3" />
      <path d="M265 30v90M230 75h70" stroke="#8ba283" strokeWidth="3" />
      <path d="M30 34h64" stroke="#8ba283" strokeWidth="8" strokeLinecap="round" />
      <path d="M34 34v20m52-20v20" stroke="#8ba283" strokeWidth="4" />
    </>}
    {name === 'park' && <>
      <rect x="0" y="120" width="320" height="60" fill="#b9c9a2" />
      <path d="M0 120h320" stroke="#8ba283" strokeWidth="4" />
      <path d="M60 120V60m0 0c-22 0-34-14-26-30 6-14 20-16 26-16s20 2 26 16c8 16-4 30-26 30Z" fill="#77917f" />
      <path d="M60 74c-12 0-20-8-20-8m20 18c10 0 18-6 18-6" stroke="#5f7468" strokeWidth="4" />
      <path d="M236 122h64M236 96h64m-64 0v26m64-26v26" stroke="#8a6a45" strokeWidth="6" />
      <path d="M236 96h64v-8H236v8Z" fill="#a58963" />
      <circle cx="140" cy="46" r="14" fill="#f0d689" />
      <path d="M40 156h60m120 0h60" stroke="#8ba283" strokeWidth="5" strokeLinecap="round" />
    </>}
    {name === 'station' && <>
      <rect x="0" y="130" width="320" height="50" fill="#cfc8ae" />
      <path d="M0 130h320M20 150h280" stroke="#8a8262" strokeWidth="4" />
      <rect x="30" y="34" width="10" height="96" fill="#5f7468" />
      <rect x="12" y="20" width="120" height="40" rx="6" fill="#3b5148" />
      <path d="M24 32h60m-60 12h84" stroke="#d8e6bd" strokeWidth="4" strokeLinecap="round" />
      <path d="M200 130V52m0 0c30 0 60 14 60 40v38H200" stroke="#5f7468" strokeWidth="5" fill="none" />
      <circle cx="290" cy="42" r="16" fill="#f4eed8" stroke="#4c5c50" strokeWidth="4" />
      <path d="M290 32v10l7 4" stroke="#4c5c50" strokeWidth="3" strokeLinecap="round" />
    </>}
    {name === 'bakery' && <>
      <rect x="0" y="0" width="320" height="180" fill="#f7f0df" />
      <path d="M30 140V50c0-20 20-30 40-30s40 10 40 30v90H30Z" fill="#d9cbb2" stroke="#bfae91" strokeWidth="3" />
      <ellipse cx="70" cy="110" rx="26" ry="24" fill="#e0a560" />
      <rect x="130" y="86" width="170" height="54" rx="4" fill="#a58963" />
      <rect x="140" y="94" width="150" height="20" rx="3" fill="#f5ecd5" opacity=".7" />
      <path d="m150 92 20-16m10 16 20-16m10 16 20-16" stroke="#d9a76b" strokeWidth="7" strokeLinecap="round" />
      <rect x="230" y="24" width="60" height="40" rx="3" fill="#3b5148" />
      <path d="M260 14v10" stroke="#8a6a45" strokeWidth="2" />
    </>}
    {name === 'library' && <>
      <rect x="0" y="0" width="320" height="180" fill="#e8e4d3" />
      <path d="M120 120V34c0-20 20-24 40-24s40 4 40 24v86H120Z" fill="#d5e2d0" opacity=".6" />
      <rect x="10" y="16" width="90" height="130" fill="#4a5f54" /><rect x="220" y="16" width="90" height="130" fill="#4a5f54" />
      <rect x="18" y="28" width="14" height="32" fill="#d3c58e" /><rect x="34" y="24" width="12" height="36" fill="#a58963" />
      <rect x="48" y="30" width="16" height="30" fill="#b35a4a" /><rect x="66" y="26" width="18" height="34" fill="#8ba283" />
      <rect x="228" y="28" width="16" height="32" fill="#d3c58e" /><rect x="246" y="24" width="14" height="36" fill="#8ba283" /><rect x="262" y="30" width="18" height="30" fill="#b35a4a" />
      <rect x="70" y="104" width="180" height="18" rx="3" fill="#8a6a45" />
      <path d="m90 122-6 40m146-40 6 40" stroke="#8a6a45" strokeWidth="6" />
      <path d="M152 104v-20" stroke="#d3c58e" strokeWidth="4" /><path d="M142 84h20" stroke="#355243" strokeWidth="8" strokeLinecap="round" />
    </>}
    {name === 'rooftop' && <>
      <rect x="0" y="0" width="320" height="180" fill="#2d3f3b" />
      <circle cx="270" cy="40" r="16" fill="#f0d689" /><circle cx="276" cy="38" r="14" fill="#2d3f3b" />
      <circle cx="48" cy="32" r="2" fill="#d8e6bd" /><circle cx="110" cy="46" r="2" fill="#d8e6bd" /><circle cx="180" cy="24" r="1.5" fill="#d8e6bd" />
      <rect x="0" y="116" width="320" height="64" fill="#5c5648" />
      <rect x="40" y="68" width="44" height="52" fill="#9e5647" /><rect x="36" y="62" width="52" height="10" rx="2" fill="#b86958" />
      <path d="M110 116V76m40 40V76m40 40V76m40 40V76m40 40V76M100 84h220m-220 20h220" stroke="#8ba283" strokeWidth="3" />
      <rect x="120" y="104" width="16" height="14" fill="#a58963" /><path d="M128 104c-4-10 4-16 4-16s8 6 4 16" fill="#6f8a74" />
    </>}
    {name === 'harbor' && <>
      <rect x="0" y="0" width="320" height="180" fill="#e6f0ed" /><rect x="0" y="100" width="320" height="80" fill="#6f8d87" />
      <path d="M250 100 256 50h12l6 50H250Z" fill="#4a635d" /><rect x="254" y="44" width="16" height="8" fill="#d3c58e" />
      <path d="m80 92 14-22v22H80Zm16 0 10-14v14H96Z" fill="#3b5148" opacity=".6" />
      <path d="M140 40c4-4 8 0 12-4 4 4 8 0 12 4m40-10c3-3 6 0 9-3 3 3 6 0 9 3" stroke="#4a635d" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M0 134 160 120v60H0v-46Z" fill="#9c7a52" /><path d="M0 148l160-14m-160 20l160-14" stroke="#755234" strokeWidth="3" />
      <rect x="130" y="104" width="16" height="34" rx="3" fill="#63452b" /><ellipse cx="138" cy="118" rx="12" ry="4" stroke="#d3c58e" strokeWidth="3" fill="none" />
    </>}
    {name === 'garden' && <>
      <rect x="0" y="0" width="320" height="180" fill="#f0ebd8" />
      <path d="M20 180V60c0-30 40-44 80-44m120 164V60c0-30-40-44-80-44M20 110h280M60 180V32m100 148V16m100 164V32" stroke="#8ba283" strokeWidth="3" opacity=".6" fill="none" />
      <path d="M70 20v24m180-24v24" stroke="#77917f" strokeWidth="2" /><path d="M60 44c0 10 20 10 20 0H60Zm180 0c0 10 20 10 20 0h-20Z" fill="#a58963" /><path d="M62 48c-6 12 0 20 4 28m8-28c4 10 2 22-2 30m174-30c-6 12 0 20 4 28" stroke="#55755e" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M120 160h160m-130-22h130m-100-22h100" stroke="#8a6a45" strokeWidth="5" />
      <circle cx="160" cy="112" r="6" fill="#b35a4a" /><circle cx="190" cy="112" r="6" fill="#d3c58e" /><circle cx="220" cy="112" r="6" fill="#b35a4a" /><circle cx="200" cy="134" r="7" fill="#d49b5b" /><circle cx="230" cy="134" r="7" fill="#e07575" />
    </>}
    {name === 'street' && <>
      <rect x="0" y="0" width="320" height="180" fill="#ede8d6" /><path d="M10 130V50l60-14 60 14v80H10Z" fill="#cfc5a9" /><path d="M130 130V30l70-10 60 10v100H130Z" fill="#bfb395" />
      <path d="M20 74h100l-12 18H8L20 74Z" fill="#35483f" /><path d="M35 74l-6 18m24-18l-6 18m24-18l-6 18m24-18l-6 18" stroke="#f4eed8" strokeWidth="4" />
      <rect x="0" y="130" width="320" height="50" fill="#a99f84" /><path d="M10 144h40m30 0h50m40 0h60m-190 16h60m30 0h50m40 0h50" stroke="#8f856c" strokeWidth="3" strokeLinecap="round" strokeDasharray="8 6" />
      <rect x="236" y="98" width="24" height="42" rx="10" fill="#b35a4a" /><rect x="232" y="94" width="32" height="6" rx="3" fill="#8f3e30" /><path d="M240 106h16" stroke="#222" strokeWidth="3" />
      <path d="M160 140V50m-16 10c0-10 16-12 16-12s16 2 16 12" stroke="#35483f" strokeWidth="4" fill="none" /><circle cx="144" cy="62" r="6" fill="#f0d689" /><circle cx="176" cy="62" r="6" fill="#f0d689" />
    </>}
  </svg>;
}

export function StoryArt({ variant = 0 }: { variant?: number }) {
  return <svg className="story-art" viewBox="0 0 540 370" fill="none" aria-hidden="true">
    <circle cx="286" cy="173" r="160" fill="#3b5148" />
    <circle cx="286" cy="173" r="126" stroke="#839277" strokeOpacity=".18" />
    <path d="M153 300h315" stroke="#849179" strokeOpacity=".4" strokeWidth="2" strokeLinecap="round" />
    <path d="M199 75h136v147H199z" fill="#243a36" stroke="#6e8271" strokeWidth="3" />
    <path d="M267 75v147m-68-75h136" stroke="#6e8271" strokeWidth="3" />
    <path d="M328 78h-32v51c21-4 34-24 32-51Z" fill="#ead58f" />
    <circle cx="222" cy="98" r="2" fill="#ccd7b4" /><circle cx="309" cy="169" r="2" fill="#ccd7b4" />
    <path d="m179 64 3 8 8 3-8 3-3 8-3-8-8-3 8-3 3-8Zm197 97 4 11 11 4-11 4-4 11-4-11-11-4 11-4 4-11Z" fill="#c9d6a3" />
    <path d="M177 238h154v18H177z" fill="#a58963" />
    <path d="m188 256-7 44m137-44 7 44" stroke="#a58963" strokeWidth="8" />
    <path d="M236 229h44l-5-28h-34l-5 28Zm-8 0h59v8h-59v-8Z" fill="#25302c" stroke="#91a68c" strokeWidth="2" />
    <path d="M241 219h33" stroke="#d2c28a" strokeWidth="5" />
    <svg x="95" y="150" width="172" height="172" viewBox="0 0 160 160"><Character kind="duck" /></svg>
    <svg x={variant === 1 ? '340' : '330'} y="180" width="133" height="133" viewBox="0 0 160 160"><Character kind="cat" /></svg>
    <path d="m402 99 13-18 14 18-14 18-13-18Z" stroke="#c9d6a3" strokeWidth="2" />
    <path d="m126 126 6-2m-4-11 4 5m-17 4 6 1" stroke="#d4dfac" strokeWidth="2" strokeLinecap="round" />
    <path d="m443 249 9-2m-5-12 3 6" stroke="#d4dfac" strokeWidth="2" strokeLinecap="round" />
    {variant === 2 && <path d="M318 277c-23 13-22 20-7 20h29" stroke="#d7ce9a" strokeWidth="2" strokeDasharray="4 5" />}
  </svg>;
}

export function ClueArt({ variant }: { variant: 'table' | 'door' | 'borrow' }) {
  return <svg className="clue-art" viewBox="0 0 460 210" fill="none" role="img" aria-label={
    variant === 'table' ? '线索图：帽子位于桌子下方' : variant === 'door' ? '线索图：猫被门遮挡，躲在门后' : '线索图：暂时取走帽子，之后归还'
  }>
    <ellipse cx="230" cy="185" rx="160" ry="10" fill="#c9d0bc" opacity=".4" />
    {variant === 'table' ? <>
      <rect x="102" y="70" width="258" height="17" rx="5" fill="#ab8865" />
      <path d="m123 87-8 94m225-94 8 94" stroke="#927154" strokeWidth="12" strokeLinecap="round" />
      <path d="m204 162 7-40h43l7 40h-57Z" fill="#35483f" />
      <path d="M210 148h46" stroke="#d3c58e" strokeWidth="8" />
      <rect x="191" y="161" width="83" height="10" rx="5" fill="#35483f" />
      <path d="M293 41h21m-11-10v21" stroke="#c4bba3" strokeWidth="2" />
    </> : variant === 'door' ? <>
      <svg x="189" y="30" width="160" height="160" viewBox="0 0 160 160"><Character kind="cat" /></svg>
      <path d="m170 26 100 22v139H170V26Z" fill="#b9c9ac" stroke="#8c9f7e" strokeWidth="3" />
      <path d="m184 44 70 15v111h-70V44Z" stroke="#8c9f7e" strokeWidth="2" />
      <circle cx="249" cy="113" r="5" fill="#be9c60" />
    </> : <>
      <path d="m124 119 7-40h43l7 40h-57Z" fill="#35483f" />
      <rect x="111" y="118" width="83" height="10" rx="5" fill="#35483f" />
      <path d="M132 106h42" stroke="#d3c58e" strokeWidth="7" />
      <path d="M222 80h87m-12-12 12 12-12 12m11 48h-87m12-12-12 12 12 12" stroke="#849570" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <svg x="316" y="54" width="105" height="105" viewBox="0 0 160 160"><Character kind="cat" /></svg>
    </>}
  </svg>;
}

/** 剧集封面：按系列角色与背景元数据绘制，非侦探系列不再复用侦探主视觉。 */
export function SeriesArt({ cast, backdrop }: { cast: readonly string[]; backdrop: string }) {
  return <svg className="story-art" viewBox="0 0 540 370" fill="none" aria-hidden="true">
    <rect x="0" y="0" width="540" height="370" fill="#f2ecd9" />
    <svg x="30" y="20" width="480" height="270" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice"><SceneBackdrop tag={`@tag:${backdrop}`} /></svg>
    {cast.slice(0, 3).map((kind, i) => (
      <svg key={kind} x={60 + i * 150} y="140" width="180" height="180" viewBox="0 0 160 160"><Character kind={kind} /></svg>
    ))}
    <path d="M0 330h540" stroke="#8ba283" strokeWidth="4" />
  </svg>;
}
