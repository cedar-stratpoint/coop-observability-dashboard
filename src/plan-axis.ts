// Pure: y-axis ticks for the Business Health Report's hand-drawn SVG charts (cash, target stock orders). Round steps (1, 2, 2.5, 5 × 10^n) that cover the
// data, and labels that keep the decimals their step needs, so two gridlines never read the same ("0k, 0k, 1k, 1k, 2k", owner 2026-11-06).

/** A round step at or above `raw` (1, 2, 2.5, 5, 10 times a power of ten). Same rule as niceMax in components/analyst/chat-blocks-format.ts. */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/** About `count` round gridlines from at or below `min` to at or above `max`; zero is a gridline whenever the range crosses it. */
export function axisTicks(min: number, max: number, count = 4): {lo: number; hi: number; ticks: number[]} {
  if (max === min) { max += Math.abs(max) * 0.1 || 1; min -= Math.abs(min) * 0.1 || 1; }
  const step = niceStep((max - min) / count);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return {lo, hi, ticks};
}

/** A tick label in pesos: 500, 1.5k, 2M. Decimals only where the step needs them. */
export function fmtAxisTick(v: number, step: number): string {
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a === 0) return '0';
  const unit = a >= 1e6 ? 1e6 : a >= 1000 ? 1000 : 1;
  const dp = unit === 1 ? 0 : Math.max(0, Math.ceil(-Math.log10(step / unit) + 1e-9));
  const n = (a / unit).toFixed(Math.min(dp, 2)).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return `${sign}${n}${unit === 1e6 ? 'M' : unit === 1000 ? 'k' : ''}`;
}
