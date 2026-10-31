import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// Vite does not find MapLibre's worker by itself in a production build ("Worker failed to load"),
// so it is bundled as an asset and its URL is passed in explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CityData, Place, Resolver } from '../resolver';
import { containsPoint, polygonsOf } from '../geo/geo';
import type { Geometry } from '../geo/geo';

maplibregl.setWorkerUrl(workerUrl);

/** What the user picked on the map; the card for it is drawn by the caller. */
export type MapSelection = { kind: 'territory'; id: string } | { kind: 'place'; id: string };

// Quiet light basemap. OpenFreeMap is a free public service without an availability guarantee
// (see its terms); VITE_MAP_STYLE swaps it for a self-hosted style/PMTiles without code changes.
// tile.openstreetmap.org must not be used here.
const STYLE_URL = import.meta.env.VITE_MAP_STYLE || 'https://tiles.openfreemap.org/styles/positron';
const UNASSIGNED_COLOR = '#9e9e9e';
const FALLBACK_VIEW = { center: [20.46, 44.8] as [number, number], zoom: 6 }; // Serbia, until data arrives

interface Feature {
  type: 'Feature';
  properties: { id?: string; source?: string };
  geometry: Geometry;
}
interface Collection {
  type: 'FeatureCollection';
  features: Feature[];
}
type Bounds = [number, number, number, number]; // west, south, east, north

function boundsOf(features: Feature[]): Bounds | null {
  let b: Bounds | null = null;
  for (const f of features) {
    for (const poly of polygonsOf(f.geometry)) {
      for (const [lng, lat] of poly[0] ?? []) {
        b = b
          ? [Math.min(b[0], lng!), Math.min(b[1], lat!), Math.max(b[2], lng!), Math.max(b[3], lat!)]
          : [lng!, lat!, lng!, lat!];
      }
    }
  }
  return b;
}

/** Centroid of the largest outer ring: a stable spot for the territory label. */
function labelPoint(g: Geometry): [number, number] | null {
  let best: { area: number; point: [number, number] } | null = null;
  for (const poly of polygonsOf(g)) {
    const ring = poly[0];
    if (!ring || ring.length < 4) continue;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i]!, [x2, y2] = ring[i + 1]!;
      const cross = x1! * y2! - x2! * y1!;
      a += cross;
      cx += (x1! + x2!) * cross;
      cy += (y1! + y2!) * cross;
    }
    if (a === 0) continue;
    const area = Math.abs(a / 2);
    if (!best || area > best.area) best = { area, point: [cx / (3 * a), cy / (3 * a)] };
  }
  return best?.point ?? null;
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

interface PlaceMarker {
  place: Place;
  el: HTMLButtonElement;
}

