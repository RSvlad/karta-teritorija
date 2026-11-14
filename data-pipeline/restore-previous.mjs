// Downloads the previously deployed data (public/data of the live site) into data-pipeline/work/previous, so
// build-data.mjs can (1) keep a city whose Sheet data is broken and (2) skip redrawing cities whose input is unchanged.
// Never fails the deploy: with nothing to restore (first deploy, site down) the build just does everything.
//
//   SITE_URL  address of the deployed site, e.g. https://owner.github.io/repo/
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { ID_PATTERN } from './lib/central.mjs';
import { profileHook } from '../profiles/load.mjs';

const site = (process.env.SITE_URL ?? '').replace(/\/?$/, '/');
const dir = process.env.PREVIOUS_DATA_DIR ?? 'data-pipeline/work/previous';

// Optional profiles/<name>/migrate-previous.mjs for a deployment whose published data has an older shape. It exports
// upgradeCityData(data) -> data (CityData of the old shape -> current) and previousGeojsonNames(id) -> [file names
// the borders were published under before]. It is deleted once a deploy has replaced the old data.
const migrate = await profileHook('migrate-previous.mjs');

async function get(path) {
  const res = await fetch(`${site}data/${path}`, { signal: AbortSignal.timeout(20000) });
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
}

// A file under its current name, else under one of the names the profile's migration lists.
async function getPrevious(name) {
  const body = await get(name);
  const id = name.endsWith('.territories.geojson') ? name.slice(0, -'.territories.geojson'.length) : null;
  if (body || id === null || !migrate?.previousGeojsonNames) return body;
  for (const old of migrate.previousGeojsonNames(id)) {
    const found = await get(old);
    if (found) return found;
  }
  return null;
}

// Upgrades CityData of an old shape; anything that is not parseable JSON is stored as it was.
function upgradeBody(name, body) {
  if (!migrate?.upgradeCityData || !name.endsWith('.json')) return body;
  try {
    return Buffer.from(JSON.stringify(migrate.upgradeCityData(JSON.parse(body.toString('utf8')))));
  } catch {
    return body;
  }
}

if (!process.env.SITE_URL) {
  console.warn('! SITE_URL није постављен: претходни подаци се не преузимају.');
  process.exit(0);
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
try {
  const list = await get('cities.json');
  if (!list) {
    console.warn(`! ${site}data/cities.json се не може преузети (први деплој?): нема претходних података.`);
    process.exit(0);
  }
  const ids = JSON.parse(list.toString('utf8')).map((c) => c.id).filter((id) => ID_PATTERN.test(String(id)));
  let restored = 0;
  for (const id of ids) {
    for (const name of [`${id}.json`, `${id}.territories.geojson`]) {
      const body = await getPrevious(name);
      if (body) {
        writeFileSync(`${dir}/${name}`, upgradeBody(name, body));
        restored += 1;
      }
    }
  }
  const state = await get('build-state.json');
  if (state) writeFileSync(`${dir}/build-state.json`, state);
  console.log(`✔ претходни подаци: градова ${ids.length}, датотека ${restored}${state ? ', са build-state.json' : ''}`);
} catch (e) {
  console.warn(`! претходни подаци се не могу преузети (${e.message}); билд ради без њих.`);
}
