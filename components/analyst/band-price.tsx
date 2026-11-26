'use client';

import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {toneText} from '@/src/review-confidence';
import {bandNote, peso, type PaperBand} from '@/src/band-prices';

/**
 * A flagged band's price pick (QA San Pablo, Nov 25), shown on the band's first row: what the
 * paper says, the paper total against Coop's at the printed price, and the two choices. Picking
 * values THIS form at that price; the catalog never changes. Once picked, a quiet line says which
 * price the form uses, with Change to take it back.
 */
export function BandPrice({band, pieces, editable, onPick}: {
  band: PaperBand;
  /** Pieces on hand across the band now (edits included). */
  pieces: number;
  editable: boolean;
  onPick?: (price: number | null) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState<number | 'undo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (band.kind == null || band.offer_price == null || band.printed_price == null) return null;
  const offer = band.offer_price;
  const printed = band.printed_price;
  const pick = async (price: number | null) => {
    if (!onPick) return;
    setBusy(price ?? 'undo');
    setError(null);
    const err = await onPick(price);
    setBusy(null);
    if (err) setError(err);
  };

  if (band.use_price != null) {
    return (
      <span className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
        <span>
          {band.use_price === printed
            ? `This band stays at the printed ${peso(printed)}.`
            : `This band is valued at ${peso(band.use_price)} on this form (printed ${peso(printed)}).`}
        </span>
        {editable && onPick && (
          <button
            type="button"
            disabled={busy != null}
            onClick={() => pick(null)}
            className="rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 outline-none transition-colors duration-150 ease-out focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50 [@media(hover:hover)]:hover:decoration-foreground"
          >
            Change
          </button>
        )}
        {error && <span role="alert" style={{color: toneText('var(--status-crit)')}}>{error}</span>}
      </span>
    );
  }

  return (
    <span className="mt-1.5 flex flex-col gap-1.5">
      <span className="text-[11px] leading-snug" style={{color: toneText('var(--status-warn)')}}>
        {bandNote(band)}. Coop has {peso(pieces * printed)} at {peso(printed)}.
      </span>
      {editable && onPick ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="xs" disabled={busy != null} onClick={() => pick(offer)} className="active:scale-[0.97]">
            {busy === offer ? 'Saving…' : `Use ${peso(offer)}`}
          </Button>
          <Button variant="ghost" size="xs" disabled={busy != null} onClick={() => pick(printed)} className="active:scale-[0.97]">
            {busy === printed ? 'Saving…' : `Keep ${peso(printed)}`}
          </Button>
          <span className="text-[11px] text-muted-foreground">For this form only.</span>
        </span>
      ) : null}
      {error && (
        <span role="alert" className="text-[11px]" style={{color: toneText('var(--status-crit)')}}>
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * "Use the paper's price on every band" (audit Nov 25): stores 473 and 5300 write their own
 * (about 20% off) price on most bands, and each band would otherwise take its own click. Shown
 * above the rows when two or more bands on the page are still open; one click picks the paper's
 * price for all of them, for this form only. Each band can still be changed on its own after.
 */
export function BandPricesBar({bands, editable, onPickAll}: {
  bands: PaperBand[];
  editable: boolean;
  onPickAll?: (picks: Array<{group: string; price: number}>) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = bands.filter((b) => b.kind != null && b.offer_price != null && b.use_price == null);
  if (open.length < 2 || !editable || !onPickAll) return null;
  const go = async () => {
    setBusy(true);
    setError(null);
    const err = await onPickAll(open.map((b) => ({group: b.group, price: b.offer_price as number})));
    setBusy(false);
    if (err) setError(err);
  };
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-xs"
      style={{borderColor: 'color-mix(in oklab, var(--status-warn) 35%, transparent)', background: 'color-mix(in oklab, var(--status-warn) 7%, transparent)'}}
    >
      <span className="min-w-0 flex-1" style={{color: toneText('var(--status-warn)')}}>
        {open.length} bands on this page are priced differently on the paper ({open.map((b) => `${peso(b.offer_price as number)} for ${peso(b.printed_price as number)}`).slice(0, 3).join(', ')}
        {open.length > 3 ? ', …' : ''}).
      </span>
      <Button variant="outline" size="xs" disabled={busy} onClick={go} className="active:scale-[0.97]">
        {busy ? 'Saving…' : `Use the paper prices on all ${open.length}`}
      </Button>
      {error && (
        <span role="alert" className="w-full" style={{color: toneText('var(--status-crit)')}}>
          {error}
        </span>
      )}
    </div>
  );
}
