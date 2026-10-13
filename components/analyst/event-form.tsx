'use client';

import {useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {useRouter} from 'next/navigation';
import {Popover} from '@base-ui/react/popover';
import {CalendarDays, ChevronDown, Info, Loader2, X} from 'lucide-react';
import type {PosEvent} from '@/src/pos-sales-types';
import {datesInRange, overlappingEvent} from '@/src/pos-sales-compute';
import {upsertEventAction, type EventInput} from '@/src/pos-events-actions';
import {formatPeso} from '@/src/pos-format';
import {Calendar, type DateRange} from '@/components/ui/calendar';
import {cn} from '@/lib/utils';

/** "Sep 17" or "Sep 17 to Sep 18" for a clash message; blank bounds coalesce. */
function formatEventDates(startsOn: string | null, endsOn: string | null): string {
  const fmt = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
  const from = startsOn ?? endsOn;
  const to = endsOn ?? startsOn;
  if (!from) return '';
  return from === to ? fmt(from) : `${fmt(from)} to ${fmt(to as string)}`;
}

/** Date-range trigger label: "Sat, Oct 18, 2026", or "Sat, Oct 18 to Mon, Oct 20, 2026"
 *  (year once when both days share it). */
function rangeLabel(start: string, end: string): string {
  const fmt = (d: string, year: boolean) =>
    new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric', ...(year ? {year: 'numeric'} : {}), timeZone: 'UTC'});
  if (start === end) return fmt(start, true);
  return `${fmt(start, start.slice(0, 4) !== end.slice(0, 4))} to ${fmt(end, true)}`;
}

/** Parse an optional peso field: blank -> null, invalid/negative -> error. */
function parseOptionalAmount(v: string): {value: number | null} | {error: string} {
  const t = v.trim();
  if (t === '') return {value: null};
  const n = Number(t.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n < 0) return {error: 'Enter a valid amount.'};
  return {value: n};
}

// Common opening floats, one tap instead of typing.
const FLOAT_PRESETS = [1000, 2000, 3000, 5000];

const inputCls =
  'h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground/60 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/40 aria-[invalid=true]:border-destructive/60';

type Errors = Partial<Record<'name' | 'dates' | 'opening' | 'closing' | 'form', string>>;

/**
 * Coop event scheduler, as a right-side slide-over so the list (or the event
 * page) stays in view behind it. Create a new bazaar or edit an existing one,
 * writing through upsertEventAction. Fields are grouped (Event, Where, When,
 * Cash, and Close-out when editing). Dates use the shared range Calendar with
 * future days enabled. Overlapping / same-day events are allowed, so a date clash
 * is a neutral "runs alongside" note, not a blocker (the POS cashier picks which
 * event each sale belongs to). `initial` present = edit mode.
 * Esc or the backdrop closes it; Cmd/Ctrl+Enter saves.
 */
export function EventForm({initial, events = [], onDone}: {initial?: PosEvent; events?: PosEvent[]; onDone: () => void}) {
  const editing = Boolean(initial);
  const router = useRouter();
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Errors>({});

  const [name, setName] = useState(initial?.name ?? '');
  const [venue, setVenue] = useState(initial?.venue ?? '');
  const [city, setCity] = useState(initial?.city ?? '');
  const [organizer, setOrganizer] = useState(initial?.organizer ?? '');
  const [range, setRange] = useState<DateRange>({start: initial?.starts_on ?? null, end: initial?.ends_on ?? null});
  const [datesOpen, setDatesOpen] = useState(false);
  const [openingCash, setOpeningCash] = useState(initial?.opening_cash != null ? String(initial.opening_cash) : '');
  const [cashNote, setCashNote] = useState(initial?.cash_note ?? '');
  const [closed, setClosed] = useState(initial?.status === 'closed');
  const [closingCash, setClosingCash] = useState(initial?.closing_cash != null ? String(initial.closing_cash) : '');

  // A single pick is a one-day event: end defaults to start.
  const startsOn = range.start;
  const endsOn = range.end ?? range.start;
  const dayCount = useMemo(() => (startsOn ? datesInRange(startsOn, endsOn).length : 0), [startsOn, endsOn]);

  // Informational: another event already covers these dates. Overlap is allowed,
  // so this is just a heads-up, never a blocker.
  const alongside = useMemo(
    () => overlappingEvent(events, startsOn, endsOn, initial?.event_id),
    [events, startsOn, endsOn, initial?.event_id],
  );

  // Lock page scroll and focus the first field while open; Esc closes (unless a
  // nested popover is open, which handles its own Esc).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    nameRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !datesOpen && !pending) onDone();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [datesOpen, pending, onDone]);

  function submit() {
    const next: Errors = {};
    if (name.trim() === '') next.name = 'Give the event a name.';
    const opening = parseOptionalAmount(openingCash);
    if ('error' in opening) next.opening = opening.error;
    const closing = parseOptionalAmount(closingCash);
    if ('error' in closing) next.closing = closing.error;
    setErrors(next);
    if (Object.keys(next).length > 0 || 'error' in opening || 'error' in closing) {
      if (next.name) nameRef.current?.focus();
      return;
    }

    const input: EventInput = {
      event_id: initial?.event_id,
      name: name.trim(),
      venue,
      city,
      organizer,
      starts_on: startsOn,
      ends_on: endsOn,
      opening_cash: opening.value,
      cash_note: cashNote,
    };
    if (editing) {
      input.status = closed ? 'closed' : 'active';
      input.closing_cash = closing.value;
    }

    startTransition(async () => {
      const res = await upsertEventAction(input);
      if (!res.ok) {
        setErrors({form: res.error});
        return;
      }
      router.refresh();
      onDone();
    });
  }

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={() => !pending && onDone()}
        className="absolute inset-0 cursor-default bg-foreground/25 backdrop-blur-[1px] transition-opacity duration-200 ease-out starting:opacity-0"
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        className="absolute inset-y-0 right-0 flex w-full max-w-[520px] flex-col border-l bg-popover text-popover-foreground shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] starting:translate-x-full motion-reduce:transition-none"
      >
        <header className="flex items-start justify-between gap-4 border-b px-6 py-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {editing ? 'Edit event' : 'New event'}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {editing
                ? 'Changes apply to the POS on its next sync.'
                : 'The POS tags sales on these dates to this event, and the till reconciles against the opening float.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onDone}
            disabled={pending}
            aria-label="Close"
            className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="flex flex-col gap-8">
            <Section title="Event">
              <Field label="Name" htmlFor="ev-name" error={errors.name}>
                <input
                  ref={nameRef}
                  id="ev-name"
                  className={cn(inputCls, 'h-11 text-base font-medium')}
                  value={name}
                  aria-invalid={Boolean(errors.name)}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (errors.name) setErrors((p) => ({...p, name: undefined}));
                  }}
                  placeholder="Pet Bazaar · Weekend 3"
                />
              </Field>
              <Field label="Organizer" optional htmlFor="ev-org">
                <input id="ev-org" className={inputCls} value={organizer} onChange={(e) => setOrganizer(e.target.value)} placeholder="Pet Express" />
              </Field>
            </Section>

            <Section title="Where">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Venue or mall" htmlFor="ev-venue">
                  <input id="ev-venue" className={inputCls} value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="SM Megamall" />
                </Field>
                <Field label="City" htmlFor="ev-city">
                  <input id="ev-city" className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="Mandaluyong" />
                </Field>
              </div>
            </Section>

            <Section title="When">
              <Field label="Dates" htmlFor="ev-dates" hint="Pick the first day, then the last. One pick makes it a single-day event.">
                <Popover.Root open={datesOpen} onOpenChange={setDatesOpen}>
                  <Popover.Trigger
                    id="ev-dates"
                    className={cn(
                      inputCls,
                      'flex items-center gap-2.5 text-left',
                      datesOpen && 'border-primary/50 ring-2 ring-ring/40',
                    )}
                  >
                    <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
                    {startsOn ? (
                      <span className="min-w-0 flex-1 truncate tabular-nums">
                        {rangeLabel(startsOn, endsOn as string)}
                      </span>
                    ) : (
                      <span className="flex-1 text-muted-foreground/60">Pick dates</span>
                    )}
                    {dayCount > 0 && (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                        {dayCount} {dayCount === 1 ? 'day' : 'days'}
                      </span>
                    )}
                    <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out', datesOpen && 'rotate-180')} />
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
                      <Popover.Popup className="w-72 origin-[var(--transform-origin)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0">
                        <div className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {!range.start ? 'Pick the first day' : !range.end ? 'Now the last day, or Done for one day' : 'Tap any day to start over'}
                        </div>
                        <Calendar value={range} onChange={setRange} allowFuture />
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => setRange({start: null, end: null})}
                            className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                          >
                            Clear
                          </button>
                          <button
                            type="button"
                            onClick={() => setDatesOpen(false)}
                            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-150 ease-out active:scale-[0.97]"
                          >
                            Done
                          </button>
                        </div>
                      </Popover.Popup>
                    </Popover.Positioner>
                  </Popover.Portal>
                </Popover.Root>
              </Field>
              {alongside && (
                <p className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                  <Info className="mt-px size-3.5 shrink-0" />
                  <span>
                    Runs alongside &ldquo;{alongside.name}&rdquo;
                    {formatEventDates(alongside.starts_on, alongside.ends_on) ? ` (${formatEventDates(alongside.starts_on, alongside.ends_on)})` : ''}.
                    That&rsquo;s fine. The POS cashier picks which event each sale belongs to.
                  </span>
                </p>
              )}
            </Section>

            <Section title="Cash">
              <Field label="Opening float" htmlFor="ev-open" error={errors.opening} hint="Cash in the till before the first sale.">
                <PesoInput
                  id="ev-open"
                  value={openingCash}
                  invalid={Boolean(errors.opening)}
                  onChange={(v) => {
                    setOpeningCash(v);
                    if (errors.opening) setErrors((p) => ({...p, opening: undefined}));
                  }}
                  placeholder="2000"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {FLOAT_PRESETS.map((amt) => {
                    const parsed = parseOptionalAmount(openingCash);
                    const on = 'value' in parsed && parsed.value === amt;
                    return (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setOpeningCash(String(amt))}
                        aria-pressed={on}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums transition-[color,background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]',
                          on ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:border-foreground/25 hover:text-foreground',
                        )}
                      >
                        {formatPeso(amt)}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Field label="Cash note" optional htmlFor="ev-note">
                <input id="ev-note" className={inputCls} value={cashNote} onChange={(e) => setCashNote(e.target.value)} placeholder="Mostly 20s and 50s" />
              </Field>
            </Section>

            {editing && (
              <Section title="Close out">
                <Field label="Status" htmlFor="ev-status">
                  <div id="ev-status" role="group" aria-label="Status" className="inline-flex rounded-lg border bg-muted/40 p-1">
                    {([false, true] as const).map((isClosed) => (
                      <button
                        key={String(isClosed)}
                        type="button"
                        onClick={() => setClosed(isClosed)}
                        aria-pressed={closed === isClosed}
                        className={cn(
                          'rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors duration-150',
                          closed === isClosed ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {isClosed ? 'Closed' : 'Active'}
                      </button>
                    ))}
                  </div>
                </Field>
                {closed && (
                  <Field label="Counted at close" optional htmlFor="ev-close" error={errors.closing} hint="The cash you counted in the till. The event page shows over or short.">
                    <PesoInput
                      id="ev-close"
                      value={closingCash}
                      invalid={Boolean(errors.closing)}
                      onChange={(v) => {
                        setClosingCash(v);
                        if (errors.closing) setErrors((p) => ({...p, closing: undefined}));
                      }}
                      placeholder="20300"
                    />
                  </Field>
                )}
              </Section>
            )}
          </div>
        </div>

        <footer className="border-t bg-popover px-6 py-4">
          {errors.form && (
            <p role="alert" className="mb-3 text-xs text-destructive">
              {errors.form}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground max-sm:hidden">
              <kbd className="rounded border bg-muted px-1 font-sans">⌘</kbd> <kbd className="rounded border bg-muted px-1 font-sans">Enter</kbd> to save
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={onDone}
                disabled={pending}
                className="h-9 rounded-lg border px-4 text-sm text-muted-foreground transition-[color,transform] duration-150 ease-out hover:text-foreground active:scale-[0.97]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-[opacity,transform] duration-150 ease-out active:scale-[0.97] disabled:opacity-60"
              >
                {pending && <Loader2 className="size-3.5 animate-spin" />}
                {editing ? 'Save changes' : 'Create event'}
              </button>
            </div>
          </div>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function Section({title, children}: {title: string; children: ReactNode}) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  optional,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline gap-1.5 text-sm font-medium">
        {label}
        {optional && <span className="text-xs font-normal text-muted-foreground">Optional</span>}
      </label>
      {children}
      {error ? (
        <p className="mt-1.5 text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Amount input with a fixed ₱ prefix. */
function PesoInput({id, value, onChange, placeholder, invalid}: {id: string; value: string; onChange: (v: string) => void; placeholder?: string; invalid?: boolean}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₱</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className={cn(inputCls, 'pl-7 tabular-nums')}
        value={value}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, ''))}
        placeholder={placeholder}
      />
    </div>
  );
}
