const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'đ', е: 'e', ж: 'ž', з: 'z',
  и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', ћ: 'ć', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'č', џ: 'dž', ш: 'š',
};

const isUpper = (ch: string | undefined): boolean => ch !== undefined && ch !== ch.toLowerCase();

/**
 * Serbian Cyrillic → Latin for display; keeps letter case and leaves every other character as it is
 * (so Latin text passes through unchanged). The digraphs љ њ џ become "Lj/Nj/Dž" at the start of a
 * word and "LJ/NJ/DŽ" inside an upper-case word: "Љубица" → "Ljubica", "ЊЕГОШЕВА" → "NJEGOŠEVA".
 * Unlike `cyrToLat` in search/normalize.ts, which folds text for matching, this one is for showing.
 */
export function cyrillicToLatin(input: string): string {
  const chars = [...input];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const lower = ch.toLowerCase();
    const latin = CYR_TO_LAT[lower];
    if (latin === undefined) out += ch;
    else if (ch === lower) out += latin;
    else if (latin.length === 1) out += latin.toUpperCase();
    else out += isUpper(chars[i - 1]) || isUpper(chars[i + 1]) ? latin.toUpperCase() : latin[0]!.toUpperCase() + latin.slice(1);
  }
  return out;
}
