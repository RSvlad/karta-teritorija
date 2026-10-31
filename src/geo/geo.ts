export interface Geometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: number[][][] | number[][][][];
}

export const polygonsOf = (g: Geometry): number[][][][] =>
  g.type === 'Polygon' ? [g.coordinates as number[][][]] : (g.coordinates as number[][][][]);

/** Ray casting: is the point inside the ring? (GeoJSON order: [lng, lat]) */
function inRing(ring: number[][], lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi! > lat !== yj! > lat && lng < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

/** Point in (Multi)Polygon: inside an outer ring and outside all of its holes. */
export function containsPoint(g: Geometry, lng: number, lat: number): boolean {
  return polygonsOf(g).some(
    ([outer, ...holes]) => !!outer && inRing(outer, lng, lat) && !holes.some((h) => inRing(h, lng, lat)),
  );
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

/** "350 m" below a kilometre, else "1,4 km". */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

/** The item closest to the given point among those that have coordinates, with the distance in metres; null if none has any. */
export function nearest<T extends { lat?: number; lng?: number }>(
  items: readonly T[],
  from: { lat: number; lng: number },
): { item: T; meters: number } | null {
  let best: { item: T; meters: number } | null = null;
  for (const item of items) {
    if (item.lat === undefined || item.lng === undefined) continue;
    const meters = distanceMeters(from, { lat: item.lat, lng: item.lng });
    if (!best || meters < best.meters) best = { item, meters };
  }
  return best;
}
