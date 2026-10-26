'use client';

import {useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {CircleAlert} from 'lucide-react';
import type {BaDirectory, BaScorecard, BaScoreRow, BaStoreRow} from '@/src/goldline-ba-data';
import {FLAG_CAUSES, type BaTag} from '@/src/goldline-checks';
import {CAUSE, TAG, tint, toneVar} from '@/components/analyst/goldline-flags';
import {NativeSelect} from '@/components/ui/native-select';
import {assignBaAction, importBasAction, type BaActionResult} from '@/app/bas/actions';
import {Card, CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Pagination} from '@/components/analyst/pagination';
import {GL_SCROLL_ROW_MOBILE, GL_TILES_MOBILE} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';

// BAs: the scorecard (F8) and the BA list (A1). The scorecard is each BA's month across
// every store they covered: points, tag (Clear · At risk · Delinquent), category and an
// auto remark, with each store linking to its tile on Flags.
// The BA list: which BA covers which store from when. The inventory form has a
// "Beauty Consultant" line, but it's often blank; with the list, a form with no name
// still counts against the store's BA, and "Liza M." resolves to "Liza Mendoza".
// Stores whose saved forms have no BA come first. Full names only (Oct 26).

const PAGE_SIZE = 20;
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtMonth = (ym: string) => `${FULL_MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
type Tab = 'scorecard' | 'list';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const field =
  'h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

export function GoldlineBas({company, data, scorecard, canEdit}: {company: string; data: BaDirectory; scorecard: BaScorecard; canEdit: boolean}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{kind: 'ok' | 'err'; text: string} | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

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

  const needle = q.trim().toLowerCase();
  const list = data.stores.filter((s) => !needle || `${s.code} ${s.name} ${s.ba ?? ''}`.toLowerCase().includes(needle));
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const rows = list.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const missing = data.stores.filter((s) => !s.ba && s.formsNoBa > 0).length;
  // Open on the list while forms are landing with no BA and nothing is scored yet.
  const [tab, setTab] = useState<Tab>(scorecard.scores.length || !missing ? 'scorecard' : 'list');

  return (
    <div className={cn('mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6', GL_TILES_MOBILE)}>
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">BAs</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each BA’s month at a glance, and which BA covers each store. Every flag counts against the BA on the form; a blank form uses the store’s BA from the list.
        </p>
      </header>

      {missing > 0 && (
        <p className="flex items-start gap-2 text-sm" style={{color: 'var(--status-warn)'}}>
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {missing} {missing === 1 ? 'store has' : 'stores have'} saved forms with no BA name and no BA on the list. Their flags count against nobody until a BA is set.
          </span>
        </p>
      )}

      {notice && (
        <p role="status" className={cn('text-sm', notice.kind === 'ok' ? 'text-muted-foreground' : 'text-destructive')}>
          {notice.text}
        </p>
      )}

      <div className={GL_SCROLL_ROW_MOBILE}>
        <div role="group" aria-label="Show" className="flex gap-2">
          {(
            [
              ['scorecard', 'Scorecard', scorecard.scores.length],
              ['list', 'BA list', data.stores.length],
            ] as Array<[Tab, string, number]>
          ).map(([v, label, c]) => (
            <button
              key={v}
              type="button"
              aria-pressed={tab === v}
              onClick={() => setTab(v)}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]',
                tab === v ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:border-foreground/30',
              )}
            >
              {label} <span className="tabular-nums opacity-80">{c}</span>
            </button>
          ))}
        </div>
      </div>

      {tab === 'scorecard' ? (
        <Scorecard data={scorecard} onList={() => setTab('list')} />
      ) : (
      <>
      {canEdit && <PasteList company={company} pending={pending} act={act} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium">
          Stores <span className="font-normal text-muted-foreground tabular-nums">{data.stores.length}</span>
        </p>
        <input
          type="search"
          aria-label="Search stores or BAs"
          placeholder="Search store or BA"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className={cn(field, 'w-full sm:w-64')}
        />
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">
            {data.stores.length ? 'No stores match.' : 'No store has sent a form or has a BA yet. Paste the BA list above to start.'}
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((s) => (
            <li key={s.code}>
              <StoreLine s={s} company={company} canEdit={canEdit} pending={pending} act={act} />
            </li>
          ))}
        </ul>
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

type Act = (fn: () => Promise<BaActionResult>, after?: () => void) => void;

function PasteList({company, pending, act}: {company: string; pending: boolean; act: Act}) {
  const [text, setText] = useState('');
  const [from, setFrom] = useState(monthStart());
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Paste the BA list</p>
          <p className="text-xs text-muted-foreground">One store per line: store code, then the BA’s full name (comma or tab between, as copied from a spreadsheet).</p>
        </div>
        <textarea
          aria-label="BA list"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={'1, Liza Mendoza\n2, Ana Perez'}
          className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Covering from <input type="date" aria-label="Covering from" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
          </label>
          <Button size="sm" disabled={pending || !text.trim() || !from} onClick={() => act(() => importBasAction({company, text, from}), () => setText(''))}>
            Save list
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StoreLine({s, company, canEdit, pending, act}: {s: BaStoreRow; company: string; canEdit: boolean; pending: boolean; act: Act}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.ba ?? '');
  const [from, setFrom] = useState(s.since ?? monthStart());
  const noBa = !s.ba && s.formsNoBa > 0;
  return (
    <Card className="py-0" style={noBa ? {boxShadow: 'inset 3px 0 0 var(--status-warn)'} : undefined}>
      <CardContent className="flex flex-col gap-2.5 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-sm font-medium">{s.name}</p>
            <p className="text-xs text-muted-foreground">
              Store {s.code}
              {s.lastForm ? ` · last form ${fmtDay(s.lastForm)}` : ' · no form yet'}
              {s.formsNoBa > 0 ? ` · ${s.formsNoBa} ${s.formsNoBa === 1 ? 'form' : 'forms'} with no BA name` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <p className="text-right text-sm">
              {s.ba ? (
                <>
                  <span className="font-medium">{s.ba}</span>
                  {s.since && <span className="block text-xs text-muted-foreground">since {fmtDay(s.since)}</span>}
                </>
              ) : (
                <span style={{color: noBa ? 'var(--status-warn)' : undefined}} className={noBa ? '' : 'text-muted-foreground'}>
                  No BA set
                </span>
              )}
            </p>
            {canEdit && !editing && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                {s.ba ? 'Change' : 'Set BA'}
              </Button>
            )}
          </div>
        </div>
        {editing && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <input
              aria-label="BA full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              list="ba-directory-names"
              maxLength={80}
              placeholder="Full name"
              autoComplete="off"
              className={cn(field, 'min-w-48 flex-1')}
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              from <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
            </label>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={pending || name.trim().length < 2 || !from} onClick={() => act(() => assignBaAction({company, store: s.code, name, from}), () => setEditing(false))}>
              Save
            </Button>
            <p className="w-full text-xs text-muted-foreground">Forms from this date with no BA name are saved under this BA, and their flags count against them. Names written on a form stay as written.</p>
          </div>
        )}
      </CardContent>
    </Card>
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
    return (
      <Card>
        <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">No saved forms yet. Each BA shows here once their store’s form is saved.</CardContent>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <NativeSelect aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
          {data.months.map((m) => (
            <option key={m} value={m}>
              {fmtMonth(m)}
            </option>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">Clear with no flags · At risk with 1 to 2 · Delinquent with 3 or more, or any padding</p>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {(['delinquent', 'at_risk', 'clear'] as BaTag[]).map((t) => {
          const {label, tone, Icon} = TAG[t];
          return (
            <button
              key={t}
              type="button"
              aria-pressed={tag === t}
              onClick={() => setTag(tag === t ? 'all' : t)}
              className={cn(
                'flex items-center justify-between gap-2 rounded-xl border bg-card px-4 py-3 text-left transition-[border-color,transform] duration-150 ease-out active:scale-[0.98] max-sm:flex-col-reverse max-sm:items-start max-sm:gap-0.5 max-sm:px-3 max-sm:py-2.5',
                tag === t ? 'border-foreground/40' : 'border-border hover:border-foreground/25',
              )}
            >
              <span className="inline-flex items-center gap-1.5 text-sm font-medium" style={{color: toneVar(tone)}}>
                <Icon aria-hidden className="size-4" /> {label}
              </span>
              <span className="font-heading text-xl font-semibold tabular-nums">{counts[t]}</span>
            </button>
          );
        })}
      </div>

      {noBa > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" style={{color: 'var(--status-warn)'}}>
          <CircleAlert aria-hidden className="size-4 shrink-0" />
          {plural(noBa, 'flag')} in {fmtMonth(month)} {noBa === 1 ? 'is' : 'are'} on forms with no BA name, so {noBa === 1 ? 'it counts' : 'they count'} against nobody yet.
          <button type="button" onClick={onList} className="font-medium underline underline-offset-4">
            Set BAs on the list
          </button>
        </p>
      )}

      {rows.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">
            {inMonth.length ? 'No BAs match.' : `No BA is named on ${fmtMonth(month)}’s forms yet. Set each store’s BA on the BA list.`}
          </CardContent>
        </Card>
      ) : (
        <>
        {/* Phones: one card per BA. */}
        <ul className="flex flex-col gap-2 sm:hidden">
          {rows.map((r) => {
            const t = TAG[r.tag];
            return (
              <li key={`${r.ba}|${r.month}`}>
                <Card className="py-0" style={{boxShadow: `inset 3px 0 0 ${toneVar(t.tone)}`}}>
                  <CardContent className="flex flex-col gap-1.5 px-3.5 py-3">
                    <p className="flex items-start justify-between gap-3">
                      <span className="font-medium">{r.ba}</span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{color: toneVar(t.tone), background: tint(t.tone, 14)}}>
                        <t.Icon aria-hidden className="size-3.5" />
                        {t.label} · {plural(r.points, 'point')}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">{r.points ? remarkOf(r) : 'No flags'}</p>
                    {r.stores.map((code, i) => (
                      <Link key={code} href={`/flags?open=${encodeURIComponent(`${code}|${r.month}|${r.ba}`)}`} className="text-xs font-medium underline-offset-4 hover:underline">
                        {r.storeNames[i]} · open form
                      </Link>
                    ))}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
        <Card className="py-0 max-sm:hidden">
          <CardContent className="px-0 py-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">BA</th>
                    <th className="px-2 py-2.5 font-medium">Tag</th>
                    <th className="px-2 py-2.5 text-right font-medium">Points</th>
                    <th className="px-3 py-2.5 font-medium">Remarks</th>
                    <th className="px-2 py-2.5 font-medium">{window.length > 1 ? `Last ${window.length} months` : 'This month'}</th>
                    <th className="px-4 py-2.5 font-medium">Stores</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const t = TAG[r.tag];
                    return (
                      <tr key={`${r.ba}|${r.month}`} className="border-b border-border/60 align-top last:border-0">
                        <td className="px-4 py-3 font-medium">{r.ba}</td>
                        <td className="px-2 py-3">
                          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap" style={{color: toneVar(t.tone), background: tint(t.tone, 14)}}>
                            <t.Icon aria-hidden className="size-3.5" />
                            {t.label}
                          </span>
                        </td>
                        <td className="px-2 py-3 text-right font-mono tabular-nums">{r.points}</td>
                        <td className="px-3 py-3 text-xs">
                          {r.points ? (
                            <>
                              {r.category && r.points > 1 && <span className="block font-medium">Mostly {CAUSE[r.category].label.toLowerCase()}</span>}
                              <span className="text-muted-foreground">{remarkOf(r)}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">No flags</span>
                          )}
                        </td>
                        <td className="px-2 py-3">
                          <span className="flex h-6 items-end gap-1" role="img" aria-label={window.map((m) => `${fmtMonth(m)}: ${pointsOf.get(`${r.ba}|${m}`)?.points ?? 'no form'}`).join(', ')}>
                            {window.map((m) => {
                              const s = pointsOf.get(`${r.ba}|${m}`);
                              return (
                                <i
                                  key={m}
                                  className="block w-2.5 rounded-sm"
                                  style={{
                                    height: s ? `${Math.max(12, (s.points / max) * 100)}%` : '12%',
                                    background: s ? toneVar(TAG[s.tag].tone) : 'var(--border)',
                                    opacity: m === month ? 1 : 0.55,
                                  }}
                                />
                              );
                            })}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <span className="flex flex-col gap-0.5">
                            {r.stores.map((code, i) => (
                              <Link key={code} href={`/flags?open=${encodeURIComponent(`${code}|${r.month}|${r.ba}`)}`} className="underline-offset-4 hover:underline">
                                {r.storeNames[i]} <span className="text-muted-foreground">· open form</span>
                              </Link>
                            ))}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
        </>
      )}
    </div>
  );
}
