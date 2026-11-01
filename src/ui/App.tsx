import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { coversAllNumbers, createResolver, DataError, formatHouseNumber, formatRange, parseHouseNumber } from '../resolver';
import type { Assignment, CityData, HouseNumber, Place, Resolution, Resolver, Street, TerritoryStreet } from '../resolver';
import { createSearch, hitId, hitName } from '../search/search';
import type { Hit } from '../search/search';
import { highlightParts } from '../search/highlight';
import { normalizeText } from '../search/normalize';
import { daysLabel, staleAgeDays } from './freshness';
import { capitalText, resultText } from './shareText';
import { formatDistance, nearest } from '../geo/geo';
import { PrintMaps, preparePrintMaps } from './PrintMap';
import { useRoute } from './route';
import type { Route } from './route';
import { nextTheme, setScript, setTheme, tx, useScript, useTheme } from './prefs';
import type { Theme } from './prefs';
// Type only: MapView (and MapLibre with it) is loaded on demand by MapSection.
import type { MapFocus, MapSelection } from './MapView';

const CITY_KEY = 'moj-paroh:city';

/** "Прикажи на мапи" on a result card: the capitals to frame, and the one the user asked about (selected). */
interface MapRequest extends MapFocus {
  cityId: string;
  selected: string;
}

const hasPoint = (p: Place): boolean => p.lat !== undefined && p.lng !== undefined;

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
        message:
          e instanceof DataError
            ? e.message
            : navigator.onLine
              ? 'Подаци тренутно нису доступни.'
              : 'Нисте на мрежи, а ови подаци још нису сачувани на уређају. Отворите апликацију једном са интернетом.',
      }))
      .then((result) => { if (alive) setDone({ key, result }); });
    return () => { alive = false; };
  }, [key]);
  return done && done.key === key ? done.result : { status: 'loading' };
}

/** False while the browser reports no network connection. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
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
  // Subscribed at the root: a change of script rebuilds the whole tree, which is when text is transliterated.
  useScript();
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
  const online = useOnline();

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
      <header class="top">
        <h1>Територије · {current.name}</h1>
        <Prefs />
      </header>
      {!online && <p class="warn" role="status">Нисте на мрежи. Приказују се подаци сачувани на уређају.</p>}
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

const THEME_ICON: Record<Theme, string> = { auto: '◐', light: '☀', dark: '☾' };
const THEME_LABEL: Record<Theme, string> = { auto: 'Тема: аутоматска', light: 'Тема: светла', dark: 'Тема: тамна' };

/**
 * Switches for the script and the colour theme. The script button names the other script in that script
 * (translate={false} keeps it from being transliterated), so it can always be found.
 */
function Prefs() {
  const script = useScript();
  const theme = useTheme();
  return (
    <div class="prefs">
      {script === 'cyr' ? (
        <button type="button" class="button secondary" lang="sr-Latn" translate={false} onClick={() => setScript('lat')}>Latinica</button>
      ) : (
        <button type="button" class="button secondary" lang="sr-Cyrl" translate={false} onClick={() => setScript('cyr')}>Ћирилица</button>
      )}
      <button type="button" class="button secondary" onClick={() => setTheme(nextTheme(theme))}>
        <span aria-hidden="true">{THEME_ICON[theme]} </span>
        {THEME_LABEL[theme]}
      </button>
    </div>
  );
}

