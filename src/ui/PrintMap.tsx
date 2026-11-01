import { useEffect, useRef, useState } from 'preact/hooks';
import type { Resolver } from '../resolver';
import { projectTerritory, starPoints } from '../geo/svgMap';
import type { Geometry } from '../geo/geo';

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

/**
 * Print-only maps of territories: a vector drawing of the border with the capital marked by a star.
 * It needs no network or tiles, prints sharply and reads in black and white: the fill is a hatch over a light tint,
 * and the colour is always paired with the territory's name in the caption. A territory without a drawn polygon
 * gets no map (the card prints as before); a capital without coordinates is not drawn (its address is on the card).
 */
export function PrintMaps({ cityId, territoryIds, resolver }: { cityId: string; territoryIds: readonly string[]; resolver: Resolver }) {
  const [features, setFeatures] = useState<Feature[]>([]);
  const uid = useRef(`pm${nextId++}`);

  useEffect(() => {
    let alive = true;
    loadFeatures(cityId).then((f) => { if (alive) setFeatures(f); });
    return () => { alive = false; };
  }, [cityId]);

  const figures = territoryIds.flatMap((id, i) => {
    const territory = resolver.territories.get(id);
    if (!territory) return [];
    const capital = resolver.capitalOf(id);
    const point = capital && capital.lat !== undefined && capital.lng !== undefined ? { lat: capital.lat, lng: capital.lng } : undefined;
    const drawing = projectTerritory(features.filter((f) => String(f.properties.id ?? '') === id).map((f) => f.geometry), point, W, H, PAD);
    return drawing ? [{ i, territory, capital, drawing }] : [];
  });
  if (figures.length === 0) return null;

  return (
    <div class="print-maps">
      {figures.map(({ i, territory, capital, drawing }) => {
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
              <path d={drawing.d} fill-rule="evenodd" fill={territory.color} fill-opacity="0.3" />
              <path d={drawing.d} fill-rule="evenodd" fill={`url(#${hatch})`} fill-opacity="0.55" stroke="#000" stroke-width="2.5" stroke-linejoin="round" />
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
