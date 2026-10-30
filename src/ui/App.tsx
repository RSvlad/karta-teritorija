import { useEffect, useMemo, useState } from 'preact/hooks';
import { createResolver, DataError, formatHouseNumber, formatRange, parseHouseNumber } from '../resolver';
import type { Assignment, CityData, Resolution, Resolver, Street } from '../resolver';
import { createStreetSearch } from '../search/streets';
import { normalizeText } from '../search/normalize';

// TODO(phase 1): city selector read from a cities list; single pilot city for now.
const CITY = 'novi-sad';

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: CityData; resolver: Resolver };

function useCity(): Loaded {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    fetch(`data/${CITY}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<CityData>;
      })
      .then((data) => alive && setState({ status: 'ready', data, resolver: createResolver(data) }))
      .catch((e) => {
        const message = e instanceof DataError ? e.message : 'Подаци тренутно нису доступни.';
        alive && setState({ status: 'error', message });
      });
    return () => { alive = false; };
  }, []);
  return state;
}

export function App() {
  const city = useCity();
  if (city.status === 'loading') return <main><p class="muted" role="status">Учитавање…</p></main>;
  if (city.status === 'error') return <main><p class="error" role="alert">{city.message}</p></main>;
  return <Search data={city.data} resolver={city.resolver} />;
}

function Search({ data, resolver }: { data: CityData; resolver: Resolver }) {
  const search = useMemo(() => createStreetSearch(data.streets), [data]);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Street | null>(null);
  const [houseText, setHouseText] = useState('');

  const suggestions = useMemo(() => search(query), [search, query]);
  // A unique exact match counts as chosen without a click.
  const exact = suggestions.filter((s) => normalizeText(s.name) === normalizeText(query));
  const street = chosen ?? (exact.length === 1 ? exact[0]! : null);

  const house = parseHouseNumber(houseText);
  const houseInvalid = houseText.trim() !== '' && !house;
  const result = street && !houseInvalid ? resolver.resolve(street.id, house) : null;
  const showList = !street && suggestions.length > 0;

  return (
    <main>
      <h1>Територије · {data.name}</h1>

      <label for="street">Улица</label>
      <input
        id="street"
        type="search"
        autocomplete="off"
        value={query}
        onInput={(e) => { setQuery(e.currentTarget.value); setChosen(null); }}
        aria-controls="suggestions"
        aria-expanded={showList}
      />
      {showList && (
        <ul id="suggestions" class="suggestions">
          {suggestions.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => { setChosen(s); setQuery(s.name); }}>
                {s.name}
                {s.settlement && <span class="muted"> · {s.settlement}</span>}
              </button>
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
        {query.trim() === '' ? null : !street && !showList ? (
          <p class="muted">Улица није пронађена.</p>
        ) : result ? (
          <ResultCard result={result} city={data.name} />
        ) : null}
      </section>
      <footer class="muted">Ажурирано: {data.updated}</footer>
    </main>
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

function ResultCard({ result, city }: { result: Resolution; city: string }) {
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
    case 'unassigned':
      body = (
        <>
          <p>Улица није додељена.</p>
          <a class="button" href={`mailto:?subject=${encodeURIComponent('Недодељена улица: ' + title)}`}>Пријави</a>
        </>
      );
  }

  return (
    <article class="card">
      <h2 class="card-title">{title}</h2>
      {body}
    </article>
  );
}