/** Street name with the part matching the query marked (same Cyrillic/Latin folding as the search). */
function Highlight({ text, query }: { text: string; query: string }) {
  // Highlighted in the script that is shown, so a digraph (Љ → Lj) is never split between two parts.
  return <>{highlightParts(tx(text), query).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : p.text))}</>;
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
  const script = useScript();
  const [query, setQuery] = useState(linkedStreet ? tx(linkedStreet.name) : '');
  const [chosen, setChosen] = useState<Hit | null>(linkedStreet ? { kind: 'street', street: linkedStreet } : null);
  const [houseText, setHouseText] = useState(linkedStreet ? route?.house ?? '' : '');
  // Combobox state: highlighted option (-1 = none) and whether Escape has dismissed the list.
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(true);
  // Set by "Прикажи на мапи" on a result card; the map section below reacts to every new request.
  const [mapRequest, setMapRequest] = useState<MapRequest | null>(null);

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
    setQuery(linked ? tx(linked.name) : '');
    setHouseText(linked ? route.house ?? '' : '');
    setActive(-1);
  }, [route?.street, route?.house]);

  // A chosen name shown in the field follows the script; text the user typed is left as typed.
  useEffect(() => {
    if (chosen) setQuery(tx(hitName(chosen)));
  }, [script]);

  const pick = (h: Hit) => {
    setChosen(h);
    setQuery(tx(hitName(h)));
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
          <PlaceCard place={place} resolver={resolver} city={data.name} cityId={cityId} updated={data.updated} />
        ) : result ? (
          <ResultCard
            result={result}
            resolver={resolver}
            city={data.name}
            cityId={cityId}
            reportEmail={data.reportEmail}
            updated={data.updated}
            onShowOnMap={(capital, all) =>
              setMapRequest((prev) => ({
                cityId,
                selected: capital.id,
                placeIds: all.filter(hasPoint).map((p) => p.id),
                seq: (prev?.seq ?? 0) + 1,
              }))
            }
          />
        ) : null}
      </section>
      {/* A city that only has its streets (no territories yet) has nothing to draw or locate. */}
      {resolver.territories.size > 0 && (
        <MapSection key={cityId} cityId={cityId} data={data} resolver={resolver} request={mapRequest} />
      )}
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
  return `mailto:${email}?subject=${encodeURIComponent(tx(subject))}&body=${encodeURIComponent(tx(lines.join('\n')))}`;
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

function PlaceLinks({ place, onShowOnMap }: { place: Place; onShowOnMap?: () => void }) {
  return (
    <div class="actions">
      {/* Only for a point with coordinates; without them the text-address links below still work. */}
      {onShowOnMap && hasPoint(place) && (
        <button type="button" class="button" onClick={onShowOnMap}>Прикажи на мапи</button>
      )}
      <a class="button" href={navigationUrl(place)} target="_blank" rel="noopener">Навигација</a>
      <a class="button secondary" href={mapUrl(place)} target="_blank" rel="noopener">На мапи</a>
    </div>
  );
}

/** The assignments of a resolution, in the order they are shown. */
function assignmentsOf(result: Resolution): Assignment[] {
  return result.kind === 'rules' ? result.assignments
    : result.kind === 'linear' ? result.segments
    : result.kind === 'inherited' ? [result.assignment]
    : [];
}

/** Distinct territories of a resolution, in the order they are shown. */
function territoryIdsOf(result: Resolution): string[] {
  return [...new Set(assignmentsOf(result).map((a) => a.territory.id))];
}

/** Capitals of the territories of a resolution, one per territory that has one. */
function capitalsOf(result: Resolution, resolver: Resolver): Place[] {
  const capitals = new Map<string, Place>();
  for (const a of assignmentsOf(result)) {
    const capital = resolver.capitalOf(a.territory.id);
    if (capital) capitals.set(capital.id, capital);
  }
  return [...capitals.values()];
}

function CapitalLine({ place, withTerritory, onShowOnMap }: { place: Place; withTerritory: boolean; onShowOnMap?: () => void }) {
  return (
    <div class="capital">
      <p>
        <span aria-hidden="true">★ </span>
        Престоница{withTerritory ? ` (територија ${place.territoryId})` : ''}: <strong>{place.name}</strong>, {place.address}
      </p>
      {place.note && <p class="muted">{place.note}</p>}
      <PlaceLinks place={place} onShowOnMap={onShowOnMap} />
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

function PlaceCard({ place, resolver, city, cityId, updated }: { place: Place; resolver: Resolver; city: string; cityId: string; updated: string }) {
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
      <PrintMaps cityId={cityId} territoryIds={[territory.id]} resolver={resolver} />
      <p class="print-only">Ажурирано: {updated}</p>
      <ShareBar key={text} title={title} text={text} />
    </article>
  );
}

/** Card of a territory picked on the map: who is responsible, the capital and the other points. */
function TerritoryCard({ territoryId, resolver, city, cityId, updated }: { territoryId: string; resolver: Resolver; city: string; cityId: string; updated: string }) {
  const territory = resolver.territories.get(territoryId);
  if (!territory) return null;
  const capital = resolver.capitalOf(territory.id);
  const points = resolver.places.filter((p) => p.territoryId === territory.id && p.kind !== 'capital');
  const streets = resolver.streetsOf(territory.id);
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
      {streets.length > 0 && (
        <>
          <h2>Улице</h2>
          <ul class={`plain street-list${streets.length > 30 ? ' dense' : ''}`}>
            {streets.map((s) => <li key={s.street.id}><TerritoryStreetLine item={s} city={city} /></li>)}
          </ul>
        </>
      )}
      <PrintMaps cityId={cityId} territoryIds={[territory.id]} resolver={resolver} />
      <p class="print-only">Ажурирано: {updated}</p>
      <ShareBar key={text} title={title} text={text} />
    </article>
  );
}

