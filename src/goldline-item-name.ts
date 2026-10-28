// "Line · shade" for a catalog item, dropping the words the catalog's variant repeats
// from its product line ("Lip and Cheek Tint Beach Glow" under "Lip and Cheek Tint
// Paraben-Free" → "Lip and Cheek Tint Paraben-Free · Beach Glow"). Pure; used by every
// Goldline screen that names an item.
export function itemDisplayName(productLine: string | null | undefined, variant: string | null | undefined, fallback = ''): string {
  const line = (productLine ?? '').trim();
  const words = (variant ?? '').trim().split(/\s+/).filter(Boolean);
  const lineWords = line.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  let k = 0;
  while (k < words.length && k < lineWords.length && words[k].toLowerCase().replace(/[^a-z0-9]/g, '') === lineWords[k]) k++;
  const shade = words.slice(k).join(' ');
  return [line, shade].filter(Boolean).join(' · ') || fallback;
}
