import type { Map as MapLibreMap } from 'maplibre-gl';
import { polygonsOf } from '../geo/geo';
import type { Geometry } from '../geo/geo';
import { projectTerritory } from '../geo/svgMap';
import type { SvgMap } from '../geo/svgMap';
import { STYLE_URL } from './mapStyle';

/** A basemap picture and the territory drawn in the very same frame, so the two line up exactly. */
export interface Basemap {
  image: string;
  drawing: SvgMap;
}

const TIMEOUT_MS = 10_000;

/**
 * Renders the basemap under one territory into a width x height picture, for printing: MapLibre draws into an
 * off-screen element, is framed on the territory (and its capital), and its canvas is copied out as a JPEG.
 * The border and the capital are projected by the map itself, so they cannot drift from the picture.
 * MapLibre is loaded on first use. Throws when the map cannot be drawn (no WebGL, style or tiles unreachable);
 * the caller then keeps the plain vector drawing.
 */
export async function renderBasemap(
  geometries: readonly Geometry[],
  capital: { lat: number; lng: number } | undefined,
  width: number,
  height: number,
  pad: number,
): Promise<Basemap | null> {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const take = (lng: number, lat: number) => {
    west = Math.min(west, lng); east = Math.max(east, lng);
    south = Math.min(south, lat); north = Math.max(north, lat);
  };
  for (const g of geometries) for (const poly of polygonsOf(g)) for (const ring of poly) for (const [lng, lat] of ring) take(lng!, lat!);
  if (capital) take(capital.lng, capital.lat);
  if (!Number.isFinite(west)) return null;

  const [maplibregl, worker] = await Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'),
    import('maplibre-gl/dist/maplibre-gl.css'),
  ]);
  maplibregl.setWorkerUrl(worker.default);

  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;`;
  document.body.appendChild(box);
  let map: MapLibreMap | undefined;
  try {
    map = new maplibregl.Map({
      container: box,
      style: STYLE_URL,
      bounds: [[west, south], [east, north]],
      fitBoundsOptions: { padding: pad, animate: false, maxZoom: 17 },
      interactive: false,
      attributionControl: false,
      fadeDuration: 0, // labels fully drawn at the first idle
      pixelRatio: 2, // sharp on paper
      canvasContextAttributes: { preserveDrawingBuffer: true }, // otherwise the canvas reads back empty
    });
    const m = map;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Basemap timed out')), TIMEOUT_MS);
      m.once('idle', () => { clearTimeout(timer); resolve(); });
    });

    const drawing = projectTerritory(geometries, capital, width, height, pad, (lng, lat) => {
      const p = m.project([lng, lat]);
      return { x: p.x, y: p.y };
    });
    if (!drawing) return null;
    const image = m.getCanvas().toDataURL('image/jpeg', 0.85);
    // Decoded now, so it is ready when the print dialog opens.
    const img = new Image();
    img.src = image;
    await img.decode().catch(() => undefined);
    return { image, drawing };
  } finally {
    map?.remove();
    box.remove();
  }
}