/** One street of a territory card: the name, then the number ranges the territory owns (none = the whole street). */
function TerritoryStreetLine({ item, city }: { item: TerritoryStreet; city: string }) {
  const { street, segments, rest } = item;
  const parts = [
    ...segments.map((r) => `${formatRange(r)}${r.assignee ? ` (${r.assignee})` : ''}`),
    ...(rest ? ['остали бројеви'] : []),
  ];
  return (
    <>
      {street.name}
      {/* The settlement only tells streets apart when it is not the city itself. */}
      {street.settlement && street.settlement !== city && <span class="muted"> ({street.settlement})</span>}
      {parts.length > 0 && <span class="muted"> · {parts.join('; ')}</span>}
    </>
  );
}

const ME_KEY = 'moj-paroh:me';

/** "Моје": the person the user chose as themselves, remembered per city in this browser only. */
function readMe(cityId: string): string | null {
  try {
    return localStorage.getItem(`${ME_KEY}:${cityId}`) || null;
  } catch {
    return null; // storage blocked: the choice just is not remembered
  }
}

function saveMe(cityId: string, name: string | null): void {
  try {
    if (name) localStorage.setItem(`${ME_KEY}:${cityId}`, name);
    else localStorage.removeItem(`${ME_KEY}:${cityId}`);
  } catch {
    /* storage blocked: see readMe */
  }
}

/** State of "Where am I?". The position lives only in memory: it is never stored or sent anywhere. */
type Fix =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'error'; message: string }
  | { state: 'done'; point: { lat: number; lng: number } };

function locateErrorText(e: GeolocationPositionError): string {
  if (e.code === e.PERMISSION_DENIED) {
    return 'Приступ локацији је одбијен. Дозволите га за ову страницу у подешавањима прегледача и покушајте поново.';
  }
  if (e.code === e.TIMEOUT) return 'Одређивање локације је предуго трајало. Покушајте поново, по могућству напољу.';
  return 'Локација тренутно није доступна. Проверите да ли је GPS укључен.';
}

function NearestCapital({ place, meters, resolver }: { place: Place; meters: number; resolver: Resolver }) {
  const territory = resolver.territories.get(place.territoryId);
  return (
    <article class="card">
      <h2 class="card-title">Најближа престоница</h2>
      <p>
        <span aria-hidden="true">★ </span>
        <strong>{place.name}</strong>, {place.address}
      </p>
      <p class="muted">
        {formatDistance(meters)} ваздушном линијом{territory ? ` · територија ${territory.id} „${territory.name}“` : ''}
      </p>
      <PlaceLinks place={place} />
    </article>
  );
}

/**
 * Map of the city's territories. MapLibre is a separate chunk that is fetched only when the map is opened,
 * so the search page stays small. The territories are also listed as buttons: the map canvas is not keyboard-friendly.
 * A click on the map opens the same cards as the search (bottom sheet on a phone, side panel on a desktop).
 * Filters (territory, assignee, "mine") narrow what the map and the list show; "Where am I?" asks the browser for
 * the GPS position once, finds the territory containing it and the nearest capital, and keeps nothing.
 */
