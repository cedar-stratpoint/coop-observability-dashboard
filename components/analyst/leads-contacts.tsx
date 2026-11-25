'use client';

// RET-17 Task 4: the Event leads list, status first. Every lead with an email, Instagram or mobile has a Log button; the
// status chip (= last contacted) opens the same dialog. Nothing is sent from Coop: Instagram opens instagram.com, email is a
// mailto link, mobile is copied. A lead with none of the three has no Log button and reads "Unknown", never "Not contacted".
import {useMemo, useState} from 'react';
import {AtSign, CircleDashed, CircleHelp, Check, Download, Mail, MessageSquarePlus, Reply} from 'lucide-react';
import {cn} from '@/lib/utils';
import type {ContactState, ContactStatus} from '@/src/person-identity';
import {
  contactStatusLabel,
  countStates,
  inDayRange,
  leadsCsv,
  matchesLeadSearch,
  prizeTally,
  withState,
  type SpinLead,
  type StatusFilter,
} from '@/src/spin-leads-types';
import {leadKey, type LeadMatch} from '@/src/lead-order-match';
import {fmtPhDate} from '@/src/crm-compute';
import {downloadCsv} from '@/src/csv';
import {instagramUrl} from '@/src/instagram';
import {isVoucherPrize} from '@/src/spin-leads-sync';
import {spinVoucherCsv, type SpinVoucherInfo} from '@/src/spin-voucher';
import {manilaDayKey} from '@/src/pos-sales-compute';
import {CopyButton} from './customer-profile';
import {FilterSelect} from './filter-select';
import {Pagination} from './pagination';
import {BoughtCell, BoughtHelp} from './lead-capture';

const PAGE_SIZE = 20;

/** What the leads page computes on the server per lead (leadKey): the website order since the spin and the contact status. */
export type LeadsContactsData = {
  vouchers: Record<string, SpinVoucherInfo>;
  statuses: Record<string, ContactStatus>;
};

const UNKNOWN: ContactStatus = {state: 'unknown', lastAt: null, lastChannel: null};
export const hasContactKey = (l: SpinLead): boolean => Boolean(l.email || l.instagram || l.mobile);

const STATE_TONE: Record<ContactState, string> = {
  not_contacted: 'border-[var(--amber-fg)]/30 bg-[var(--amber-bg)] text-[var(--bhr-warn)] dark:text-[var(--amber-fg)]',
  contacted: 'border-primary/25 bg-accent text-accent-foreground',
  replied: 'border-[var(--status-good)]/30 bg-[var(--status-good)]/10 text-[var(--status-good)]',
  unknown: 'border-dashed border-border bg-transparent text-muted-foreground',
};
const STATE_ICON: Record<ContactState, typeof Check> = {not_contacted: CircleDashed, contacted: Check, replied: Reply, unknown: CircleHelp};

/**
 * The status chip: "Not contacted", "Contacted · Nov 20", "Replied · Nov 21" or "Unknown". With `onLog` it is the Last
 * contacted control: a click opens the Log dialog for this person (a chosen day sets the last contacted date).
 */
export function StatusChip({status, onLog, name}: {status: ContactStatus; onLog?: () => void; name?: string}) {
  const Icon = STATE_ICON[status.state];
  const text = contactStatusLabel(status);
  const cls = cn(
    'inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium tabular-nums',
    STATE_TONE[status.state],
  );
  if (!onLog) {
    return (
      <span className={cls} title={status.state === 'unknown' ? 'Unknown: no email, Instagram or mobile, or the contact log could not be read' : undefined}>
        <Icon className="size-3" aria-hidden />
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onLog}
      title="Log a contact, on the day it happened"
      aria-label={`${text}. Log a contact${name ? ` with ${name}` : ''}`}
      className={cn(cls, 'transition-[transform,box-shadow] duration-150 hover:ring-2 hover:ring-ring/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:transition-none')}
    >
      <Icon className="size-3" aria-hidden />
      {text}
    </button>
  );
}

