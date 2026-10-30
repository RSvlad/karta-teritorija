const DAY_MS = 24 * 60 * 60 * 1000;

/** Data last updated more than this many days ago is flagged as possibly outdated. */
export const DEFAULT_STALE_DAYS = 90;

/** Threshold from the build-time VITE_STALE_DAYS (a positive whole number of days); anything else gives the default. */
export function staleThresholdDays(configured: string | undefined = import.meta.env.VITE_STALE_DAYS): number {
  const n = Number(configured?.trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_STALE_DAYS;
}

/** Whole calendar days between the `YYYY-MM-DD` date `updated` and `now`; null if `updated` is not a valid date of that form. */
export function dataAgeDays(updated: string, now: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(updated.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const then = new Date(Date.UTC(y, mo - 1, d));
  // Rejects dates Date.UTC would silently roll over (e.g. 2026-02-31).
  if (then.getUTCFullYear() !== y || then.getUTCMonth() !== mo - 1 || then.getUTCDate() !== d) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today - then.getTime()) / DAY_MS);
}

/** Age in days when the data is older than the threshold, else null (fresh, in the future, or unreadable date). */
export function staleAgeDays(
  updated: string,
  thresholdDays: number = staleThresholdDays(),
  now: Date = new Date(),
): number | null {
  const age = dataAgeDays(updated, now);
  return age !== null && age > thresholdDays ? age : null;
}

/** "дан" or "дана" after a count of days ("пре 91 дан", "пре 92 дана", "пре 111 дана"). */
export function daysLabel(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? 'дан' : 'дана';
}