function MapSection({ cityId, data, resolver, request }: {
  cityId: string; data: CityData; resolver: Resolver; request: MapRequest | null;
}) {
  const [open, setOpen] = useState(false);
  const [View, setView] = useState<typeof import('./MapView').default | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<MapSelection | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [showPoints, setShowPoints] = useState(true);
  const [territoryFilter, setTerritoryFilter] = useState('');
  const [assignee, setAssignee] = useState('');
  const [me, setMe] = useState<string | null>(() => readMe(cityId));
  const [onlyMine, setOnlyMine] = useState(false);
  const [fix, setFix] = useState<Fix>({ state: 'idle' });
  const [located, setLocated] = useState<{ territoryId: string | null; polygons: boolean } | null>(null);
  const locateRef = useRef<HTMLElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

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

  const territories = [...resolver.territories.values()];
  const hasPoints = resolver.places.some((p) => p.kind !== 'capital');

  // Everybody named in the data (defaults and per-rule overrides), and the territories each of them serves.
  const people = useMemo(() => {
    const names = new Set<string>();
    for (const t of resolver.territories.values()) {
      names.add(t.defaults.primary);
      if (t.defaults.deputy) names.add(t.defaults.deputy);
    }
    for (const r of data.rules) if (r.assignee) names.add(r.assignee);
    return [...names].sort((a, b) => a.localeCompare(b, 'sr'));
  }, [data, resolver]);

  const territoriesOf = (name: string): Set<string> => {
    const ids = new Set<string>();
    for (const t of resolver.territories.values()) {
      if (t.defaults.primary === name || t.defaults.deputy === name) ids.add(t.id);
    }
    for (const r of data.rules) if (r.assignee === name) ids.add(r.territoryId);
    return ids;
  };

  // null = no filter is set (everything is shown).
  const visible = useMemo(() => {
    const sets: Set<string>[] = [];
    if (territoryFilter) sets.push(new Set([territoryFilter]));
    if (assignee) sets.push(territoriesOf(assignee));
    if (onlyMine && me) sets.push(territoriesOf(me));
    if (sets.length === 0) return null;
    return new Set([...sets[0]!].filter((id) => sets.every((s) => s.has(id))));
  }, [territoryFilter, assignee, onlyMine, me, data, resolver]);

  const place = selected?.kind === 'place' ? resolver.places.find((p) => p.id === selected.id) : undefined;

  // A selection that the filters hide would leave a card for something not on the map.
  useEffect(() => {
    if (!selected || !visible) return;
    const id = selected.kind === 'territory' ? selected.id : place?.territoryId;
    if (id && !visible.has(id)) setSelected(null);
  }, [visible]);

  const resetFilters = () => {
    setTerritoryFilter('');
    setAssignee('');
    setOnlyMine(false);
  };

  // "Прикажи на мапи" on a result card: open the map, select that capital (its card and territory are shown)
  // and frame every capital of the result. A filter that hides one of them is cleared.
  useEffect(() => {
    if (!request || request.cityId !== cityId) return;
    const wanted = new Set(request.placeIds.map((id) => resolver.places.find((p) => p.id === id)?.territoryId));
    if (visible && [...wanted].some((id) => id && !visible.has(id))) resetFilters();
    setOpen(true); // MapLibre loads lazily, while the section scrolls into view
    setSelected({ kind: 'place', id: request.selected });
    setFocus({ placeIds: request.placeIds, seq: request.seq });
    sectionRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [request]);

  const rememberMe = (name: string) => {
    setMe(name);
    saveMe(cityId, name);
    setAssignee('');
    setOnlyMine(true);
  };

  const forgetMe = () => {
    setMe(null);
    saveMe(cityId, null);
    setOnlyMine(false);
  };

  const locate = () => {
    if (!('geolocation' in navigator)) {
      setFix({ state: 'error', message: 'Овај прегледач не подржава одређивање локације.' });
      return;
    }
    setOpen(true); // the map is needed to find the territory; MapLibre loads while the browser asks for permission
    setSelected(null);
    setFocus(null);
    setLocated(null);
    setFix({ state: 'busy' });
    navigator.geolocation.getCurrentPosition(
      (pos) => setFix({ state: 'done', point: { lat: pos.coords.latitude, lng: pos.coords.longitude } }),
      (err) => setFix({ state: 'error', message: locateErrorText(err) }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const clearLocation = () => {
    setFix({ state: 'idle' });
    setLocated(null);
  };

  // Called by the map once it has looked for the territory containing the point.
  const onLocated = (territoryId: string | null, polygons: boolean) => {
    setLocated({ territoryId, polygons });
    // The territory the user stands in must not be hidden by an old filter.
    if (territoryId && visible && !visible.has(territoryId)) resetFilters();
  };

  const point = fix.state === 'done' ? fix.point : null;
  const nearestCapital = useMemo(
    () => (point ? nearest(resolver.places.filter((p) => p.kind === 'capital'), point) : null),
    [point, resolver],
  );

  useEffect(() => {
    if (point) locateRef.current?.scrollIntoView({ block: 'nearest' });
  }, [point]);

  const shown = visible ? territories.filter((t) => visible.has(t.id)) : territories;

  return (
    <section class="map-section" aria-label="Мапа територија" ref={sectionRef}>
      <div class="map-actions">
        <button
          type="button"
          class="button secondary"
          aria-expanded={open}
          aria-controls="map-panel"
          onClick={() => { setOpen(!open); setSelected(null); setFocus(null); }}
        >
          {open ? 'Сакриј мапу' : 'Прикажи мапу'}
        </button>
        <button type="button" class="button" disabled={fix.state === 'busy'} onClick={locate}>
          Где сам ја?
        </button>
      </div>
      {fix.state === 'busy' && <p class="muted" role="status">Одређивање локације…</p>}
      {fix.state === 'error' && <p class="error" role="alert">{fix.message}</p>}
      {open && (
        <div id="map-panel" class="map-panel">
          {territories.length > 1 && (
            <div class="map-filters">
              <label>
                Територија
                <select value={territoryFilter} onChange={(e) => setTerritoryFilter(e.currentTarget.value)}>
                  <option value="">Све</option>
                  {territories.map((t) => <option key={t.id} value={t.id}>{t.id} {t.name}</option>)}
                </select>
              </label>
              <label>
                Задужени
                <select value={assignee} onChange={(e) => setAssignee(e.currentTarget.value)}>
                  <option value="">Сви</option>
                  {people.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              {me && (
                <label class="inline">
                  <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.currentTarget.checked)} />
                  Само моје ({me})
                </label>
              )}
              {assignee && assignee !== me && (
                <button type="button" class="button secondary" onClick={() => rememberMe(assignee)}>Ово сам ја</button>
              )}
              {me && <button type="button" class="button secondary" onClick={forgetMe}>Заборави „моје“</button>}
              {visible && <button type="button" class="button secondary" onClick={resetFilters}>Прикажи све</button>}
            </div>
          )}
          <div class="map-tools">
            {hasPoints && (
              <label class="inline">
                <input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.currentTarget.checked)} />
                Прикажи остале тачке
              </label>
            )}
            {shown.length === 0 ? (
              <p class="muted" role="status">Нема територија за изабране филтере.</p>
            ) : (
              <ul class="plain territory-list" aria-label="Територије">
                {shown.map((t) => (
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
            )}
          </div>
          <div class="map-layout">
            {View ? (
              <View
                cityId={cityId}
                data={data}
                resolver={resolver}
                selected={selected}
                focus={focus}
                showPoints={showPoints}
                visible={visible}
                userPoint={point}
                onLocated={onLocated}
                onSelect={setSelected}
              />
            ) : loadFailed ? (
              <p class="error" role="alert">Мапа тренутно није доступна.</p>
            ) : (
              <p class="muted" role="status">Учитавање мапе…</p>
            )}
            {selected && (
              <aside class="map-sheet" aria-label="Детаљи изабраног на мапи">
                <button type="button" class="button secondary close" onClick={() => setSelected(null)}>Затвори</button>
                {place ? (
                  <PlaceCard place={place} resolver={resolver} city={data.name} cityId={cityId} updated={data.updated} />
                ) : (
                  <TerritoryCard territoryId={selected.id} resolver={resolver} city={data.name} cityId={cityId} updated={data.updated} />
                )}
              </aside>
            )}
          </div>
        </div>
      )}
      {point && (
        <section class="locate" ref={locateRef} aria-label="Ваша локација">
          {located?.territoryId ? (
            <>
              <p role="status">Налазите се у територији {located.territoryId}.</p>
              <TerritoryCard territoryId={located.territoryId} resolver={resolver} city={data.name} cityId={cityId} updated={data.updated} />
            </>
          ) : located?.polygons ? (
            <p role="status">Налазите се ван свих територија.</p>
          ) : located || loadFailed ? (
            <p class="warn" role="status">Територију није могуће одредити: мапа са границама није доступна.</p>
          ) : (
            <p class="muted" role="status">Одређивање територије…</p>
          )}
          {nearestCapital ? (
            <NearestCapital place={nearestCapital.item} meters={nearestCapital.meters} resolver={resolver} />
          ) : (
            <p class="muted">Најближа престоница се не може одредити: ни једна нема координате.</p>
          )}
          <p class="muted">Локација се користи само у овом прегледачу: не шаље се нигде и не чува се.</p>
          <button type="button" class="button secondary" onClick={clearLocation}>Уклони локацију</button>
        </section>
      )}
    </section>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // no clipboard access (insecure context, denied permission)
  }
}

/**
 * Prints the card the button belongs to. The card is marked for the duration of the print dialog and the print
 * stylesheet hides everything else, so a card in the map panel prints as alone as one in the search results.
 * The basemaps under its territory maps are drawn first (a few seconds at most, only the first time); if they
 * cannot be, the card prints with the plain border drawings.
 */
async function printCard(button: HTMLElement): Promise<void> {
  const card = button.closest<HTMLElement>('.card');
  if (!card) {
    window.print();
    return;
  }
  if (button.hasAttribute('aria-busy')) return; // already preparing this print
  button.setAttribute('aria-busy', 'true');
  try {
    await preparePrintMaps(card);
  } finally {
    button.removeAttribute('aria-busy');
  }
  const clear = () => {
    card.classList.remove('print-target');
    document.body.classList.remove('printing');
    window.removeEventListener('afterprint', clear);
  };
  card.classList.add('print-target');
  document.body.classList.add('printing');
  window.addEventListener('afterprint', clear); // not cleared right after print(): on some phones it returns before the dialog opens
  window.print();
}

/** "Подели" uses the Web Share API and falls back to copying text and link; "Копирај" copies the result text; "Штампај" prints the card (print styles hide everything else). */
function ShareBar({ title, text }: { title: string; text: string }) {
  const [note, setNote] = useState<string | null>(null);

  // The text is built in Cyrillic; what is copied or shared is in the script the user has chosen.
  const copy = async () => setNote((await copyText(tx(text))) ? 'Копирано.' : 'Копирање није успело.');

  const share = async () => {
    const url = location.href;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: tx(title), text: tx(text), url });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return; // the user closed the share sheet
      }
    }
    setNote((await copyText(`${tx(text)}\n${url}`)) ? 'Текст и линк су копирани.' : 'Дељење није успело.');
  };

  return (
    <div class="actions">
      <button type="button" class="button" onClick={share}>Подели</button>
      <button type="button" class="button secondary" onClick={copy}>Копирај</button>
      <button type="button" class="button secondary" onClick={(e) => printCard(e.currentTarget)}>Штампај</button>
      {note && <span class="muted" role="status">{note}</span>}
    </div>
  );
}

