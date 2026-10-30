// Build step (runs as `prebuild`): private Google Sheet -> public/data/*.json.
//
// Config (environment):
//   GOOGLE_SERVICE_ACCOUNT  service-account key JSON (GitHub secret)
//   SHEETS_CITIES           JSON array: [{ "id": "novi-sad", "name": "Нови Сад", "sheetId": "…", "reportEmail": "…" }]
//   PIPELINE_REQUIRED=1     fail instead of falling back to the demo seed (set for deploys)
//
// Without config the fictional demo data is used, for local development only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildCity } from './lib/build-city.mjs';
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
    const [territoriesRaw, rulesRaw] = await Promise.all([
      fetchSheet(token, c.sheetId, 'Територије'),
      fetchSheet(token, c.sheetId, 'Правила'),
    ]);
    const data = buildCity({
      city: c.id, name: c.name, reportEmail: c.reportEmail, updated, territoriesRaw, rulesRaw,
    });
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
}
writeFileSync(
  `${OUT_DIR}/cities.json`,
  JSON.stringify(written.map(({ id, name }) => ({ id, name })), null, 2) + '\n',
);
console.log(`✔ подаци из Sheet-а: ${written.map((w) => w.id).join(', ')} → ${OUT_DIR}/`);
