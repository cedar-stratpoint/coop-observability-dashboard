// The reader's per-row note ("alt") is free text the model wrote, and older reads used its own
// shorthand: column numbers ("col3"), field names ("begin_plus_delivery"), and internal terms
// ("off_manifest: printed row not in reference list"). QA found these confusing (Nov 23/24).
// New reads are told to write plain words; this cleans the notes already stored, so every
// note reads in the reviewer's column names. Pure, so it unit-tests.

type Layout = 'v1' | 'v2' | 'legacy-locations' | 'legacy-printed';

// Column numbers as printed on each layout (Legacy col5/col7 are peso amounts, never noted).
const COL_NAMES: Record<Layout, Record<number, string>> = {
  v1: {1: 'Stockroom', 2: 'Drawer', 3: 'Selling area', 4: 'Delivery', 5: 'Ending'},
  v2: {1: 'Delivery', 2: 'Stockroom', 3: 'Drawer', 4: 'Selling area', 5: 'Ending'},
  'legacy-locations': {1: 'Stockroom', 2: 'Drawer', 3: 'Selling area', 4: 'Deducted', 6: 'Ending'},
  'legacy-printed': {1: 'Beginning', 2: 'Delivery', 3: 'Beginning + Delivery', 4: 'Deducted', 6: 'Ending'},
};

type NoteRow = {stockroom?: number | null; drawer?: number | null; selling_area?: number | null};

/** Which column names apply to a row: a Legacy row filed as stockroom / drawer / selling uses
 *  those names for its printed positions; a Legacy row on the printed model keeps them. */
export function noteLayout(version: string | null | undefined, row: NoteRow): Layout {
  if (version === 'v2') return 'v2';
  if (version === 'legacy') return row.stockroom != null || row.drawer != null || row.selling_area != null ? 'legacy-locations' : 'legacy-printed';
  return 'v1';
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The reader's note in the reviewer's words, or null when there is nothing to say. `known`:
 *  the row is on this page's printed list, so an old "not in the list" remark no longer holds
 *  (Legacy pages now read against the Legacy form's own rows) and is dropped. */
export function readerNote(alt: string | null | undefined, layout: Layout, opts: {known?: boolean} = {}): string | null {
  let s = alt?.trim();
  if (!s) return null;
  const cols = COL_NAMES[layout];
  const locations = layout === 'legacy-locations';
  // "off_manifest: printed row not in reference list, printed name Double Espresso"
  s = s.replace(/off_manifest:?\s*/gi, '');
  if (opts.known) {
    // On the list after all: drop the remark and the printed name that went with it.
    s = s.replace(/(?:printed (?:row |but )?)?not in (?:the )?reference list/gi, '').replace(/printed name\s+[^;]+/gi, '');
  } else {
    s = s.replace(/(?:printed (?:row |but )?)?not in (?:the )?reference list/gi, 'not on the usual list for this page');
    s = s.replace(/printed name\s+([^;]+?)(?=;|$)/gi, (_, name: string) => `printed as "${name.trim()}"`);
  }
  // Field names the model used verbatim.
  s = s.replace(/\bbegin_plus_delivery\b/gi, locations ? 'selling area' : 'beginning + delivery');
  s = s.replace(/\bdeducted_pcs\b/gi, 'deducted');
  s = s.replace(/\bending_on_hand\b/gi, 'ending');
  s = s.replace(/\bselling_area\b/gi, 'selling area');
  // "col3" / "column 3" → the column's name on this layout.
  s = s.replace(/\bcol(?:umn)?\s*(\d)\b/gi, (m, n: string) => (cols[Number(n)] ? lower(cols[Number(n)]) : m));
  if (locations) {
    // A Legacy page filed as stockroom / drawer / selling: the reader's printed-header words
    // name the wrong thing there (its "Beginning" column is the Stockroom count, and so on).
    s = s.replace(/\bbeginning\s*\+\s*delivery\b/gi, 'selling area');
    s = s.replace(/\bbeginning\b/gi, 'stockroom');
    s = s.replace(/\bdelivery\b/gi, 'drawer');
  }
  s = s.split(';').map((x) => x.replace(/\s{2,}/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '')).filter(Boolean).join('; ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}
