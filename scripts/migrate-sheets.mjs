// One-off migration: per-city Sheets (old SHEETS_CITIES) -> CSV files for the central Sheet (SHEETS_ID).
// Writes data-pipeline/work/migration/<Лист>.csv (git-ignored: private data), one file per tab, each data row
// with the city id in a new first column "град", plus Градови.csv. Nothing is written to Google.
//
//   GOOGLE_SERVICE_ACCOUNT=... SHEETS_CITIES=... node scripts/migrate-sheets.mjs
//
// Then, in the new Sheet: File → Import → Upload → "Insert new sheet(s)", with "Convert text to numbers, dates
// and formulas" switched OFF (ids such as 01 and the ажурирано date must stay text). Name every tab exactly like
// the file. See README, "Пренос са Sheet-ова по граду".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchModifiedDate, fetchSheet, getAccessToken, parseCredentials, DRIVE_METADATA_SCOPE, SHEETS_SCOPE } from '../data-pipeline/lib/sheets.mjs';

const OUT = 'data-pipeline/work/migration';
const TABS = ['Територије', 'Правила', 'Тачке', 'Обим', 'Границе'];

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

// Only what cities.yml gives us per city: place and settlement_admin_levels (flat file, written by hand).
function readCitiesYml(path = 'data-pipeline/cities.yml') {
  const out = {};
  if (!existsSync(path)) return out;
  let id = null;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const key = line.match(/^([a-z0-9-]+):\s*$/);
    if (key) { id = key[1]; out[id] = {}; continue; }
    const field = id && line.match(/^\s+(place|settlement_admin_levels):\s*(.+?)\s*(#.*)?$/);
    if (field) out[id][field[1]] = field[2];
  }
  return out;
}

const credentials = process.env.GOOGLE_SERVICE_ACCOUNT;
const citiesJson = process.env.SHEETS_CITIES;
if (!credentials || !citiesJson) {
  console.error('✖ Потребни су GOOGLE_SERVICE_ACCOUNT и SHEETS_CITIES (стари, по граду).');
  process.exit(1);
}
const cities = JSON.parse(citiesJson);
const key = parseCredentials(credentials);
const token = await getAccessToken(key, undefined, `${SHEETS_SCOPE} ${DRIVE_METADATA_SCOPE}`);
const yml = readCitiesYml();

mkdirSync(OUT, { recursive: true });
const merged = Object.fromEntries(TABS.map((t) => [t, null]));
const cityRows = [['ид', 'назив', 'place', 'насеља', 'reportEmail', 'ажурирано']];

for (const c of cities) {
  for (const title of TABS) {
    const raw = await fetchSheet(token, c.sheetId, title, { optional: title !== 'Територије' && title !== 'Правила' });
    if (raw === null) continue;
    const [header = [], ...body] = raw;
    merged[title] ??= [['град', ...header]];
    if (merged[title][0].slice(1).join('\u0000') !== header.join('\u0000')) {
      console.warn(`! ${c.id}: колоне листа „${title}“ су другачије од првог града; проверите ${title}.csv након увоза.`);
    }
    for (const row of body) if (row.some((v) => String(v).trim() !== '')) merged[title].push([c.id, ...row]);
  }
  const updated = await fetchModifiedDate(token, c.sheetId).catch(() => null);
  const levels = (yml[c.id]?.settlement_admin_levels ?? '').replace(/[[\]]/g, '').replace(/\s/g, '');
  cityRows.push([c.id, c.name, yml[c.id]?.place ?? '', levels, c.reportEmail ?? '', updated ?? '']);
  console.log(`✔ ${c.id}`);
}

writeFileSync(`${OUT}/Градови.csv`, toCsv(cityRows));
for (const [title, rows] of Object.entries(merged)) {
  if (rows) writeFileSync(`${OUT}/${title}.csv`, toCsv(rows));
}
console.log(`\nГотово: ${OUT}/ (${Object.entries(merged).filter(([, r]) => r).map(([t]) => t).concat('Градови').join(', ')}).`);
