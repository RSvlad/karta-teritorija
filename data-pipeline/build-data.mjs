// Build step (runs as `prebuild`): private central Google Sheet -> public/data/*.json.
//
// Config (environment):
//   GOOGLE_SERVICE_ACCOUNT  service-account key JSON (GitHub secret)
//   SHEETS_ID               id of the one Sheet that holds every city (GitHub secret)
//   PIPELINE_REQUIRED=1     fail instead of falling back to the demo seed (set for deploys)
//
// The Sheet has a "Градови" tab (id, назив, place, насеља, reportEmail, ажурирано) and the data tabs
// "Територије", "Правила" and optionally "Тачке", "Обим", "Границе", each with a "град" column (lib/central.mjs).
// All tabs are read with two requests, however many cities there are.
//
// Without config the fictional demo data is used, for local development only.
// If data-pipeline/cache/<city>/streets.json exists (streets.py), its streets are added to the city.
// A city of cities.yml that is not in "Градови" but has that cache is still built, with its OSM streets only (lib/osm-only.mjs).
// The optional "Тачке" tab gives the capitals and other points; their coordinates come from
// data-pipeline/cache/<city>/geocode-cache.json (geocode.py), which reads work/<city>/places-input.json written here.
// The street rules ("Правила") alone feed data-pipeline/territories.py, which writes
// public/data/<city>.territories.geojson, the borders shown on the map. It needs Python (requirements.txt).
// (A city with both an "Обим" tab and geocoded capitals ("Тачке") is still drawn the older way, from the capitals.)
//
// A city with bad data does not stop the others: its previous deployed version (restored into
// data-pipeline/work/previous by restore-previous.mjs) is kept with a warning. A city whose border-relevant
// input is unchanged since the previous deploy (build-state.json) is not redrawn: territories.py is skipped.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildCity } from './lib/build-city.mjs';
import { fingerprint, parseCitiesTab, splitByCity } from './lib/central.mjs';
import { loadOsmStreets, mergeOsmStreets } from './lib/osm-index.mjs';
import { loadOsmOnlyCities } from './lib/osm-only.mjs';
import { attachCoordinates, loadGeocodeCache, writePlacesInput } from './lib/places.mjs';
import { fetchTabs, getAccessToken, parseCredentials } from './lib/sheets.mjs';
import { parseBoundaries, writeBoundaries } from './lib/boundaries.mjs';
import { buildRulesInput, buildTerritoriesInput, writeTerritoriesInput } from './lib/territories-input.mjs';

