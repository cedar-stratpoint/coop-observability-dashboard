// Failure alerts for the Shopee sync (SYN-06): which jobs deserve an email, and what it says. Pure, with the sender injected.
//
// TODO(SYN-06 wiring): the dashboard has no email mechanism today, so nothing calls this yet. To switch it on:
//   1. a sender over Resend's HTTPS API (plain fetch, like the backend's src/lib/resend.js; RESEND_API_KEY + EMAIL_FROM + a recipient list in env, server-only),
//   2. somewhere to remember which keys went (an `alerted_at` column on shopee_sync_jobs, applied by hand; apply it to staging first), so each alert is sent once,
//   3. call `dispatchAlerts` from where a job turns failed (handleProgress in api.ts, sweepJobs in service.ts) and from a poll that also sees a stuck
//      awaiting_verification job. The target is an email within 5 minutes of the failure (story SYN-06).
// The message is built to be safe to send anywhere: job id, days and a scrubbed reason. No screenshot, link, buyer data, requester address,
// per-day note, password or code ever goes in it, and the builder has no field to carry one.
import {rangeText} from './card-model';
import type {Job} from './types';

/** A sync waiting for the person to type the Shopee password this long is worth a nudge. */
export const AWAITING_ALERT_MS = 2 * 3_600_000;
const REASON_MAX = 300;

export type AlertKind = 'failed' | 'awaiting_verification';
export interface Alert {
  /** One per job and kind: the caller remembers sent keys so an alert goes out once. */
  key: string;
  kind: AlertKind;
  job: Job;
}
export interface AlertMessage {
  subject: string;
  text: string;
}

// A person ending a sync (cancel, removing the Mac) is not a failure to chase; an expired job nobody claimed is shown on the card and has nothing running to fix.
const endedByPerson = (error: string | null): boolean => /^(Cancelled by|The Mac was removed)/i.test(error ?? '');

export function alertsDue(jobs: readonly Job[], now: Date, alreadySent: ReadonlySet<string>): Alert[] {
  const out: Alert[] = [];
  for (const job of jobs) {
    let kind: AlertKind | null = null;
    if (job.status === 'failed' && !endedByPerson(job.error)) kind = 'failed';
    else if (job.status === 'awaiting_verification' && now.getTime() - Date.parse(job.claimedAt ?? job.createdAt) > AWAITING_ALERT_MS) kind = 'awaiting_verification';
    if (kind && !alreadySent.has(`${job.id}:${kind}`)) out.push({key: `${job.id}:${kind}`, kind, job});
  }
  return out;
}

/** Strips what must never travel by email from free text a worker wrote: addresses, links, long digit runs (phones, order numbers), and "password x" / "otp x" pairs. */
export function scrubReason(raw: string | null): string {
  const t = (raw ?? '')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/\b(password|passcode|passwd|otp|pin|verification code|code)\b[\s:=-]*\S+/gi, '[removed]')
    .replace(/\d[\d\s-]{4,}\d/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > REASON_MAX ? `${t.slice(0, REASON_MAX)}...` : t || 'no reason was given';
}

export function alertMessage(a: Alert): AlertMessage {
  const {job} = a;
  const days = rangeText(job.days);
  if (a.kind === 'awaiting_verification') {
    return {
      subject: 'Shopee sync is waiting for verification',
      text: `A Shopee sync has been waiting for a person to verify on the worker Mac for over ${AWAITING_ALERT_MS / 3_600_000} hours.\n\nJob: ${job.id}\nDays: ${days}\n\nOpen the Shopee sync card on the Coop Overview. The Monday import still covers the week.`,
    };
  }
  return {
    subject: 'Shopee sync failed',
    text: `A Shopee sync failed.\n\nJob: ${job.id}\nDays: ${days}\nReason: ${scrubReason(job.error)}\n\nDays already loaded are kept. Open the Shopee sync card on the Coop Overview to retry. The Monday import still covers the week.`,
  };
}

/** Sends each due alert through `send`; returns the keys that went. One failing send does not stop the rest, and its key is left out so it is tried again. */
export async function dispatchAlerts(i: {jobs: readonly Job[]; now: Date; alreadySent: ReadonlySet<string>; send: (m: AlertMessage) => Promise<void>}): Promise<string[]> {
  const sent: string[] = [];
  for (const a of alertsDue(i.jobs, i.now, i.alreadySent)) {
    try {
      await i.send(alertMessage(a));
      sent.push(a.key);
    } catch {
      // left unsent; the next pass retries
    }
  }
  return sent;
}