/** The Website CRM's Log contact button, so both pages read the same. */
export function LogButton({onClick, name, compact = false}: {onClick: () => void; name: string; compact?: boolean}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Log a contact with ${name}`}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-primary/40 bg-primary/5 font-semibold text-primary transition-[background-color,transform] duration-150 hover:bg-primary/10 active:scale-[0.97] motion-reduce:transition-none',
        compact ? 'h-7 px-2 text-[11px]' : 'h-8 px-2.5 text-xs',
      )}
    >
      <MessageSquarePlus className="size-3.5" aria-hidden />
      Log
    </button>
  );
}

const iconLink =
  'inline-flex size-7 items-center justify-center rounded-md border text-muted-foreground transition-[color,border-color,transform] duration-150 hover:border-primary hover:text-foreground active:scale-[0.97]';

/** Log · IG ↗ · Email · Copy mobile. Opening and copying only: nothing is sent from Coop. */
function Actions({lead, onLog}: {lead: SpinLead; onLog: () => void}) {
  const ig = instagramUrl(lead.instagram);
  const who = leadName(lead);
  return (
    <span className="inline-flex items-center gap-1">
      {/* Log first, so it lines up row to row whatever else the lead gave. */}
      {hasContactKey(lead) && <LogButton onClick={onLog} name={who} compact />}
      {ig && (
        <a href={ig} target="_blank" rel="noopener noreferrer" className={iconLink} aria-label={`Open @${lead.instagram} on Instagram`} title="Open on Instagram">
          <AtSign className="size-3.5" aria-hidden />
        </a>
      )}
      {lead.email && (
        <a href={`mailto:${lead.email}`} className={iconLink} aria-label={`Email ${lead.email}`} title="Write an email (opens your mail app)">
          <Mail className="size-3.5" aria-hidden />
        </a>
      )}
      {lead.mobile && <CopyButton text={lead.mobile} className="h-7 px-2 text-[11px]">Mobile</CopyButton>}
    </span>
  );
}

const leadName = (l: SpinLead): string => l.name ?? (l.instagram ? `@${l.instagram}` : (l.email ?? l.mobile ?? 'this lead'));

/** "2026-09-18" → "Sep 18" for the date filter. */
const dayShort = (key: string): string => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric'});

/** "Sep 20, 9:32 PM" (Manila). */
const stamp = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila'});

function websiteText(v: SpinVoucherInfo | undefined): {text: string; tone: 'good' | 'muted'} {
  if (v?.state === 'ordered') return {text: `Ordered ${fmtPhDate(v.orderAt)}`, tone: 'good'};
  if (v?.state === 'not_used') return {text: 'No order', tone: 'muted'};
  if (v?.state === 'no_email') return {text: 'No email to check', tone: 'muted'};
  return {text: 'Unknown', tone: 'muted'};
}

const STATUS_LABEL: Record<StatusFilter, string> = {all: 'All', not_contacted: 'Not contacted', contacted: 'Contacted', replied: 'Replied', unknown: 'Unknown'};

export function LeadsContacts({
  leads,
  matches,
  data,
  logRead,
  onLog,
}: {
  leads: SpinLead[];
  matches?: Record<string, LeadMatch>;
  data: LeadsContactsData;
  /** False = the contact log could not be read: every status is Unknown. */
  logRead: boolean;
  onLog: (l: SpinLead) => void;
}) {
  const {vouchers, statuses} = data;
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [event, setEvent] = useState('all');
  const [prize, setPrize] = useState('all');
  const [collectedFrom, setCollectedFrom] = useState('all');
  const [collectedTo, setCollectedTo] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [unused, setUnused] = useState(false);
  const statusOf = (l: SpinLead): ContactStatus => statuses[leadKey(l)] ?? UNKNOWN;
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const prizes = useMemo(() => prizeTally(leads), [leads]);
  const events = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of leads) if (l.campaign) m.set(l.campaign, (m.get(l.campaign) ?? 0) + 1);
    return [...m];
  }, [leads]);
  const days = useMemo(() => [...new Set(leads.map((l) => manilaDayKey(l.collectedAt)))].sort().reverse(), [leads]);
  const voucherStats = useMemo(() => {
    const s = {winners: 0, ordered: 0, noEmail: 0, notUsed: 0, unknown: 0};
    for (const l of leads) {
      if (!isVoucherPrize(l.prize)) continue;
      const st = vouchers[leadKey(l)]?.state;
      s.winners++;
      if (st === 'ordered') s.ordered++;
      else if (st === 'no_email') s.noEmail++;
      else if (st === 'not_used') s.notUsed++;
      else s.unknown++;
    }
    return s;
  }, [leads, vouchers]);

  // Every filter but Status, so the Status counts say what each choice would show ("Not contacted 512").
  const scoped = useMemo(
    () =>
      leads
        .filter(
          (l) =>
            (!unused || vouchers[leadKey(l)]?.state === 'not_used') &&
            (event === 'all' || l.campaign === event) &&
            (prize === 'all' || l.prize === prize) &&
            inDayRange(manilaDayKey(l.collectedAt), collectedFrom, collectedTo) &&
            matchesLeadSearch(l, q),
        )
        // Newest first, so "Not contacted yet" starts with the freshest leads.
        .sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt)),
    [leads, unused, vouchers, event, prize, collectedFrom, collectedTo, q],
  );
  const counts = useMemo(() => countStates(scoped, statuses), [scoped, statuses]);
  const filtered = useMemo(() => withState(scoped, status, statuses), [scoped, status, statuses]);
  const filtering = filtered.length !== leads.length;

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const start = (current - 1) * PAGE_SIZE;
  const rows = filtered.slice(start, start + PAGE_SIZE);

  const handles = filtered.flatMap((l) => (l.instagram ? [`@${l.instagram}`] : []));
  const emails = filtered.flatMap((l) => (l.email ? [l.email] : []));
  const mobiles = filtered.flatMap((l) => (l.mobile ? [l.mobile] : []));
  const exportCsv = () => {
    const asOf = new Date().toISOString();
    if (unused) {
      // RET-13B's export, unchanged: the voucher winners with no website order since.
      const lastOf = (l: SpinLead) => (statusOf(l).state === 'unknown' ? null : statusOf(l).lastAt);
      downloadCsv(`spin-voucher-winners (${filtered.length}).csv`, spinVoucherCsv(filtered.map((l) => ({lead: l, state: vouchers[leadKey(l)]?.state ?? null, orderAt: vouchers[leadKey(l)]?.orderAt ?? null, lastContactAt: lastOf(l)})), asOf));
    } else downloadCsv(`event-leads (${filtered.length}).csv`, leadsCsv(filtered, statuses, vouchers, asOf));
  };
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const notYetOn = status === 'not_contacted';

  return (
    <section aria-labelledby="leads-contacts-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="leads-contacts-title" className="text-sm font-semibold">
            Contacts
            <span className="ml-2 font-normal tabular-nums text-muted-foreground">
              {filtering ? `${filtered.length.toLocaleString()} of ${leads.length.toLocaleString()}` : leads.length.toLocaleString()}
            </span>
          </h2>
          {!logRead && <p className="mt-0.5 text-xs text-muted-foreground">The contact log could not be read, so every status shows as Unknown.</p>}
        </div>
        <button
          type="button"
          aria-pressed={notYetOn}
          onClick={() => reset(setStatus)(notYetOn ? 'all' : 'not_contacted')}
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] motion-reduce:transition-none',
            notYetOn ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90' : 'border-primary/40 bg-primary/5 text-primary hover:bg-primary/10',
          )}
        >
          <CircleDashed className="size-3.5" aria-hidden />
          Not contacted yet <span className="tabular-nums opacity-80">({counts.not_contacted.toLocaleString()})</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-3 py-2.5">
        <input
          type="search"
          value={q}
          onChange={(e) => reset(setQ)(e.target.value)}
          placeholder="Search name, @handle, email, mobile"
          aria-label="Search contacts"
          className="h-8 w-64 rounded-lg border border-border bg-background px-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-primary max-sm:w-full"
        />
        {events.length > 1 && (
          <FilterSelect label="Event" value={event} onChange={reset(setEvent)} options={[['all', 'All events'], ...events.map(([e, n]): [string, string] => [e, `${e} (${n})`])]} />
        )}
        {days.length > 1 && (
          <>
            <FilterSelect
              label="Collected"
              value={collectedFrom}
              onChange={(v) => {
                reset(setCollectedFrom)(v);
                if (v !== 'all' && collectedTo !== 'all' && collectedTo < v) setCollectedTo(v);
              }}
              options={[['all', 'First day'], ...[...days].reverse().map((d): [string, string] => [d, dayShort(d)])]}
            />
            <FilterSelect
              label="to"
              value={collectedTo}
              onChange={reset(setCollectedTo)}
              options={[['all', 'Last day'], ...days.filter((d) => collectedFrom === 'all' || d >= collectedFrom).map((d): [string, string] => [d, dayShort(d)])]}
            />
          </>
        )}
        <FilterSelect label="Prize" value={prize} onChange={reset(setPrize)} options={[['all', 'All prizes'], ...prizes.map((p): [string, string] => [p.prize, `${p.prize} (${p.count})`])]} />
        <FilterSelect
          label="Status"
          value={status}
          onChange={(v) => reset(setStatus)(v as StatusFilter)}
          options={(['all', 'not_contacted', 'contacted', 'replied', 'unknown'] as const).map((s): [string, string] => [
            s,
            `${STATUS_LABEL[s]} (${(s === 'all' ? scoped.length : counts[s]).toLocaleString()})`,
          ])}
        />
        <button
          type="button"
          aria-pressed={unused}
          onClick={() => reset(setUnused)(!unused)}
          className={cn(
            'inline-flex h-8 items-center rounded-lg border px-2.5 text-xs transition-[color,border-color] duration-150',
            unused ? 'border-primary text-primary' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Won voucher, no order <span className="ml-1 tabular-nums">({voucherStats.notUsed})</span>
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        {voucherStats.winners} voucher winners, {voucherStats.ordered} ordered on the website since, {voucherStats.noEmail} Instagram-only (no email, can&rsquo;t check)
        {voucherStats.unknown > 0 && <>, {voucherStats.unknown} unknown (website orders unavailable)</>}. Any website order after the spin counts as used.
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <CopyButton text={handles.join('\n')} className={cn(!handles.length && 'pointer-events-none opacity-50')}>Copy {plural(handles.length, 'IG handle')}</CopyButton>
        <CopyButton text={emails.join('\n')} className={cn(!emails.length && 'pointer-events-none opacity-50')}>Copy {plural(emails.length, 'email')}</CopyButton>
        <CopyButton text={mobiles.join('\n')} className={cn(!mobiles.length && 'pointer-events-none opacity-50')}>Copy {plural(mobiles.length, 'mobile')}</CopyButton>
        <button
          type="button"
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-[color,border-color,transform] duration-150 hover:border-primary hover:text-foreground active:scale-[0.97] disabled:opacity-50"
        >
          <Download className="size-3.5" aria-hidden />
          CSV
        </button>
      </div>

      {/* Desktop: one table. Phone: a card per lead with the chip and the actions. */}
      <div className="hidden overflow-x-auto rounded-xl border md:block">
        {/* w-max: columns size to their content, so a nowrap cell never spills into the next one; the card scrolls instead of the
            page. Actions sit right after the name (owner 2026-11-25 on the Website CRM: Log next to the name), so nothing is pinned
            over another column and Log is in reach without scrolling. Bought at booth, the widest and least used, goes last. */}
        <table className="w-max min-w-full text-xs">
          <thead className="whitespace-nowrap border-b bg-muted/40 text-left text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Name</th>
              <th className="px-3 py-2 font-semibold">Actions</th>
              <th className="px-3 py-2 font-semibold">Instagram</th>
              <th className="px-3 py-2 font-semibold">Email</th>
              <th className="px-3 py-2 font-semibold">Mobile</th>
              <th className="px-3 py-2 font-semibold">Pet</th>
              <th className="px-3 py-2 font-semibold">Prize</th>
              <th className="px-3 py-2 text-right font-semibold">Collected</th>
              <th className="px-3 py-2 font-semibold">Website</th>
              {matches && (
                <th className="px-3 py-2 font-semibold">
                  <span className="inline-flex items-center gap-1">Bought at booth <BoughtHelp /></span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const ig = instagramUrl(l.instagram);
              const w = websiteText(vouchers[leadKey(l)]);
              return (
                <tr key={leadKey(l)} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <StatusChip status={statusOf(l)} onLog={hasContactKey(l) ? () => onLog(l) : undefined} name={leadName(l)} />
                  </td>
                  <td className="max-w-[180px] truncate px-3 py-2 font-medium" title={l.name ?? undefined}>{l.name ?? <span className="font-normal text-muted-foreground">—</span>}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <Actions lead={l} onLog={() => onLog(l)} />
                  </td>
                  <td className="max-w-[160px] truncate px-3 py-2">
                    {ig ? (
                      <a href={ig} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">@{l.instagram}</a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="max-w-[200px] truncate px-3 py-2" title={l.email ?? undefined}>{l.email ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">{l.mobile ?? '—'}</td>
                  <td className="max-w-[160px] truncate px-3 py-2 text-muted-foreground" title={l.pet ?? undefined}>{l.pet ?? '—'}</td>
                  <td className="max-w-[140px] truncate px-3 py-2 text-muted-foreground" title={l.prize}>{l.prize}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">{stamp(l.collectedAt)}</td>
                  <td className={cn('whitespace-nowrap px-3 py-2', w.tone === 'good' ? 'text-[var(--status-good)]' : 'text-muted-foreground')}>{w.text}</td>
                  {matches && <BoughtCell match={matches[leadKey(l)]} />}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="px-3 py-8 text-center text-xs text-muted-foreground">No leads match these filters.</div>}
      </div>

      <ul className="flex flex-col divide-y rounded-xl border md:hidden">
        {rows.map((l) => {
          const w = websiteText(vouchers[leadKey(l)]);
          return (
            <li key={leadKey(l)} className="flex flex-col gap-2 px-3.5 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{leadName(l)}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[l.name && l.instagram ? `@${l.instagram}` : null, l.email, l.mobile].filter(Boolean).join(' · ') || 'No contact details'}
                  </div>
                </div>
                <StatusChip status={statusOf(l)} onLog={hasContactKey(l) ? () => onLog(l) : undefined} name={leadName(l)} />
              </div>
              <div className="text-xs text-muted-foreground">
                {[l.pet, l.prize, stamp(l.collectedAt)].filter(Boolean).join(' · ')}
                <span className={cn('block', w.tone === 'good' && 'text-[var(--status-good)]')}>Website: {w.text}</span>
              </div>
              <Actions lead={l} onLog={() => onLog(l)} />
            </li>
          );
        })}
        {rows.length === 0 && <li className="px-3 py-8 text-center text-xs text-muted-foreground">No leads match these filters.</li>}
      </ul>

      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {start + 1}&ndash;{start + rows.length} of {filtered.length.toLocaleString()}
          </span>
          <Pagination page={current} pageCount={pageCount} onPage={setPage} label="Contacts pagination" />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Nothing is sent from Coop: Instagram opens the profile, email opens your mail app, and Log records a contact you already made.
        Public codes like GRAND300 have no recipient list: Coop can only show who used them (Website CRM &rarr; Used code (any order)).
      </p>
    </section>
  );
}
