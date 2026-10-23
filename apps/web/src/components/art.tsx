export function Character({ kind, className = '' }: { kind: string; className?: string }) {
  return <svg className={className} viewBox="0 0 160 160" fill="none" aria-hidden="true">
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
    </> : <>
      <ellipse cx="80" cy="146" rx="46" ry="7" fill="#9c9464" opacity=".12" />
      <path d="M104 22c-33-9-63 15-63 51 0 40 32 65 70 52-22-9-35-30-35-53 0-22 11-40 28-50Z" fill="#f0d689" />
      <path d="M102 28C80 45 76 85 97 110" stroke="#e5c16b" strokeWidth="3" strokeLinecap="round" />
      <path d="m56 71 5-3m-7 17 5 2" stroke="#a5905c" strokeWidth="2" strokeLinecap="round" />
      <circle cx="61" cy="76" r="3" fill="#555a41" />
      <path d="m58 91 9 2" stroke="#555a41" strokeWidth="2" strokeLinecap="round" />
      <path d="m114 39 3 9 9 3-9 3-3 9-3-9-9-3 9-3 3-9Zm13 46 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z" fill="#f0d689" />
    </>}
  </svg>;
}

export function PropArt({ reference }: { reference: string }) {
  const name = reference.replace('@emoji:', '');
  const labels: Record<string, string> = { top_hat: '礼帽', notebook: '笔记本', magnifying_glass: '放大镜' };
  const label = labels[name];
  if (!label) throw new Error(`试播界面不支持该道具：${reference}`);
  return <svg viewBox="0 0 80 80" fill="none" role="img" aria-label={label}>
    {name === 'top_hat' ? <>
      <path d="m19 57 6-36h31l6 36H19Z" fill="#35483f" />
      <path d="M24 47h34" stroke="#d3c58e" strokeWidth="7" />
      <rect x="11" y="56" width="61" height="9" rx="4" fill="#35483f" />
    </> : name === 'notebook' ? <>
      <rect x="18" y="12" width="46" height="58" rx="5" fill="#ae8a63" />
      <path d="M27 12v58" stroke="#7b6145" strokeWidth="3" />
      <path d="M35 28h20m-20 9h20m-20 9h13" stroke="#f4e6bf" strokeWidth="2" strokeLinecap="round" />
    </> : <>
      <circle cx="34" cy="31" r="21" fill="#dce9d4" fillOpacity=".8" stroke="#52694c" strokeWidth="6" />
      <path d="m50 48 18 22" stroke="#52694c" strokeWidth="10" strokeLinecap="round" />
      <path d="M23 29c0-7 5-12 12-12" stroke="#fffdf3" strokeWidth="3" strokeLinecap="round" />
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
