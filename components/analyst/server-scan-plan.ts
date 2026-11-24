// Which upload path a drop takes when server-driven reading is on (user report 2026-11-23).
// Two whole-scan PDFs dropped together used to fall back to the client path silently: the
// browser split and sent every page, the tab had to stay open, and the upload's name was
// dropped. Now each PDF is uploaded as its own server-read scan, one after another, and a
// typed name is kept on each with " · part N". Anything with a CSV/XLSX in it stays on the
// client path, which still handles mixed drops.

export type ScanPlan = {kind: 'client'} | {kind: 'server'; scans: {index: number; total: number; name?: string}[]};

const isPdf = (name: string) => name.toLowerCase().endsWith('.pdf');

/** Pure: decide the path for a drop and the name each server scan gets. */
export function planServerScans(files: {name: string}[], serverUpload: boolean, typedName: string): ScanPlan {
  if (!serverUpload || files.length === 0 || !files.every((f) => isPdf(f.name))) return {kind: 'client'};
  const base = typedName.trim();
  const total = files.length;
  return {
    kind: 'server',
    scans: files.map((_, i) => ({index: i + 1, total, name: base ? (total > 1 ? `${base} · part ${i + 1}` : base) : undefined})),
  };
}
