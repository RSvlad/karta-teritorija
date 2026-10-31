// Input of data-pipeline/territories.py: the Sheet's "Обим" tab plus the capitals' coordinates.
// Pure (apart from the writer), so it can be checked without network access.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PipelineError, readTable } from './build-city.mjs';

const WORK_DIR = 'data-pipeline/work';

/**
 * -> { input, geocodedCapitals }. `input` is the territories-input.json payload of territories.py:
 * every territory with its capital's coordinates (when geocoded) and one scope row per "Обим" row.
 * Throws PipelineError for rows that point at an unknown territory.
 */
export function buildTerritoriesInput(data, scopeRaw) {
  const problems = [];
  const rows = readTable('scope', 'Обим', scopeRaw, problems);
  const ids = new Set(data.territories.map((t) => t.id));
  const scope = [];
  for (const { row, values: v } of rows) {
    if (!v.territory || !v.street) {
      problems.push(`Обим, ред ${row}: попуните територију и улицу`);
    } else if (!ids.has(v.territory)) {
      problems.push(`Обим, ред ${row}: територија „${v.territory}“ не постоји у листу „Територије“`);
    } else {
      scope.push({ territory: v.territory, street: v.street, settlement: v.settlement, from: v.from, to: v.to });
    }
  }
  if (problems.length) throw new PipelineError(problems);

  const capitals = new Map(
    data.places
      .filter((p) => p.kind === 'capital' && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map((p) => [p.territoryId, { lat: p.lat, lng: p.lng }]),
  );
  const territories = data.territories.map((t) => (capitals.has(t.id) ? { id: t.id, capital: capitals.get(t.id) } : { id: t.id }));
  return { input: { territories, scope }, geocodedCapitals: capitals.size };
}

/** data-pipeline/work/<city>/territories-input.json (git-ignored: it comes from the private Sheet). */
export function writeTerritoriesInput(city, input, dir = WORK_DIR) {
  const out = `${dir}/${city}/territories-input.json`;
  mkdirSync(`${dir}/${city}`, { recursive: true });
  writeFileSync(out, JSON.stringify(input, null, 2) + '\n');
  return out;
}
