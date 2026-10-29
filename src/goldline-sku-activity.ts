// SKU linking activity (Oct 29): who did what, newest first, for "Recent activity" and its
// full trail. Built from the decision log (f2e) and, for history from before the log
// existed, from what was already kept: each SKU's latest decision and remark
// (sku_link_reviews), notes (item_notes) and decommissions (products.retired_*). A log
// entry and the review row it wrote are the same event, so reviews within a few seconds
// of a logged decision on the same SKU are dropped. Pure, so the wording is tested.

export type ActivityKind = 'approved' | 'rejected' | 'linked' | 'unlinked' | 'remark' | 'decommissioned' | 'restored' | 'note' | 'note_removed' | 'undo';
export type ActivityEvent = {id: string; at: string; by: string | null; kind: ActivityKind; text: string; target: 'sku' | 'item'; key: string};

export type LogEntry = {
  id: number;
  target: 'sku' | 'item';
  key: string;
  action: Exclude<ActivityKind, 'note_removed' | 'undo'>;
  summary: string | null;
  done_by: string | null;
  done_at: string;
  undone_by: string | null;
  undone_at: string | null;
  noteRemoved?: boolean; // a note entry that left no note behind
  itemCode?: string | null; // for unlinks: the item it was linked to
};
export type ReviewEntry = {sku_code: string; action: string | null; item_code: string | null; action_by: string | null; action_at: string | null; remark: string | null; remark_by: string | null; remark_at: string | null};
export type NoteEntry = {item_code: string; note_by: string | null; note_at: string};
export type RetiredEntry = {item_code: string; retired_by: string | null; retired_at: string};

const NEAR_MS = 15_000;
const near = (a: string | null, b: string | null) => Boolean(a && b) && Math.abs(Date.parse(a!) - Date.parse(b!)) <= NEAR_MS;

export function buildActivity(input: {
  log: LogEntry[];
  reviews: ReviewEntry[];
  notes: NoteEntry[];
  retired: RetiredEntry[];
  skuName: (sku: string) => string; // "Professional Eye Penci"
  itemName: (item: string) => string; // "Professional Eye Pencil · 802 Medium Brown"
}): ActivityEvent[] {
  const {log, skuName, itemName} = input;
  const sku = (k: string) => `${skuName(k)} (${k})`;
  const item = (k: string) => `${itemName(k)} (${k})`;
  const subject = (t: 'sku' | 'item', k: string) => (t === 'sku' ? sku(k) : item(k));
  const out: ActivityEvent[] = [];

  const describe = (e: {kind: ActivityKind; target: 'sku' | 'item'; key: string; summary?: string | null; itemCode?: string | null}): string => {
    switch (e.kind) {
      case 'approved':
        return `Approved Coop's match ${e.summary ?? ''} for ${sku(e.key)}`.replace('  ', ' ');
      case 'rejected':
        return `Rejected ${e.summary ?? 'Coop’s match'} for ${sku(e.key)}`;
      case 'linked':
        return `Chose ${e.summary ?? 'an item'} for ${sku(e.key)}`;
      case 'unlinked':
        return `Unlinked ${sku(e.key)}${e.itemCode ? ` from ${e.itemCode}` : ''}`;
      case 'remark':
        return `Added a remark on ${sku(e.key)}`;
      case 'decommissioned':
        return `Marked ${item(e.key)} as decommissioned`;
      case 'restored':
        return `Brought back ${item(e.key)}`;
      case 'note':
        return `Saved a note on ${item(e.key)}`;
      case 'note_removed':
        return `Removed the note on ${item(e.key)}`;
      default:
        return subject(e.target, e.key);
    }
  };

  for (const e of log) {
    const kind: ActivityKind = e.action === 'note' && e.noteRemoved ? 'note_removed' : e.action;
    const text = describe({kind, target: e.target, key: e.key, summary: e.summary, itemCode: e.itemCode});
    out.push({id: `log-${e.id}`, at: e.done_at, by: e.done_by, kind, text, target: e.target, key: e.key});
    if (e.undone_at) {
      out.push({id: `undo-${e.id}`, at: e.undone_at, by: e.undone_by, kind: 'undo', text: `Undid: ${text.charAt(0).toLowerCase()}${text.slice(1)}`, target: e.target, key: e.key});
    }
  }

  // Older history, from before the log: skip anything a log entry already covers.
  const logged = (target: 'sku' | 'item', key: string, actions: string[], at: string | null) =>
    log.some((l) => l.target === target && l.key === key && actions.includes(l.action) && near(l.done_at, at));
  for (const r of input.reviews) {
    const act = r.action as ActivityKind | null;
    if (act && r.action_at && ['approved', 'rejected', 'linked', 'unlinked'].includes(act) && !logged('sku', r.sku_code, [act], r.action_at)) {
      out.push({id: `rev-${r.sku_code}`, at: r.action_at, by: r.action_by, kind: act, text: describe({kind: act, target: 'sku', key: r.sku_code, summary: r.item_code, itemCode: r.item_code}), target: 'sku', key: r.sku_code});
    }
    // A remark saved on its own (not with the decision) is its own event.
    if (r.remark && r.remark_at && !near(r.remark_at, r.action_at) && !logged('sku', r.sku_code, ['remark'], r.remark_at)) {
      out.push({id: `rem-${r.sku_code}`, at: r.remark_at, by: r.remark_by, kind: 'remark', text: describe({kind: 'remark', target: 'sku', key: r.sku_code}), target: 'sku', key: r.sku_code});
    }
  }
  for (const n of input.notes) {
    if (!logged('item', n.item_code, ['note'], n.note_at)) out.push({id: `note-${n.item_code}`, at: n.note_at, by: n.note_by, kind: 'note', text: describe({kind: 'note', target: 'item', key: n.item_code}), target: 'item', key: n.item_code});
  }
  for (const p of input.retired) {
    if (!logged('item', p.item_code, ['decommissioned'], p.retired_at)) {
      out.push({id: `ret-${p.item_code}`, at: p.retired_at, by: p.retired_by, kind: 'decommissioned', text: describe({kind: 'decommissioned', target: 'item', key: p.item_code}), target: 'item', key: p.item_code});
    }
  }

  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}
