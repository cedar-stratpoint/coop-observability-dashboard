'use client';

import {useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowLeft, ChevronDown} from 'lucide-react';
import dynamic from 'next/dynamic';
import {CHANNELS, CHANNEL_ACCENT, shortMonth, hexToRgb} from './health-view-shared';
import type {BusinessHealthSnapshot, ChannelActuals, ChannelFacts, Knobs} from '@/src/health-types';
import {DEFAULT_WEBSITE_ACQ_COST, computeChannelHealth, computeHealth, computeOverallHealth, factsToActuals} from '@/src/health-compute';
import {HEALTH_HINTS} from './health-hints';
import {InfoTip} from './info-tip';

const peso2 = (n: number) => '₱' + n.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
// Percent with up to 2 decimals, trailing zeros trimmed (40% stays "40%",
// 0.4167 → "41.67%") — so fractional COGS/Fee inputs aren't rounded away.
const pct = (f: number) => `${(Math.round(f * 10000) / 100).toString()}%`;
const fmtQrr = (q: number | null) => (q == null ? 'N/A' : q >= 100 ? q.toLocaleString(undefined, {maximumFractionDigits: 0}) : q.toFixed(2));
const fmtRange = (from: string, to: string) => {
  const md = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
  return `${md(from)} – ${md(to)}, ${new Date(`${to}T00:00:00Z`).getUTCFullYear()}`;
};

const CHANNEL_LABEL: Record<string, string> = {shopee: 'Shopee', lazada: 'Lazada', website: 'Website', offline: 'Offline'};

/** Short focus-guide captions (what each field is asking for). */
const FIELD_HELP: Record<string, string> = {
  cogs: 'COGS — cost to make + ship the product, as a % of revenue.',
  platformFee: 'Platform Fee — the marketplace’s cut, as a % of revenue.',
  promos: 'Promos — total ₱ spent on discounts & bundles this window.',
  acqCost: 'Acq. cost — total ₱ spent acquiring website customers (organic/ops). Seeded at ₱5,000 as a placeholder — edit it.',
  aov: 'AOV — average order value (measured). Edit to model a target.',
  orders: 'Orders (measured). Edit to model a target scenario.',
  buyers: 'Distinct buyers (measured). Edit to model a target scenario.',
  roas: 'ROAS — return on ad spend (measured). Edit to model a target.',
};

/** A bold, highlighted section label (QRR / LTV / CAC). */
function SectionLabel({children, hint}: {children: React.ReactNode; hint?: string}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="rounded-md bg-foreground/[0.07] px-2 py-0.5 text-xs font-bold uppercase tracking-[0.09em] text-foreground">{children}</span>
      {hint && <InfoTip text={hint} />}
    </span>
  );
}

/** Wraps a computed value and replays a "pop" animation whenever `value` changes
 *  (skips the initial render). Respects prefers-reduced-motion via CSS. */
function Pop({value, className, children}: {value: number | string | null; className?: string; children: React.ReactNode}) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el) return;
    el.classList.remove('health-pop');
    void el.offsetWidth; // force reflow so the animation replays
    el.classList.add('health-pop');
  }, [value]);
  return (
    <span ref={ref} className={`inline-block ${className ?? ''}`}>
      {children}
    </span>
  );
}

/** An editable MEASURED value (AOV / Orders / Buyers / ROAS) — dashed neutral
 *  outline to distinguish it from the solid-accent assumption chips. Turns amber
 *  when overridden away from the measured actual, signalling a hypothetical. */
