'use client';

import {useEffect, useRef, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Check, Copy, Cloud, Laptop, Plus, Trash2} from 'lucide-react';
import {revokeWorker, setRemoteBrowserUrl, startEnrolment} from '@/src/shopee-sync-actions';
import {agoText, enrolCommand, macStatus, SESSION_LABEL, type Tone} from '@/src/shopee-sync/card-model';
import type {CloudState, CloudWorkerView, ShopeeSyncStatus} from '@/src/shopee-sync/status';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';

// Settings > Sync worker: the one cloud worker (status, last seen, last login check, Revoke, and for admins the remote browser address), then
// the muted secondary path, My sync Macs. Lists the person's own Macs (an admin sees everyone's, with the owner), removes one, and adds one: a name, then a
// one-time command. The code is shown once, here only; it is never stored in the page and never fetched again. The Shopee password is never
// entered in Coop: an admin types it in the worker's own browser (the remote link), and on a Mac in the Shopee browser at http://localhost:6080.

const TONE: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-accent text-accent-foreground',
  warn: 'bg-[var(--amber-bg)] text-[color-mix(in_oklab,var(--amber-fg)_55%,var(--foreground))]',
  good: 'bg-[color-mix(in_oklab,var(--status-good)_14%,transparent)] text-[var(--status-good)]',
  crit: 'bg-destructive/10 text-destructive',
};

type Issued = {command: string; expiresAt: string; variant: 'mac' | 'cloud'};
const CLOUD_PILL: Record<CloudState, {label: string; tone: Tone}> = {asleep: {label: 'Asleep', tone: 'neutral'}, online: {label: 'Online', tone: 'good'}, offline: {label: 'Offline', tone: 'crit'}};
const LOGIN_TEXT = {ready: 'Signed in', needs_password: 'Needs password', signed_out: 'Signed out'} as const;

/** Copy that falls back to selecting the text, as the enrol command does. */
function CopyButton({text, label}: {text: string; label: string}) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied('yes');
          } catch {
            setCopied('no');
          }
          setTimeout(() => setCopied(null), 2000);
        }}
        className="h-9 px-3.5 active:scale-[0.97]"
      >
        {copied === 'yes' ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        {copied === 'yes' ? 'Copied' : label}
      </Button>
      <span className="text-[13px] text-muted-foreground" aria-live="polite">
        {copied === 'no' ? 'Could not copy. Select the address and press Ctrl or Cmd + C.' : ''}
      </span>
    </>
  );
}

/** Admin only: the address of the protected remote browser, saved on the cloud worker and never shown to anyone else. */
function RemoteUrlField({worker, onSaved}: {worker: CloudWorkerView; onSaved: () => void}) {
  const [value, setValue] = useState(worker.remoteUrl ?? '');
  const [msg, setMsg] = useState<{ok: boolean; text: string} | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await setRemoteBrowserUrl(worker.id, value);
      setMsg(r.ok ? {ok: true, text: value.trim() ? 'Saved.' : 'Cleared.'} : {ok: false, text: r.error});
      if (r.ok) onSaved();
    });
  return (
    <section aria-label="Remote browser link" className="flex flex-col gap-3 rounded-[var(--radius)] border border-border bg-card p-4 md:p-5">
      <div>
        <h2 className="font-serif text-xl font-normal text-foreground">Remote browser link</h2>
        <p className="mt-1 max-w-[62ch] text-[13px] text-muted-foreground">
          Admins only. Where an admin signs in to Shopee in the worker&apos;s own Chrome, behind Cloudflare Access with Google sign-in. Non-admins never see it. Coop never carries the password.
        </p>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) save();
        }}
      >
        <label htmlFor="remote-url" className="sr-only">
          Remote browser address
        </label>
        <input
          id="remote-url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          placeholder="https://browser.example.com"
          className="h-10 min-w-0 flex-1 basis-64 rounded-lg border border-input bg-background px-3 font-mono text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <Button type="submit" disabled={pending || value.trim() === (worker.remoteUrl ?? '')} className="h-9 px-3.5 active:scale-[0.97]">
          Save
        </Button>
        {worker.remoteUrl && <CopyButton text={worker.remoteUrl} label="Copy" />}
      </form>
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} className={cn('text-[13px] font-medium', msg.ok ? 'text-[var(--status-good)]' : 'text-destructive')}>
          {msg.text}
        </p>
      )}
    </section>
  );
}

