const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'đ', е: 'e', ж: 'ž', з: 'z',
  и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', ћ: 'ć', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'č', џ: 'dž', ш: 'š',
};

/** Serbian Cyrillic → Latin (lower-case output; non-Cyrillic characters pass through). */
export function cyrToLat(input: string): string {
  let out = '';
  for (const ch of input.toLowerCase()) out += CYR_TO_LAT[ch] ?? ch;
  return out;
}

/**
 * Canonical search form: same result for Cyrillic, Latin, with/without diacritics.
 * "Футошка", "Futoška", "futoska" → "futoska"; "Ђуре", "Đure", "Djure" → "djure".
 */
export function normalizeText(input: string): string {
  return cyrToLat(input)
    .replace(/đ/g, 'dj')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '') // č ć š ž (and dž → dz) lose their marks
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