const OUT_DIR = 'public/data';
const PREVIOUS_DIR = process.env.PREVIOUS_DATA_DIR ?? 'data-pipeline/work/previous';
const REQUIRED_TABS = ['Градови', 'Територије', 'Правила'];
const OPTIONAL_TABS = ['Тачке', 'Обим', 'Границе'];

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// In GitHub Actions a warning annotation also shows on the run summary, not only in the log.
function annotate(message) {
  console.warn(`! ${message}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${message.replace(/\r?\n/g, '%0A')}`);
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

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const credentials = process.env.GOOGLE_SERVICE_ACCOUNT;
const sheetsId = process.env.SHEETS_ID;

if (!credentials || !sheetsId) {
  if (process.env.PIPELINE_REQUIRED === '1') {
    fail('Недостају GOOGLE_SERVICE_ACCOUNT и SHEETS_ID; деплој не сме да користи демо податке.');
  }
  console.warn('! GOOGLE_SERVICE_ACCOUNT/SHEETS_ID нису постављени: користе се демо подаци (само за локални развој).');
  const seed = spawnSync(process.execPath, ['scripts/seed-demo-data.mjs'], { stdio: 'inherit' });
  process.exit(seed.status ?? 1);
}

const key = parseCredentials(credentials);
const token = await getAccessToken(key).catch((e) => fail(e.message));
const buildDate = new Date().toISOString().slice(0, 10);

// ── Read everything once, then group by city in memory ────────────────────────────────────────────────────
const tabs = await fetchTabs(token, sheetsId, [...REQUIRED_TABS, ...OPTIONAL_TABS]).catch((e) => fail(e.message));
const structural = []; // errors that cannot be blamed on one city: they stop the build
for (const title of REQUIRED_TABS) {
  if (tabs[title] === null) structural.push(`нема листа „${title}“ у Sheet-у`);
}
const cities = tabs['Градови'] ? parseCitiesTab(tabs['Градови'], structural) : [];
const cityIds = new Set(cities.map((c) => c.id));
const byTab = {};
for (const title of [...REQUIRED_TABS.slice(1), ...OPTIONAL_TABS]) {
  byTab[title] = splitByCity(tabs[title], title, cityIds, structural);
}
if (structural.length) fail(`Билд прекинут: исправите Sheet.\n${structural.map((p) => `  • ${p}`).join('\n')}`);

// What streets.py needs from the Sheet instead of cities.yml (git-ignored: work/).
mkdirSync('data-pipeline/work', { recursive: true });
writeFileSync(
  'data-pipeline/work/cities.json',
  JSON.stringify(
    Object.fromEntries(
      cities.filter((c) => c.place).map((c) => [c.id, { name: c.name, place: c.place, settlement_admin_levels: c.levels }]),
    ),
    null,
    2,
  ) + '\n',
);

mkdirSync(OUT_DIR, { recursive: true });
const previousState = readJson(`${PREVIOUS_DIR}/build-state.json`)?.cities ?? {};
const state = {};
const written = [];
const kept = [];
const dropped = [];
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

// Copies the previous deployed files of a city. Returns false when there is no previous version.
function keepPrevious(id) {
  const data = `${PREVIOUS_DIR}/${id}.json`;
  if (!existsSync(data)) return false;
  copyFileSync(data, `${OUT_DIR}/${id}.json`);
  const geo = `${PREVIOUS_DIR}/${id}.territories.geojson`;
  if (existsSync(geo)) copyFileSync(geo, `${OUT_DIR}/${id}.territories.geojson`);
  if (previousState[id]) state[id] = previousState[id];
  return true;
}

for (const c of cities) {
  try {
    // A city without rows in an optional tab behaves as if it had no such tab.
    const pick = (title, optional = false) => {
      const table = byTab[title]?.get(c.id) ?? null;
      return optional && (!table || table.length < 2) ? null : table;
    };
    const territoriesRaw = pick('Територије');
    const rulesRaw = pick('Правила');
    const placesRaw = pick('Тачке', true);
    const scopeRaw = pick('Обим', true);
    const boundsRaw = pick('Границе', true);
    // `updated` drives the stale-data warning (#17): the "ажурирано" column of "Градови", edited by hand when
    // the city's data is checked. The build date would make neglected data look fresh, so it is only a fallback.
    let updated = c.updated;
    if (!updated) {
      updated = buildDate;
      console.warn(`! ${c.id}: у листу „Градови“ нема датума „ажурирано“; као „ажурирано“ користи се датум билда, `
        + 'па упозорење о застарелим подацима неће радити.');
    }
    let data = buildCity({
      city: c.id, name: c.name, reportEmail: c.reportEmail, updated, territoriesRaw, rulesRaw, placesRaw,
    });
    if (placesRaw === null) {
      console.warn(`! ${c.id}: нема редова у листу „Тачке“; картице неће имати престоницу.`);
    } else {
      const geocoded = attachCoordinates(data, loadGeocodeCache(c.id));
      data = geocoded.data;
      reportPlaces(c.id, data.places.length, geocoded.missing);
      writePlacesInput(data); // input of geocode.py
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
    // Borders are drawn from the street rules alone (territories.py, "streets" mode). Only a city that has both
    // the "Обим" tab and geocoded capitals keeps the older capital-and-scope drawing.
    let drawing = null;
    const hasCapitals = data.places.some((p) => p.kind === 'capital' && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (data.territories.length === 0) {
      console.warn(`! ${c.id}: нема територија у листу „Територије“; границе се не цртају.`);
    } else if (!existsSync(`data-pipeline/cache/${c.id}/network.json`)) {
      console.warn(`! ${c.id}: нема уличне мреже; територије се не цртају `
        + `(покрените: python data-pipeline/territories.py --city ${c.id} --refresh и комитујте network.json).`);
    } else if (scopeRaw !== null && hasCapitals) {
      drawing = buildTerritoriesInput(data, scopeRaw).input;
    } else {
      drawing = buildRulesInput(data);
    }
    const boundaries = parseBoundaries(boundsRaw, new Set(data.territories.map((t) => t.id)));

    if (drawing) {
      const geoOut = `${OUT_DIR}/${c.id}.territories.geojson`;
      const geoPrevious = `${PREVIOUS_DIR}/${c.id}.territories.geojson`;
      const print = fingerprint(
        key.private_key,
        { city: c.id, tables: { rules: rulesRaw, territories: territoriesRaw, places: placesRaw, scope: scopeRaw, bounds: boundsRaw } },
        [
          `data-pipeline/cache/${c.id}/network.json`,
          `data-pipeline/cache/${c.id}/geocode-cache.json`,
          `data-pipeline/cache/${c.id}/streets.json`,
          'data-pipeline/territories.py',
          'data-pipeline/lib/territories-input.mjs',
        ],
      );
      if (previousState[c.id]?.fingerprint === print && existsSync(geoPrevious)) {
        copyFileSync(geoPrevious, geoOut);
        console.log(`✔ ${c.id}: улаз за границе је непромењен, узете границе из претходног деплоја (territories.py прескочен)`);
      } else {
        writeTerritoriesInput(c.id, drawing);
        const hand = writeBoundaries(c.id, boundaries);
        if (hand) console.log(`✔ ${c.id}: ручних граница из листа „Границе“: ${hand}`);
        const run = spawnSync(python, ['data-pipeline/territories.py', '--city', c.id], {
          stdio: 'inherit',
          env: { ...process.env, PYTHONUTF8: '1' },
        });
        if (run.error) {
          throw new Error(`${python} се не може покренути (${run.error.message}); потребно је: pip install -r data-pipeline/requirements.txt`);
        }
        if (run.status !== 0) {
          rmSync(geoOut, { force: true });
          throw new Error(`цртање територија није успело (излаз ${run.status}), погледајте поруку изнад.`);
        }
      }
      state[c.id] = { fingerprint: print };
    }
    writeFileSync(`${OUT_DIR}/${c.id}.json`, JSON.stringify(data, null, 2) + '\n');
    written.push(c);
  } catch (e) {
    console.error(`\n✖ ${c.id}: ${e.message}`);
    delete state[c.id];
    const firstLine = e.message.split('\n')[0];
    if (keepPrevious(c.id)) {
      kept.push(c);
      annotate(`${c.id}: подаци имају грешке, задржана је претходна верзија града (остали градови се објављују). ${firstLine}`);
    } else {
      dropped.push(c);
      annotate(`${c.id}: подаци имају грешке, а нема претходне верзије: град није објављен. ${firstLine}`);
    }
  }
}

if (written.length + kept.length === 0 && cities.length > 0) fail('Билд прекинут: ниједан град нема исправне податке.');

// Cities with an OSM street index but no row in "Градови" (cities.yml): searchable, every street "unassigned".
// A city that is in "Градови" is never replaced by its OSM-only version, even when its data is broken.
const osmOnly = loadOsmOnlyCities(cityIds, buildDate);
for (const { id, data, report } of osmOnly) {
  writeFileSync(`${OUT_DIR}/${id}.json`, JSON.stringify(data, null, 2) + '\n');
  console.log(`✔ ${id}: само улице из OSM-а (нема у листу „Градови“), улица: ${data.streets.length}`);
  if (report.skipped.length) console.warn(`! ${id}: прескочене улице: ${report.skipped.join('; ')}`);
}
const published = new Set([...written, ...kept].map((c) => c.id));
writeFileSync(
  `${OUT_DIR}/cities.json`,
  JSON.stringify(
    [...cities.filter((c) => published.has(c.id)), ...osmOnly].map(({ id, name }) => ({ id, name })),
    null,
    2,
  ) + '\n',
);
// Read by restore-previous.mjs in the next deploy. Public, so it holds only keyed fingerprints.
writeFileSync(`${OUT_DIR}/build-state.json`, JSON.stringify({ version: 1, cities: state }, null, 2) + '\n');
console.log(`✔ подаци из Sheet-а: ${written.map((w) => w.id).join(', ') || '—'} → ${OUT_DIR}/`);
if (kept.length) console.warn(`! задржана претходна верзија: ${kept.map((c) => c.id).join(', ')}`);
if (dropped.length) console.warn(`! није објављено (грешке, нема претходне верзије): ${dropped.map((c) => c.id).join(', ')}`);
