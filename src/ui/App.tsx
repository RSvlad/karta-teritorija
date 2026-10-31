import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createResolver, DataError, formatHouseNumber, formatRange, parseHouseNumber } from '../resolver';
import type { Assignment, CityData, HouseNumber, Place, Resolution, Resolver, Street } from '../resolver';
import { createSearch, hitId, hitName } from '../search/search';
import type { Hit } from '../search/search';
import { highlightParts } from '../search/highlight';
import { normalizeText } from '../search/normalize';
import { daysLabel, staleAgeDays } from './freshness';
import { useRoute } from './route';
import type { Route } from './route';
// Type only: MapView (and MapLibre with it) is loaded on demand by MapSection.
import type { MapSelection } from './MapView';

const CITY_KEY = 'moj-paroh:city';

/** Entry of data/cities.json (produced by the pipeline): the cities that have a data file. */
interface CityRef {
  id: string;
  name: string;
}

type Remote<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: T };

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Runs `load` whenever `key` changes. A result for an older key is never returned for the current one. */
function useRemote<T>(key: string, load: () => Promise<T>): Remote<T> {
  const [done, setDone] = useState<{ key: string; result: Exclude<Remote<T>, { status: 'loading' }> } | null>(null);
  useEffect(() => {
    let alive = true;
    load()
      .then((value) => ({ status: 'ready' as const, value }))
      .catch((e) => ({
        status: 'error' as const,
        message: e instanceof DataError ? e.message : 'Подаци тренутно нису доступни.',
      }))
      .then((result) => { if (alive) setDone({ key, result }); });
    return () => { alive = false; };
  }, [key]);
  return done && done.key === key ? done.result : { status: 'loading' };
}

/** City from the link if it exists, else the last chosen city if it still exists, else the first one in the list. */
function initialCity(cities: CityRef[], linked?: string): string {
  if (linked && cities.some((c) => c.id === linked)) return linked;
  try {
    const saved = localStorage.getItem(CITY_KEY);
    if (saved && cities.some((c) => c.id === saved)) return saved;
  } catch {
    // Storage can be blocked (private mode); fall back to the default.
  }
  return cities[0]!.id;
}

export function App() {
  const cities = useRemote('cities', () => fetchJson<CityRef[]>('data/cities.json'));
  if (cities.status === 'loading') return <main><p class="muted" role="status">Учитавање…</p></main>;
  if (cities.status === 'error') return <main><p class="error" role="alert">{cities.message}</p></main>;
  if (cities.value.length === 0) return <main><p class="error" role="alert">Нема доступних градова.</p></main>;
  return <Cities cities={cities.value} />;
}

function Cities({ cities }: { cities: CityRef[] }) {
  const [route, go] = useRoute();
  const [cityId, setCityId] = useState(() => initialCity(cities, route?.city));
  const city = useRemote(cityId, async () => {
    const data = await fetchJson<CityData>(`data/${encodeURIComponent(cityId)}.json`);
    return { data, resolver: createResolver(data) };
  });
  const current = cities.find((c) => c.id === cityId)!;

  // Back/Forward or a pasted link pointing at another city.
  useEffect(() => {
    if (route && route.city !== cityId && cities.some((c) => c.id === route.city)) setCityId(route.city);
  }, [route]);

  const choose = (id: string) => {
    setCityId(id);
    go({ city: id }, false);
    try {
      localStorage.setItem(CITY_KEY, id);
    } catch {
      // Choice just won't be remembered.
    }
  };

  return (
    <main>
      <h1>Територије · {current.name}</h1>
      {cities.length > 1 && (
        <>
          <label for="city">Град</label>
          <select id="city" value={cityId} onChange={(e) => choose(e.currentTarget.value)}>
            {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </>
      )}
      {city.status === 'loading' ? (
        <p class="muted" role="status">Учитавање…</p>
      ) : city.status === 'error' ? (
        <p class="error" role="alert">{city.message}</p>
      ) : (
        // key resets the query and chosen street when the city changes.
        <Search
          key={cityId}
          cityId={cityId}
          data={city.value.data}
          resolver={city.value.resolver}
          route={route?.city === cityId ? route : null}
          go={go}
        />
      )}
    </main>
  );
}

/** Street name with the part matching the query marked (same Cyrillic/Latin folding as the search). */
function Highlight({ text, query }: { text: string; query: string }) {
  return <>{highlightParts(text, query).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : p.text))}</>;
}