function ResultCard({ result, resolver, city, cityId, reportEmail, updated, onShowOnMap }: {
  result: Resolution; resolver: Resolver; city: string; cityId: string; reportEmail?: string; updated: string;
  /** Show a capital on the map; the second argument is every capital of the result (all get framed). */
  onShowOnMap?: (capital: Place, all: readonly Place[]) => void;
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
              <p><PeopleLine a={a} />{!coversAllNumbers(a.rule!) && <> <span class="muted">{formatRange(a.rule!)}</span></>}</p>
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
      // A city without territories has only its street list so far: nothing is assigned, so there is nothing to report.
      const noTerritories = resolver.territories.size === 0;
      body = noTerritories ? (
        <p>Територије за овај град још нису унете.</p>
      ) : (
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
      {capitals.map((p) => (
        <CapitalLine
          key={p.id}
          place={p}
          withTerritory={capitals.length > 1}
          onShowOnMap={onShowOnMap && (() => onShowOnMap(p, capitals))}
        />
      ))}
      <PrintMaps cityId={cityId} territoryIds={territoryIdsOf(result)} resolver={resolver} />
      {/* The page footer is hidden in print, so the date goes on the printed card itself. */}
      <p class="print-only">Ажурирано: {updated}</p>
      {/* key resets the "copied" note when the result changes. */}
      <ShareBar key={text} title={title} text={text} />
    </article>
  );
}
