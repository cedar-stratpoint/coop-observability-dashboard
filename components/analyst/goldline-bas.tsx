'use client';

import {useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {CircleAlert} from 'lucide-react';
import type {BaDirectory, BaStoreRow} from '@/src/goldline-ba-data';
import {assignBaAction, importBasAction, type BaActionResult} from '@/app/bas/actions';
import {Card, CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Pagination} from '@/components/analyst/pagination';
import {GL_TILES_MOBILE} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';

// The BA list (A1): which BA covers which store from when. The inventory form has a
// "Beauty Consultant" line, but it's often blank; with the list, a form with no name
// still counts against the store's BA, and "Liza M." resolves to "Liza Mendoza".
// Stores whose saved forms have no BA come first. Full names only (Oct 26).

const PAGE_SIZE = 20;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const field =
  'h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

export function GoldlineBas({company, data, canEdit}: {company: string; data: BaDirectory; canEdit: boolean}) {
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

  return (
    <div className={cn('mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6', GL_TILES_MOBILE)}>
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">BAs</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Which BA covers each store. When a form’s Beauty Consultant line is blank, its flags count against the store’s BA from this list.
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
