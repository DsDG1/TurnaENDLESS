import type { CSSProperties } from 'react';

const paths = {
  discover: 'M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  progress: 'M4 20V10m8 10V4m8 16v-7',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  back: 'M20 12H4m6-6-6 6 6 6',
  down: 'm7 10 5 5 5-5',
  play: 'm9 5 11 7-11 7V5Z',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  cloud: 'M7 18a5 5 0 0 1-1-10 7 7 0 0 1 13 2 4 4 0 0 1-1 8M9 15l3 3 5-6',
  book: 'M12 6C9 3 5 3 2 4v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-3-1-7-1-10 2Zm0 0v15',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  chat: 'M21 11a8 8 0 0 1-8 8H5l-4 3V11a10 10 0 0 1 20 0ZM7 10h8M7 14h5',
  comic: 'M3 3h18v18H3V3Zm9 0v18M3 12h9',
  target: 'M20 12a8 8 0 1 1-8-8m8 0-8 8m4-8h4v4M15 12a3 3 0 1 1-3-3',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  info: 'M12 11v6m0-10v.2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  desktop: 'M3 4h18v13H3V4Zm9 13v4m-5 0h10',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  leaf: 'M5 19C-1 6 12 3 21 3c0 11-4 19-13 15m-4 3L16 9',
  repeat: 'm17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}

export function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand${small ? ' brand-small' : ''}`}>
    <svg width="35" height="30" viewBox="0 0 44 32" fill="none" aria-hidden="true"><path d="M4 8h12l12 17h12V8H28L16 25H4Z" stroke="currentColor" strokeWidth="4.5" strokeLinejoin="round" /></svg>
    <span>ENDLESS<span className="brand-period">.</span></span>
  </span>;
}
