'use client';

import {useMemo, useState} from 'react';
import {Check, Copy} from 'lucide-react';
import type {SpinLead} from '@/src/spin-leads-types';
import type {LeadMatch} from '@/src/lead-order-match';
import {FOLLOW_UP_DAYS, addDays, followUpMessage, leadKey, petName, treatPhrase, type FollowUpStage} from '@/src/lead-order-match';
import {manilaDayKey} from '@/src/pos-sales-compute';
import {SegmentedControl} from './segmented-control';
import {LeadCapture} from './lead-capture';
import {LeadsContacts, LogButton, StatusChip, hasContactKey} from './leads-contacts';
import {ContactLogDialog} from './contact-log-dialog';
import {leadPerson} from '@/src/spin-leads-types';
import type {CustomerContact} from '@/src/customer-contacts';
import type {ContactStatus} from '@/src/person-identity';
import type {SpinVoucherInfo} from '@/src/spin-voucher';
import type {PawsportBadge} from '@/src/pawsport';

const VIEWS = [
  {value: 'contacts', label: 'Contacts'},
  {value: 'followups', label: 'Follow-ups'},
] as const;

const UNKNOWN: ContactStatus = {state: 'unknown', lastAt: null, lastChannel: null};

/**
 * /customers/leads: the contact list (status first, RET-17), or the day's follow-up messages built from it. One Log dialog
 * serves both views; statuses and each lead's contacts are computed on the server (src/person-identity.ts).
 */
export function LeadsView({
  leads,
  matches,
  vouchers,
  passports,
  statuses,
  histories,
  logRead,
  legacy,
  viewer,
}: {
  leads: SpinLead[];
  matches: Record<string, LeadMatch>;
  /** Per lead (leadKey): whether a website order followed the spin. Computed on the server; null state = orders unread. */
  vouchers: Record<string, SpinVoucherInfo>;
  /** RET-18 P1: per lead (leadKey) that is the same person as a PawSport holder, their passport. Absent = no match found. */
  passports: Record<string, PawsportBadge>;
  /** Per lead (leadKey): contact status from the manual log (D1, D2); 'unknown' never counts as not contacted. */
  statuses: Record<string, ContactStatus>;
  /** Per lead with contacts (or unreadable ones, null); a lead missing here has none yet. */
  histories: Record<string, CustomerContact[] | null>;
  /** False = the log could not be read (every status Unknown, nothing can be logged). */
  logRead: boolean;
  /** The log was read without the Instagram / mobile columns (SQL not applied yet). */
  legacy: boolean;
  viewer: string | null;
}) {
  const [view, setView] = useState<'contacts' | 'followups'>('contacts');
  const [logFor, setLogFor] = useState<SpinLead | null>(null);
  const statusOf = (l: SpinLead): ContactStatus => statuses[leadKey(l)] ?? UNKNOWN;
  const historyOf = (l: SpinLead): CustomerContact[] | null => (!logRead ? null : leadKey(l) in histories ? histories[leadKey(l)] : []);
  return (
    <div className="flex flex-col gap-6">
      <SegmentedControl ariaLabel="Leads view" options={VIEWS} value={view} onChange={setView} />
      {view === 'contacts' ? (
        <LeadCapture leads={leads} orders={0} matches={matches} list={<LeadsContacts leads={leads} matches={matches} data={{vouchers, statuses, passports}} logRead={logRead} onLog={setLogFor} />} />
      ) : (
        <FollowUps leads={leads} matches={matches} statusOf={statusOf} onLog={setLogFor} />
      )}
      {logFor && (
        <ContactLogDialog
          name={logFor.name ?? ''}
          person={leadPerson(logFor)}
          history={historyOf(logFor)}
          viewer={viewer}
          legacy={legacy}
          onClose={() => setLogFor(null)}
        />
      )}
    </div>
  );
}

type LogProps = {statusOf: (l: SpinLead) => ContactStatus; onLog: (l: SpinLead) => void};

const STAGES: {stage: FollowUpStage; title: string; hint: string}[] = [
  {stage: 'thanks', title: 'Thank-you', hint: `Spun ${FOLLOW_UP_DAYS.thanks} day before`},
  {stage: 'promo', title: 'Website promo', hint: `Spun ${FOLLOW_UP_DAYS.promo} days before`},
];

/**
 * Who to message on a given day, with the message filled in. Only confident
 * purchase matches are listed: an unsure one could thank someone for a
 * stranger's order. A copy-and-paste list, not a sender.
 */
function FollowUps({leads, matches, statusOf, onLog}: {leads: SpinLead[]; matches: Record<string, LeadMatch>} & LogProps) {
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
                <FollowUpRow key={leadKey(l)} lead={l} match={m} stage={s.stage} statusOf={statusOf} onLog={onLog} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function FollowUpRow({lead, match, stage, statusOf, onLog}: {lead: SpinLead; match: LeadMatch; stage: FollowUpStage} & LogProps) {
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
        <div className="mt-1.5">
          <StatusChip status={statusOf(lead)} onLog={hasContactKey(lead) ? () => onLog(lead) : undefined} name={lead.name ?? undefined} />
        </div>
      </div>
      <p className="flex-1 leading-relaxed">{message}</p>
      <span className="flex shrink-0 items-center gap-1.5 self-start">
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        {hasContactKey(lead) && <LogButton onClick={() => onLog(lead)} name={lead.name ?? lead.email ?? (lead.instagram ? `@${lead.instagram}` : 'this lead')} compact />}
      </span>
    </li>
  );
}
