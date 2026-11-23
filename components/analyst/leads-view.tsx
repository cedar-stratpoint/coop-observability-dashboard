'use client';

import {useMemo, useState} from 'react';
import {Check, Copy} from 'lucide-react';
import type {SpinLead} from '@/src/spin-leads-types';
import type {LeadMatch} from '@/src/lead-order-match';
import {FOLLOW_UP_DAYS, addDays, followUpMessage, leadKey, petName, treatPhrase, type FollowUpStage} from '@/src/lead-order-match';
import {manilaDayKey} from '@/src/pos-sales-compute';
import {SegmentedControl} from './segmented-control';
import {LeadCapture, type VoucherProps} from './lead-capture';

const VIEWS = [
  {value: 'contacts', label: 'Contacts'},
  {value: 'followups', label: 'Follow-ups'},
] as const;

/** /customers/leads: the contact list, or the day's follow-up messages built from it. */
export function LeadsView({leads, matches, ...voucher}: {leads: SpinLead[]; matches: Record<string, LeadMatch>} & VoucherProps) {
  const [view, setView] = useState<'contacts' | 'followups'>('contacts');
  return (
    <div className="flex flex-col gap-6">
      <SegmentedControl ariaLabel="Leads view" options={VIEWS} value={view} onChange={setView} />
      {view === 'contacts' ? <LeadCapture leads={leads} orders={0} matches={matches} voucher={voucher} /> : <FollowUps leads={leads} matches={matches} />}
    </div>
  );
}

const STAGES: {stage: FollowUpStage; title: string; hint: string}[] = [
  {stage: 'thanks', title: 'Thank-you', hint: `Spun ${FOLLOW_UP_DAYS.thanks} day before`},
  {stage: 'promo', title: 'Website promo', hint: `Spun ${FOLLOW_UP_DAYS.promo} days before`},
];

/**
 * Who to message on a given day, with the message filled in. Only confident
 * purchase matches are listed: an unsure one could thank someone for a
 * stranger's order. A copy-and-paste list, not a sender.
 */
function FollowUps({leads, matches}: {leads: SpinLead[]; matches: Record<string, LeadMatch>}) {
  const [day, setDay] = useState(() => manilaDayKey(new Date().toISOString()));

  const due = useMemo(
    () =>
      STAGES.map((s) => ({
        ...s,
        rows: leads.flatMap((l) => {
          const m = matches[leadKey(l)];
          if (!m || m.confidence !== 'confident') return [];
          return addDays(manilaDayKey(l.collectedAt), FOLLOW_UP_DAYS[s.stage]) === day ? [{l, m}] : [];
        }),
      })),
    [leads, matches, day],
  );
  const unsure = Object.values(matches).filter((m) => m.confidence === 'unsure').length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <label className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 focus-within:text-foreground">
          Due on
          <input
            type="date"
            value={day}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="bg-transparent font-medium text-foreground outline-none"
          />
        </label>
        {unsure > 0 && <span>{unsure} unsure purchase matches are left out. Check them in Contacts.</span>}
      </div>

      {due.map((s) => (
        <section key={s.stage}>
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {s.title}
            <span className="ml-1.5 font-medium normal-case tracking-normal">
              {s.hint} · {s.rows.length}
            </span>
          </div>
          {s.rows.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-5 text-center text-xs text-muted-foreground">
              Nobody is due for this message on this day.
            </div>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {s.rows.map(({l, m}) => (
                <FollowUpRow key={leadKey(l)} lead={l} match={m} stage={s.stage} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function FollowUpRow({lead, match, stage}: {lead: SpinLead; match: LeadMatch; stage: FollowUpStage}) {
  const [copied, setCopied] = useState(false);
  const message = followUpMessage(stage, lead, match);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the message is on screen to copy by hand */
    }
  };
  return (
    <li className="flex flex-col gap-2 px-3 py-3 text-xs sm:flex-row sm:items-start sm:gap-4">
      <div className="w-full shrink-0 sm:w-56">
        <div className="truncate font-medium">{lead.instagram ? `@${lead.instagram}` : lead.email}</div>
        <div className="truncate text-muted-foreground">
          {petName(lead)} · {treatPhrase(match.products)}
        </div>
      </div>
      <p className="flex-1 leading-relaxed">{message}</p>
      <button
        type="button"
        onClick={copy}
        className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </li>
  );
}
