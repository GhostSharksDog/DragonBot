import type { CSSProperties } from 'react';

export type IconName = 'close' | 'settings' | 'history' | 'plus' | 'send' | 'stop' | 'chevron' | 'folder' | 'globe' | 'check' | 'spark' | 'refresh' | 'arrow' | 'shield' | 'image' | 'minus' | 'external';
const paths: Record<IconName, string> = {
  close: 'm6 6 12 12M18 6 6 18', settings: 'm9.5 4 .7-2h3.6l.7 2 2 .9 2.2-.4 1.8 3.1-1.5 1.6v2.4l1.5 1.6-1.8 3.1-2.2-.4-2 .9-.7 2h-3.6l-.7-2-2-.9-2.2.4-1.8-3.1L3.1 12V9.6L1.6 8l1.8-3.1 2.2.4 2-.9Zm-.6 6.9a3.1 3.1 0 1 0 6.2 0 3.1 3.1 0 1 0-6.2 0',
  history: 'M3 10a9 9 0 1 1 2 8M3 4v6h6m3-4v6l4 2', plus: 'M12 5v14M5 12h14', send: 'm4 4 17 8-17 8 3-8-3-8Zm3 8h14', stop: 'M6 6h12v12H6Z', chevron: 'm9 5 7 7-7 7', folder: 'M3 7V5h6l2 2h10v13H3V7Z', globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-18 0h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z', check: 'm5 12 4 4L19 6', spark: 'm12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z', refresh: 'M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5m-4 6a8 8 0 0 0 14 5l3-3m0 5v-5h-5', arrow: 'M5 12h14m-6-6 6 6-6 6', shield: 'm12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3Zm-4 9 3 3 5-6', image: 'M3 3h18v18H3Zm0 14 6-6 5 5 3-3 4 4M15 7h.01', minus: 'M5 12h14', external: 'M14 3h7v7m0-7L10 14M10 4H4v16h16v-6',
};
export function Icon({ name, size = 18, style, className }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style} className={className}><path d={paths[name]} /></svg>;
}

/** A temporary egg, deliberately distinct from the still-missing character reference. */
export function Egg({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 180 200" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="egg-shell" x1="45" y1="25" x2="140" y2="180" gradientUnits="userSpaceOnUse"><stop stopColor="#f4fff8" /><stop offset=".7" stopColor="#d5ebda" /><stop offset="1" stopColor="#9ccbb7" /></linearGradient>
      <linearGradient id="egg-horn" x1="50" y1="20" x2="68" y2="76" gradientUnits="userSpaceOnUse"><stop stopColor="#b5d3a9" /><stop offset="1" stopColor="#448b70" /></linearGradient>
    </defs>
    <ellipse cx="91" cy="185" rx="48" ry="6" fill="#1c5741" opacity=".11" />
    <g className="egg-body">
      <path d="M57 69C39 52 45 34 49 25c2 17 13 19 25 26m35 2c13-4 22-14 24-28 9 20 5 35-11 46" fill="url(#egg-horn)" stroke="#3e7762" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M90 42c-32 0-59 57-59 91 0 32 25 50 59 50s59-18 59-50c0-34-27-91-59-91Z" fill="url(#egg-shell)" stroke="#5f8b75" strokeWidth="2.5" />
      <path d="m35 118 17 8 12-10 15 12 15-9 15 9 14-12 22 7" stroke="#77a089" strokeWidth="2" strokeLinejoin="round" />
      <path d="m78 71 12-9 12 9-12 11-12-11Z" fill="#83b298" opacity=".6" />
      <g className="egg-eyes" stroke="#365e4d" strokeWidth="3.2" strokeLinecap="round"><path d="M65 100v5M115 100v5" /></g>
      <path d="M85 108q5 5 10 0" stroke="#365e4d" strokeWidth="2.2" strokeLinecap="round" />
      <ellipse cx="56" cy="109" rx="7" ry="3.5" fill="#d5a29b" opacity=".5" /><ellipse cx="124" cy="109" rx="7" ry="3.5" fill="#d5a29b" opacity=".5" />
      <path d="M48 141c4 14 11 22 25 26" stroke="#fffef7" strokeWidth="5" opacity=".65" strokeLinecap="round" />
      <path d="m117 147 6 3-6 4-5-4 5-3Z" fill="#75a185" opacity=".55" />
    </g>
    <path className="egg-spark" d="m156 64 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z" fill="#93ad79" />
  </svg>;
}
