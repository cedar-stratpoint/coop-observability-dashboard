'use client';

import {useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {ArrowUpRight, CircleAlert, Search, Store, UserRound, UsersRound} from 'lucide-react';
import type {BaDirectory, BaScorecard, BaScoreRow, BaStoreRow} from '@/src/goldline-ba-data';
import {FLAG_CAUSES, type BaTag} from '@/src/goldline-checks';
import {CAUSE, TAG, tint, toneVar} from '@/components/analyst/goldline-flags';
import {NativeSelect} from '@/components/ui/native-select';
import {assignBaAction, type BaActionResult} from '@/app/bas/actions';
import {Button} from '@/components/ui/button';
import {Pagination} from '@/components/analyst/pagination';
import {GL_PAGE, GL_SCROLL_ROW_MOBILE, titleName} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';

// BAs: the scorecard (F8) and the BA list (A1). The scorecard is each BA's month across
// every store they covered: points, tag (Clear · At risk · Delinquent), category and an
// auto remark, with each store linking to its tile on Flags.
// The BA list: which BA covers which store from when, learned from the names written
// on uploaded forms (Oct 27: no list is typed in). A form with no name counts against
// the store's BA, and "Liza M." resolves to "Liza Mendoza". Admins can correct a
// store's BA here. Stores whose saved forms have no BA come first. Full names only.
// Oct 28 look: same language as SKU linking (underline tabs, one quiet list with column
// headers, generous padding), a stat strip by the title, a soft banner with one action,
// initials avatars for BAs and monograms for stores.

const PAGE_SIZE = 20;
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtMonth = (ym: string) => `${FULL_MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
type Tab = 'scorecard' | 'list';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const field =
  'h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';
const LIST_COLS = 'md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_9rem_7rem]';
const TAB_HELP: Record<Tab, string> = {
  scorecard: 'Each BA’s month: flags count as points, and the points set the tag.',
  list: 'Coop learns each BA from the name written on the forms. Change a store’s BA here only to correct it.',
};

/** Two letters for an avatar: first and last word ("Liza Mendoza" → LM, "Cubao" → CU). */
const initials = (name: string) => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[w.length - 1][0]).toUpperCase();
};

export function GoldlineBas({company, data, scorecard, canEdit}: {company: string; data: BaDirectory; scorecard: BaScorecard; canEdit: boolean}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{kind: 'ok' | 'err'; text: string} | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [onlyMissing, setOnlyMissing] = useState(false);

  function act(fn: () => Promise<BaActionResult>, after?: () => void) {
    setNotice(null);
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setNotice({kind: 'ok', text: res.note});
        after?.();
        router.refresh();
      } else setNotice({kind: 'err', text: res.error});
    });
  }

  const needsBa = (s: BaStoreRow) => !s.ba && s.formsNoBa > 0;
  const missing = data.stores.filter(needsBa).length;
  const needle = q.trim().toLowerCase();
  const list = data.stores.filter((s) => (!onlyMissing || needsBa(s)) && (!needle || `${s.code} ${s.name} ${s.ba ?? ''}`.toLowerCase().includes(needle)));
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const rows = list.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  // Open on the list while forms are landing with no BA and nothing is scored yet.
  const [tab, setTab] = useState<Tab>(scorecard.scores.length || !missing ? 'scorecard' : 'list');
  const showMissing = () => {
    setTab('list');
    setOnlyMissing(true);
    setQ('');
    setPage(1);
  };

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex max-w-2xl flex-col gap-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">BAs</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">Each BA’s month at a glance, and who covers each store. Every flag counts against the BA on the form; a form with no name uses the store’s BA.</p>
        </div>
        <dl className="flex gap-8">
          <Stat label="Stores" value={data.stores.length} />
          <Stat label="BAs known" value={data.bas.length} />
          <Stat label="Need a BA" value={missing} tone={missing ? 'warn' : undefined} />
        </dl>
      </header>

      {missing > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border px-5 py-4 sm:flex-row sm:items-center sm:justify-between" style={{borderColor: tint('warn', 35), background: tint('warn', 7)}}>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full" style={{background: tint('warn', 16), color: toneVar('warn')}}>
              <CircleAlert aria-hidden className="size-4" />
            </span>
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium">
                {missing} {missing === 1 ? 'store needs' : 'stores need'} a BA
              </p>
              <p className="text-sm text-muted-foreground">Their saved forms have no BA name, so their flags count against nobody until a BA is set.</p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={showMissing} className="shrink-0 self-start sm:self-auto">
            Show {missing === 1 ? 'it' : 'them'}
          </Button>
        </div>
      )}

      {notice && (
        <p role="status" className={cn('-my-2 text-sm', notice.kind === 'ok' ? 'text-muted-foreground' : 'text-destructive')}>
          {notice.text}
        </p>
      )}

      <div className="flex flex-col gap-4">
        <div className={cn('border-b', GL_SCROLL_ROW_MOBILE)}>
          <div role="tablist" aria-label="Show" className="-mb-px flex gap-1">
            {(
              [
                ['scorecard', 'Scorecard', scorecard.scores.length],
                ['list', 'BA list', data.stores.length],
              ] as Array<[Tab, string, number]>
            ).map(([v, label, c]) => {
              const on = tab === v;
              return (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setTab(v)}
                  className={cn(
                    'inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150',
                    on ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                  <span className={cn('rounded-full px-1.5 text-xs tabular-nums', on ? 'bg-foreground/10' : 'bg-muted')}>{c}</span>
                </button>
              );
            })}
          </div>
        </div>
        <p className="pt-1 text-sm leading-relaxed text-muted-foreground">{TAB_HELP[tab]}</p>
      </div>

      {tab === 'scorecard' ? (
        <Scorecard data={scorecard} onList={showMissing} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 max-md:w-full">
              <div className="relative max-md:w-full">
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  aria-label="Search stores or BAs"
                  placeholder="Search store or BA…"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setPage(1);
                  }}
                  className={cn(field, 'pl-8 md:w-72')}
                />
              </div>
              {missing > 0 && (
                <div role="group" aria-label="Filter" className="flex rounded-md bg-muted/60 p-0.5 text-xs">
                  {(
                    [
                      [false, 'All'],
                      [true, 'Needs a BA'],
                    ] as Array<[boolean, string]>
                  ).map(([v, label]) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={onlyMissing === v}
                      onClick={() => {
                        setOnlyMissing(v);
                        setPage(1);
                      }}
                      className={cn(
                        'h-7 rounded px-3 transition-colors duration-150',
                        onlyMissing === v ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              {list.length} {list.length === 1 ? 'store' : 'stores'}
              {missing > 0 && !onlyMissing ? ', the ones needing a BA first' : ''}
            </p>
          </div>

          {rows.length === 0 ? (
            <Empty
              Icon={Store}
              title={data.stores.length ? 'No stores match' : 'No stores yet'}
              text={data.stores.length ? 'Try another name or code.' : 'Stores and their BAs appear here as forms are uploaded.'}
            />
          ) : (
            <div className="overflow-hidden rounded-xl border">
              <div className={cn('hidden gap-8 border-b px-6 py-3 text-xs font-medium text-muted-foreground md:grid', LIST_COLS)}>
                <span>Store</span>
                <span>BA</span>
                <span>Last form</span>
                <span className="sr-only">Action</span>
              </div>
              <ul className="divide-y">
                {rows.map((s) => (
                  <StoreLine key={s.code} s={s} company={company} canEdit={canEdit} pending={pending} act={act} />
                ))}
              </ul>
            </div>
          )}
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="Store pages" />
        </>
      )}

      <datalist id="ba-directory-names">
        {data.bas.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </div>
  );
}

function Stat({label, value, tone}: {label: string; value: number; tone?: 'warn'}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-heading text-2xl font-semibold tabular-nums" style={tone ? {color: toneVar(tone)} : undefined}>
        {value}
      </dd>
    </div>
  );
}

function Empty({Icon, title, text}: {Icon: typeof Store; title: string; text: string}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon aria-hidden className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}

function Avatar({name, round = true, muted = false}: {name: string; round?: boolean; muted?: boolean}) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-9 shrink-0 place-items-center text-xs font-semibold tracking-wide',
        round ? 'rounded-full' : 'rounded-lg',
        muted ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary',
      )}
    >
      {initials(name)}
    </span>
  );
}

type Act = (fn: () => Promise<BaActionResult>, after?: () => void) => void;

function StoreLine({s, company, canEdit, pending, act}: {s: BaStoreRow; company: string; canEdit: boolean; pending: boolean; act: Act}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.ba ?? '');
  const [from, setFrom] = useState(s.since ?? monthStart());
  const noBa = !s.ba && s.formsNoBa > 0;
  const storeName = titleName(s.name);
  return (
    <li>
      <div className={cn('grid gap-x-8 gap-y-3 px-6 py-4 transition-colors duration-150 hover:bg-muted/30 md:items-center', LIST_COLS, editing && 'bg-muted/30')}>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={storeName} round={false} muted />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="truncate text-sm font-medium" title={s.name}>
              {storeName}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">Store {s.code}</p>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-3">
          {s.ba ? (
            <>
              <Avatar name={s.ba} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="truncate text-sm">{s.ba}</p>
                {s.since && <p className="text-xs text-muted-foreground">since {fmtDay(s.since)}</p>}
              </div>
            </>
          ) : (
            <div className="flex min-w-0 flex-col items-start gap-1">
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
                style={noBa ? {color: toneVar('warn'), background: tint('warn', 14)} : undefined}
              >
                <span className="size-1.5 rounded-full" style={{background: noBa ? toneVar('warn') : 'var(--muted-foreground)'}} aria-hidden />
                <span className={noBa ? '' : 'text-muted-foreground'}>No BA yet</span>
              </span>
              {s.formsNoBa > 0 && (
                <p className="text-xs text-muted-foreground">
                  {s.formsNoBa} {s.formsNoBa === 1 ? 'form' : 'forms'} with no BA name
                </p>
              )}
            </div>
          )}
        </div>

        <p className="text-sm tabular-nums">
          <span className="text-xs text-muted-foreground md:hidden">Last form </span>
          {s.lastForm ? fmtDay(s.lastForm) : <span className="text-muted-foreground">No form yet</span>}
        </p>

        <div className="md:text-right">
          {canEdit && !editing && (
            <Button size="sm" variant={noBa ? 'default' : 'outline'} onClick={() => setEditing(true)}>
              {s.ba ? 'Change' : 'Set BA'}
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="flex flex-col gap-4 bg-muted/30 px-6 pt-1 pb-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,22rem)_11rem]">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              BA’s full name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                list="ba-directory-names"
                maxLength={80}
                placeholder="e.g. Liza Mendoza"
                autoComplete="off"
                autoFocus
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Covers the store from
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
            </label>
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Forms from this date with no BA name are saved under this BA, and their flags count against them. Names written on a form stay as written.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending || name.trim().length < 2 || !from} onClick={() => act(() => assignBaAction({company, store: s.code, name, from}), () => setEditing(false))}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** "Padding 2 times, incorrect total 1 time": the auto remark, most first. */
function remarkOf(r: BaScoreRow): string {
  return FLAG_CAUSES.filter((c) => r.byCause[c] > 0)
    .sort((a, b) => r.byCause[b] - r.byCause[a])
    .map((c, i) => `${i === 0 ? CAUSE[c].label : CAUSE[c].label.toLowerCase()} ${plural(r.byCause[c], 'time')}`)
    .join(', ');
}

const TAG_RULE: Record<BaTag, string> = {
  delinquent: '3 or more flags, or any padding',
  at_risk: '1 to 2 flags',
  clear: 'No flags this month',
};
const SCORE_COLS = 'lg:grid-cols-[minmax(0,1fr)_8rem_4rem_minmax(0,1.2fr)_6rem_minmax(0,1fr)]';

function Scorecard({data, onList}: {data: BaScorecard; onList: () => void}) {
  const [month, setMonth] = useState(data.months[0] ?? '');
  const [tag, setTag] = useState<BaTag | 'all'>('all');
  const inMonth = data.scores.filter((r) => r.month === month);
  const counts = {delinquent: 0, at_risk: 0, clear: 0} as Record<BaTag, number>;
  for (const r of inMonth) counts[r.tag]++;
  const rows = inMonth.filter((r) => tag === 'all' || r.tag === tag);
  const noBa = data.noBa[month] ?? 0;
  // Points per BA for the six months up to the one in view, oldest first.
  const window = data.months.filter((m) => m <= month).slice(0, 6).reverse();
  const pointsOf = new Map(data.scores.map((r) => [`${r.ba}|${r.month}`, r]));
  const max = Math.max(1, ...data.scores.map((r) => r.points));

  if (!data.months.length) {
    return <Empty Icon={UsersRound} title="No scores yet" text="Each BA gets a monthly score once their store’s form is saved. The BA list shows who covers each store." />;
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <NativeSelect aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
          {data.months.map((m) => (
            <option key={m} value={m}>
              {fmtMonth(m)}
            </option>
          ))}
        </NativeSelect>
        {tag !== 'all' && (
          <button type="button" onClick={() => setTag('all')} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Show every tag
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {(['delinquent', 'at_risk', 'clear'] as BaTag[]).map((t) => {
          const {label, tone, Icon} = TAG[t];
          const on = tag === t;
          return (
            <button
              key={t}
              type="button"
              aria-pressed={on}
              onClick={() => setTag(on ? 'all' : t)}
              className={cn(
                'flex items-center gap-4 rounded-xl border bg-card px-5 py-4 text-left transition-[border-color,box-shadow,transform] duration-150 ease-out active:scale-[0.99]',
                on ? 'ring-1' : 'hover:border-foreground/25',
              )}
              style={on ? {borderColor: toneVar(tone), boxShadow: `0 0 0 1px ${toneVar(tone)}`} : undefined}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-full" style={{background: tint(tone, 16), color: toneVar(tone)}}>
                <Icon aria-hidden className="size-5" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="flex items-baseline gap-2">
                  <span className="font-heading text-2xl font-semibold tabular-nums">{counts[t]}</span>
                  <span className="text-sm font-medium">{label}</span>
                </span>
                <span className="truncate text-xs text-muted-foreground">{TAG_RULE[t]}</span>
              </span>
            </button>
          );
        })}
      </div>

      {noBa > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border px-5 py-3.5 text-sm sm:flex-row sm:items-center sm:justify-between" style={{borderColor: tint('warn', 35), background: tint('warn', 7)}}>
          <p className="flex items-start gap-2">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" style={{color: toneVar('warn')}} />
            <span>
              {plural(noBa, 'flag')} in {fmtMonth(month)} {noBa === 1 ? 'is' : 'are'} on forms with no BA name, so {noBa === 1 ? 'it counts' : 'they count'} against nobody yet.
            </span>
          </p>
          <Button size="sm" variant="outline" onClick={onList} className="shrink-0 self-start sm:self-auto">
            Set BAs
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <Empty
          Icon={UserRound}
          title={inMonth.length ? 'No BAs with this tag' : 'No BA named yet'}
          text={inMonth.length ? 'Pick another tag, or show every tag.' : `No BA is named on ${fmtMonth(month)}’s forms yet. BAs are read from the forms as they’re uploaded.`}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <div className={cn('hidden gap-6 border-b px-6 py-3 text-xs font-medium text-muted-foreground lg:grid', SCORE_COLS)}>
            <span>BA</span>
            <span>Tag</span>
            <span className="text-right">Points</span>
            <span>Remarks</span>
            <span>{window.length > 1 ? `Last ${window.length} months` : 'This month'}</span>
            <span>Stores</span>
          </div>
          <ul className="divide-y">
            {rows.map((r) => {
              const t = TAG[r.tag];
              return (
                <li key={`${r.ba}|${r.month}`} className={cn('grid gap-x-6 gap-y-3 px-6 py-4 transition-colors duration-150 hover:bg-muted/30 lg:items-center', SCORE_COLS)}>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={r.ba} />
                    <p className="truncate text-sm font-medium">{r.ba}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap" style={{color: toneVar(t.tone), background: tint(t.tone, 14)}}>
                      <t.Icon aria-hidden className="size-3.5" />
                      {t.label}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums lg:hidden">{plural(r.points, 'point')}</span>
                  </div>
                  <p className="text-right text-sm tabular-nums max-lg:hidden">{r.points}</p>
                  <div className="min-w-0 text-xs leading-relaxed">
                    {r.points ? (
                      <>
                        {r.category && r.points > 1 && <span className="block font-medium">Mostly {CAUSE[r.category].label.toLowerCase()}</span>}
                        <span className="text-muted-foreground">{remarkOf(r)}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">No flags</span>
                    )}
                  </div>
                  <span className="flex h-7 items-end gap-1 max-lg:hidden" role="img" aria-label={window.map((m) => `${fmtMonth(m)}: ${pointsOf.get(`${r.ba}|${m}`)?.points ?? 'no form'}`).join(', ')}>
                    {window.map((m) => {
                      const s = pointsOf.get(`${r.ba}|${m}`);
                      return (
                        <i
                          key={m}
                          className="block w-2.5 rounded-sm"
                          style={{
                            height: s ? `${Math.max(14, (s.points / max) * 100)}%` : '14%',
                            background: s ? toneVar(TAG[s.tag].tone) : 'var(--border)',
                            opacity: m === month ? 1 : 0.5,
                          }}
                        />
                      );
                    })}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {r.stores.map((code, i) => (
                      <Link
                        key={code}
                        href={`/flags?open=${encodeURIComponent(`${code}|${r.month}|${r.ba}`)}`}
                        className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:border-foreground/30 hover:bg-muted/40"
                      >
                        {titleName(r.storeNames[i])}
                        <ArrowUpRight aria-hidden className="size-3 text-muted-foreground" />
                      </Link>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
