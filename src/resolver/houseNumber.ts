import { normalizeText } from '../search/normalize';
import type { HouseNumber } from './types';

/** Parses "15", "15а", "15a", "15/2", "15 а/2". Returns null for anything else. */
export function parseHouseNumber(input: string): HouseNumber | null {
  const m = /^(\d{1,5})\s*(\p{L}?)\s*(?:\/\s*(\d{1,4}))?$/u.exec(input.trim());
  if (!m) return null;
  return {
    n: Number(m[1]),
    suffix: m[2] ? normalizeText(m[2]) : '',
    sub: m[3] ? Number(m[3]) : null,
  };
}

/** Natural order: 15 < 15a < 15b < 15/1 < 15/2 < 17. */
export function compareHouseNumbers(a: HouseNumber, b: HouseNumber): number {
  return (
    a.n - b.n ||
    Number(a.sub !== null) - Number(b.sub !== null) || // plain/lettered before "/sub"
    a.suffix.localeCompare(b.suffix) ||
    (a.sub ?? 0) - (b.sub ?? 0)
  );
}

export function formatHouseNumber(h: HouseNumber): string {
  return `${h.n}${h.suffix}${h.sub !== null ? `/${h.sub}` : ''}`;
}