export function ShopeeSyncMacs({status, at}: {status: ShopeeSyncStatus; at: string}) {
  const router = useRouter();
  const [now, setNow] = useState(() => new Date(at));
  useEffect(() => {
    setNow(new Date());
  }, []);
  const [pending, start] = useTransition();
  const cap = status.canAddMac;
  const [name, setName] = useState('');
  const [adding, setAdding] = useState<'mac' | 'cloud' | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cmdRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const add = () =>
    start(async () => {
      setError(null);
      const variant = adding === 'cloud' ? 'cloud' : 'mac';
      const r = await startEnrolment(name, variant);
      if (!r.ok) return setError(r.error);
      setIssued({command: enrolCommand(r.command, window.location.origin), expiresAt: r.expiresAt, variant});
      setAdding(null);
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

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Sync worker" className="flex flex-col gap-3">
        <h2 className="font-serif text-xl font-normal text-foreground">Sync worker</h2>
        <p className="max-w-[62ch] text-[13px] text-muted-foreground">
          One cloud worker, on demand: it sleeps when idle and wakes for a sync, about 1 to 4 minutes. An admin signs in to Shopee on it when it asks. Admins can revoke it.
        </p>
        {status.cloudWorkers.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-[var(--radius)] border border-border bg-card p-4 md:p-5">
            <p className="text-sm font-medium text-foreground">No cloud worker yet</p>
            <p className="max-w-[55ch] text-sm text-muted-foreground">{status.isAdmin ? 'Add it here once the server is ready. It is enrolled by an admin and serves everyone who presses Sync.' : 'An admin adds it. Until then, Sync works only on a Mac you add below.'}</p>
            {status.isAdmin && (
              <Button
                type="button"
                disabled={!cap.ok}
                onClick={() => {
                  setName('Cloud worker');
                  setAdding('cloud');
                }}
                className="h-9 px-3.5 active:scale-[0.97]"
              >
                <Cloud className="size-4" aria-hidden /> Add the cloud worker
              </Button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-[var(--radius)] border border-border bg-card">
            {status.cloudWorkers.map((w) => {
              const p = CLOUD_PILL[w.state];
              return (
                <li key={w.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between md:p-5">
                  <div className="flex min-w-0 items-start gap-3">
                    <Cloud className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{w.name}</span>
                        <span className={cn('rounded-full px-2 py-0.5 text-[11.5px] font-semibold', TONE[p.tone])}>{p.label}</span>
                      </div>
                      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px] text-muted-foreground">
                        <dt>Owner</dt>
                        <dd className="truncate">{w.ownerEmail}</dd>
                        <dt>Last seen</dt>
                        <dd>{agoText(w.lastSeen, now)}</dd>
                        <dt>Last login check</dt>
                        <dd>{w.loginState ? `${LOGIN_TEXT[w.loginState]}, ${agoText(w.loginCheckedAt, now)}` : 'not checked yet'}</dd>
                      </dl>
                    </div>
                  </div>
                  {status.isAdmin &&
                    (confirmId === w.id ? (
                      <div className="flex shrink-0 flex-wrap items-center gap-2" role="group" aria-label={`Revoke ${w.name}?`}>
                        <span className="text-[13px] text-muted-foreground">Revoke it? It stops at once.</span>
                        <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => remove(w.id)} className="h-8 px-3">
                          Revoke
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setConfirmId(null)} className="h-8 px-3">
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <Button type="button" variant="outline" size="sm" onClick={() => setConfirmId(w.id)} aria-label={`Revoke ${w.name}`} className="h-8 shrink-0 self-start px-3 sm:self-center">
                        <Trash2 className="size-3.5" aria-hidden /> Revoke
                      </Button>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {status.isAdmin && status.cloudWorkers[0] && <RemoteUrlField key={status.cloudWorkers[0].remoteUrl ?? ''} worker={status.cloudWorkers[0]} onSaved={() => router.refresh()} />}

      <div className="mt-2 flex flex-col gap-1 border-t border-border pt-6">
        <h2 className="font-serif text-xl font-normal text-foreground">My sync Macs</h2>
        <p className="max-w-[62ch] text-[13px] text-muted-foreground">A secondary path. A Mac you add runs only syncs you press, and you type the Shopee password on that Mac.</p>
      </div>
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
                variant="outline"
                disabled={!cap.ok}
                onClick={() => {
                  setAdding('mac');
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
                {adding === 'cloud' ? 'Name the cloud worker' : 'What do you call this Mac?'}
              </label>
              <input
                id="mac-name"
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder={adding === 'cloud' ? 'Cloud worker' : "Dave's MacBook"}
                autoComplete="off"
                className="h-10 w-full max-w-sm rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!name.trim() || pending} className="h-9 px-3.5 active:scale-[0.97]">
                  Make the command
                </Button>
                <Button type="button" variant="ghost" onClick={() => setAdding(null)} className="h-9 px-3.5">
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </section>
      )}

      {issued && (
        <section aria-label={issued.variant === 'cloud' ? 'Run this on the server' : 'Run this on your Mac'} className="flex flex-col gap-4 rounded-[var(--radius)] border border-primary/40 bg-card p-4 md:p-5">
          <div>
            <h2 className="font-serif text-xl font-normal text-foreground">{issued.variant === 'cloud' ? 'Run this on the server' : 'Run this on your Mac'}</h2>
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
          {issued.variant === 'cloud' ? (
            <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-foreground marker:text-muted-foreground">
              <li>Replace the image tag placeholder with the worker image tag, then run the command on the cloud server.</li>
              <li>Set the remote browser address below once the protected link exists. An admin signs in to Shopee there; Coop never sees the password.</li>
              <li>The worker reports its first Shopee login check and shows here.</li>
            </ol>
          ) : (
            <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-foreground marker:text-muted-foreground">
              <li>Run the command in Terminal on that Mac.</li>
              <li>
                Open <span className="font-mono text-[13px]">http://localhost:6080</span>, sign in to Seller Centre and verify the password there. Coop never sees it.
              </li>
              <li>The Mac turns Online in the list above.</li>
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
