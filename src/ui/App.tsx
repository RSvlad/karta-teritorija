import { useEffect, useMemo, useState } from 'preact/hooks';
import { createResolver, DataError, formatHouseNumber, formatRange, parseHouseNumber } from '../resolver';
import type { Assignment, CityData, HouseNumber, Resolution, Resolver, Street } from '../resolver';
import { createStreetSearch } from '../search/streets';
import { highlightParts } from '../search/highlight';
import { normalizeText } from '../search/normalize';

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

/** Last chosen city if it still exists, otherwise the first one in the list. */
function initialCity(cities: CityRef[]): string {
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
  const [cityId, setCityId] = useState(() => initialCity(cities));
  const city = useRemote(cityId, async () => {
    const data = await fetchJson<CityData>(`data/${encodeURIComponent(cityId)}.json`);
    return { data, resolver: createResolver(data) };
  });
  const current = cities.find((c) => c.id === cityId)!;

  const choose = (id: string) => {
    setCityId(id);
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
        <Search key={cityId} data={city.value.data} resolver={city.value.resolver} />
      )}
    </main>
  );
}

/** Street name with the part matching the query marked (same Cyrillic/Latin folding as the search). */
function Highlight({ text, query }: { text: string; query: string }) {
  return <>{highlightParts(text, query).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : p.text))}</>;
}

function Search({ data, resolver }: { data: CityData; resolver: Resolver }) {
  const search = useMemo(() => createStreetSearch(data.streets), [data]);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Street | null>(null);
  const [houseText, setHouseText] = useState('');
  // Combobox state: highlighted option (-1 = none) and whether Escape has dismissed the list.
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(true);

  const suggestions = useMemo(() => search(query), [search, query]);
  // A unique exact match counts as chosen without a click.
  const exact = suggestions.filter((s) => normalizeText(s.name) === normalizeText(query));
  const street = chosen ?? (exact.length === 1 ? exact[0]! : null);

  const house = parseHouseNumber(houseText);
  const houseInvalid = houseText.trim() !== '' && !house;
  const result = street && !houseInvalid ? resolver.resolve(street.id, house) : null;
  const canList = !street && suggestions.length > 0;
  const showList = open && canList;

  const pick = (s: Street) => {
    setChosen(s);
    setQuery(s.name);
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
      <label for="street">Улица</label>
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
        <ul id="suggestions" class="suggestions" role="listbox" aria-label="Предлози улица">
          {suggestions.map((s, i) => (
            <li
              key={s.id}
              id={`suggestion-${i}`}
              role="option"
              aria-selected={i === active}
              // Keeps focus in the input while clicking an option.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
            >
              <span>
                <Highlight text={s.name} query={query} />
                {s.settlement && <span class="muted"> · {s.settlement}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

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

      <section aria-live="polite" class="result">
        {query.trim() === '' ? null : !street && !canList ? (
          <p class="muted">Улица није пронађена.</p>
        ) : result ? (
          <ResultCard result={result} city={data.name} reportEmail={data.reportEmail} />
        ) : null}
      </section>
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

function ResultCard({ result, city, reportEmail }: { result: Resolution; city: string; reportEmail?: string }) {
  const title = `${result.street.name}${'house' in result && result.house ? ' ' + formatHouseNumber(result.house) : ''} · ${city}`;

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

  return (
    <article class="card">
      <h2 class="card-title">{title}</h2>
      {body}
    </article>
  );
}