function ActualField({initial, baseline, onChange, prefix, suffix, helpKey, setHelp}: {
  initial: string; baseline: number; onChange: (n: number) => void; prefix?: string; suffix?: string; helpKey: string; setHelp: (s: string | null) => void;
}) {
  const [text, setText] = useState(initial);
  const changed = (parseFloat(text) || 0) !== baseline;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-md border border-dashed px-1.5 py-0.5 align-middle transition-colors focus-within:ring-2 focus-within:ring-foreground/40 ${changed ? 'border-amber-500 bg-amber-500/[0.07]' : 'border-foreground/30 bg-background hover:border-foreground/55'}`}>
      {prefix && <span className="text-[13px] text-muted-foreground">{prefix}</span>}
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onFocus={() => setHelp(FIELD_HELP[helpKey] ?? null)}
        onBlur={() => setHelp(null)}
        onChange={(e) => {
          const v = e.target.value;
          if (!/^\d*\.?\d*$/.test(v)) return;
          setText(v);
          const n = parseFloat(v);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        style={{width: `${Math.max(2, text.length + 1)}ch`}}
        className={`bg-transparent text-center text-[15px] font-bold tabular-nums outline-none transition-[width] duration-150 ease-out ${changed ? 'text-amber-700 dark:text-amber-400' : 'text-foreground'}`}
      />
      {suffix && <span className="text-[13px] text-muted-foreground">{suffix}</span>}
    </span>
  );
}

/** Read-only value token inside an equation. */
function Val({children, hint}: {children: React.ReactNode; hint?: string}) {
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap font-semibold tabular-nums text-foreground">
      {children}
      {hint && <InfoTip text={hint} />}
    </span>
  );
}

/** A labelled, editable variable chip. The label lives inside the chip so it's
 *  always clear what the field is; focus lights it up and shows a guide caption. */
function Knob({label, helpKey, initial, suffix, accent, disabled, onChange, setHelp}: {
  label: string; helpKey: string; initial: string; suffix: string; accent: string; disabled?: boolean;
  onChange: (n: number) => void; setHelp: (s: string | null) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border-2 bg-background px-2 py-1 transition-colors focus-within:ring-2 focus-within:ring-foreground/40 ${disabled ? 'border-border opacity-60' : 'border-border focus-within:bg-background'}`}
      style={disabled ? undefined : {borderColor: 'var(--knob-border)', ['--knob-border' as string]: accent + '55'}}
    >
      <span className="text-[10.5px] font-bold uppercase tracking-wide text-foreground/70">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={text}
        onFocus={() => setHelp(FIELD_HELP[helpKey] ?? null)}
        onBlur={() => setHelp(null)}
        onChange={(e) => {
          const v = e.target.value;
          if (!/^\d*\.?\d*$/.test(v)) return;
          setText(v);
          const n = parseFloat(v);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        style={{width: `${Math.max(3, text.length + 1)}ch`}}
        className="bg-transparent text-center text-base font-bold tabular-nums text-foreground outline-none transition-[width] duration-150 ease-out disabled:text-muted-foreground"
      />
      <span className="text-sm font-medium text-muted-foreground">{suffix}</span>
    </span>
  );
}

const op = (s: string) => <span className="mx-1.5 font-medium text-foreground/45">{s}</span>;

/** iOS-style segmented control: a single glass thumb slides between segments.
 *  Arrow keys / Home / End move the selection (role=tablist), and the slide is
 *  dropped entirely under prefers-reduced-motion. */
