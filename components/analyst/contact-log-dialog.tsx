'use client';

// "Log contact" (RET-05): record a DM, SMS, call, hand-sent email or other contact that a team member already made with a
// website customer, and see who reached them before. It records, it never sends: there is no send control anywhere here.
// Only the person who logged a contact sees its Delete control; the server action checks again (delete-own).
import {useEffect, useId, useRef, useState, useTransition} from 'react';
import {createPortal} from 'react-dom';
import {useRouter} from 'next/navigation';
import {MessageSquarePlus, Trash2, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {fmtPh} from '@/src/crm-compute';
import {CHANNEL_LABEL, CONTACT_CHANNELS, CONTACT_NOTE_MAX, type ContactChannel, type CustomerContact} from '@/src/customer-contacts';
import {deleteContact, logContact} from '@/src/customer-contacts-actions';

const label = 'mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground';

export function ContactLogDialog({
  name,
  email,
  history,
  viewer,
  onClose,
}: {
  name: string;
  email: string | null;
  /** This customer's logged contacts, newest first; null = the log is not set up here (nothing can be logged). */
  history: CustomerContact[] | null;
  viewer: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const noteId = useId();
  const first = useRef<HTMLInputElement>(null);
  const [channel, setChannel] = useState<ContactChannel | null>(null);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ok: boolean; text: string} | null>(null);
  const ready = history !== null && Boolean(email);

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
      const res = await logContact({email, channel, note});
      if (res.ok) {
        setMsg({ok: true, text: `${CHANNEL_LABEL[channel]} logged.`});
        setChannel(null);
        setNote('');
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
              {name ? `${name}, ` : ''}
              {email ?? 'no email address'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground transition-colors hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {history === null ? (
            <p className="rounded-lg border border-dashed px-3 py-2 text-xs leading-snug text-muted-foreground">
              The contact log is not set up in this environment yet, so contacts cannot be logged here and the manual count shows as unavailable.
            </p>
          ) : !email ? (
            <p className="rounded-lg border border-dashed px-3 py-2 text-xs leading-snug text-muted-foreground">
              This customer has no email address, so a contact cannot be logged against them.
            </p>
          ) : (
            <>
              <p className="mb-4 text-xs text-muted-foreground">
                Record a contact you already made by hand. It counts toward times contacted, apart from the automated emails. Nothing is sent from here.
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
