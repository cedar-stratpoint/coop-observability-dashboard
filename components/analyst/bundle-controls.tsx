'use client';

import {useEffect, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Boxes, Check, Pencil, Plus, Trash2, X} from 'lucide-react';
import type {PosBundleRow} from '@/src/pos-types';
import type {ActionResult} from '@/src/pos-actions';
import {
  createBundleAction,
  deleteBundleAction,
  renameBundleAction,
  repriceBundleAction,
  setBundleActiveAction,
  setBundleEmojiAction,
  setBundleScopeAction,
} from '@/src/pos-actions';
import {formatPeso, POS_CATEGORIES} from '@/src/pos-format';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {Eyebrow} from './sections';
import {EmojiPicker} from './emoji-picker';
import {ModalShell, useModalExit} from './modal-shell';

/**
 * Coop's view of the POS bundles (pos_bundles). Bundles are created on the POS
 * (the Buy-Any-N builder), so this co-edits rather than creates: emoji, listed,
 * name, price, and delete. Every edit writes to pos_bundles and the POS mirrors
 * it on the next catalog pull, so all devices converge.
 */
export function BundleControls({bundles}: {bundles: PosBundleRow[]}) {
  // Mirror the server data locally so edits can apply optimistically, then
  // reconcile. The page's shared Refresh button (in ProductControls) triggers
  // a plain router.refresh(), which lands here as a new `bundles` prop — this
  // effect re-syncs to it, same pattern as ProductControls.
  const [rows, setRows] = useState(bundles);
  useEffect(() => setRows(bundles), [bundles]);
  const [status, setStatus] = useState<Record<string, {saved?: boolean; error?: string}>>({});
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [dialog, setDialog] = useState<{mode: 'create'} | {mode: 'scope'; bundle: PosBundleRow} | null>(null);

  function flash(id: string) {
    setStatus((s) => ({...s, [id]: {saved: true}}));
    setTimeout(() => setStatus((s) => ({...s, [id]: {}})), 1500);
  }

  function mutate(id: string, patch: Partial<PosBundleRow>, action: () => Promise<ActionResult>) {
    const prev = rows;
    setRows((rs) => rs.map((r) => (r.bundle_id === id ? {...r, ...patch} : r)));
    setStatus((s) => ({...s, [id]: {}}));
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setRows(prev);
        setStatus((s) => ({...s, [id]: {error: res.error}}));
      } else {
        flash(id);
      }
    });
  }

  function remove(id: string, name: string) {
    if (!window.confirm(`Delete bundle “${name}”? This removes it from the POS too.`)) return;
    const prev = rows;
    setRows((rs) => rs.filter((r) => r.bundle_id !== id));
    startTransition(async () => {
      const res = await deleteBundleAction(id);
      if (!res.ok) {
        setRows(prev);
        setStatus((s) => ({...s, [id]: {error: res.error}}));
      }
    });
  }

  const summary = (b: PosBundleRow) =>
    b.bundle_type === 'pick'
      ? `Buy any ${b.pick_count ?? 0} · ${(b.line_categories ?? []).join(', ') || 'any line'}`
      : `${b.items.length} item${b.items.length !== 1 ? 's' : ''}: ${b.items.map((i) => `${i.name}×${i.qty}`).join(', ') || '—'}`;

  return (
    <div className="mx-auto mt-8 max-w-6xl px-6 md:px-10">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Eyebrow icon={Boxes}>Bundles</Eyebrow>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {rows.length} bundle{rows.length !== 1 ? 's' : ''}, shared with the POS. Create one here or on the POS, and edit
            its emoji, name, price, listing, and scope (the lines it covers and how many). Edits sync back to every device.
          </p>
        </div>
        <button type="button" onClick={() => setDialog({mode: 'create'})}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
          <Plus className="size-3.5" /> New bundle
        </button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2.5 text-center font-medium">Emoji</th>
                  <th className="px-4 py-2.5 font-medium">Bundle</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 text-right font-medium">Price</th>
                  <th className="px-4 py-2.5 text-right font-medium">Listed</th>
                  <th className="px-4 py-2.5 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      No bundles yet. Create one in the POS.
                    </td>
                  </tr>
                ) : (
                  rows.map((b) => (
                    <BundleRow
                      key={b.bundle_id}
                      row={b}
                      saved={status[b.bundle_id]?.saved}
                      error={status[b.bundle_id]?.error}
                      summary={summary(b)}
                      onSetEmoji={(emoji) => emoji && mutate(b.bundle_id, {emoji}, () => setBundleEmojiAction(b.bundle_id, emoji))}
                      onRename={(name) => mutate(b.bundle_id, {name}, () => renameBundleAction(b.bundle_id, name))}
                      onReprice={(price) => {
                        const n = Number(price);
                        mutate(b.bundle_id, Number.isFinite(n) && n > 0 ? {price: n} : {}, () => repriceBundleAction(b.bundle_id, price));
                      }}
                      onToggle={(active) => mutate(b.bundle_id, {active}, () => setBundleActiveAction(b.bundle_id, active))}
                      onDelete={() => remove(b.bundle_id, b.name)}
                      onEditScope={b.bundle_type === 'pick' ? () => setDialog({mode: 'scope', bundle: b}) : undefined}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      {isPending && <span className="sr-only">Saving…</span>}

      {dialog && (
        <BundleDialog dialog={dialog} onClose={() => setDialog(null)} onDone={() => {setDialog(null); router.refresh();}} />
      )}
    </div>
  );
}

type EditField = 'name' | 'price' | null;

function BundleRow({
  row,
  saved,
  error,
  summary,
  onSetEmoji,
  onRename,
  onReprice,
  onToggle,
  onDelete,
  onEditScope,
}: {
  row: PosBundleRow;
  saved?: boolean;
  error?: string;
  summary: string;
  onSetEmoji: (emoji: string) => void;
  onRename: (name: string) => void;
  onReprice: (price: string) => void;
  onToggle: (active: boolean) => void;
  onDelete: () => void;
  onEditScope?: () => void;
}) {
  const [editing, setEditing] = useState<EditField>(null);
  const [draft, setDraft] = useState('');

  function begin(field: EditField, current: string) {
    setEditing(field);
    setDraft(current);
  }
  function save() {
    const v = draft.trim();
    if (editing === 'name' && v) onRename(v);
    else if (editing === 'price' && v) onReprice(v);
    setEditing(null);
  }

  return (
    <tr className={cn('border-b last:border-0', !row.active && 'opacity-55')}>
      <td className="px-4 py-2.5 text-center">
        <EmojiPicker value={row.emoji ?? ''} onCommit={onSetEmoji} ariaLabel={`Edit emoji for ${row.name}`} />
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          {editing === 'name' ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              className="h-7 w-48 rounded-md border bg-background px-2 text-sm outline-none focus-visible:border-ring"
            />
          ) : (
            <button type="button" className="group flex items-center gap-1.5 text-left hover:text-primary" onClick={() => begin('name', row.name)}>
              <span className="font-medium">{row.name}</span>
              <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
            </button>
          )}
          {saved && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              <Check className="size-3" /> Saved
            </span>
          )}
          {error && <span className="text-[11px] text-destructive">{error}</span>}
        </div>
        {onEditScope ? (
          <button type="button" onClick={onEditScope}
            className="group mt-0.5 inline-flex items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-primary">
            <span>{summary}</span>
            <Pencil className="size-3 opacity-40 transition-opacity group-hover:opacity-80" />
          </button>
        ) : (
          <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p>
        )}
      </td>
      <td className="px-4 py-2.5">
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
          {row.bundle_type === 'pick' ? 'Buy Any N' : 'Fixed'}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        {editing === 'price' ? (
          <input
            autoFocus
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            className="h-7 w-24 rounded-md border bg-background px-2 text-right text-sm outline-none focus-visible:border-ring"
          />
        ) : (
          <button type="button" className="group inline-flex items-center gap-1.5 hover:text-primary" onClick={() => begin('price', String(row.price))}>
            <span>{formatPeso(row.price)}</span>
            <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
          </button>
        )}
      </td>
      <td className="px-4 py-2.5">
        <div className="flex justify-end">
          <button
            type="button"
            role="switch"
            aria-checked={row.active}
            aria-label={row.active ? `Unlist ${row.name}` : `List ${row.name}`}
            onClick={() => onToggle(!row.active)}
            className={cn('relative h-5 w-9 shrink-0 rounded-full border transition-colors', row.active ? 'border-primary bg-primary' : 'border-border bg-muted')}
          >
            <span className={cn('absolute top-1/2 size-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-[left]', row.active ? 'left-[calc(100%-1.125rem)]' : 'left-0.5')} />
          </button>
        </div>
      </td>
      <td className="px-4 py-2.5 text-right">
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${row.name}`}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
      </td>
    </tr>
  );
}

// Create a new Buy-Any-N bundle, or edit an existing bundle's scope (the eligible
// lines + pick count). Name / emoji / price are only in create mode; on an existing
// bundle those stay inline-editable in the row.
function BundleDialog({dialog, onClose: onClosed, onDone}: {
  dialog: {mode: 'create'} | {mode: 'scope'; bundle: PosBundleRow};
  onClose: () => void;
  onDone: () => void;
}) {
  const {closing, close: onClose} = useModalExit(onClosed);
  const creating = dialog.mode === 'create';
  const bundle = creating ? null : dialog.bundle;
  const [name, setName] = useState(bundle?.name ?? '');
  const [emoji, setEmoji] = useState(bundle?.emoji ?? '');
  const [price, setPrice] = useState(bundle?.price != null ? String(bundle.price) : '');
  const [pickCount, setPickCount] = useState(bundle?.pick_count ?? 2);
  const [lines, setLines] = useState<string[]>(bundle?.line_categories ?? []);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {if (e.key === 'Escape') onClose();};
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggleLine(c: string) {
    setLines((ls) => (ls.includes(c) ? ls.filter((x) => x !== c) : [...ls, c]));
  }
  function save() {
    setError(null);
    startTransition(async () => {
      const res = creating
        ? await createBundleAction({name, emoji, price, pickCount, lineCategories: lines})
        : await setBundleScopeAction(dialog.bundle.bundle_id, pickCount, lines);
      if (res.ok) onDone();
      else setError(res.error);
    });
  }
  return (
    <ModalShell closing={closing} onBackdropClick={onClose} backdropLabel="Cancel" panelClassName="w-full max-w-md rounded-xl border bg-popover p-5 shadow-lg">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{creating ? 'New bundle' : `Edit scope · ${bundle?.name}`}</h2>
        <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
      </div>

      <div className="flex flex-col gap-3">
        {creating && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Name</span>
              <input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Buy Any 3" className="rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring" />
            </label>
            <div className="flex gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Emoji</span>
                <div className="pt-0.5"><EmojiPicker value={emoji} onCommit={(e) => setEmoji(e)} ariaLabel="Bundle emoji" /></div>
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs font-medium">Price</span>
                <div className="flex items-center gap-1"><span className="text-sm text-muted-foreground">₱</span>
                  <input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums outline-none focus-visible:border-ring" /></div>
              </label>
            </div>
          </>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Buy any (pick count)</span>
          <input type="number" min={1} value={pickCount} onChange={(e) => setPickCount(Math.max(1, Math.round(Number(e.target.value) || 1)))}
            className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums outline-none focus-visible:border-ring" />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Eligible lines <span className="font-normal text-muted-foreground">a customer may pick from these</span></span>
          <div className="flex flex-wrap gap-2">
            {POS_CATEGORIES.map((c) => {
              const on = lines.includes(c as string);
              return (
                <button key={c} type="button" onClick={() => toggleLine(c as string)}
                  className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', on ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  {c}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
        <button onClick={save} disabled={pending} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {pending ? 'Saving…' : creating ? 'Create bundle' : 'Save scope'}
        </button>
      </div>
    </ModalShell>
  );
}
