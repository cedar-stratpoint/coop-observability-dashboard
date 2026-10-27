import {cn} from '@/lib/utils';

// The drop zone's illustration (Oct 28): the three files Coop takes, as a small fanned
// stack of sheets. In front, the inventory form (header strip, product rows and the BA's
// count columns, like the paper); behind it a POS sales export (CSV, green) and a
// Watsons POS Sales Data workbook (XLS, red), coloured with the same hues as
// FileTypeBadge (PDF 295, CSV 150, XLS 25). Theme-aware: sheets use the card colour, with
// lines mixed from the text colour. While files are dragged over (`active`) the sheets fan out a little and the
// upload badge lifts; transform-only, 200ms ease-out, off under reduced motion.

const hue = (h: number, a = 1) => `oklch(0.68 0.12 ${h} / ${a})`;
// Sheet lines and edges from the text colour, so they read in light and dark alike.
const ink = (pct: number) => `color-mix(in oklab, var(--foreground) ${pct}%, transparent)`;
const LINE = ink(14);
const EDGE = ink(20);

export function UploadIllustration({active = false, className}: {active?: boolean; className?: string}) {
  const move = 'transition-transform duration-200 ease-out motion-reduce:transition-none';
  return (
    <svg viewBox="0 0 240 150" aria-hidden className={cn('h-auto w-48 sm:w-56', className)} style={{overflow: 'visible'}}>
      {/* XLS: back right */}
      <g className={move} style={{transformOrigin: '150px 120px', transform: active ? 'rotate(14deg) translate(10px,-4px)' : 'rotate(9deg)'}}>
        <rect x="118" y="22" width="78" height="100" rx="8" fill="var(--card)" stroke={EDGE} />
        <rect x="118" y="22" width="78" height="16" rx="8" fill={hue(25, 0.18)} />
        <rect x="118" y="30" width="78" height="8" fill={hue(25, 0.18)} />
        {[0, 1, 2, 3, 4].map((r) => (
          <g key={r}>
            {[0, 1, 2].map((c) => (
              <rect key={c} x={126 + c * 22} y={46 + r * 13} width="18" height="8" rx="2" fill={r === 1 && c === 2 ? hue(25, 0.55) : LINE} />
            ))}
          </g>
        ))}
      </g>
      {/* CSV: back left */}
      <g className={move} style={{transformOrigin: '90px 120px', transform: active ? 'rotate(-14deg) translate(-10px,-4px)' : 'rotate(-9deg)'}}>
        <rect x="44" y="22" width="78" height="100" rx="8" fill="var(--card)" stroke={EDGE} />
        <rect x="44" y="22" width="78" height="16" rx="8" fill={hue(150, 0.18)} />
        <rect x="44" y="30" width="78" height="8" fill={hue(150, 0.18)} />
        {[0, 1, 2, 3, 4, 5].map((r) => (
          <g key={r}>
            <rect x="52" y={46 + r * 11} width="30" height="5" rx="2.5" fill={LINE} />
            <rect x="88" y={46 + r * 11} width={r % 2 ? 14 : 22} height="5" rx="2.5" fill={r === 3 ? hue(150, 0.6) : LINE} />
          </g>
        ))}
      </g>
      {/* Inventory form: front */}
      <g className={move} style={{transform: active ? 'translateY(-6px)' : 'none'}}>
        <rect x="78" y="14" width="84" height="112" rx="9" fill="var(--card)" stroke={EDGE} />
        <rect x="88" y="24" width="40" height="6" rx="3" fill={hue(295, 0.6)} />
        <rect x="88" y="34" width="56" height="4" rx="2" fill={LINE} />
        <line x1="88" y1="46" x2="152" y2="46" stroke={EDGE} />
        {[0, 1, 2, 3, 4, 5, 6].map((r) => (
          <g key={r}>
            <rect x="88" y={52 + r * 9.5} width={r % 3 === 1 ? 20 : 26} height="4" rx="2" fill={LINE} />
            {[0, 1, 2, 3].map((c) => (
              <rect key={c} x={120 + c * 8.5} y={51 + r * 9.5} width="6" height="6" rx="1.5" fill="none" stroke={r === 2 && c === 1 ? hue(295, 0.9) : EDGE} />
            ))}
          </g>
        ))}
      </g>
      {/* Upload badge */}
      <g className={move} style={{transform: active ? 'translateY(-8px)' : 'none'}}>
        <circle cx="160" cy="118" r="17" fill="var(--primary)" />
        <path d="M160 126v-15m-6 6 6-6 6 6" fill="none" stroke="var(--primary-foreground)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
