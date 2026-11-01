import { polygonsOf } from './geo';
import type { Geometry } from './geo';

export interface SvgMap {
  /** SVG path data of all rings of the territory (draw with fill-rule="evenodd" so holes stay empty). */
  d: string;
  /** The capital in the same drawing; null when it has no coordinates. */
  capital: { x: number; y: number } | null;
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** Maps a coordinate to a point of the drawing. */
export type Project = (lng: number, lat: number) => { x: number; y: number };

/**
 * Projects a territory (all its polygons) and its capital into a width x height drawing, scaled to fit with `pad` on
 * every side. Equirectangular, with longitude shortened by cos(latitude), which is exact enough for a city.
 * The capital is part of the frame, so it is visible even when it lies outside the polygons. Null: nothing to draw.
 * With `project` the drawing is placed by it instead (to line up with a basemap rendered in the same frame).
 */
export function projectTerritory(
  geometries: readonly Geometry[],
  capital: { lat: number; lng: number } | undefined,
  width: number,
  height: number,
  pad: number,
  project?: Project,
): SvgMap | null {
  const rings = geometries.flatMap((g) => polygonsOf(g).flat()).filter((r) => r.length >= 3);
  if (rings.length === 0) return null;

  let at: Project;
  if (project) {
    // The frame is decided by the caller (a basemap the drawing has to line up with); only the numbers are rounded.
    at = (lng, lat) => {
      const p = project(lng, lat);
      return { x: round(p.x), y: round(p.y) };
    };
  } else {
    const all: number[][] = rings.flat();
    if (capital) all.push([capital.lng, capital.lat]);
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [lng, lat] of all) {
      minLat = Math.min(minLat, lat!); maxLat = Math.max(maxLat, lat!);
      minLng = Math.min(minLng, lng!); maxLng = Math.max(maxLng, lng!);
    }

    const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const w = Math.max((maxLng - minLng) * kx, 1e-9), h = Math.max(maxLat - minLat, 1e-9);
    const scale = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
    const offX = (width - w * scale) / 2, offY = (height - h * scale) / 2;
    at = (lng, lat) => ({ x: round(offX + (lng - minLng) * kx * scale), y: round(offY + (maxLat - lat) * scale) });
  }

  const d = rings
    .map((ring) => `M${ring.map(([lng, lat]) => { const p = at(lng!, lat!); return `${p.x} ${p.y}`; }).join('L')}Z`)
    .join('');
  return { d, capital: capital ? at(capital.lng, capital.lat) : null };
}

/** Five-pointed star centred on (cx, cy), as SVG points. */
export function starPoints(cx: number, cy: number, outer: number): string {
  const inner = outer * 0.4;
  return Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    return `${round(cx + r * Math.cos(a))},${round(cy + r * Math.sin(a))}`;
  }).join(' ');
}
