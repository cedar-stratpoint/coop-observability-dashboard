import {parseThousands} from './plan-compute';

// Breakdown of the three consolidated typed lines (the Cedar Tree workbook's own sub-rows). The grid cell stores the SUM (plan_actuals, unchanged),
// so every derived number, the close gate and the cash chain keep reading the total. The parts live beside it (plan_actual_parts, supabase/plan_actual_parts.sql).
// The part ids are mirrored in that SQL function: test/plan-parts-rpc-local.integration.test.ts saves every id below through the RPC.
export interface PartDef {id: string; label: string}
export const LINE_PARTS: Readonly<Record<string, readonly PartDef[]>> = {
  overhead: [
    {id: 'salaries', label: 'Salaries'}, {id: 'rent', label: 'Rent'}, {id: 'accounting', label: 'Accounting'},
    {id: 'tech', label: 'Tech costs'}, {id: 'growth_consultant', label: 'Growth consultant'}, {id: 'rnd', label: 'R&D / product dev, testing and sampling'},
  ],
  cogs: [{id: 'marketplace_cogs', label: 'Marketplace COGS'}, {id: 'website_cogs', label: 'Website COGS'}, {id: 'events_cogs', label: 'Events COGS'}],
  content_other: [{id: 'content_socials', label: 'Content and socials'}, {id: 'other_spend', label: 'Other spend'}],
};
export const PART_LINE_IDS: readonly string[] = Object.keys(LINE_PARTS);
export const hasParts = (line: string): boolean => line in LINE_PARTS;

/** The workbook's per-part plan values (pesos) by line, part, then plan month index. Loaded into plan_part_targets (scripts/seed-plan-from-workbook.mjs), read by src/plan-data.ts. */
export type PartSeed = Readonly<Record<string, Readonly<Record<string, readonly (number | null)[]>>>>;

const cents = (pesos: number): number => Math.round(pesos * 100);
/** Pesos summed in whole centavos, so 0.1 + 0.2 is 0.3. */
export const sumPesos = (amounts: readonly number[]): number => amounts.reduce((n, a) => n + cents(a), 0) / 100;

export type PartsParse = {ok: true; parts: Record<string, number>; total: number} | {ok: false; errors: Record<string, string>};
/**
 * What the modal holds (thousands of pesos per part, as the grid) -> pesos. Rule: EVERY part needs a value; a blank is an error, never an invisible 0
 * (type 0 for a part with no cost; "Total only" is for when the split is unknown). Keeps "empty" and "0" distinct everywhere.
 */
export function parsePartsInput(line: string, texts: Readonly<Record<string, string>>): PartsParse {
  const errors: Record<string, string> = {};
  const parts: Record<string, number> = {};
  for (const p of LINE_PARTS[line] ?? []) {
    const raw = texts[p.id] ?? '';
    if (raw.trim() === '') { errors[p.id] = 'Type 0 if there is none.'; continue; }
    const v = parseThousands(raw);
    if (!v.ok || v.pesos === null) { errors[p.id] = 'Enter a number.'; continue; }
    if (v.pesos < 0) { errors[p.id] = 'Cannot be negative.'; continue; }
    parts[p.id] = v.pesos;
  }
  return Object.keys(errors).length ? {ok: false, errors} : {ok: true, parts, total: sumPesos(Object.values(parts))};
}

/** Server-side check of a breakdown (pesos). Returns an error message, or null when fine. */
export function validateParts(line: unknown, parts: unknown): string | null {
  const defs = typeof line === 'string' ? LINE_PARTS[line] : undefined;
  if (!defs) return 'Unknown line.';
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) return 'Fill in every part.';
  const rec = parts as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (!defs.some((d) => d.id === k)) return `Unknown part: ${k}.`;
  for (const d of defs) {
    const v = rec[d.id];
    if (v === undefined || v === null) return 'Fill in every part, type 0 for none.';
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${d.label}: enter a number.`;
    if (v < 0) return `${d.label} cannot be negative.`;
    if (v > 1e12) return `${d.label} is too large.`;
  }
  return null;
}

/** Saved parts count only while they still add up to the saved total. A total typed directly afterwards makes them stale: they are then ignored, never shown. */
export function consistentParts(line: string, total: number | null, parts: Readonly<Record<string, number>> | undefined): boolean {
  if (total === null || !parts || !(LINE_PARTS[line] ?? []).every((d) => typeof parts[d.id] === 'number')) return false;
  return cents(sumPesos(Object.values(parts))) === cents(total);
}

/** The workbook plan value per part for one month, only while the parts still add up to the line's target (a newer plan version would not match them). */
export function partTargets(line: string, i: number, lineTarget: number | null, seed: PartSeed): Record<string, number> | null {
  const defs = LINE_PARTS[line];
  const s = seed[line];
  if (!defs || !s || lineTarget === null) return null;
  const out: Record<string, number> = {};
  for (const d of defs) { const v = s[d.id]?.[i]; if (typeof v !== 'number') return null; out[d.id] = v; }
  return Math.abs(sumPesos(Object.values(out)) - lineTarget) <= 1 ? out : null;
}
