'use client';

// "Log contact" (RET-05, RET-17): record a DM, SMS, call, hand-sent email or other contact that a team member already made with a
// website customer or an event lead (by email, Instagram or mobile), whether they replied, and on which day ("When", the
// editable last contacted). It records, it never sends: there is no send control anywhere here. A wrong entry is fixed by
// deleting it and logging again. Only the person who logged a contact sees its Delete control; the server action checks again.
import {useEffect, useId, useRef, useState, useTransition} from 'react';
import {createPortal} from 'react-dom';
import {useRouter} from 'next/navigation';
import {MessageSquarePlus, Reply, Trash2, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {fmtPh} from '@/src/crm-compute';
import {CHANNEL_LABEL, CONTACT_CHANNELS, CONTACT_NOTE_MAX, loggableKeys, type ContactChannel, type CustomerContact} from '@/src/customer-contacts';
import {deleteContact, logContact} from '@/src/customer-contacts-actions';
import {manilaDayKey} from '@/src/pos-sales-compute';
import type {Person} from '@/src/person-identity';

/** "2026-11-20" → "Nov 20". */
const fmtDay = (day: string): string => new Date(`${day}T12:00:00+08:00`).toLocaleDateString('en-US', {timeZone: 'Asia/Manila', month: 'short', day: 'numeric'});

const label = 'mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground';

export function ContactLogDialog({
  name,
  person,
  history,
  viewer,
  legacy = false,
  onClose,
}: {
  name: string;
  /** Who: the keys a contact is logged against (every key they have, so the same person matches on any of them). */
  person: Person;
  /** This person's logged contacts (contactsOf), newest first; null = they cannot be read here (nothing can be logged). */
  history: CustomerContact[] | null;
  viewer: string | null;
  /** The log was read without the RET-17 columns: log by email only, so email logging keeps working before the SQL. */
  legacy?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const noteId = useId();
  const whenId = useId();
  const today = manilaDayKey(new Date().toISOString());
  const first = useRef<HTMLInputElement>(null);
  const [channel, setChannel] = useState<ContactChannel | null>(null);
  const [note, setNote] = useState('');
  const [replied, setReplied] = useState(false);
  const [when, setWhen] = useState(today);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ok: boolean; text: string} | null>(null);
  // Normalised and only the keys the server accepts: a junk booth mobile never blocks a good email (legacy: email only).
  const keys = loggableKeys(person, legacy);
  const hasKey = Boolean(keys.email || keys.instagram || keys.mobile);
  const ready = history !== null && hasKey;
  const who = [person.instagram ? `@${person.instagram.replace(/^@/, '')}` : null, person.email, person.mobile].filter(Boolean).join(' · ');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Focus the first channel once, on open: not again when a refresh re-renders the dialog.
  useEffect(() => first.current?.focus(), []);

  function submit() {
    if (!ready || !channel) return;
    setMsg(null);
    startTransition(async () => {
      const res = await logContact({...keys, channel, note, replied: !legacy && replied, contactedAt: when});
      if (res.ok) {
        setMsg({ok: true, text: `${CHANNEL_LABEL[channel]} logged${when === today ? '' : ` for ${fmtDay(when)}`}.`});
        setChannel(null);
        setNote('');
        setReplied(false);
        setWhen(today);
        router.refresh();
      } else setMsg({ok: false, text: res.error});
    });
  }

  function remove(id: string) {
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await deleteContact(id);
      setConfirming(null);
      if (res.ok) {
        setMsg({ok: true, text: 'Contact deleted.'});
        router.refresh();
      } else setMsg({ok: false, text: res.error});
    });
  }

  if (typeof document === 'undefined') return null;
  const left = CONTACT_NOTE_MAX - note.length;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-foreground/40 backdrop-blur-[1px] animate-in fade-in-0 duration-200 motion-reduce:animate-none" />
      <div className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-lg animate-in fade-in-0 zoom-in-[0.97] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:animate-none">
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
              <MessageSquarePlus className="size-4" /> Log a contact
            </h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {name ? `${name}${who ? ', ' : ''}` : ''}
              {who || (name ? '' : 'no email, Instagram or mobile')}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground transition-colors hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {history === null ? (
            <p className="rounded-lg border border-dashed px-3 py-2 text-xs leading-snug text-muted-foreground">
              {legacy
                ? 'Contacts by Instagram or mobile are not set up in this environment yet (supabase/customer_contacts_lead_keys.sql), so this person’s status is unknown and nothing can be logged here.'
                : 'The contact log is not set up in this environment yet, so contacts cannot be logged here and the manual count shows as unavailable.'}
            </p>
          ) : !hasKey ? (
            <p className="rounded-lg border border-dashed px-3 py-2 text-xs leading-snug text-muted-foreground">
              No email, Instagram or mobile on file, so a contact cannot be logged against this person.
            </p>
          ) : (
            <>
              <p className="mb-4 text-xs text-muted-foreground">
                Record a contact you already made by hand, on the day it happened. It counts toward times contacted, apart from the automated emails. Nothing is sent from here; to fix a wrong entry, delete yours below and log it again.
              </p>
              <fieldset>
                <legend className={label}>Channel</legend>
                <div className="flex flex-wrap gap-1.5">
                  {CONTACT_CHANNELS.map((c, i) => (
                    <label
                      key={c}
                      className={cn(
                        'cursor-pointer rounded-md border px-2.5 py-1.5 text-xs font-medium transition-[color,border-color,background-color,transform] duration-150 active:scale-[0.97]',
                        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                        channel === c ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:border-primary hover:text-foreground',
                      )}
                    >
                      <input ref={i === 0 ? first : undefined} type="radio" name="contact-channel" value={c} checked={channel === c} onChange={() => setChannel(c)} className="sr-only" />
                      {CHANNEL_LABEL[c]}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <label htmlFor={whenId} className={label}>
                    When
                  </label>
                  <input
                    id={whenId}
                    type="date"
                    value={when}
                    max={today}
                    required
                    onChange={(e) => setWhen(e.target.value || today)}
                    className="h-8 rounded-md border bg-background px-2 text-xs tabular-nums text-foreground outline-none focus-visible:border-ring"
                  />
                </div>
                {/* "They replied" needs the replied column (supabase/customer_contacts_lead_keys.sql): hidden on the legacy log. */}
                {!legacy && <label
                  className={cn(
                    'inline-flex h-8 cursor-pointer select-none items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-[color,border-color,background-color] duration-150',
                    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                    replied ? 'border-[var(--status-good)] bg-[var(--status-good)]/10 text-[var(--status-good)]' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <input type="checkbox" checked={replied} onChange={(e) => setReplied(e.target.checked)} className="size-3.5 accent-[var(--status-good)]" />
                  They replied
                </label>}
              </div>

              <div className="mt-4">
                <label htmlFor={noteId} className={label}>
                  Note <span className="opacity-60">(optional)</span>
                </label>
                <textarea
                  id={noteId}
                  value={note}
                  maxLength={CONTACT_NOTE_MAX}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder="e.g. replied on Instagram about the salmon treats"
                  className="w-full resize-none rounded-md border bg-background px-2.5 py-2 text-sm outline-none focus-visible:border-ring"
                />
                <span className={cn('mt-1 block text-right font-mono text-[10px] tabular-nums', left < 50 ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
                  {note.length}/{CONTACT_NOTE_MAX}
                </span>
              </div>
            </>
          )}

          {history !== null && (
            <div className="mt-5">
              <span className={label}>Logged by the team ({history.length})</span>
              {history.length === 0 ? (
                <p className="text-xs text-muted-foreground">No manual contacts logged yet.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border">
                  {history.map((h) => {
                    const mine = viewer !== null && h.createdBy === viewer;
                    return (
                      <li key={h.id} className="flex items-start justify-between gap-3 px-3 py-2">
                        <div className="min-w-0 text-xs">
                          <div className="font-medium text-foreground">
                            {CHANNEL_LABEL[h.channel] ?? h.channel}
                            {h.replied && (
                              <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] font-medium text-[var(--status-good)]">
                                <Reply className="size-3" aria-hidden /> replied
                              </span>
                            )}
                            <span className="ml-1.5 font-normal text-muted-foreground">
                              {fmtPh(h.contactedAt)}, {mine ? 'you' : h.createdBy}
                            </span>
                          </div>
                          {h.note && <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">{h.note}</p>}
                        </div>
                        {mine && (
                          <button
                            type="button"
                            onClick={() => remove(h.id)}
                            onBlur={() => setConfirming((v) => (v === h.id ? null : v))}
                            disabled={pending}
                            aria-label={confirming === h.id ? 'Confirm delete' : 'Delete this contact'}
                            className={cn(
                              'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-[color,background-color,transform] duration-150 active:scale-[0.97] disabled:opacity-50',
                              confirming === h.id ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:text-destructive',
                            )}
                          >
                            <Trash2 className="size-3.5" />
                            {confirming === h.id ? 'Delete?' : null}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {msg && (
            <p role="status" className={cn('mt-3 text-xs', msg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive')}>
              {msg.text}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3">
          <span className="font-mono text-[11px] text-muted-foreground">Recorded with your account</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97]">
              Close
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || !ready || !channel}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97] disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Log contact'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
