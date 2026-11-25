// An upload "drop" is what the user uploaded in one go. Picking a store sorts a drop into one
// upload batch per store form; each such batch records the batch it came from (parent_batch_id).
// The drop is the top of that chain. Pure.

export type BatchLink = {id: string; parent_batch_id: string | null};

/** batch id -> the drop it belongs to (its top-most parent; itself when it has none). */
export function dropOf(batches: BatchLink[]): Map<string, string> {
  const parent = new Map(batches.map((b) => [b.id, b.parent_batch_id]));
  const out = new Map<string, string>();
  for (const b of batches) {
    let id = b.id;
    const seen = new Set<string>();
    while (parent.get(id) && !seen.has(id)) {
      seen.add(id);
      id = parent.get(id)!;
    }
    out.set(b.id, id);
  }
  return out;
}

/** Every batch in the same drop as `batchId` (the drop itself and all split-offs). */
export function familyOf(batches: BatchLink[], batchId: string): string[] {
  const drops = dropOf(batches);
  const root = drops.get(batchId) ?? batchId;
  const ids = batches.filter((b) => drops.get(b.id) === root).map((b) => b.id);
  return ids.includes(batchId) ? ids : [batchId, ...ids];
}
