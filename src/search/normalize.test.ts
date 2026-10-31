import { describe, expect, it } from 'vitest';
import { normalizeText } from './normalize';
import { createSearch } from './search';

describe('normalizeText', () => {
  it('maps Cyrillic, Latin and ASCII spellings to one form', () => {
    const forms = ['Futoska', 'Футошка', 'futoška', 'FUTOŠKA'].map(normalizeText);
    expect(new Set(forms).size).toBe(1);
    expect(forms[0]).toBe('futoska');
  });

  it('treats đ / dj / ђ alike', () => {
    expect(normalizeText('Ђуре Јакшића')).toBe(normalizeText('Đure Jakšića'));
    expect(normalizeText('Djure Jaksica')).toBe(normalizeText('Ђуре Јакшића'));
  });

  it('handles digraphs lj, nj, dž and č/ć/š/ž', () => {
    expect(normalizeText('Љубљанска')).toBe(normalizeText('Ljubljanska'));
    expect(normalizeText('Његошева')).toBe(normalizeText('njegoševa'));
    expect(normalizeText('Џона')).toBe(normalizeText('džona'));
    expect(normalizeText('Чаробни ћуп')).toBe(normalizeText('carobni cup'));
  });

  it('accepts decomposed diacritics and strips punctuation', () => {
    expect(normalizeText('Futos\u030Cka')).toBe('futoska');
    expect(normalizeText('  Ул.  Футошка, ')).toBe('ul futoska');
  });
});

describe('createSearch', () => {
  const searchHits = createSearch([
    { id: 'a', name: 'Футошка', settlement: 'Нови Сад' },
    { id: 'b', name: 'Булевар ослобођења' },
    { id: 'c', name: 'Школска', settlement: 'Нови Сад' },
    { id: 'd', name: 'Школска', settlement: 'Петроварадин' },
  ]);
  const search = (q: string) => searchHits(q).flatMap((h) => (h.kind === 'street' ? [h.street] : []));

  it('matches by prefix across scripts', () => {
    expect(search('fut').map((s) => s.id)).toEqual(['a']);
    expect(search('oslobodj').map((s) => s.id)).toEqual(['b']);
  });

  it('returns same-named streets from different settlements', () => {
    expect(search('skolska').map((s) => s.id).sort()).toEqual(['c', 'd']);
  });

  it('returns nothing for empty or unknown queries', () => {
    expect(search('  ')).toEqual([]);
    expect(search('xyz')).toEqual([]);
  });
});
