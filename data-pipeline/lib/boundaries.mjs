// Hand-drawn territory borders from the Sheet's optional "Границе" tab (private data: never committed).
// Columns: територија (id), геометрија (GeoJSON Polygon/MultiPolygon, WGS84). They replace the automatic
// borders of territories.py, which reads them from data-pipeline/work/<city>/overrides/<id>.geojson.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { PipelineError } from './build-city.mjs';

const WORK_DIR = 'data-pipeline/work';

/** raw (2D array, header first) | null -> [{ id, geometry }]. Throws PipelineError on bad rows. */
export function parseBoundaries(raw, territoryIds) {
  if (!raw || raw.length < 2) return [];
  const head = raw[0].map((h) => String(h).trim().toLowerCase());
  const idCol = head.indexOf('територија');
  const geoCol = head.indexOf('геометрија');
  if (idCol < 0 || geoCol < 0) {
    throw new PipelineError(['Границе: недостају колоне „територија“ и „геометрија“']);
  }
  const problems = [];
  const out = new Map();
  raw.slice(1).forEach((r, i) => {
    const row = i + 2;
    const id = String(r[idCol] ?? '').trim();
    const text = String(r[geoCol] ?? '').trim();
    if (!id && !text) return;
    if (!territoryIds.has(id)) return void problems.push(`Границе, ред ${row}: територија „${id}“ не постоји у листу „Територије“`);
    let geometry;
    try {
      geometry = JSON.parse(text);
    } catch {
      return void problems.push(`Границе, ред ${row}: геометрија није исправан JSON`);
    }
    if (!['Polygon', 'MultiPolygon'].includes(geometry?.type)) {
      return void problems.push(`Границе, ред ${row}: геометрија мора бити Polygon или MultiPolygon`);
    }
    out.set(id, geometry);
  });
  if (problems.length) throw new PipelineError(problems);
  return [...out].map(([id, geometry]) => ({ id, geometry }));
}

/** data-pipeline/work/<city>/overrides/<id>.geojson (git-ignored). Stale files are removed first. */
export function writeBoundaries(city, boundaries, dir = WORK_DIR) {
  const target = `${dir}/${city}/overrides`;
  rmSync(target, { recursive: true, force: true });
  if (!boundaries.length) return 0;
  mkdirSync(target, { recursive: true });
  for (const { id, geometry } of boundaries) {
    const feature = { type: 'Feature', properties: { id }, geometry };
    writeFileSync(`${target}/${id}.geojson`, JSON.stringify({ type: 'FeatureCollection', features: [feature] }));
  }
  return boundaries.length;
}
