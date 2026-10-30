import { normalizeText } from './normalize';
import type { Street } from '../resolver/types';

interface Entry {
  street: Street;
  norm: string;
  tokens: string[];
}

/** Every query token must prefix some name token; earlier/whole-name matches rank first. */
export function createStreetSearch(streets: Street[]) {
  const entries: Entry[] = streets.map((street) => {
    const norm = normalizeText(street.name);
    return { street, norm, tokens: norm.split(' ') };
  });

  return function search(query: string, limit = 8): Street[] {
    const q = normalizeText(query);
    if (!q) return [];
    const qTokens = q.split(' ');
    const scored: { street: Street; score: number; len: number }[] = [];
    for (const e of entries) {
      let score = e.norm === q ? 0 : e.norm.startsWith(q) ? 1 : 2;
      const ok = qTokens.every((qt) => e.tokens.some((t) => t.startsWith(qt)));
      if (!ok) continue;
      scored.push({ street: e.street, score, len: e.norm.length });
    }
    scored.sort((a, b) => a.score - b.score || a.len - b.len);
    return scored.slice(0, limit).map((s) => s.street);
  };
}