interface Props {
  cityId: string;
  data: CityData;
  resolver: Resolver;
  selected: MapSelection | null;
  /** Show the smaller markers (collection points, other); capitals are always shown. */
  showPoints: boolean;
  /** Territories to show (filters); null = all. Layers, labels and markers of the others are hidden. */
  visible: ReadonlySet<string> | null;
  /** The user's GPS position, if they asked "Where am I?". It is only drawn, never stored or sent. */
  userPoint: { lat: number; lng: number } | null;
  /** Territory containing `userPoint` (null = outside all of them; `polygons` false = the map has none to look in). */
  onLocated: (territoryId: string | null, polygons: boolean) => void;
  onSelect: (s: MapSelection | null) => void;
}

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export default function MapView({ cityId, data, resolver, selected, showPoints, visible, userPoint, onLocated, onSelect }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<PlaceMarker[]>([]);
  const labelsRef = useRef<{ id: string; el: HTMLElement }[]>([]);
  const featuresRef = useRef<{ id: string; geometry: Geometry }[]>([]);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const boundsRef = useRef(new Map<string, Bounds>());
  // Listeners are registered once; they call the latest callback through the ref.
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const locatedRef = useRef(onLocated);
  locatedRef.current = onLocated;
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let map: maplibregl.Map | null = null;
    setStatus({ kind: 'loading' });

    (async () => {
      let collection: Collection;
      try {
        const r = await fetch(`data/${encodeURIComponent(cityId)}.territories.geojson`);
        if (r.status === 404) throw new Error('Мапа за овај град још није доступна.');
        if (!r.ok) throw new Error('Мапа тренутно није доступна.');
        collection = (await r.json()) as Collection;
      } catch (e) {
        if (!cancelled) setStatus({ kind: 'error', message: e instanceof Error && e.message.startsWith('Мапа') ? e.message : 'Мапа тренутно није доступна.' });
        return;
      }
      if (cancelled || !box.current) return;

      // Colours and names come from the Sheet data; a polygon without a known territory is "unassigned" grey.
      const features = collection.features.map((f) => {
        const id = String(f.properties.id ?? '');
        const territory = resolver.territories.get(id);
        return { ...f, properties: { id, color: territory?.color ?? UNASSIGNED_COLOR, assigned: !!territory } };
      });
      const bounds = boundsOf(features);
      featuresRef.current = features.filter((f) => f.properties.assigned).map((f) => ({ id: f.properties.id, geometry: f.geometry }));

      map = new maplibregl.Map({
        container: box.current,
        style: STYLE_URL,
        ...(bounds ? { bounds, fitBoundsOptions: { padding: 40, animate: false } } : FALLBACK_VIEW),
        attributionControl: false,
        cooperativeGestures: false,
      });
      mapRef.current = map;
      // The basemap style declares its own credit; the OSM credit is also stated explicitly.
      map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors' }));
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

      map.on('load', () => {
        if (cancelled || !map) return;
        map.addSource('territories', { type: 'geojson', data: { type: 'FeatureCollection', features } as never });
        map.addLayer({
          id: 'territories-fill', type: 'fill', source: 'territories',
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'assigned'], 0.35, 0.2] },
        });
        map.addLayer({
          id: 'territories-line', type: 'line', source: 'territories',
          paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 },
        });
        map.addLayer({
          id: 'territories-selected', type: 'line', source: 'territories',
          filter: ['==', ['get', 'id'], '\u0000'],
          paint: { 'line-color': '#1b1b1b', 'line-width': 4 },
        });
        map.on('mouseenter', 'territories-fill', () => { map!.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'territories-fill', () => { map!.getCanvas().style.cursor = ''; });
        map.on('click', (e) => {
          const hit = map!.queryRenderedFeatures(e.point, { layers: ['territories-fill'] })[0];
          const id = hit?.properties?.assigned ? String(hit.properties.id) : null;
          selectRef.current(id ? { kind: 'territory', id } : null);
        });
        setStatus({ kind: 'ready' });
      });

      // Territory labels (decoration; the territories are also listed as buttons next to the map).
      for (const f of features) {
        const t = resolver.territories.get(f.properties.id);
        const spot = t && labelPoint(f.geometry);
        const b = boundsOf([f]);
        if (b && t) boundsRef.current.set(t.id, b);
        if (!t || !spot) continue;
        const el = document.createElement('div');
        el.className = 'map-label';
        el.setAttribute('aria-hidden', 'true');
        el.textContent = `${t.id} ${t.name}`;
        new maplibregl.Marker({ element: el }).setLngLat(spot).addTo(map);
        labelsRef.current.push({ id: t.id, el });
      }

      // Capital = star, other points = smaller dot. Places the pipeline could not geocode have no marker.
      markersRef.current = [];
      for (const place of resolver.places) {
        if (place.lat === undefined || place.lng === undefined) continue;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `map-marker ${place.kind === 'capital' ? 'capital' : 'point'}`;
        el.textContent = place.kind === 'capital' ? '★' : '';
        el.style.setProperty('--tc', resolver.territories.get(place.territoryId)?.color ?? UNASSIGNED_COLOR);
        el.setAttribute('aria-label', `${place.kind === 'capital' ? 'Престоница' : 'Тачка'}: ${place.name}`);
        el.addEventListener('click', (ev) => {
          ev.stopPropagation(); // not a click on the territory underneath
          selectRef.current({ kind: 'place', id: place.id });
        });
        new maplibregl.Marker({ element: el }).setLngLat([place.lng, place.lat]).addTo(map);
        markersRef.current.push({ place, el });
      }
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      markersRef.current = [];
      labelsRef.current = [];
      featuresRef.current = [];
      userMarkerRef.current = null;
      boundsRef.current.clear();
    };
  }, [cityId, data]);

  // Layer switch for the smaller markers, and the territory filter for everything on the map.
  useEffect(() => {
    for (const { place, el } of markersRef.current) {
      el.hidden = (place.kind !== 'capital' && !showPoints) || (!!visible && !visible.has(place.territoryId));
    }
    for (const { id, el } of labelsRef.current) el.hidden = !!visible && !visible.has(id);
    const map = mapRef.current;
    if (!map || status.kind !== 'ready') return;
    const shown = visible ? ['in', ['get', 'id'], ['literal', [...visible]]] : null;
    map.setFilter('territories-fill', shown as never);
    map.setFilter('territories-line', shown as never);
  }, [showPoints, visible, status.kind]);

  // "Where am I?": the territory containing the point (same ids as the search), marker and camera.
  useEffect(() => {
    userMarkerRef.current?.remove();
    userMarkerRef.current = null;
    const map = mapRef.current;
    if (userPoint && status.kind === 'error') locatedRef.current(null, false); // no polygons to look in
    if (!userPoint || !map || status.kind !== 'ready') return;
    const hit = featuresRef.current.find((f) => containsPoint(f.geometry, userPoint.lng, userPoint.lat));
    const el = document.createElement('div');
    el.className = 'map-me';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Ваша локација');
    userMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([userPoint.lng, userPoint.lat]).addTo(map);
    const b = hit && boundsRef.current.get(hit.id);
    if (b) {
      map.fitBounds(
        [Math.min(b[0], userPoint.lng), Math.min(b[1], userPoint.lat), Math.max(b[2], userPoint.lng), Math.max(b[3], userPoint.lat)],
        { padding: 60, animate: !reducedMotion(), maxZoom: 16 },
      );
    } else {
      map.easeTo({ center: [userPoint.lng, userPoint.lat], zoom: Math.max(map.getZoom(), 13), duration: reducedMotion() ? 0 : 400 });
    }
    locatedRef.current(hit?.id ?? null, true);
  }, [userPoint, status.kind]);

  // Selection -> highlight and camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status.kind !== 'ready') return;
    map.setFilter('territories-selected', ['==', ['get', 'id'], selected?.kind === 'territory' ? selected.id : '\u0000']);
    for (const { place, el } of markersRef.current) {
      el.setAttribute('aria-pressed', String(selected?.kind === 'place' && selected.id === place.id));
    }
    const animate = !reducedMotion();
    if (selected?.kind === 'territory') {
      const b = boundsRef.current.get(selected.id);
      if (b) map.fitBounds(b, { padding: 60, animate, maxZoom: 16 });
    } else if (selected?.kind === 'place') {
      const p = resolver.places.find((x) => x.id === selected.id);
      if (p && p.lat !== undefined && p.lng !== undefined) map.easeTo({ center: [p.lng, p.lat], duration: animate ? 400 : 0 });
    }
  }, [selected?.kind, selected?.id, status.kind]);

  return (
    <div class="map-canvas-wrap">
      <div ref={box} class="map-canvas" />
      {status.kind === 'loading' && <p class="map-status muted" role="status">Учитавање мапе…</p>}
      {status.kind === 'error' && <p class="map-status error" role="alert">{status.message}</p>}
    </div>
  );
}
