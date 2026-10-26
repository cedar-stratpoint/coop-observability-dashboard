// Types for the plain-JS import script, so the test that exercises its parser
// typechecks with the rest of the project.
/** A parsed export row, shaped like a public.spin_wheel_leads insert. */
export interface SpinLeadRow {
  email: string | null;
  instagram: string | null;
  name: string | null;
  pet: string | null;
  picky: string | null;
  mobile: string | null;
  prize: string;
  campaign: string | null;
  collected_at: string;
  consent_at: string | null;
}
export function parsePhTimestamp(raw: string): string | null;
export function parseSpinLeadsCsv(csv: string): SpinLeadRow[];
