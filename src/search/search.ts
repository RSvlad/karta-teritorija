import { normalizeText } from './normalize';
import type { Place, Street } from '../resolver/types';

/** One search result: a street or a place (capital, collector point, ...). */
export type Hit =
  | { kind: 'street'; street: Street }
  | { kind: 'place'; place: Place };

export const hitId = (h: Hit): string => (h.kind === 'street' ? `street:${h.street.id}` : `place:${h.place.id}`);
export const hitName = (h: Hit): string => (h.kind === 'street' ? h.street.name : h.place.name);

interface Entry {
  hit: Hit;
  norm: string;
  tokens: string[];
}

/**
 * One search over streets and places. Every query token must prefix some name token;
 * earlier/whole-name matches rank first, and streets come before places on equal rank.
 */
export function createSearch(streets: Street[], places: Place[] = []) {
  const hits: Hit[] = [
    ...streets.map((street): Hit => ({ kind: 'street', street })),
    ...places.map((place): Hit => ({ kind: 'place', place })),
  ];
  const entries: Entry[] = hits.map((hit) => {
    const norm = normalizeText(hitName(hit));
    return { hit, norm, tokens: norm.split(' ') };
  });

  return function search(query: string, limit = 8): Hit[] {
    const q = normalizeText(query);
    if (!q) return [];
    const qTokens = q.split(' ');
    const scored: { hit: Hit; score: number; len: number }[] = [];
    for (const e of entries) {
      const score = e.norm === q ? 0 : e.norm.startsWith(q) ? 1 : 2;
      const ok = qTokens.every((qt) => e.tokens.some((t) => t.startsWith(qt)));
      if (!ok) continue;
      scored.push({ hit: e.hit, score, len: e.norm.length });
    }
    scored.sort((a, b) => a.score - b.score || a.len - b.len);
    return scored.slice(0, limit).map((s) => s.hit);
  };
}