interface SearchProps {
  cityId: string;
  data: CityData;
  resolver: Resolver;
  /** Route of this city, or null when the URL does not point at it. */
  route: Route | null;
  go: (next: Route, replace: boolean) => void;
}

function Search({ cityId, data, resolver, route, go }: SearchProps) {
  const search = useMemo(() => createSearch(data.streets, resolver.places), [data, resolver]);
  const linkedStreet = route?.street ? data.streets.find((s) => s.id === route.street) ?? null : null;
  const [query, setQuery] = useState(linkedStreet?.name ?? '');
  const [chosen, setChosen] = useState<Hit | null>(linkedStreet ? { kind: 'street', street: linkedStreet } : null);
  const [houseText, setHouseText] = useState(linkedStreet ? route?.house ?? '' : '');
  // Combobox state: highlighted option (-1 = none) and whether Escape has dismissed the list.
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(true);

  const suggestions = useMemo(() => search(query), [search, query]);
  // A unique exact match counts as chosen without a click.
  const exact = suggestions.filter((h) => normalizeText(hitName(h)) === normalizeText(query));
  const picked = chosen ?? (exact.length === 1 ? exact[0]! : null);
  const street = picked?.kind === 'street' ? picked.street : null;
  const place = picked?.kind === 'place' ? picked.place : null;

  const house = parseHouseNumber(houseText);
  const houseInvalid = !place && houseText.trim() !== '' && !house;
  const result = street && !houseInvalid ? resolver.resolve(street.id, house) : null;
  const canList = !picked && suggestions.length > 0;
  const showList = open && canList;

  // State -> URL. A newly chosen street adds a history entry; house number edits rewrite it.
  // While the house number is half-typed (invalid) the URL keeps the last valid one.
  // Places have no link of their own: choosing one leaves the city link only.
  const lastStreetId = useRef(street?.id);
  useEffect(() => {
    if (houseInvalid || (!route && !street)) return;
    const pushed = !!street && street.id !== lastStreetId.current;
    lastStreetId.current = street?.id;
    go({ city: cityId, street: street?.id, house: street && house ? houseText.trim() : undefined }, !pushed);
  }, [street?.id, houseText]);

  // URL -> state (Back/Forward). Skipped when the URL already matches what is on screen,
  // which is also the case right after the effect above has written it.
  useEffect(() => {
    if (!route) return;
    const linked = route.street ? data.streets.find((s) => s.id === route.street) ?? null : null;
    if (!linked) {
      if (!street) return; // nothing on screen to reset (e.g. the user is still typing)
    } else if (linked.id === street?.id && (route.house ?? '') === houseText.trim()) {
      return;
    }
    setChosen(linked ? { kind: 'street', street: linked } : null);
    setQuery(linked?.name ?? '');
    setHouseText(linked ? route.house ?? '' : '');
    setActive(-1);
  }, [route?.street, route?.house]);

  const pick = (h: Hit) => {
    setChosen(h);
    setQuery(hitName(h));
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!showList) {
      // Escape closed the list; ArrowDown brings it back.
      if (e.key === 'ArrowDown' && canList) {
        e.preventDefault();
        setOpen(true);
        setActive(0);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => (i + 1) % suggestions.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
        break;
      case 'Enter':
        if (active >= 0) {
          e.preventDefault();
          pick(suggestions[active]!);
        }
        break;
      case 'Escape':
        // Also stops type="search" from clearing the field.
        e.preventDefault();
        setOpen(false);
        setActive(-1);
        break;
    }
  };

  return (
    <>
      <label for="street">Улица или тачка</label>
      <input
        id="street"
        type="search"
        role="combobox"
        autocomplete="off"
        value={query}
        onInput={(e) => { setQuery(e.currentTarget.value); setChosen(null); setOpen(true); setActive(-1); }}
        onKeyDown={onKeyDown}
        aria-autocomplete="list"
        aria-controls="suggestions"
        aria-expanded={showList}
        aria-activedescendant={showList && active >= 0 ? `suggestion-${active}` : undefined}
      />
      {showList && (
        <ul id="suggestions" class="suggestions" role="listbox" aria-label="Предлози улица и тачака">
          {suggestions.map((h, i) => (
            <li
              key={hitId(h)}
              id={`suggestion-${i}`}
              role="option"
              aria-selected={i === active}
              // Keeps focus in the input while clicking an option.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(h)}
            >
              <span>
                {/* The icon is decoration; the kind is also spoken and, for places, the address is shown. */}
                <span class="kind" aria-hidden="true">{h.kind === 'street' ? '🛣️' : h.place.kind === 'capital' ? '★' : '📍'}</span>
                <span class="sr-only">{h.kind === 'street' ? 'Улица: ' : h.place.kind === 'capital' ? 'Престоница: ' : 'Тачка: '}</span>
                <Highlight text={hitName(h)} query={query} />
                {h.kind === 'street' && h.street.settlement && <span class="muted"> · {h.street.settlement}</span>}
                {h.kind === 'place' && <span class="muted"> · {h.place.address}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!place && (
        <>
          <label for="house">Број (опционо)</label>
          <input
            id="house"
            inputMode="numeric"
            autocomplete="off"
            value={houseText}
            onInput={(e) => setHouseText(e.currentTarget.value)}
            aria-invalid={houseInvalid}
          />
          {houseInvalid && <p class="error">Број није у препознатом облику (нпр. 15, 15а, 15/2).</p>}
        </>
      )}

      <section aria-live="polite" class="result">
        {query.trim() === '' ? null : !picked && !canList ? (
          <p class="muted">Улица или тачка није пронађена.</p>
        ) : place ? (
          <PlaceCard place={place} resolver={resolver} city={data.name} updated={data.updated} />
        ) : result ? (
          <ResultCard
            result={result}
            resolver={resolver}
            city={data.name}
            reportEmail={data.reportEmail}
            updated={data.updated}
          />
        ) : null}
      </section>
      <MapSection key={cityId} cityId={cityId} data={data} resolver={resolver} />
      <footer class="muted">Ажурирано: {data.updated}</footer>
    </>
  );
}

function PeopleLine({ a }: { a: Assignment }) {
  return (
    <>
      <strong>{a.people.primary}</strong>
      {a.people.deputy && <span class="muted"> · заменик: {a.people.deputy}</span>}
    </>
  );
}

function TerritoryHeading({ a }: { a: Assignment }) {
  // Colour is always paired with the name, never alone.
  return (
    <h2>
      <span class="swatch" style={{ background: a.territory.color }} aria-hidden="true" />
      Територија {a.territory.id} „{a.territory.name}“
    </h2>
  );
}

/** Per-city address from the data, else the build-time VITE_REPORT_EMAIL; undefined when neither is configured. */
function reportRecipient(fromData: string | undefined): string | undefined {
  const email = (fromData ?? import.meta.env.VITE_REPORT_EMAIL)?.trim();
  return email || undefined;
}

function reportLink(email: string, street: Street, house: HouseNumber | null, city: string): string {
  const lines = [
    `Улица: ${street.name}${street.settlement ? ` (${street.settlement})` : ''}`,
    ...(house ? [`Број: ${formatHouseNumber(house)}`] : []),
    `Град: ${city}`,
  ];
  const subject = `Недодељена улица: ${street.name}`;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}

/** Directions in the user's maps app: by coordinates when known, else by the address text. */
function navigationUrl(p: Place): string {
  const destination = p.lat !== undefined && p.lng !== undefined ? `${p.lat},${p.lng}` : p.address;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

/** The point on a map (OpenStreetMap); an address search when the place has no coordinates. */
function mapUrl(p: Place): string {
  if (p.lat !== undefined && p.lng !== undefined) {
    return `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}`;
  }
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(p.address)}`;
}

function PlaceLinks({ place }: { place: Place }) {
  return (
    <div class="actions">
      <a class="button" href={navigationUrl(place)} target="_blank" rel="noopener">Навигација</a>
      <a class="button secondary" href={mapUrl(place)} target="_blank" rel="noopener">На мапи</a>
    </div>
  );
}

/** Distinct territories of a resolution, in the order they are shown. */
function capitalsOf(result: Resolution, resolver: Resolver): Place[] {
  const assignments = result.kind === 'rules' ? result.assignments
    : result.kind === 'linear' ? result.segments
    : result.kind === 'inherited' ? [result.assignment]
    : [];
  const capitals = new Map<string, Place>();
  for (const a of assignments) {
    const capital = resolver.capitalOf(a.territory.id);
    if (capital) capitals.set(capital.id, capital);
  }
  return [...capitals.values()];
}

/** "★ Престоница: назив, адреса"; the territory is named only when the card spans several. */
function capitalText(p: Place, withTerritory: boolean): string {
  return `★ Престоница${withTerritory ? ` (територија ${p.territoryId})` : ''}: ${p.name}, ${p.address}`;
}

function CapitalLine({ place, withTerritory }: { place: Place; withTerritory: boolean }) {
  return (
    <div class="capital">
      <p>
        <span aria-hidden="true">★ </span>
        Престоница{withTerritory ? ` (територија ${place.territoryId})` : ''}: <strong>{place.name}</strong>, {place.address}
      </p>
      {place.note && <p class="muted">{place.note}</p>}
      <PlaceLinks place={place} />
    </div>
  );
}

function StaleWarning({ updated }: { updated: string }) {
  // Set only when the data is older than the threshold (VITE_STALE_DAYS, default 90 days).
  const staleAge = staleAgeDays(updated);
  if (staleAge === null) return null;
  return (
    <p class="warn">
      ⚠ Подаци су последњи пут ажурирани пре {staleAge} {daysLabel(staleAge)} ({updated}) и могу бити застарели.
    </p>
  );
}

function PlaceCard({ place, resolver, city, updated }: { place: Place; resolver: Resolver; city: string; updated: string }) {
  const territory = resolver.territories.get(place.territoryId)!;
  const title = `${place.name} · ${city}`;
  const kind = place.kind === 'capital' ? 'Престоница' : place.kind === 'collector' ? 'Сабирна тачка' : 'Тачка';
  const text = [
    title,
    `${kind}: ${place.address}`,
    `Територија ${territory.id} „${territory.name}“: ${territory.defaults.primary}`,
    ...(place.note ? [place.note] : []),
  ].join('\n');
  return (
    <article class="card">
      <h2 class="card-title">{title}</h2>
      <StaleWarning updated={updated} />
      <p>
        <span aria-hidden="true">{place.kind === 'capital' ? '★ ' : '📍 '}</span>
        {kind}: {place.address}
      </p>
      {place.note && <p class="muted">{place.note}</p>}
      <h2>
        <span class="swatch" style={{ background: territory.color }} aria-hidden="true" />
        Територија {territory.id} „{territory.name}“
      </h2>
      <p><strong>{territory.defaults.primary}</strong></p>
      <PlaceLinks place={place} />
      <p class="print-only">Ажурирано: {updated}</p>
      <ShareBar key={text} title={title} text={text} />
    </article>
  );
}

/** Card of a territory picked on the map: who is responsible, the capital and the other points. */
function TerritoryCard({ territoryId, resolver, city, updated }: { territoryId: string; resolver: Resolver; city: string; updated: string }) {
  const territory = resolver.territories.get(territoryId);
  if (!territory) return null;
  const capital = resolver.capitalOf(territory.id);
  const points = resolver.places.filter((p) => p.territoryId === territory.id && p.kind !== 'capital');
  const title = `Територија ${territory.id} „${territory.name}“ · ${city}`;
  const people = territory.defaults.deputy
    ? `${territory.defaults.primary} (заменик: ${territory.defaults.deputy})`
    : territory.defaults.primary;
  const text = [
    title,
    people,
    ...(capital ? [capitalText(capital, false)] : []),
    ...points.map((p) => `📍 ${p.name}, ${p.address}`),
  ].join('\n');
  return (
    <article class="card">
      <h2 class="card-title">
        <span class="swatch" style={{ background: territory.color }} aria-hidden="true" />
        {title}
      </h2>
      <StaleWarning updated={updated} />
      <p><strong>{territory.defaults.primary}</strong>{territory.defaults.deputy && <span class="muted"> · заменик: {territory.defaults.deputy}</span>}</p>
      {capital && <CapitalLine place={capital} withTerritory={false} />}
      {points.length > 0 && (
        <>
          <h2>Тачке</h2>
          <ul class="plain">
            {points.map((p) => <li key={p.id}><span aria-hidden="true">📍 </span>{p.name} <span class="muted">· {p.address}</span></li>)}
          </ul>
        </>
      )}
      <p class="print-only">Ажурирано: {updated}</p>
      <ShareBar key={text} title={title} text={text} />
    </article>
  );
}

/**
 * Map of the city's territories. MapLibre is a separate chunk that is fetched only when the map is opened,
 * so the search page stays small. The territories are also listed as buttons: the map canvas is not keyboard-friendly.
 * A click on the map opens the same cards as the search (bottom sheet on a phone, side panel on a desktop).
 */
function MapSection({ cityId, data, resolver }: { cityId: string; data: CityData; resolver: Resolver }) {
  const [open, setOpen] = useState(false);
  const [View, setView] = useState<typeof import('./MapView').default | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<MapSelection | null>(null);
  const [showPoints, setShowPoints] = useState(true);

  useEffect(() => {
    if (!open || View) return;
    setLoadFailed(false);
    let alive = true;
    // setView(() => ...): the module's default export is a function and must not be treated as an updater.
    import('./MapView').then(
      (m) => { if (alive) setView(() => m.default); },
      () => { if (alive) setLoadFailed(true); },
    );
    return () => { alive = false; };
  }, [open]);

  const place = selected?.kind === 'place' ? resolver.places.find((p) => p.id === selected.id) : undefined;
  const hasPoints = resolver.places.some((p) => p.kind !== 'capital');
  const territories = [...resolver.territories.values()];

  return (
    <section class="map-section" aria-label="Мапа територија">
      <button
        type="button"
        class="button secondary"
        aria-expanded={open}
        aria-controls="map-panel"
        onClick={() => { setOpen(!open); setSelected(null); }}
      >
        {open ? 'Сакриј мапу' : 'Прикажи мапу'}
      </button>
      {open && (
        <div id="map-panel" class="map-panel">
          <div class="map-tools">
            {hasPoints && (
              <label class="inline">
                <input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.currentTarget.checked)} />
                Прикажи остале тачке
              </label>
            )}
            <ul class="plain territory-list" aria-label="Територије">
              {territories.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    class="chip"
                    aria-pressed={selected?.kind === 'territory' && selected.id === t.id}
                    onClick={() => setSelected(selected?.kind === 'territory' && selected.id === t.id ? null : { kind: 'territory', id: t.id })}
                  >
                    <span class="swatch" style={{ background: t.color }} aria-hidden="true" />
                    {t.id} {t.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div class="map-layout">
            {View ? (
              <View cityId={cityId} data={data} resolver={resolver} selected={selected} showPoints={showPoints} onSelect={setSelected} />
            ) : loadFailed ? (
              <p class="error" role="alert">Мапа тренутно није доступна.</p>
            ) : (
              <p class="muted" role="status">Учитавање мапе…</p>
            )}
            {selected && (
              <aside class="map-sheet" aria-label="Детаљи изабраног на мапи">
                <button type="button" class="button secondary close" onClick={() => setSelected(null)}>Затвори</button>
                {place ? (
                  <PlaceCard place={place} resolver={resolver} city={data.name} updated={data.updated} />
                ) : (
                  <TerritoryCard territoryId={selected.id} resolver={resolver} city={data.name} updated={data.updated} />
                )}
              </aside>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Plain-text version of an assignment, for Copy and Share. */
function assignmentText(a: Assignment): string {
  const people = a.people.deputy ? `${a.people.primary} (заменик: ${a.people.deputy})` : a.people.primary;
  return `Територија ${a.territory.id} „${a.territory.name}“: ${people}${a.rule ? ' ' + formatRange(a.rule) : ''}`;
}

/** Plain-text version of the whole result card. */
function resultText(result: Resolution, title: string, capitals: Place[]): string {
  const lines = [title];
  switch (result.kind) {
    case 'rules':
      lines.push(...result.assignments.map(assignmentText));
      if (result.border) lines.push(`⚠ Број ${formatHouseNumber(result.house)} је граничан: наведена су оба задужења.`);
      break;
    case 'linear':
      lines.push('Улица је подељена по бројевима:', ...result.segments.map(assignmentText));
      break;
    case 'inherited':
      lines.push(assignmentText(result.assignment));
      break;
    case 'unassigned':
      lines.push('Улица није додељена.');
      break;
  }
  lines.push(...capitals.map((p) => capitalText(p, capitals.length > 1)));
  return lines.join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // no clipboard access (insecure context, denied permission)
  }
}

/** "Подели" uses the Web Share API and falls back to copying text and link; "Копирај" copies the result text; "Штампај" prints the card (print styles hide everything else). */
function ShareBar({ title, text }: { title: string; text: string }) {
  const [note, setNote] = useState<string | null>(null);

  const copy = async () => setNote((await copyText(text)) ? 'Копирано.' : 'Копирање није успело.');

  const share = async () => {
    const url = location.href;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return; // the user closed the share sheet
      }
    }
    setNote((await copyText(`${text}\n${url}`)) ? 'Текст и линк су копирани.' : 'Дељење није успело.');
  };

  return (
    <div class="actions">
      <button type="button" class="button" onClick={share}>Подели</button>
      <button type="button" class="button secondary" onClick={copy}>Копирај</button>
      <button type="button" class="button secondary" onClick={() => window.print()}>Штампај</button>
      {note && <span class="muted" role="status">{note}</span>}
    </div>
  );
}

function ResultCard({ result, resolver, city, reportEmail, updated }: {
  result: Resolution; resolver: Resolver; city: string; reportEmail?: string; updated: string;
}) {
  const title = `${result.street.name}${'house' in result && result.house ? ' ' + formatHouseNumber(result.house) : ''} · ${city}`;
  const capitals = capitalsOf(result, resolver);
  let body;
  switch (result.kind) {
    case 'rules':
      body = (
        <>
          {result.assignments.map((a, i) => (
            <div key={i}>
              {(i === 0 || a.territory.id !== result.assignments[i - 1]!.territory.id) && <TerritoryHeading a={a} />}
              <p><PeopleLine a={a} /> <span class="muted">{formatRange(a.rule!)}</span></p>
              {a.rule?.note && <p class="muted">{a.rule.note}</p>}
            </div>
          ))}
          {result.border && (
            <p class="warn">⚠ Број {formatHouseNumber(result.house)} је граничан: наведена су оба задужења.</p>
          )}
        </>
      );
      break;
    case 'linear':
      body = (
        <>
          <p class="muted">Улица је подељена по бројевима:</p>
          {result.segments.map((a, i) => (
            <div key={i}>
              <TerritoryHeading a={a} />
              <p><PeopleLine a={a} /> <span class="muted">{formatRange(a.rule!)}</span></p>
            </div>
          ))}
        </>
      );
      break;
    case 'inherited':
      body = (
        <>
          <TerritoryHeading a={result.assignment} />
          <p><PeopleLine a={result.assignment} /></p>
        </>
      );
      break;
    case 'unassigned': {
      const email = reportRecipient(reportEmail);
      body = (
        <>
          <p>Улица није додељена.</p>
          {email && <a class="button" href={reportLink(email, result.street, result.house, city)}>Пријави</a>}
        </>
      );
    }
  }

  const text = resultText(result, title, capitals);
  return (
    <article class="card">
      <h2 class="card-title">{title}</h2>
      <StaleWarning updated={updated} />
      {body}
      {capitals.map((p) => <CapitalLine key={p.id} place={p} withTerritory={capitals.length > 1} />)}
      {/* The page footer is hidden in print, so the date goes on the printed card itself. */}
      <p class="print-only">Ажурирано: {updated}</p>
      {/* key resets the "copied" note when the result changes. */}
      <ShareBar key={text} title={title} text={text} />
    </article>
  );
}
