// Dev/preview convenience: if the pipeline has not produced public/data yet,
// copy the fictional demo fixtures so the app has something to load.
// Cities that only have an OSM street index (cities.yml + data-pipeline/cache/<city>/streets.json) are
// added next to them, so their streets are searchable too. Existing data is never overwritten.
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadOsmOnlyCities } from '../data-pipeline/lib/osm-only.mjs';

const OUT_DIR = 'public/data';
const CITIES = `${OUT_DIR}/cities.json`;

const seeds = [
  ['fixtures/demo-cities.json', CITIES],
  ['fixtures/demo-novi-sad.json', `${OUT_DIR}/novi-sad.json`],
  ['fixtures/demo-novi-sad.territories.geojson', `${OUT_DIR}/novi-sad.territories.geojson`],
];

for (const [source, target] of seeds) {
  if (existsSync(target)) continue;
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(source, target);
  console.log('seeded demo data →', target);
}

const cities = JSON.parse(readFileSync(CITIES, 'utf8'));
const known = new Set(cities.map((c) => c.id));
const added = loadOsmOnlyCities(known, new Date().toISOString().slice(0, 10));
for (const { id, name, data } of added) {
  writeFileSync(`${OUT_DIR}/${id}.json`, JSON.stringify(data, null, 2) + '\n');
  cities.push({ id, name });
  console.log(`seeded OSM streets → ${OUT_DIR}/${id}.json (${data.streets.length} streets)`);
}
if (added.length) writeFileSync(CITIES, JSON.stringify(cities, null, 2) + '\n');
