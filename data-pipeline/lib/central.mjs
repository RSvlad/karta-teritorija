// The central Sheet: one spreadsheet for all cities. Every data tab has a "град" column (city id) and the
// "Градови" tab lists the cities. Pure (apart from fingerprint reading files), so it can be checked offline.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readTable } from './build-city.mjs';

export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CITY_COLUMN = ['град', 'city'];
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * "Градови" tab -> [{ id, name, place, levels, reportEmail, updated }] in Sheet order.
 * `levels` are OSM admin_level values of settlements (default [9]); `updated` is YYYY-MM-DD or ''.
 * Everything wrong is added to `problems` (the whole tab is shared configuration, so it stops the build).
 */
export function parseCitiesTab(raw, problems) {
  const rows = readTable('cities', 'Градови', raw, problems);
  const seen = new Set();
  const cities = [];
  for (const { row, values: v } of rows) {
    const where = `Градови, ред ${row}`;
    if (!ID_PATTERN.test(v.id)) {
      problems.push(`${where}: ид града „${v.id}“ мора бити облика novi-sad`);
      continue;
    }
    if (seen.has(v.id)) problems.push(`${where}: ид „${v.id}“ се понавља`);
    seen.add(v.id);
    if (!v.name) problems.push(`${where}: нема назива`);
    let levels = [9];
    if (v.levels) {
      levels = v.levels.split(/[,;\s]+/).filter(Boolean).map(Number);
      if (!levels.every((n) => Number.isInteger(n) && n > 0)) {
        problems.push(`${where}: насеља „${v.levels}“ морају бити цели бројеви раздвојени зарезом (OSM admin_level, нпр. 9)`);
        levels = [9];
      }
    }
    if (v.updated && (!/^\d{4}-\d{2}-\d{2}$/.test(v.updated) || Number.isNaN(Date.parse(v.updated)))) {
      problems.push(`${where}: ажурирано „${v.updated}“ мора бити датум облика 2026-11-01 (колона као обичан текст)`);
    }
    cities.push({ id: v.id, name: v.name, place: v.place, levels, reportEmail: v.reportEmail, updated: v.updated });
  }
  if (rows.length === 0) problems.push('Градови: нема ниједног града');
  return cities;
}

/**
 * Splits a shared tab (header first, with a "град" column) into one table per city: Map(cityId -> raw).
 * Every known city gets a table (header only when it has no rows). Each table keeps `rowNumbers`, the
 * Sheet row of every body row, so errors name the real row. A row without a city, or with a city that is not
 * in "Градови", is added to `problems`; fully blank rows are ignored. `raw` null (no such tab) -> null.
 */
export function splitByCity(raw, title, cityIds, problems) {
  if (raw === null) return null;
  const [header = [], ...body] = raw;
  const col = header.findIndex((h) => CITY_COLUMN.includes(clean(h).toLowerCase()));
  const tables = new Map([...cityIds].map((id) => [id, Object.assign([header], { rowNumbers: [] })]));
  if (col < 0) {
    problems.push(`лист „${title}“: нема колоне „град“`);
    return tables;
  }
  body.forEach((cells, i) => {
    if (cells.every((c) => clean(c) === '')) return;
    const row = i + 2;
    const city = clean(cells[col]);
    if (!city) return void problems.push(`${title}, ред ${row}: нема града`);
    const table = tables.get(city);
    if (!table) return void problems.push(`${title}, ред ${row}: непознат град „${city}“ (није у листу „Градови“)`);
    table.push(cells);
    table.rowNumbers.push(row);
  });
  return tables;
}

/**
 * Fingerprint of everything that decides a city's territory borders: its rows, the files territories.py
 * and the input builders read, and the code itself. HMAC with a secret, because the result is published
 * (build-state.json) and a plain hash of private rows could be used to confirm guesses about them.
 */
export function fingerprint(secret, tables, files) {
  const h = createHmac('sha256', secret);
  h.update(JSON.stringify(tables));
  for (const file of files) {
    h.update(`\0${file}\0`);
    h.update(existsSync(file) ? readFileSync(file) : 'missing');
  }
  return h.digest('hex');
}
