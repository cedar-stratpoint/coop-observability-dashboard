'use client';

import {useEffect, useRef, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Check, Copy, Laptop, Plus, Trash2} from 'lucide-react';
import {revokeWorker, startEnrolment} from '@/src/shopee-sync-actions';
import {agoText, enrolCommand, macStatus, SESSION_LABEL, type Tone} from '@/src/shopee-sync/card-model';
import type {ShopeeSyncStatus} from '@/src/shopee-sync/status';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';

// Settings > My sync Macs. Lists the person's own Macs (an admin sees everyone's, with the owner), removes one, and adds one: a name, then a
// one-time command. The code is shown once, here only; it is never stored in the page and never fetched again. The Shopee password is never
// entered in Coop: the last step is typing it in the Shopee browser the Mac opens at http://localhost:6080.

const TONE: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-accent text-accent-foreground',
  warn: 'bg-[var(--amber-bg)] text-[color-mix(in_oklab,var(--amber-fg)_55%,var(--foreground))]',
  good: 'bg-[color-mix(in_oklab,var(--status-good)_14%,transparent)] text-[var(--status-good)]',
  crit: 'bg-destructive/10 text-destructive',
};

type Issued = {command: string; expiresAt: string};

export function ShopeeSyncMacs({status, at}: {status: ShopeeSyncStatus; at: string}) {
  const router = useRouter();
  const [now, setNow] = useState(() => new Date(at));
  useEffect(() => {
    setNow(new Date());
  }, []);
  const [pending, start] = useTransition();
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cmdRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const add = () =>
    start(async () => {
      setError(null);
      const r = await startEnrolment(name);
      if (!r.ok) return setError(r.error);
      setIssued({command: enrolCommand(r.command, window.location.origin), expiresAt: r.expiresAt});
      setName('');
      router.refresh();
    });
  const remove = (id: string) =>
    start(async () => {
      setError(null);
      const r = await revokeWorker(id);
      if (!r.ok) setError(r.error);
      setConfirmId(null);
      router.refresh();
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued!.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked (insecure origin, permissions): select the text so Cmd/Ctrl+C works
      const el = cmdRef.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setError('Could not copy automatically. The command is selected: press Ctrl or Cmd + C.');
    }
  };

  const cap = status.canAddMac;
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Your Macs" className="rounded-[var(--radius)] border border-border bg-card">
        {status.workers.length === 0 ? (
          <div className="flex flex-col items-start gap-1 p-5">
            <p className="text-sm font-medium text-foreground">No Mac added yet</p>
            <p className="max-w-[55ch] text-sm text-muted-foreground">Add the Mac you will use for Shopee syncs. It needs Docker, and you need to be able to type the Shopee password on it.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {status.workers.map((w) => {
              const m = macStatus(w);
              return (
                <li key={w.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between md:p-5">
                  <div className="flex min-w-0 items-start gap-3">
                    <Laptop className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{w.name}</span>
                        <span className={cn('rounded-full px-2 py-0.5 text-[11.5px] font-semibold', TONE[m.tone])}>{m.label}</span>
                        {!w.own && <span className="text-xs text-muted-foreground">owner {w.ownerEmail}</span>}
                      </div>
                      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px] text-muted-foreground">
                        <dt>Session</dt>
                        <dd>{SESSION_LABEL[w.sessionState]}</dd>
                        <dt>Last seen</dt>
                        <dd>{agoText(w.lastSeen, now)}</dd>
                        <dt>Last sync</dt>
                        <dd>{w.lastSyncAt ? agoText(w.lastSyncAt, now) : 'none yet'}</dd>
                      </dl>
                    </div>
                  </div>
                  {confirmId === w.id ? (
                    <div className="flex shrink-0 flex-wrap items-center gap-2" role="group" aria-label={`Remove ${w.name}?`}>
                      <span className="text-[13px] text-muted-foreground">Remove it? It stops at once.</span>
                      <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => remove(w.id)} className="h-8 px-3">
                        Remove
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setConfirmId(null)} className="h-8 px-3">
                        Keep
                      </Button>
                    </div>
                  ) : (
                    <Button type="button" variant="outline" size="sm" onClick={() => setConfirmId(w.id)} aria-label={`Revoke ${w.name}`} className="h-8 shrink-0 self-start px-3 sm:self-center">
                      <Trash2 className="size-3.5" aria-hidden /> Revoke
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {error && (
        <p role="alert" className="text-[13px] font-medium text-destructive">
          {error}
        </p>
      )}

      {!issued && (
        <section aria-label="Add a Mac" className="rounded-[var(--radius)] border border-border bg-card p-4 md:p-5">
          {!adding ? (
            <div className="flex flex-col items-start gap-2">
              <Button
                type="button"
                disabled={!cap.ok}
                onClick={() => {
                  setAdding(true);
                  setTimeout(() => nameRef.current?.focus(), 0);
                }}
                className="h-9 px-3.5 active:scale-[0.97]"
              >
                <Plus className="size-4" aria-hidden /> Add a Mac
              </Button>
              {!cap.ok && <p className="text-[13px] text-muted-foreground">{cap.reason}</p>}
            </div>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim() && !pending) add();
              }}
            >
              <label htmlFor="mac-name" className="text-sm font-medium text-foreground">
                What do you call this Mac?
              </label>
              <input
                id="mac-name"
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="Dave's MacBook"
                autoComplete="off"
                className="h-10 w-full max-w-sm rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!name.trim() || pending} className="h-9 px-3.5 active:scale-[0.97]">
                  Make the command
                </Button>
                <Button type="button" variant="ghost" onClick={() => setAdding(false)} className="h-9 px-3.5">
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </section>
      )}

      {issued && (
        <section aria-label="Run this on your Mac" className="flex flex-col gap-4 rounded-[var(--radius)] border border-primary/40 bg-card p-4 md:p-5">
          <div>
            <h2 className="font-serif text-xl font-normal text-foreground">Run this on your Mac</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              The code inside works once and expires in 15 minutes (at {new Date(issued.expiresAt).toLocaleTimeString('en-PH', {hour: '2-digit', minute: '2-digit'})}). It is shown only here. If it runs out, make a new one.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <code ref={cmdRef} tabIndex={0} aria-label="Enrolment command" className="block max-w-full select-all overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/60 p-3 font-mono text-[12.5px] leading-relaxed text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
              {issued.command}
            </code>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={copy} className="h-9 px-3.5 active:scale-[0.97]">
                {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                {copied ? 'Copied' : 'Copy command'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setIssued(null)} className="h-9 px-3.5">
                Done
              </Button>
            </div>
          </div>
          <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-foreground marker:text-muted-foreground">
            <li>Run the command in Terminal on that Mac.</li>
            <li>
              Open <span className="font-mono text-[13px]">http://localhost:6080</span>, sign in to Seller Centre and verify the password there. Coop never sees it.
            </li>
            <li>The Mac turns Online in the list above.</li>
          </ol>
        </section>
      )}
    </div>
  );
}