function SegmentedControl<T extends string>({options, value, onChange, accentFor, ariaLabel}: {
  options: {key: T; label: string}[];
  value: T;
  onChange: (v: T) => void;
  accentFor?: (v: T) => string;
  ariaLabel: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [thumb, setThumb] = useState<{x: number; w: number} | null>(null);
  const [ready, setReady] = useState(false); // no slide-in from 0 on first paint

  useEffect(() => {
    const measure = () => {
      const el = btnRefs.current[value];
      if (!el) return;
      setThumb({x: el.offsetLeft, w: el.offsetWidth});
    };
    measure();
    const raf = requestAnimationFrame(() => setReady(true));
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [value, options.length]);

  const accent = accentFor ? accentFor(value) : '#059669';

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = options.findIndex((o) => o.key === value);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % options.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + options.length) % options.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = options.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onChange(options[n].key);
    btnRefs.current[options[n].key]?.focus();
  };

  return (
    <div
      ref={wrapRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="relative inline-flex rounded-xl border border-border bg-muted/50 p-1"
    >
      {thumb && (
        <span
          aria-hidden
          className={`absolute inset-y-1 left-0 rounded-lg ${ready ? 'motion-safe:transition-[transform,width] motion-safe:duration-[380ms]' : ''}`}
          style={{
            transform: `translateX(${thumb.x}px)`,
            width: thumb.w,
            backgroundColor: accent,
            // iOS segmented-control curve: settles with a slight overshoot.
            transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), 0 1px 3px rgba(0,0,0,0.20)',
            backdropFilter: 'blur(6px)',
          }}
        />
      )}
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            ref={(el) => {
              btnRefs.current[o.key] = el;
            }}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.key)}
            className={`relative z-10 rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/45 focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
              active ? 'text-white' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The whole business as one number, beside the page title (Cards tab only). */
function OverallQrrPill({channels, target}: {
  channels: {channel: string; actuals: ChannelActuals; knobs: Knobs}[]; target: number;
}) {
  const o = computeOverallHealth(channels);
  const na = o.qrr == null;
  const onTrack = !na && o.qrr! >= target;
  const tone = na
    ? 'border-border bg-muted/40 text-muted-foreground'
    : onTrack
      ? 'border-emerald-500/45 bg-emerald-500/[0.09] text-emerald-700 dark:text-emerald-400'
      : 'border-amber-500/45 bg-amber-500/[0.09] text-amber-700 dark:text-amber-400';
  const names = (list: string[]) => list.map((c) => CHANNEL_LABEL[c] ?? c).join(' + ');

  return (
    <div className={`rounded-xl border px-4 py-2.5 ${tone}`}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.09em] text-foreground/60">Overall QRR</span>
        <InfoTip text={HEALTH_HINTS.overallQrr} />
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <Pop value={o.qrr} className="text-[30px] font-bold leading-none tabular-nums">{fmtQrr(o.qrr)}</Pop>
        <span className="text-xs font-medium text-muted-foreground">/ target {target}</span>
      </div>
      {/* Same progress-to-target read as the channel cards, so the two match. */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.09]">
        <div
          className={`h-full rounded-full transition-all duration-500 ${onTrack ? 'bg-emerald-500' : 'bg-amber-500'}`}
          style={{width: na ? '0%' : `${Math.min(100, (o.qrr! / target) * 100)}%`}}
        />
      </div>
      {!na && (
        <div className="mt-1.5 text-[11px] text-foreground/70">
          LTV <span className="font-semibold text-foreground">{peso2(o.contribution)}</span>{op('÷')}CAC{' '}
          <span className="font-semibold text-foreground">{peso2(o.cac)}</span>
        </div>
      )}
      <div className="mt-1 text-[11px] text-foreground/55">
        {na
          ? 'No channel has an acquisition cost yet'
          : `${names(o.included)}${o.excluded.length ? ` · ${names(o.excluded)} excluded (no CAC)` : ''}`}
      </div>
    </div>
  );
}

function ChannelCard({facts, actuals, knobs, target, nonce, dirty, onReset, onActual, onKnob}: {
  facts: ChannelFacts; actuals: ChannelActuals; knobs: Knobs; target: number; nonce: number;
  dirty: boolean; onReset: () => void; onActual: (a: ChannelActuals) => void; onKnob: (k: Knobs) => void;
}) {
  const base = factsToActuals(facts); // measured baselines (for the overridden highlight)
  const h = computeHealth(actuals, knobs);
  const accent = CHANNEL_ACCENT[facts.channel];
  const [help, setHelp] = useState<string | null>(null);
  const naQrr = h.qrr == null;
  const onTrack = !naQrr && h.qrr! >= target;
  const qrrColor = naQrr ? 'text-muted-foreground' : onTrack ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400';
  const barColor = onTrack ? 'bg-emerald-500' : 'bg-amber-500';

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md">
      <div className="h-1.5" style={{backgroundColor: accent}} />
      <div className="flex flex-1 flex-col gap-4 p-6">
        <div className="flex items-center gap-2 text-base font-bold text-foreground">
          <span className="size-3 rounded-full" style={{backgroundColor: accent}} />
          {CHANNEL_LABEL[facts.channel]} <InfoTip text={HEALTH_HINTS[`ch_${facts.channel}`]} />
          {dirty && (
            <button
              onClick={onReset}
              className="ml-auto inline-flex items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-700 shadow-sm transition-colors hover:bg-amber-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300"
            >
              <span className="text-[13px] leading-none">↺</span> Reset
            </button>
          )}
        </div>

        {/* QRR hero */}
        <div>
          <SectionLabel hint={HEALTH_HINTS.qrr}>QRR</SectionLabel>
          <div className="mt-2 flex items-baseline gap-2.5">
            <Pop value={h.qrr} className={`text-[54px] font-bold leading-none tabular-nums ${qrrColor}`}>{fmtQrr(h.qrr)}</Pop>
            <span className="text-sm font-medium text-muted-foreground">/ target {target}</span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{width: naQrr ? '0%' : `${Math.min(100, (h.qrr! / target) * 100)}%`}} />
          </div>
          <div className="mt-2.5 text-sm text-foreground/75">
            LTV <span className="font-semibold text-foreground">{peso2(h.contribution)}</span>{op('÷')}CAC <span className="font-semibold text-foreground">{peso2(h.cac)}</span>{op('=')}<span className="font-bold text-foreground">{fmtQrr(h.qrr)}</span>
          </div>
        </div>

        {/* LTV — per-order gross margin (label kept; see HEALTH_HINTS.contribution) */}
        <div className="rounded-xl border border-border bg-muted/25 p-4">
          <div className="flex items-center justify-between">
            <SectionLabel hint={HEALTH_HINTS.contribution}>LTV</SectionLabel>
            <Pop value={h.contribution} className="text-[22px] font-bold tabular-nums text-foreground">{peso2(h.contribution)}</Pop>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-y-2 text-[15px] text-foreground/85">
            <span className="text-foreground/60">AOV</span>&nbsp;
            <ActualField prefix="₱" initial={String(actuals.aov)} baseline={base.aov} helpKey="aov" setHelp={setHelp} onChange={(n) => onActual({...actuals, aov: n})} />
            {op('×')}<span className="text-foreground/60">Margin</span>&nbsp;
            <span className="inline-flex items-center gap-0.5 font-semibold tabular-nums text-foreground">
              <Pop value={h.margin}>{pct(h.margin)}</Pop>
              <InfoTip text={HEALTH_HINTS.margin} />
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[15px] text-foreground/85">
            <span className="text-foreground/60">Margin{op('=')}1</span>
            {op('−')}
            <Knob label="COGS" helpKey="cogs" initial={String(Math.round(knobs.cogsPct * 100))} suffix="%" accent={accent} setHelp={setHelp} onChange={(n) => onKnob({...knobs, cogsPct: n / 100})} />
            {op('−')}
            <Knob label="Platform Fee" helpKey="platformFee" initial={String(Math.round(knobs.platformFeePct * 100))} suffix="%" accent={accent} disabled={!facts.platformFeeApplies} setHelp={setHelp} onChange={(n) => onKnob({...knobs, platformFeePct: n / 100})} />
          </div>
        </div>

        {/* CAC */}
        <div className="rounded-xl border border-border bg-muted/25 p-4">
          <div className="flex items-center justify-between">
            <SectionLabel hint={HEALTH_HINTS.cac}>CAC</SectionLabel>
            <Pop value={h.cac} className="text-[22px] font-bold tabular-nums text-foreground">{peso2(h.cac)}</Pop>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[15px] text-foreground/85">
            {h.roas != null ? (
              <span className="inline-flex items-center gap-1">
                <span className="text-foreground/60">(AOV</span>&nbsp;<Val>{peso2(h.aov)}</Val>{op('÷')}<span className="text-foreground/60">ROAS</span>
                <ActualField suffix="×" initial={String(actuals.roas ?? '')} baseline={base.roas ?? 0} helpKey="roas" setHelp={setHelp} onChange={(n) => onActual({...actuals, roas: n})} />
                <span className="text-foreground/60">)</span>
              </span>
            ) : (
              <Knob label="Acq. cost" helpKey="acqCost" initial={String(knobs.acqCost)} suffix="₱" accent={accent} setHelp={setHelp} onChange={(n) => onKnob({...knobs, acqCost: n})} />
            )}
            {h.roas == null && <span className="inline-flex items-center gap-1 text-foreground/60">÷ {actuals.orders.toLocaleString()} orders <InfoTip text={HEALTH_HINTS.perOrder} /></span>}
            {op('+')}
            <Knob label="Promos" helpKey="promos" initial={String(knobs.promos)} suffix="₱" accent={accent} setHelp={setHelp} onChange={(n) => onKnob({...knobs, promos: n})} />
            <span className="inline-flex items-center gap-1 text-foreground/60">÷ {actuals.orders.toLocaleString()} orders <InfoTip text={HEALTH_HINTS.perOrder} /></span>
          </div>
          <div className="mt-3 text-sm text-foreground/60">
            = {peso2(h.marketingPerOrder)}/order {h.roas != null ? 'marketing' : 'acquisition'} + {peso2(h.promosPerOrder)}/order promo
          </div>
          {naQrr && (
            <div className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-[13px] font-medium text-amber-700 dark:text-amber-400">
              No acquisition cost yet — enter an Acq. cost or Promos to compute QRR.
            </div>
          )}
        </div>

        {/* Repeat rate — tracked, but deliberately outside the ratio. Orders
            still drives CAC (and the blend's weighting), so both stay editable.
            Offline has no buyer identity (the POS doesn't capture one), so repeat
            rate can't be computed — shown as N/A rather than a misleading 0. */}
        {facts.channel === 'offline' ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/15 p-4">
            <div className="flex items-center justify-between">
              <SectionLabel hint={HEALTH_HINTS.repeat}>Repeat rate</SectionLabel>
              <span className="text-[22px] font-bold tabular-nums text-foreground/50">N/A</span>
            </div>
            <div className="mt-2 text-[13px] leading-snug text-foreground/55">
              The POS doesn&rsquo;t capture buyer identity yet, so orders per buyer can&rsquo;t be measured. A separate signal, <span className="font-semibold">not</span> part of QRR.
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-muted/15 p-4">
            <div className="flex items-center justify-between">
              <SectionLabel hint={HEALTH_HINTS.repeat}>Repeat rate</SectionLabel>
              <Pop value={h.repeat} className="text-[22px] font-bold tabular-nums text-foreground">{h.repeat.toFixed(2)}×</Pop>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-y-2 text-[15px] text-foreground/85">
              <ActualField suffix="orders" initial={String(actuals.orders)} baseline={base.orders} helpKey="orders" setHelp={setHelp} onChange={(n) => onActual({...actuals, orders: n})} />
              {op('÷')}
              <ActualField suffix="buyers" initial={String(actuals.buyers)} baseline={base.buyers} helpKey="buyers" setHelp={setHelp} onChange={(n) => onActual({...actuals, buyers: n})} />
            </div>
            <div className="mt-2 text-[13px] leading-snug text-foreground/55">
              Orders per buyer. A separate signal, <span className="font-semibold">not</span> part of QRR.
            </div>
          </div>
        )}

        {/* Focus guide */}
        <div className={`min-h-[1.25rem] text-[13px] font-medium transition-colors ${help ? 'text-foreground/80' : 'text-transparent'}`}>
          {help ?? 'placeholder'}
        </div>

        {/* Measured-data footer (source of truth for the editable fields above) */}
        <div className="mt-auto border-t border-border pt-3.5">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium text-foreground/70">
            <span className="text-foreground/45">Measured</span>
            <span className="inline-flex items-center gap-1">{facts.orders.toLocaleString()} orders <InfoTip text={HEALTH_HINTS.orders} /></span>
            {facts.channel !== 'offline' && (
              <span className="inline-flex items-center gap-1">{facts.buyers.toLocaleString()} buyers <InfoTip text={HEALTH_HINTS.buyers} /></span>
            )}
            <span>{peso2(facts.revenue)} revenue</span>
          </div>
          {facts.channel === 'website' && (
            <p className="mt-2 text-xs italic leading-snug text-foreground/55">
              Note: CRM order history starts 17 Apr 2026 — earlier website orders aren’t synced, so volume is expected to be lower.
            </p>
          )}
          {facts.channel === 'offline' && (
            <p className="mt-2 text-xs italic leading-snug text-foreground/55">
              Note: POS bazaar sales. No ads (so no ROAS), and CAC comes from an event cost you enter. It joins the Overall QRR once that cost is set.
            </p>
          )}
        </div>
        <span hidden>{nonce}</span>
      </div>
    </div>
  );
}

// Recharts is code-split: the two Business Health charts live in
// ./health-view-chart and load as async chunks, keeping Recharts (~110 kB gz) out
// of the /health initial JS. Height-matched skeletons hold layout (no CLS).
const TrendView = dynamic(() => import('./health-view-chart').then((m) => m.TrendView), {
  ssr: false,
  loading: () => <div className="h-[420px] w-full animate-pulse rounded-lg bg-muted/40 max-md:h-[320px]" aria-hidden />,
});
const BuyerMixChart = dynamic(() => import('./health-view-chart').then((m) => m.BuyerMixChart), {
  ssr: false,
  loading: () => <div className="h-[320px] w-full animate-pulse rounded-lg bg-muted/40 max-md:h-[260px]" aria-hidden />,
});

function HeatmapView({snapshot}: {snapshot: BusinessHealthSnapshot}) {
  const [ch, setCh] = useState<'shopee' | 'lazada' | 'website'>('shopee');
  const matrix = snapshot.cohorts?.[ch];
  const rows = (matrix?.rows ?? []).filter((r) => r.size > 0);
  const rgb = hexToRgb(CHANNEL_ACCENT[ch]);
  const cell = (v: number) => ({background: `rgba(${rgb},${(0.08 + 0.85 * v).toFixed(3)})`, color: v > 0.5 ? '#fff' : undefined});
  const mixData = (snapshot.buyerMix?.[ch] ?? []).map((m) => ({label: shortMonth(m.month), newBuyers: m.newBuyers, returning: m.returning}));
  const hasMix = mixData.some((m) => m.newBuyers + m.returning > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="mr-auto text-sm font-semibold text-foreground">Retention &amp; buyer mix · counts distinct buyers (unique customers, not orders)</span>
        {/* Channel switcher carries each channel's own accent — the colour
            vocabulary already used by the cards, bars and heatmap cells. */}
        <SegmentedControl
          ariaLabel="Channel"
          options={CHANNELS.map((c) => ({key: c.key, label: c.label}))}
          value={ch}
          onChange={setCh}
          accentFor={(k) => CHANNEL_ACCENT[k]}
        />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-0.5 flex items-center gap-1 text-sm font-semibold text-foreground">
          Cohort Retention · {CHANNEL_LABEL[ch]}
          <InfoTip text="Each row is a cohort — buyers whose FIRST purchase was that month. Reading across, a cell is the % of that cohort's BUYERS who ordered again in that later month (own month = 100%). Distinct buyers, not orders." />
        </div>
        <p className="mb-3 text-xs text-muted-foreground">% of each month’s new buyers who came back in later months.</p>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No cohort data for {CHANNEL_LABEL[ch]} in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate text-sm" style={{borderSpacing: 3}}>
            <thead>
              <tr className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1 text-left">Cohort</th>
                <th className="px-2 py-1 text-right">Buyers</th>
                {(matrix?.months ?? []).map((m) => (
                  <th key={m} className="px-2 py-1 text-center">{shortMonth(m)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ci = (matrix?.months ?? []).indexOf(r.cohort);
                return (
                  <tr key={r.cohort}>
                    <td className="whitespace-nowrap px-2 py-1 font-semibold text-foreground">{shortMonth(r.cohort)} ’{r.cohort.slice(2, 4)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{r.size.toLocaleString()}</td>
                    {(matrix?.months ?? []).map((m, mj) => {
                      if (mj < ci) return <td key={m} className="px-2 py-1" />; // before this cohort existed
                      const v = r.retention[mj - ci];
                      const active = Math.round(v * r.size);
                      return (
                        <td
                          key={m}
                          className="whitespace-nowrap rounded-md px-2 py-1.5 text-center text-[13px] font-semibold tabular-nums"
                          style={cell(v)}
                          title={`${shortMonth(r.cohort)} cohort in ${shortMonth(m)}: ${active} of ${r.size} retained (${Math.round(v * 100)}%)`}
                        >
                          {active} ({Math.round(v * 100)}%)
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* legend */}
      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <span>Retention</span>
        <span className="text-[11px]">0%</span>
        <span className="inline-flex h-3 w-40 overflow-hidden rounded">
          {Array.from({length: 20}, (_, i) => (
            <span key={i} className="h-full flex-1" style={{background: `rgba(${rgb},${(0.08 + 0.85 * (i / 19)).toFixed(3)})`}} />
          ))}
        </span>
        <span className="text-[11px]">100%</span>
        <span className="ml-3">A cohort’s own month is 100%; cells to the right are later months’ repeat rates.</span>
      </div>
    </div>

      {/* New vs Returning buyers — follows the same channel selector */}
      {hasMix && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-0.5 flex items-center gap-1 text-sm font-semibold text-foreground">
            New vs Returning Buyers · {CHANNEL_LABEL[ch]}
            <InfoTip text="Distinct buyers each month, split into New (first-ever purchase that month) and Returning (also bought in an earlier month). The full bar is the unique buyers active that month — not order count." />
          </div>
          <p className="mb-3 text-xs text-muted-foreground">Unique buyers per month (not orders) — new vs returning.</p>
          <BuyerMixChart data={mixData} rgb={rgb} accent={CHANNEL_ACCENT[ch]} />
        </div>
      )}
      </div>
    </div>
  );
}

export function HealthView({snapshot}: {snapshot: BusinessHealthSnapshot}) {
  // Normalise so a snapshot saved before a knob existed (e.g. acqCost) never
  // yields undefined in an input.
  const defaults = () =>
    Object.fromEntries(
      snapshot.perChannel.map((c) => [
        c.channel,
        {
          cogsPct: c.defaults.cogsPct ?? 0.35,
          platformFeePct: c.defaults.platformFeePct ?? (c.platformFeeApplies ? 0.25 : 0),
          promos: c.defaults.promos ?? 0,
          // Ad-less channels open with the placeholder spend so they show a QRR
          // rather than N/A. `||` (not `??`) on purpose: snapshots saved before
          // the batch seeded this carry a literal 0, which needs the same
          // treatment as a missing value. Still fully editable on the card.
          // Offline is the exception: its event cost starts at ₱0 so it stays
          // OUT of the pooled Overall QRR until a real event cost is entered
          // (no fabricated bazaar cost).
          acqCost:
            c.channel === 'offline'
              ? c.defaults.acqCost ?? 0
              : c.defaults.acqCost || (c.platformFeeApplies ? 0 : DEFAULT_WEBSITE_ACQ_COST),
        } as Knobs,
      ]),
    );
  const actualDefaults = () => Object.fromEntries(snapshot.perChannel.map((c) => [c.channel, factsToActuals(c)]));
  const [knobs, setKnobs] = useState<Record<string, Knobs>>(defaults);
  const [actuals, setActuals] = useState<Record<string, ChannelActuals>>(actualDefaults);
  const [nonces, setNonces] = useState<Record<string, number>>({});
  const [view, setView] = useState<'cards' | 'trend' | 'heatmap'>('cards');
  const hasMonthly = (snapshot.monthly?.length ?? 0) > 0;
  const hasCohorts = Boolean(snapshot.cohorts);

  // Back button: return to wherever the user came from, not a hardcoded route.
  // Falls back to the Overview home when there's no in-app history to pop.
  const router = useRouter();
  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back();
    else router.push('/');
  };

  const baseKnobs = defaults();
  const baseActuals = actualDefaults();
  const isDirty = (ch: string) =>
    JSON.stringify(actuals[ch]) !== JSON.stringify(baseActuals[ch]) || JSON.stringify(knobs[ch]) !== JSON.stringify(baseKnobs[ch]);
  const resetChannel = (ch: string) => {
    setActuals((prev) => ({...prev, [ch]: baseActuals[ch]}));
    setKnobs((prev) => ({...prev, [ch]: baseKnobs[ch]}));
    setNonces((prev) => ({...prev, [ch]: (prev[ch] ?? 0) + 1})); // remount that card's inputs
  };
  // Condense the header once the cards start scrolling under it. The window is the
  // scroll container (the shell's <main> only clips horizontally).
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    const onScroll = () => setCondensed(window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const views: {key: 'cards' | 'trend' | 'heatmap'; label: string}[] = [
    {key: 'cards', label: 'Cards'},
    ...(hasMonthly ? ([{key: 'trend', label: 'Trend'}] as const) : []),
    ...(hasCohorts ? ([{key: 'heatmap', label: 'Heatmap'}] as const) : []),
  ];

  return (
    <div className="mx-auto max-w-[1560px] space-y-6 px-6 pb-6 max-md:px-4">
      <style>{`@keyframes healthPop{0%{transform:scale(1)}35%{transform:scale(1.22)}100%{transform:scale(1)}}.health-pop{animation:healthPop .4s ease-out}@media (prefers-reduced-motion: reduce){.health-pop{animation:none}}`}</style>
      <header
        className={`sticky top-14 z-20 -mx-6 flex flex-wrap items-end justify-between gap-3 border-b px-6 pb-4 transition-[padding,background-color,border-color] duration-300 max-md:-mx-4 max-md:px-4 ${
          condensed ? 'border-border bg-background/85 pt-3 backdrop-blur-md' : 'border-border bg-background pt-6'
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={goBack}
              aria-label="Go back"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
            </button>
          <div>
            <h1 className={`font-bold tracking-tight text-foreground transition-[font-size] duration-300 ${condensed ? 'text-[21px]' : 'text-[28px]'}`}>
              Business Health
            </h1>
            {/* Subtitle + period collapse away on scroll so the pill and tabs stay put. */}
            <div className={`grid transition-all duration-300 ${condensed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
              <div className="overflow-hidden">
                <p className="mt-1 text-sm text-foreground/65">Per-channel Quality Revenue Ratio</p>
                <p className="mt-1.5 flex items-center gap-1.5 text-sm">
                  <span className="text-foreground/60">Reporting period</span>
                  <span className="rounded-md bg-foreground/[0.06] px-2 py-0.5 font-bold text-foreground">{fmtRange(snapshot.window.from, snapshot.window.to)}</span>
                  <InfoTip text={HEALTH_HINTS.window} />
                </p>
              </div>
            </div>
          </div>
          </div>
          {view === 'cards' && (
            <OverallQrrPill
              channels={snapshot.perChannel.map((c) => ({channel: c.channel, actuals: actuals[c.channel], knobs: knobs[c.channel]}))}
              target={snapshot.target}
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          {views.length > 1 && (
            <SegmentedControl ariaLabel="Health view" options={views} value={view} onChange={setView} />
          )}
        </div>
      </header>

      {view === 'cards' && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-foreground/70">
          <span className="font-semibold uppercase tracking-wide text-foreground/50">Every field is editable — model a target:</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-3.5 rounded border-2" style={{borderColor: '#2F6BD4'}} />
            Cost assumptions (COGS, Platform Fee, Promos, Acq. cost)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-3.5 rounded border border-dashed border-foreground/45" />
            Actuals — AOV, orders, buyers, ROAS (amber when overridden)
          </span>
        </div>
      )}

      <div role="tabpanel" aria-label={views.find((v) => v.key === view)?.label ?? 'Cards'}>
      {view === 'trend' && hasMonthly ? (
        <TrendView snapshot={snapshot} knobs={knobs} />
      ) : view === 'heatmap' && hasCohorts ? (
        <HeatmapView snapshot={snapshot} />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {snapshot.perChannel.map((c) => (
            <ChannelCard
              key={`${c.channel}-${nonces[c.channel] ?? 0}`}
              facts={c}
              actuals={actuals[c.channel]}
              knobs={knobs[c.channel]}
              target={snapshot.target}
              nonce={nonces[c.channel] ?? 0}
              dirty={isDirty(c.channel)}
              onReset={() => resetChannel(c.channel)}
              onActual={(a) => setActuals((prev) => ({...prev, [c.channel]: a}))}
              onKnob={(k) => setKnobs((prev) => ({...prev, [c.channel]: k}))}
            />
          ))}
        </div>
      )}
      </div>

      <details className="group rounded-xl border border-dashed border-border bg-muted/30 text-[13px] leading-relaxed text-foreground/65">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 p-4 font-medium text-foreground/80 [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
          How this is calculated
        </summary>
        <div className="px-4 pb-4">
        {view === 'trend' ? (
          <p>
            <strong className="text-foreground">Trend</strong> plots each channel’s QRR month by month, so you can see whether unit economics are improving. Each bar uses your <strong className="text-foreground">current assumptions from the Cards tab</strong> (Promos &amp; Acq. cost are spread across months by order volume); the <strong className="text-foreground">horizontal dashed line</strong> is the target of {snapshot.target}, and bars below it are under target. The <strong className="text-foreground">dark dotted line with markers</strong> is the <strong className="text-foreground">Overall QRR</strong> for each month — the same blend as the header pill (total gross margin ÷ total spend for that month), so a month where a channel had no acquisition cost leaves that channel out of the blend. Shopee starts in March (ads began then, so earlier months have no acquisition cost to divide by); Website is seeded with a placeholder Acq. cost of ₱5,000, so it appears from its first month of orders — edit that on the Cards tab to reflect real spend. Hover a bar for the exact value. Trailing window {snapshot.window.label}.
          </p>
        ) : view === 'heatmap' ? (
          <p>
            <strong className="text-foreground">Cohort Retention</strong> groups buyers by the month of their <strong className="text-foreground">first purchase</strong> (each row). Reading left→right, a cell is the <strong className="text-foreground">% of that cohort who ordered again</strong> in that later month — a cohort’s own month is always 100%, and <strong className="text-foreground">darker cells mean more customers came back</strong>. Use the selector to switch channels (buyers aren’t deduped across channels). This is the repeat-purchase behaviour behind each channel’s <strong className="text-foreground">Repeat rate</strong> KPI — a real signal for revenue, though deliberately kept out of QRR, which measures per-order efficiency. Website cohorts start in April (CRM history). Trailing window {snapshot.window.label}.
          </p>
        ) : (
          <p>
            Each channel stands alone (no blending); the <strong className="text-foreground">Overall QRR</strong> beside the title is the one exception — the whole business pooled by volume, over only the channels that have a CAC: total gross margin ÷ total marketing + promo spend, so every order counts once and the figure sits near the highest-volume channel. A channel with no acquisition cost is excluded from both sides (its profit against ₱0 would inflate the ratio); give it an Acq. cost and it joins in. <strong className="text-foreground">Every field is editable</strong>: <strong className="text-foreground">solid-outlined</strong> chips are cost assumptions (COGS%, Platform Fee%, Promos, Acq. cost); <strong className="text-foreground">dashed</strong> fields are your measured actuals (AOV, orders, buyers, ROAS) — override them to model a target, and they turn amber to flag the hypothetical. Margin = 1 − COGS% − Platform Fee%. Both sides of the ratio are <strong className="text-foreground">per order</strong>: LTV here is the gross margin on one order = AOV × Margin, and CAC = (marketing or acquisition) + (Promos ÷ orders). QRR = LTV ÷ CAC, target {snapshot.target} — with promos at ₱0 this is simply Margin × ROAS. <strong className="text-foreground">Repeat rate</strong> (orders ÷ buyers) is shown per channel as its own KPI and is deliberately not folded into QRR. Website has no ads, so its CAC comes from Acq. cost — seeded with a ₱5,000 placeholder for the window, which you should replace with real organic/ops spend. “Measured” under each card is the source data; a channel’s <span className="font-semibold text-amber-700 dark:text-amber-300">↺ Reset</span> pill appears by its name once you change something, restoring just that channel. Edits reset on reload. Trailing window {snapshot.window.label}.
          </p>
        )}
        </div>
      </details>
    </div>
  );
}
