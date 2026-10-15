import {redirect} from 'next/navigation';
import {ArrowUpRight, CheckCircle2, CircleAlert, CircleHelp, Database, GitBranch} from 'lucide-react';
import {getCoopAdminHolder} from '@/src/active-context';
import {currentEnv} from '@/src/coop-env-server';
import {COOP_ENVS, type CoopEnv} from '@/src/coop-env';
import {Card, CardContent} from '@/components/ui/card';

export const dynamic = 'force-dynamic';

// Manage environments — read-only, for anyone holding a Coop Admin role (any view).
// Each environment is its own deployment with its own database and sign-in; this page
// shows where each one lives and whether it's healthy, from its public /api/health.
// Settings are changed in Vercel, not here.

type Health =
  | {state: 'up' | 'db_down'; commit: string | null; branch: string | null; db: string | null; checkedAt: string}
  | {state: 'no_probe' | 'protected' | 'unexpected' | 'unreachable'};

async function probe(e: CoopEnv): Promise<Health> {
  try {
    const res = await fetch(`${e.url}/api/health`, {cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(4000)});
    if (res.status === 404) return {state: 'no_probe'}; // site is up, but running a version without the probe
    if (res.status === 401 || res.status === 403) return {state: 'protected'}; // e.g. Vercel Deployment Protection
    if (!res.ok) return {state: res.status >= 300 && res.status < 400 ? 'unexpected' : 'unreachable'};
    const j = (await res.json().catch(() => null)) as {dbOk?: boolean; commit?: string | null; branch?: string | null; db?: string | null; checkedAt?: string} | null;
    if (!j) return {state: 'unexpected'};
    return {state: j.dbOk ? 'up' : 'db_down', commit: j.commit ?? null, branch: j.branch ?? null, db: j.db ?? null, checkedAt: j.checkedAt ?? new Date().toISOString()};
  } catch {
    return {state: 'unreachable'};
  }
}

const STATUS = {
  up: {label: 'Up · database connected', tone: 'var(--status-good)', Icon: CheckCircle2},
  db_down: {label: 'Up · database not answering', tone: 'var(--status-crit)', Icon: CircleAlert},
  no_probe: {label: 'Up · running an older version (no health check yet)', tone: 'var(--status-warn)', Icon: CircleHelp},
  protected: {label: 'Up · behind Vercel protection (health check blocked)', tone: 'var(--status-warn)', Icon: CircleHelp},
  unexpected: {label: 'Unexpected response from the health check', tone: 'var(--status-warn)', Icon: CircleHelp},
  unreachable: {label: 'Not reachable', tone: 'var(--status-crit)', Icon: CircleAlert},
} as const;

export default async function Page() {
  const holder = await getCoopAdminHolder();
  if (!holder) redirect('/');
  const [here, healths] = await Promise.all([currentEnv(), Promise.all(COOP_ENVS.map(probe))]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <span className="font-mono text-xs tracking-widest uppercase" style={{color: here.tone}}>
          {here.label} · Coop
        </span>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Environments</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each environment is its own site with its own database and sign-in. Switching opens the same page on the other site, and no environment
          ever holds another&apos;s keys. Settings live in each site&apos;s Vercel project.
        </p>
        <div className="h-0.5 w-24 rounded-full bg-gradient-to-r from-primary to-transparent" aria-hidden />
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {COOP_ENVS.map((e, i) => {
          const h = healths[i];
          const s = STATUS[h.state];
          const active = e.key === here.key;
          return (
            <Card key={e.key} className="relative overflow-hidden">
              <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{background: e.tone}} />
              <CardContent className="flex flex-col gap-4 pl-6">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <h2 className="font-heading text-lg font-semibold">{e.label}</h2>
                    <a href={e.url} className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                      {e.host} <ArrowUpRight aria-hidden className="size-3" />
                    </a>
                  </div>
                  {active && (
                    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium" style={{color: 'var(--status-good)', background: 'color-mix(in oklab, var(--status-good) 12%, transparent)'}}>
                      <span className="size-1.5 rounded-full bg-current" /> You&apos;re here
                    </span>
                  )}
                </div>

                <p className="flex items-center gap-2 text-sm" style={{color: `color-mix(in oklab, ${s.tone} 80%, var(--foreground))`}}>
                  <s.Icon aria-hidden className="size-4 shrink-0" /> {s.label}
                </p>

                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                  <dt className="flex items-center gap-1.5 text-muted-foreground">
                    <Database aria-hidden className="size-3.5" /> Database
                  </dt>
                  <dd className="min-w-0">
                    {e.dbLabel}
                    {'db' in h && h.db && <span className="block font-mono text-xs text-muted-foreground">ref {h.db}</span>}
                  </dd>
                  <dt className="flex items-center gap-1.5 text-muted-foreground">
                    <GitBranch aria-hidden className="size-3.5" /> Deployed
                  </dt>
                  <dd className="font-mono text-xs">
                    {'commit' in h && (h.commit || h.branch) ? [h.branch, h.commit].filter(Boolean).join(' · ') : <span className="font-sans text-sm text-muted-foreground">—</span>}
                  </dd>
                </dl>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardContent className="flex flex-col gap-2 text-sm">
          <h2 className="font-heading text-base font-semibold">Who sees the switcher</h2>
          <p className="text-muted-foreground">
            Anyone holding a Coop Admin role, in whatever view they&apos;re using. On the other site you sign in again, and that site checks your
            roles in its own database, so you need the Coop Admin role there too. Risky access changes in Production (suspending or removing
            access) ask you to type <span className="font-mono text-foreground">PRODUCTION</span> first, and every access change records which
            environment it happened in.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
