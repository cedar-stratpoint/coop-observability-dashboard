/** The reader signature a read is stamped with: model + deployed commit. Null without a commit
 *  (local dev), so reads there are never reused. Pure. */
export function readReuseKey(model: string, commitSha: string | null | undefined): string | null {
  const c = commitSha?.trim();
  return c ? `${model}@${c.slice(0, 12)}` : null;
}
