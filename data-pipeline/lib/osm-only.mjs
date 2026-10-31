// Cities that have an OSM street index (data-pipeline/cache/<city>/streets.json) but no Sheet yet.
// They still get a data file, so their streets are searchable and the city shows up in the city picker;
// every street is "unassigned" until the city gets a Sheet (SHEETS_CITIES).
import { existsSync, readFileSync } from 'node:fs';
import { loadOsmStreets, mergeOsmStreets } from './osm-index.mjs';

const CITIES_YML = 'data-pipeline/cities.yml';

/**
 * City ids and names from cities.yml, in file order. Only these two fields are needed,
 * so the file is read line by line instead of adding a YAML dependency.
 */
export function readCitiesYml(path = CITIES_YML) {
  if (!existsSync(path)) return [];
  const cities = [];
  let current = null;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const key = /^([a-z0-9]+(?:-[a-z0-9]+)*):\s*(?:#.*)?$/.exec(line);
    if (key) {
      current = { id: key[1], name: '' };
      cities.push(current);
      continue;
    }
    const name = /^\s+name:\s*(.+?)\s*$/.exec(line);
    if (name && current && !current.name) current.name = name[1].replace(/^["']|["']$/g, '');
  }
  return cities.filter((c) => c.name);
}

/** CityData of a city with streets only: no territories, rules or places. */
export function buildOsmOnlyCity({ id, name, osm, buildDate }) {
  const empty = {
    city: id,
    name,
    updated: osm.fetched ?? buildDate,
    territories: [],
    streets: [],
    rules: [],
    internal: [],
    places: [],
  };
  return mergeOsmStreets(empty, osm.streets);
}

/**
 * Street-only data for every city of cities.yml that has an OSM index and is not in `exclude`
 * (the ids that already have data). Returns [{ id, name, data, report }].
 */
export function loadOsmOnlyCities(exclude, buildDate, { ymlPath, cacheDir } = {}) {
  const found = [];
  for (const { id, name } of readCitiesYml(ymlPath)) {
    if (exclude.has(id)) continue;
    const osm = loadOsmStreets(id, cacheDir);
    if (!osm) continue;
    const { data, report } = buildOsmOnlyCity({ id, name, osm, buildDate });
    found.push({ id, name, data, report });
  }
  return found;
}
