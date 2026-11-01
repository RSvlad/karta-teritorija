import { useEffect, useRef, useState } from 'preact/hooks';
import type { Resolver } from '../resolver';
import { projectTerritory, starPoints } from '../geo/svgMap';
import type { Geometry } from '../geo/geo';
import { renderBasemap } from './printBasemap';
import type { Basemap } from './printBasemap';

interface Feature {
  properties: { id?: string };
  geometry: Geometry;
}

// One request per city, shared by every card on the page. A failure is not cached, so the next card tries again.
const loaded = new Map<string, Promise<Feature[]>>();

function loadFeatures(cityId: string): Promise<Feature[]> {
  let p = loaded.get(cityId);
  if (!p) {
    p = fetch(`data/${encodeURIComponent(cityId)}.territories.geojson`)
      .then((r) => (r.ok ? (r.json() as Promise<{ features?: Feature[] }>) : { features: [] })) // 404: borders not drawn yet
      .then((c) => c.features ?? []);
    p.catch(() => loaded.delete(cityId));
    loaded.set(cityId, p);
  }
  return p.catch(() => []);
}

const W = 600, H = 400, PAD = 24;
let nextId = 0;

// Basemaps are drawn on demand (see preparePrintMaps), once per territory and capital, and shared by every card.
// A failure is not cached, so the next print tries again.
const ready = new Map<string, Basemap>();
const inflight = new Map<string, Promise<Basemap | null>>();
const cards = new Set<{ root: HTMLElement; run: () => Promise<void> }>();

type Point = { lat: number; lng: number };
const keyOf = (cityId: string, id: string, point: Point | undefined) => `${cityId}|${id}|${point ? `${point.lat},${point.lng}` : ''}`;

/**
 * Draws the basemaps under the territory maps inside `scope` (the card about to be printed) and waits for them,
 * so call it before window.print(). Best effort: a map that cannot be drawn (offline, no WebGL, slow tiles) is simply
 * left out and that territory prints as the plain drawing.
 */
export async function preparePrintMaps(scope: HTMLElement): Promise<void> {
  await Promise.allSettled([...cards].filter((c) => scope.contains(c.root)).map((c) => c.run()));
  await new Promise((resolve) => setTimeout(resolve, 50)); // the cards re-render with the pictures before the print dialog opens
}

/**
 * Print-only maps of territories: the border drawn as vectors over a basemap, with the capital marked by a star.
 * The basemap is a picture of the quiet light map (the same style as the map panel); the border, hatch and star are
 * drawn on top and read in black and white: the fill is a hatch over a light tint, and the colour is always paired
 * with the territory's name in the caption. Without a basemap (not prepared, offline) the border is drawn alone on
 * white. A territory without a drawn polygon gets no map (the card prints as before); a capital without coordinates
 * is not drawn (its address is on the card).
 */
export function PrintMaps({ cityId, territoryIds, resolver }: { cityId: string; territoryIds: readonly string[]; resolver: Resolver }) {
  const [features, setFeatures] = useState<Feature[]>([]);
  const [, redraw] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const uid = useRef(`pm${nextId++}`);

  const inputsFor = (id: string, all: readonly Feature[]) => {
    const territory = resolver.territories.get(id);
    if (!territory) return null;
    const capital = resolver.capitalOf(id);
    const point = capital && capital.lat !== undefined && capital.lng !== undefined ? { lat: capital.lat, lng: capital.lng } : undefined;
    const geometries = all.filter((f) => String(f.properties.id ?? '') === id).map((f) => f.geometry);
    return { territory, capital, point, geometries };
  };

  // Called by the print button through preparePrintMaps; always the latest props.
  const prepare = useRef<() => Promise<void>>(async () => undefined);
  prepare.current = async () => {
    const all = await loadFeatures(cityId);
    await Promise.all(territoryIds.map(async (id) => {
      const input = inputsFor(id, all);
      if (!input || input.geometries.length === 0) return;
      const key = keyOf(cityId, id, input.point);
      if (ready.has(key)) return;
      let p = inflight.get(key);
      if (!p) {
        p = renderBasemap(input.geometries, input.point, W, H, PAD);
        inflight.set(key, p);
        p.then((b) => { if (b) ready.set(key, b); }).catch(() => undefined).finally(() => inflight.delete(key));
      }
      await p.catch(() => undefined);
    }));
    redraw((n) => n + 1);
  };

  useEffect(() => {
    let alive = true;
    loadFeatures(cityId).then((f) => { if (alive) setFeatures(f); });
    return () => { alive = false; };
  }, [cityId]);

  useEffect(() => {
    const card = { root: root.current!, run: () => prepare.current() };
    cards.add(card);
    return () => { cards.delete(card); };
  }, []);

  const figures = territoryIds.flatMap((id, i) => {
    const input = inputsFor(id, features);
    if (!input) return [];
    const base = ready.get(keyOf(cityId, id, input.point));
    const drawing = base?.drawing ?? projectTerritory(input.geometries, input.point, W, H, PAD);
    return drawing ? [{ i, territory: input.territory, capital: input.capital, drawing, base }] : [];
  });
  // Always rendered (empty when there is nothing to draw) so the print button can find the card's maps.
  if (figures.length === 0) return <div class="print-maps" ref={root} />;

  return (
    <div class="print-maps" ref={root}>
      {figures.map(({ i, territory, capital, drawing, base }) => {
        const hatch = `${uid.current}-${i}`;
        const c = drawing.capital;
        const right = c !== null && c.x > W * 0.6; // label on the side with more room
        return (
          <figure key={territory.id} class="print-map">
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Мапа територије ${territory.id} „${territory.name}“`}>
              <defs>
                <pattern id={hatch} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="8" stroke="#000" stroke-width="1.2" />
                </pattern>
              </defs>
              {base && <image href={base.image} x="0" y="0" width={W} height={H} />}
              <path d={drawing.d} fill-rule="evenodd" fill={territory.color} fill-opacity={base ? 0.18 : 0.3} />
              <path d={drawing.d} fill-rule="evenodd" fill={`url(#${hatch})`} fill-opacity={base ? 0.3 : 0.55} stroke="#000" stroke-width="2.5" stroke-linejoin="round" />
              {c && (
                <>
                  <polygon points={starPoints(c.x, c.y, 15)} fill="#fff" stroke="#000" stroke-width="2.5" stroke-linejoin="round" />
                  {capital && (
                    <text
                      x={right ? c.x - 22 : c.x + 22} y={c.y + 5} text-anchor={right ? 'end' : 'start'}
                      font-size="16" font-weight="700" fill="#000" stroke="#fff" stroke-width="4" paint-order="stroke"
                    >
                      {capital.name}
                    </text>
                  )}
                </>
              )}
              {base && (
                <text x={W - 6} y={H - 6} text-anchor="end" font-size="10" fill="#000" stroke="#fff" stroke-width="3" paint-order="stroke">
                  © OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap
                </text>
              )}
            </svg>
            <figcaption>
              <span class="swatch" style={{ background: territory.color }} aria-hidden="true" />
              Територија {territory.id} „{territory.name}“{c && <> · <span aria-hidden="true">★ </span>престоница</>}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
