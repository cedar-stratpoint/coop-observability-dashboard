'use client';

// The Flags hub's frame (P0, Nov 26): one title, two views. All flags opens first (every
// check, reader and reviewer flag, Needs you on top); BA scorecard is today's tiles. Two
// tabs only (Hick's law). Switching is a navigation, so it is instant: no motion on a control
// used many times a day. Plan: knowledge/tasks/2026-11-26-nichido-flags-hub.md.

import type {ReactNode} from 'react';
import {useState, useTransition} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {RefreshCw} from 'lucide-react';
import {runChecksAction} from '@/app/flags/actions';
import {Button} from '@/components/ui/button';
import {GL_PAGE} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';

export type HubTab = 'all' | 'ba';

const TABS: Array<{v: HubTab; label: string; href: string}> = [
  {v: 'all', label: 'All flags', href: '/flags'},
  {v: 'ba', label: 'BA scorecard', href: '/flags?view=ba'},
];

const INTRO: Record<HubTab, string> = {
  all: 'Everything Coop’s checks, the reader and reviewers raised across your stores, with what needs you first. Only Coop’s checks count against a BA.',
  ba: 'Every flag Coop raises counts against the BA on the form. One tile per store and BA; open it to see the form with each flagged cell boxed.',
};

export function FlagsHubShell({view, company, canEdit, children}: {view: HubTab; company: string; canEdit: boolean; children: ReactNode}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ok: boolean; text: string} | null>(null);
  const runChecks = () =>
    start(async () => {
      setNotice(null);
      const res = await runChecksAction({company});
      setNotice(res.ok ? {ok: true, text: res.note ?? 'Checks ran.'} : {ok: false, text: res.error});
      if (res.ok) router.refresh();
    });

  return (
    <div className={cn(GL_PAGE, 'gap-0')}>
      <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex max-w-2xl flex-col gap-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Flags</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{INTRO[view]}</p>
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" disabled={pending} onClick={runChecks}>
            <RefreshCw aria-hidden className={cn('size-3.5', pending && 'animate-spin motion-reduce:animate-none')} /> Run checks
          </Button>
        )}
      </header>
      {notice && (
        <p role="status" className={cn('mt-3 text-sm', notice.ok ? 'text-muted-foreground' : 'text-destructive')}>
          {notice.text}
        </p>
      )}
      <nav aria-label="Flags views" className="mt-8 flex gap-8 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.v}
            href={t.href}
            aria-current={view === t.v ? 'page' : undefined}
            className={cn(
              'relative -mb-px inline-flex h-10 items-center text-sm font-medium outline-none transition-colors duration-150',
              'focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/40',
              view === t.v ? 'text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground' : 'text-muted-foreground pointer-fine:hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="pt-8">{children}</div>
    </div>
  );
}
