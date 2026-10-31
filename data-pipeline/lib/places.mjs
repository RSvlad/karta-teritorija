// Places (capitals and other points): pairs the Sheet's addresses with the geocode cache written by
// data-pipeline/geocode.py. Pure (apart from the file helpers), so it can be checked without network access.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { slug } from './build-city.mjs';

const CACHE_DIR = 'data-pipeline/cache';
const WORK_DIR = 'data-pipeline/work';

/** Cache key of an address. Same function as address_key() in geocode.py (Cyrillic/Latin spellings match). */
export const addressKey = (address) => slug(address);

/** Reads data-pipeline/cache/<city>/geocode-cache.json. Returns null when it has not been generated. */
export function loadGeocodeCache(cityId, dir = CACHE_DIR) {
  const path = `${dir}/${cityId}/geocode-cache.json`;
  if (!existsSync(path)) return null;
  let payload;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: није исправан JSON (${e.message}); поново покрените geocode.py`);
  }
  if (!payload || typeof payload.addresses !== 'object' || Array.isArray(payload.addresses)) {
    throw new Error(`${path}: нема објекта „addresses“; поново покрените geocode.py`);
  }
  return { path, addresses: payload.addresses };
}

/**
 * Adds lat/lng to every place whose address is in the cache.
 * `missing` lists the places left without coordinates (geocode.py was not run, or it failed for them).
 */
export function attachCoordinates(data, cache) {
  const missing = [];
  const places = data.places.map((p) => {
    const hit = cache?.addresses[addressKey(p.address)];
    if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lng)) return { ...p, lat: hit.lat, lng: hit.lng };
    missing.push(p);
    return p;
  });
  return { data: { ...data, places }, missing };
}

/** What geocode.py needs: one row per place, written to data-pipeline/work/<city>/places-input.json (git-ignored). */
export function writePlacesInput(data, dir = WORK_DIR) {
  const out = `${dir}/${data.city}/places-input.json`;
  mkdirSync(`${dir}/${data.city}`, { recursive: true });
  const places = data.places.map(({ id, name, kind, territoryId, address }) => ({ id, name, kind, territoryId, address }));
  writeFileSync(out, JSON.stringify({ city: data.city, places }, null, 2) + '\n');
  return out;
}
