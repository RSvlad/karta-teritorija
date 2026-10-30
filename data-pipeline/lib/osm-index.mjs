// Pairs a city's Sheet streets with the OSM street index written by data-pipeline/streets.py.
// Pure (apart from loadOsmStreets), so it can be checked without network access.
import { existsSync, readFileSync } from 'node:fs';
import { slug } from './build-city.mjs';

const CACHE_DIR = 'data-pipeline/cache';

/** Reads data-pipeline/cache/<city>/streets.json. Returns null when it has not been generated. */
export function loadOsmStreets(cityId, dir = CACHE_DIR) {
  const path = `${dir}/${cityId}/streets.json`;
  if (!existsSync(path)) return null;
  let payload;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: није исправан JSON (${e.message}); поново покрените streets.py --refresh`);
  }
  if (!Array.isArray(payload?.streets)) {
    throw new Error(`${path}: нема низа „streets“; поново покрените streets.py --refresh`);
  }
  return { path, fetched: payload.fetched, streets: payload.streets };
}

// A missing settlement on either side matches any settlement; two given ones must be equal.
const compatible = (a, b) => a === '' || b === '' || a === b;

const describe = (s) => `„${s.name}“${s.settlement ? ` (${s.settlement})` : ''}`;

/**
 * Adds OSM streets that have no Sheet counterpart to `data.streets` (they have no rules, so the
 * resolver reports them as unassigned) and lists Sheet streets that have no OSM counterpart.
 * Names are compared through slug(), so Cyrillic/Latin spellings of one street are the same street.
 * IDs of existing (Sheet) streets never change; only new OSM-only streets get IDs here.
 */
export function mergeOsmStreets(data, osmStreets) {
  const osm = new Map();
  for (const s of osmStreets) {
    const name = String(s?.name ?? '').replace(/\s+/g, ' ').trim();
    const settlement = String(s?.settlement ?? '').replace(/\s+/g, ' ').trim();
    const nameSlug = slug(name);
    if (!nameSlug) continue;
    const settlementSlug = slug(settlement);
    const key = `${nameSlug}|${settlementSlug}`;
    if (!osm.has(key)) osm.set(key, { name, settlement, nameSlug, settlementSlug });
  }

  const group = (items) => {
    const byName = new Map();
    for (const item of items) {
      const list = byName.get(item.nameSlug) ?? [];
      list.push(item);
      byName.set(item.nameSlug, list);
    }
    return byName;
  };
  const sheet = data.streets.map((s) => ({ ...s, nameSlug: slug(s.name), settlementSlug: slug(s.settlement ?? '') }));
  const sheetByName = group(sheet);
  const osmByName = group([...osm.values()]);

  const missingInOsm = sheet
    .filter((s) => !(osmByName.get(s.nameSlug) ?? []).some((o) => compatible(s.settlementSlug, o.settlementSlug)))
    .map(describe);

  const extra = [...osm.values()]
    .filter((o) => !(sheetByName.get(o.nameSlug) ?? []).some((s) => compatible(s.settlementSlug, o.settlementSlug)))
    .sort((a, b) => a.name.localeCompare(b.name, 'sr') || a.settlement.localeCompare(b.settlement, 'sr'));

  // Same rule as the Sheet streets: the settlement goes into the ID only when the name repeats.
  const nameCount = new Map();
  for (const s of sheet) nameCount.set(s.nameSlug, (nameCount.get(s.nameSlug) ?? 0) + 1);
  for (const o of extra) nameCount.set(o.nameSlug, (nameCount.get(o.nameSlug) ?? 0) + 1);

  const usedIds = new Set(data.streets.map((s) => s.id));
  const added = [];
  const skipped = [];
  for (const o of extra) {
    const shared = nameCount.get(o.nameSlug) > 1 && o.settlementSlug;
    const id = shared ? `${o.nameSlug}-${o.settlementSlug}` : o.nameSlug;
    if (usedIds.has(id)) {
      skipped.push(`${describe(o)}: ид „${id}“ је већ заузет`);
      continue;
    }
    usedIds.add(id);
    added.push({ id, name: o.name, ...(o.settlement && { settlement: o.settlement }) });
  }

  return {
    data: { ...data, streets: [...data.streets, ...added] },
    report: { missingInOsm, added: added.length, skipped },
  };
}
