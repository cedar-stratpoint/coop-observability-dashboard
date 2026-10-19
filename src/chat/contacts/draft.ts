// The `contacts` tool, draft mode (P2 of knowledge/tasks/2026-10-19-ask-coop-customer-leads-plan.md). Pure.
// Two ways to write messages for an event's leads, both copy-out only (nothing is ever sent):
//  - template: the model writes ONE message with {{placeholders}}; the app fills each lead's values in a single pass, so a
//    long list never has to pass through the model as text;
//  - per_lead: for a small batch the model writes each message itself, addressed by the row numbers of the list.
// Every value a customer typed is cleaned (markup, links, braces, line breaks) before it is merged, and merged once, so a pet
// field containing "{{prize}}" cannot expand into anything.
import {petName, treatPhrase, leadKey} from '../../lead-order-match';
import {manilaDayKey} from '../../pos-sales-compute';
import type {SpinLead} from '../../spin-leads-types';
import type {ClarifyResult} from '../clarify';
import type {MetricRow, ResultColumn} from '../result-types';
import {clean, CONSENT_NOTE, selectLeads, slug, type DraftInput, type LeadsOutcome, type LeadsSource} from './leads';

export const PLACEHOLDERS = ['pet', 'prize', 'event', 'treats', 'collected_date'] as const;
const SAMPLES = 5;
const MAX_MESSAGE = 1200;

const COLUMNS: ResultColumn[] = [
  {key: 'n', label: '#', unit: 'count', role: 'category'},
  {key: 'to', label: 'To', unit: 'text', role: 'category'},
  {key: 'message', label: 'Message', unit: 'text', role: 'category'},
];

const CHANNEL_FIELD = {email: 'email', sms: 'mobile', instagram: 'instagram'} as const;
const CHANNEL_LABEL = {email: 'email', sms: 'SMS text', instagram: 'Instagram DM'} as const;

/** Model-written text: no markup, no links, no control characters (a line break is kept), capped. */
function scrub(text: string): string {
  return text.replace(/\S*:\/\/\S*|www\.\S*/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, MAX_MESSAGE);
}

export interface DraftOutcome extends Omit<LeadsOutcome, 'model'> {
  model: {event: string; counts: Record<string, number>; samples: string[]; notes: string[]};
}

export function draftLeads(input: DraftInput, source: LeadsSource): DraftOutcome | ClarifyResult | {error: string} {
  const sel = selectLeads(input, source);
  if (!('event' in sel)) return sel;
  const {event, label, listed} = sel;
  const field = CHANNEL_FIELD[input.channel];
  const to = (l: SpinLead): string | null => clean(l[field], 80);

  let chosen: {n: number; lead: SpinLead; text?: string}[];
  if (input.per_lead) {
    const seen = new Set<number>();
    chosen = [];
    for (const p of input.per_lead) {
      if (p.n > listed.length) return {error: `Row ${p.n} is not in the list: it has ${listed.length} rows.`};
      if (seen.has(p.n)) continue; // the first message for a row wins
      seen.add(p.n);
      chosen.push({n: p.n, lead: listed[p.n - 1], text: scrub(p.text)});
    }
  } else {
    const bad = [...(input.template ?? '').matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]).filter((k) => !(PLACEHOLDERS as readonly string[]).includes(k));
    if (bad.length > 0) return {error: `Unknown placeholder {{${bad[0]}}}. Allowed: ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}.`};
    chosen = listed.slice(0, input.limit).map((lead, i) => ({n: i + 1, lead}));
  }

  const template = scrub(input.template ?? '');
  const rows: MetricRow[] = [];
  let skipped = 0;
  let unsure = 0;
  for (const c of chosen) {
    const addr = to(c.lead);
    if (!addr) {
      skipped += 1;
      continue;
    }
    const m = source.matches?.[leadKey(c.lead)];
    if (m && m.products.length > 0 && m.confidence === 'unsure') unsure += 1;
    let message = c.text;
    if (message === undefined) {
      const values: Record<string, string> = {
        pet: clean(petName({...c.lead, pet: clean(c.lead.pet)}), 40) ?? 'your furbaby',
        prize: clean(c.lead.prize, 60) ?? 'prize',
        event: clean(event.name, 80) ?? 'the event',
        treats: clean(treatPhrase(m?.products ?? []), 120) ?? 'treats',
        collected_date: manilaDayKey(c.lead.collectedAt),
      };
      message = template.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_all, k: string) => values[k] ?? ''); // one pass: a value is never scanned again
    }
    rows.push({n: c.n, to: addr, message});
  }
  if (rows.length === 0) return {error: `None of the ${chosen.length} chosen leads has ${field === 'email' ? 'an email' : field === 'mobile' ? 'a mobile number' : 'an Instagram handle'}, so there is nothing to draft for ${CHANNEL_LABEL[input.channel]}.`};

  const counts = {listed: listed.length, drafted: rows.length, skipped_no_channel: skipped, without_consent_date: chosen.filter((c) => !c.lead.consentAt).length};
  const notes = [
    `${rows.length} ${CHANNEL_LABEL[input.channel]} drafts for ${label}. Nothing was sent: the owner copies them out and sends them.`,
    CONSENT_NOTE,
    ...(skipped > 0 ? [`${skipped} chosen lead${skipped === 1 ? ' has' : 's have'} no ${field}, so no draft was made for them.`] : []),
    ...(unsure > 0 ? [`${unsure} draft${unsure === 1 ? ' uses' : 's use'} an unsure order match for the treats (booth timing was close to another order).`] : []),
    'Leads with no pet name read "your furbaby"; leads with no order match read "treats". You see only a few sample drafts; the owner sees them all.',
  ];
  return {
    table: {
      title: `Drafts: ${event.name} (${CHANNEL_LABEL[input.channel]})`,
      columns: COLUMNS,
      rows,
      total: null,
      reliable: true,
      caveats: [`Nothing is sent: copy the drafts out. ${counts.without_consent_date} of ${chosen.length} chosen leads have no consent date (the date is the first sign-up only). Honour unsubscribes.`],
      basis: `${rows.length} drafts, ${CHANNEL_LABEL[input.channel]}`,
      pii: true,
      copyColumns: {messages: 'message'},
      csvName: `drafts-${slug(event.name)}.csv`,
    },
    model: {event: label, counts, samples: rows.slice(0, SAMPLES).map((r) => String(r.message)), notes},
    audit: {eventId: event.event_id, rows: rows.length, columns: COLUMNS.map((c) => c.key)},
  };
}
