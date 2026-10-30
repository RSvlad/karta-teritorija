import { cyrToLat, normalizeText } from './normalize';

export interface Part {
  text: string;
  match: boolean;
}

/** One character folded exactly like normalizeText does (marks dropped, anything else becomes a space). */
function foldChar(ch: string): string {
  return cyrToLat(ch)
    .replace(/đ/g, 'dj')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]/g, ' ');
}

/**
 * Splits `text` into matched / unmatched parts for the query, using the same folding as the search,
 * so "futo" highlights "Футошка" and "Futoška" alike. A word is matched when it starts with a query token.
 */
export function highlightParts(text: string, query: string): Part[] {
  const qTokens = normalizeText(query).split(' ').filter(Boolean);
  if (qTokens.length === 0) return [{ text, match: false }];

  // Folded text plus, for every folded character, the span of the original text it came from.
  let folded = '';
  const from: number[] = [];
  const to: number[] = [];
  let pos = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    const next = pos + ch.length;
    if (f === '') {
      // A combining mark: it belongs to the previous character.
      if (to.length > 0) to[to.length - 1] = next;
    } else {
      for (let k = 0; k < f.length; k++) {
        from.push(pos);
        to.push(next);
      }
      folded += f;
    }
    pos = next;
  }

  const flags: boolean[] = new Array(text.length).fill(false);
  for (const word of folded.matchAll(/[a-z0-9]+/g)) {
    const w = word[0];
    const at = word.index!;
    let len = 0;
    for (const qt of qTokens) if (w.startsWith(qt)) len = Math.max(len, qt.length);
    if (len === 0) continue;
    for (let o = from[at]!; o < to[at + len - 1]!; o++) flags[o] = true;
  }

  const parts: Part[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && flags[j] === flags[i]) j++;
    parts.push({ text: text.slice(i, j), match: flags[i]! });
    i = j;
  }
  return parts;
}
