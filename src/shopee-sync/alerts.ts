// Failure alerts for the Shopee sync (SYN-06): which jobs deserve an email, and what it says. Pure, with the sender injected.
//
// Recipients: the Coop Admins, resolved by the future sender and passed as `to`. Failures, sign-in needs and nudges all go to them.
// TODO(SYN-06 wiring): the dashboard has no email mechanism today, so nothing calls this yet. To switch it on:
//   1. a sender over Resend's HTTPS API (plain fetch, like the backend's src/lib/resend.js; RESEND_API_KEY + EMAIL_FROM + a recipient list in env, server-only),
//   2. somewhere to remember which keys went (an `alerted_at` column on shopee_sync_jobs, applied by hand; apply it to staging first), so each alert is sent once,
//   3. call `dispatchAlerts` from where a job turns failed (handleProgress in api.ts, sweepJobs in service.ts) and from a poll that also sees a stuck
//      awaiting_verification job. The target is an email within 5 minutes of the failure (story SYN-06).
// The message is built to be safe to send anywhere: job id, days and a scrubbed reason. No screenshot, link, buyer data, requester address,
// per-day note, password or code ever goes in it, and the builder has no field to carry one.
import {rangeText} from './card-model';
import type {Job, LoginState} from './types';

/** A sync waiting for an admin to sign in this long is worth a nudge. It expires at 60 minutes (AWAITING_EXPIRY_MS in rules.ts), so the nudge comes well before. */
export const AWAITING_ALERT_MS = 15 * 60_000;
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
    else if (job.status === 'awaiting_verification' && now.getTime() - Date.parse(job.awaitingSince ?? job.claimedAt ?? job.createdAt) > AWAITING_ALERT_MS) kind = 'awaiting_verification';
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
      text: `A Shopee sync has been waiting for an admin to sign in to Shopee for over ${AWAITING_ALERT_MS / 60_000} minutes. It expires after 60 minutes.\n\nJob: ${job.id}\nDays: ${days}\n\nOpen the Shopee sync card on the Coop Overview and use Open remote browser. The Monday import still covers the week.`,
    };
  }
  return {
    subject: 'Shopee sync failed',
    text: `A Shopee sync failed.\n\nJob: ${job.id}\nDays: ${days}\nReason: ${scrubReason(job.error)}\n\nDays already loaded are kept. Open the Shopee sync card on the Coop Overview to retry. The Monday import still covers the week.`,
  };
}

/**
 * The cloud worker's login needs an admin (needs_password or signed_out). One key per state: the caller remembers it and forgets it once the login is
 * ready again, so a new episode alerts again but a login that stays bad does not alert on every check.
 */
export function loginAlertDue(login: LoginState | 'unknown', alreadySent: ReadonlySet<string>): {key: string; state: 'needs_password' | 'signed_out'} | null {
  if (login !== 'needs_password' && login !== 'signed_out') return null;
  const key = `login:${login}`;
  return alreadySent.has(key) ? null : {key, state: login};
}
export function loginAlertMessage(state: 'needs_password' | 'signed_out'): AlertMessage {
  return {
    subject: state === 'needs_password' ? 'Shopee needs an admin to sign in' : 'Shopee is signed out',
    text: `${state === 'needs_password' ? 'Shopee is asking for the account password' : 'Shopee ended the session'}, so Sync is switched off for everyone until an admin signs in.\n\nOpen the Shopee sync card on the Coop Overview and use Open remote browser. Type the password in that browser, never in Coop. The Monday import still covers the week.`,
  };
}

/** The Coop Admins who are told, for the injected sender. Failures and sign-in alerts go to them, not to the person who pressed Sync. */
export type Send = (m: AlertMessage, to: readonly string[]) => Promise<void>;

/**
 * Sends each due alert through `send` to `to` (the admins); returns the keys that went. One failing send does not stop the rest, and its key is left
 * out so it is tried again. `login` is the cloud worker's last known login, to alert when it needs an admin.
 */
export async function dispatchAlerts(i: {jobs: readonly Job[]; now: Date; alreadySent: ReadonlySet<string>; send: Send; to?: readonly string[]; login?: LoginState | 'unknown'}): Promise<string[]> {
  const sent: string[] = [];
  const to = i.to ?? [];
  const items: {key: string; message: AlertMessage}[] = alertsDue(i.jobs, i.now, i.alreadySent).map((a) => ({key: a.key, message: alertMessage(a)}));
  const l = loginAlertDue(i.login ?? 'unknown', i.alreadySent);
  if (l) items.push({key: l.key, message: loginAlertMessage(l.state)});
  for (const it of items) {
    try {
      await i.send(it.message, to);
      sent.push(it.key);
    } catch {
      // left unsent; the next pass retries
    }
  }
  return sent;
}
