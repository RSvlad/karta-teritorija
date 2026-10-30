import { useCallback, useEffect, useState } from 'preact/hooks';

/**
 * Hash route `#/<city>/<street id>/<house>`, e.g. `#/novi-sad/futoska/15`.
 * GitHub Pages has no server routing, so the state lives in the fragment.
 * Only public search state goes here: no secrets.
 */
export interface Route {
  city: string;
  street?: string;
  house?: string;
}

export function parseRoute(hash: string): Route | null {
  const path = hash.replace(/^#\/?/, '');
  if (!path) return null;
  let parts: string[];
  try {
    // Each segment is encoded separately, so a "/" inside a house number (15/2) arrives as %2F.
    parts = path.split('/').map((p) => decodeURIComponent(p));
  } catch {
    return null; // malformed percent-encoding
  }
  const [city, street, house] = parts;
  if (!city) return null;
  return { city, street: street || undefined, house: house || undefined };
}

export function formatRoute(r: Route): string {
  const parts = [r.city];
  if (r.street) {
    parts.push(r.street);
    if (r.house) parts.push(r.house);
  }
  return '#/' + parts.map((p) => encodeURIComponent(p)).join('/');
}

export function sameRoute(a: Route | null, b: Route | null): boolean {
  return (a?.city ?? '') === (b?.city ?? '')
    && (a?.street ?? '') === (b?.street ?? '')
    && (a?.house ?? '') === (b?.house ?? '');
}

/**
 * Current route plus `go`. `replace` rewrites the current history entry (house number edits);
 * otherwise a new entry is pushed so Back/Forward step through chosen streets.
 * `hashchange` (Back/Forward, a pasted link) updates the route.
 */
export function useRoute(): [Route | null, (next: Route, replace: boolean) => void] {
  const [route, setRoute] = useState<Route | null>(() => parseRoute(location.hash));

  useEffect(() => {
    const onChange = () => {
      const next = parseRoute(location.hash);
      setRoute((prev) => (sameRoute(prev, next) ? prev : next));
    };
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);

  const go = useCallback((next: Route, replace: boolean) => {
    if (sameRoute(parseRoute(location.hash), next)) return;
    const hash = formatRoute(next);
    if (replace) history.replaceState(null, '', hash); // does not fire hashchange
    else location.hash = hash;
    setRoute((prev) => (sameRoute(prev, next) ? prev : next));
  }, []);

  return [route, go];
}
