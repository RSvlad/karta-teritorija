// Build step (runs as `prebuild`): private Google Sheet -> public/data/*.json.
//
// Config (environment):
//   GOOGLE_SERVICE_ACCOUNT  service-account key JSON (GitHub secret)
//   SHEETS_CITIES           JSON array: [{ "id": "novi-sad", "name": "Нови Сад", "sheetId": "…", "reportEmail": "…" }]
//   PIPELINE_REQUIRED=1     fail instead of falling back to the demo seed (set for deploys)
//
// Without config the fictional demo data is used, for local development only.
// If data-pipeline/cache/<city>/streets.json exists (streets.py), its streets are added to the city.
// The optional "Тачке" tab gives the capitals and other points; their coordinates come from
// data-pipeline/cache/<city>/geocode-cache.json (geocode.py), which reads work/<city>/places-input.json written here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildCity } from './lib/build-city.mjs';
import { loadOsmStreets, mergeOsmStreets } from './lib/osm-index.mjs';
import { attachCoordinates, loadGeocodeCache, writePlacesInput } from './lib/places.mjs';
import { fetchSheet, getAccessToken, parseCredentials } from './lib/sheets.mjs';

const OUT_DIR = 'public/data';
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function parseCities(json) {
  let cities;
  try {
    cities = JSON.parse(json);
  } catch {
    fail('SHEETS_CITIES није исправан JSON');
  }
  if (!Array.isArray(cities) || cities.length === 0) fail('SHEETS_CITIES мора бити непразан низ');
  const seen = new Set();
  for (const c of cities) {
    if (!c?.id || !ID_PATTERN.test(c.id)) fail(`SHEETS_CITIES: ид града „${c?.id}“ мора бити облика novi-sad`);
    if (seen.has(c.id)) fail(`SHEETS_CITIES: ид „${c.id}“ се понавља`);
    seen.add(c.id);
    if (!c.name || !c.sheetId) fail(`SHEETS_CITIES: град „${c.id}“ мора имати name и sheetId`);
  }
  return cities;
}

// OSM mismatches are warnings, not errors: OSM names may legitimately differ from the Sheet.
function reportOsm(id, osm, { missingInOsm, added, skipped }) {
  console.log(`✔ ${id}: OSM индекс (${osm.fetched ?? 'датум непознат'}), додато улица без правила: ${added}`);
  const lines = (items) => items.map((s) => `    • ${s}`).join('\n');
  if (missingInOsm.length) {
    console.warn(`! ${id}: улице из Sheet-а без пара у OSM-у (проверите писање или освежите индекс):\n${lines(missingInOsm)}`);
  }
  if (skipped.length) {
    console.warn(`! ${id}: улице из OSM-а које су прескочене:\n${lines(skipped)}`);
  }
}

// A place without coordinates still works (navigation falls back to the address text), so this is
// a warning here; report.py (#9) makes a capital without coordinates critical because it seeds the drawing.
function reportPlaces(id, count, missing) {
  console.log(`✔ ${id}: тачака: ${count}, са координатама: ${count - missing.length}`);
  if (missing.length) {
    const lines = missing.map((p) => `    • ${p.name}: ${p.address}`).join('\n');
    console.warn(`! ${id}: тачке без координата (покрените: python data-pipeline/geocode.py --city ${id}):\n${lines}`);
  }
}

const credentials = process.env.GOOGLE_SERVICE_ACCOUNT;
const citiesJson = process.env.SHEETS_CITIES;

if (!credentials || !citiesJson) {
  if (process.env.PIPELINE_REQUIRED === '1') {
    fail('Недостају GOOGLE_SERVICE_ACCOUNT и SHEETS_CITIES; деплој не сме да користи демо податке.');
  }
  console.warn('! GOOGLE_SERVICE_ACCOUNT/SHEETS_CITIES нису постављени: користе се демо подаци (само за локални развој).');
  const seed = spawnSync(process.execPath, ['scripts/seed-demo-data.mjs'], { stdio: 'inherit' });
  process.exit(seed.status ?? 1);
}

const cities = parseCities(citiesJson);
const token = await getAccessToken(parseCredentials(credentials)).catch((e) => fail(e.message));
const updated = new Date().toISOString().slice(0, 10);

mkdirSync(OUT_DIR, { recursive: true });
const written = [];
let failed = false;

for (const c of cities) {
  try {
    const [territoriesRaw, rulesRaw, placesRaw] = await Promise.all([
      fetchSheet(token, c.sheetId, 'Територије'),
      fetchSheet(token, c.sheetId, 'Правила'),
      fetchSheet(token, c.sheetId, 'Тачке', { optional: true }),
    ]);
    let data = buildCity({
      city: c.id, name: c.name, reportEmail: c.reportEmail, updated, territoriesRaw, rulesRaw, placesRaw,
    });
    if (placesRaw === null) {
      console.warn(`! ${c.id}: нема листа „Тачке“; картице неће имати престоницу.`);
    } else {
      const geocoded = attachCoordinates(data, loadGeocodeCache(c.id));
      data = geocoded.data;
      reportPlaces(c.id, data.places.length, geocoded.missing);
    }
    const osm = loadOsmStreets(c.id);
    if (osm) {
      const merged = mergeOsmStreets(data, osm.streets);
      data = merged.data;
      reportOsm(c.id, osm, merged.report);
    } else {
      console.warn(`! ${c.id}: нема OSM индекса улица; претрага познаје само улице из Sheet-а. `
        + `Покрените: python data-pipeline/streets.py --city ${c.id}`);
    }
    written.push({ id: c.id, name: c.name, data });
  } catch (e) {
    failed = true;
    console.error(`\n✖ ${c.id}: ${e.message}`);
  }
}

// Nothing is written unless every city is valid, so a bad Sheet never yields a partial deploy.
if (failed) fail('Билд прекинут: исправите Sheet.');

for (const { id, data } of written) {
  writeFileSync(`${OUT_DIR}/${id}.json`, JSON.stringify(data, null, 2) + '\n');
  if (data.places.length) writePlacesInput(data); // input of geocode.py
}
writeFileSync(
  `${OUT_DIR}/cities.json`,
  JSON.stringify(written.map(({ id, name }) => ({ id, name })), null, 2) + '\n',
);
console.log(`✔ подаци из Sheet-а: ${written.map((w) => w.id).join(', ')} → ${OUT_DIR}/`);
