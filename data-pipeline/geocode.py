#!/usr/bin/env python3
"""Geocoding of places (issue #10): capitals and other points from the Sheet's "Тачке" tab.

For every address it looks for an OSM address point (addr:street + addr:housenumber inside the city),
and only if there is none asks Nominatim (at most one request per second, as its usage policy requires).
Results go to data-pipeline/cache/<city>/geocode-cache.json, which is committed: the normal build only
reads it and never calls a geocoder. Failures are not cached (they are retried next time) and are listed
in data-pipeline/work/<city>/geocode-report.json, which report.py shows.

    python data-pipeline/geocode.py --city novi-sad            # only addresses not in the cache yet
    python data-pipeline/geocode.py --city novi-sad --refresh  # all addresses again

Input  data-pipeline/work/<city>/places-input.json (git-ignored, written by build-data.mjs)
Exit   0 = every address has coordinates, 1 = some failed (listed), 2 = bad input.

Addresses are read as "<street> <house number>[, <settlement>]". Without a house number only Nominatim
can help. An address that matches several distant OSM points is reported as ambiguous, never guessed:
add the settlement to the address.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

from streets import CACHE_DIR, clean, load_cities, show
from territories import WORK_DIR, slug

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "moj-paroh-data-pipeline (https://github.com/RSvlad/moj-paroh)"
MIN_INTERVAL_S = 1.1     # Nominatim: at most 1 request per second
AMBIGUOUS_M = 60.0       # address points closer than this are one place (entrances of one building)
SOURCE = "© OpenStreetMap contributors (ODbL)"

# "Футошка 15", "Булевар цара Лазара 3а", "Школска 7/2" -> street, house number
ADDRESS_RE = re.compile(r"^(?P<street>.+?)\s+(?P<house>\d+\s*[^\W\d_]?(?:\s*/\s*\d+)?)$")


def address_key(address: str) -> str:
    """Cache key. Same function as addressKey() in lib/places.mjs (Cyrillic and Latin spellings match)."""
    return slug(address)


def parse_address(address: str) -> tuple[str, str | None, str]:
    """-> (street, house number or None, settlement or '')."""
    head, _, tail = clean(address).partition(",")
    settlement = tail.split(",")[0].strip()
    m = ADDRESS_RE.match(head.strip())
    if not m:
        return head.strip(), None, settlement
    return m.group("street").strip(), m.group("house"), settlement


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Haversine distance of two (lat, lng) points in metres."""
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def build_address_index(rows) -> dict:
    """[(street, house, settlements, lat, lng)] -> {(slug(street), slug(house)): [(lat, lng, {settlement slugs})]}."""
    index: dict = {}
    for street, house, settlements, lat, lng in rows:
        street, house = slug(clean(street)), slug(clean(house))
        if street and house:
            index.setdefault((street, house), []).append((lat, lng, {slug(s) for s in settlements if s}))
    return index


def match_address(index: dict, street: str, house: str, settlement: str):
    """-> ((lat, lng), None) when found, (None, reason) otherwise."""
    found = index.get((slug(street), slug(house)), [])
    if settlement:
        wanted = slug(settlement)
        # An OSM point without any settlement tag cannot contradict the address.
        found = [f for f in found if not f[2] or wanted in f[2]]
    if not found:
        return None, "нема адресне тачке у OSM-у"
    centre = (sum(f[0] for f in found) / len(found), sum(f[1] for f in found) / len(found))
    if any(distance_m((f[0], f[1]), centre) > AMBIGUOUS_M for f in found):
        return None, "више удаљених адресних тачака у OSM-у (наведите насеље у адреси)"
    return centre, None


# ---------------------------------------------------------------------------------------------
# Network (OSM address points, Nominatim)
# ---------------------------------------------------------------------------------------------

def fetch_boundary(city: dict):
    import osmnx as ox

    ox.settings.use_cache = True
    ox.settings.cache_folder = str(CACHE_DIR / "osmnx")
    ox.settings.log_console = False
    return ox.geocode_to_gdf(city["place"]).geometry.union_all()


def fetch_address_rows(area) -> list:
    """Address points inside `area` -> [(street, house, settlements, lat, lng)]."""
    import osmnx as ox

    feats = ox.features_from_polygon(area, tags={"addr:housenumber": True})
    if feats.empty or "addr:street" not in feats.columns:
        return []
    points = feats.geometry.representative_point()
    columns = [c for c in ("addr:city", "addr:suburb", "addr:place") if c in feats.columns]
    rows = []
    for (_, row), pt in zip(feats.iterrows(), points):
        street, house = row.get("addr:street"), row.get("addr:housenumber")
        if not isinstance(street, str) or not isinstance(house, str):
            continue
        rows.append((street, house, [row[c] for c in columns if isinstance(row[c], str)], pt.y, pt.x))
    return rows


class Nominatim:
    """One request per MIN_INTERVAL_S, whatever the caller does."""

    def __init__(self) -> None:
        self._last = 0.0

    def search(self, query: str) -> tuple[float, float] | None:
        wait = MIN_INTERVAL_S - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        url = NOMINATIM_URL + "?" + urllib.parse.urlencode(
            {"q": query, "format": "jsonv2", "limit": 1, "accept-language": "sr"})
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=30) as response:
            results = json.loads(response.read().decode("utf-8"))
        if not results:
            return None
        return float(results[0]["lat"]), float(results[0]["lon"])


# ---------------------------------------------------------------------------------------------
# Cache and driver
# ---------------------------------------------------------------------------------------------

def cache_path(city_id: str) -> Path:
    return CACHE_DIR / city_id / "geocode-cache.json"


def read_cache(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        addresses = json.loads(path.read_text(encoding="utf-8")).get("addresses")
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{show(path)}: није исправан JSON ({exc}); обришите фајл и покрените поново") from exc
    if not isinstance(addresses, dict):
        raise ValueError(f"{show(path)}: нема објекта „addresses“; обришите фајл и покрените поново")
    return addresses


def write_cache(path: Path, city_id: str, addresses: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"city": city_id, "source": SOURCE, "addresses": dict(sorted(addresses.items()))}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_places(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"улаз: {exc} (прво покрените билд: npm run build)") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path.name}: није исправан JSON ({exc})") from exc
    places = data.get("places") if isinstance(data, dict) else None
    if not isinstance(places, list) or not all(isinstance(p, dict) and clean(p.get("address")) for p in places):
        raise ValueError(f"{path.name}: „places“ мора бити листа тачака са адресом")
    return places


class Geocoder:
    """OSM address points first, Nominatim second. Both are loaded only when an address needs them."""

    def __init__(self, city: dict, nominatim: Nominatim | None = None) -> None:
        self.city = city
        self.nominatim = nominatim or Nominatim()
        self._area = None
        self._index = None

    def area(self):
        if self._area is None:
            self._area = fetch_boundary(self.city)
        return self._area

    def index(self) -> dict:
        if self._index is None:
            print("  преузимање адресних тачака из OSM-а (може потрајати)…")
            self._index = build_address_index(fetch_address_rows(self.area()))
        return self._index

    def inside_city(self, lat: float, lng: float) -> bool:
        from shapely.geometry import Point

        return self.area().buffer(0.002).contains(Point(lng, lat))  # ~200 m of slack for edge addresses

    def geocode(self, address: str) -> tuple[dict | None, str | None]:
        """-> ({'lat', 'lng', 'via'}, None) or (None, reason)."""
        street, house, settlement = parse_address(address)
        reason = "нема броја у адреси"
        if house:
            point, reason = match_address(self.index(), street, house, settlement)
            if point:
                return {"lat": round(point[0], 6), "lng": round(point[1], 6), "via": "osm"}, None
            if "више удаљених" in reason:
                return None, reason  # more searching would only guess
        query = address if "," in address else f"{address}, {self.city['place']}"
        try:
            found = self.nominatim.search(query)
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as exc:
            return None, f"{reason}; Nominatim није одговорио ({exc})"
        if not found:
            return None, f"{reason}; Nominatim не познаје адресу"
        if not self.inside_city(*found):
            return None, f"{reason}; Nominatim је вратио тачку ван града ({found[0]:.5f}, {found[1]:.5f})"
        return {"lat": round(found[0], 6), "lng": round(found[1], 6), "via": "nominatim"}, None


def run(city_id: str, city: dict, input_path: Path, cache_file: Path, refresh: bool,
        geocoder: Geocoder | None = None) -> int:
    places = load_places(input_path)
    cache = read_cache(cache_file)
    geocoder = geocoder or Geocoder(city)

    wanted: dict[str, str] = {}
    for p in places:
        wanted.setdefault(address_key(p["address"]), clean(p["address"]))
    result = {k: v for k, v in cache.items() if k in wanted}  # addresses no longer in the Sheet are dropped
    dropped = len(cache) - len(result)

    failed: dict[str, str] = {}
    done = 0
    for key, address in wanted.items():
        if key in result and not refresh:
            continue
        print(f"→ {address}")
        found, reason = geocoder.geocode(address)
        if found:
            result[key] = {"address": address, **found, "fetched": date.today().isoformat()}
            done += 1
            print(f"  ✔ {found['lat']}, {found['lng']} ({found['via']})")
        else:
            result.pop(key, None)  # a stale position of an address that now fails must not stay
            failed[key] = reason or "непознат разлог"
            print(f"  ✖ {failed[key]}", file=sys.stderr)

    write_cache(cache_file, city_id, result)
    report = {
        "city": city_id,
        "geocoded": done,
        "cached": len(result) - done,
        "dropped": dropped,
        "failed": [{"id": p["id"], "name": p.get("name", ""), "address": clean(p["address"]),
                    "reason": failed[address_key(p["address"])]}
                   for p in places if address_key(p["address"]) in failed],
    }
    out = input_path.parent / "geocode-report.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{'✖' if failed else '✔'} {city_id}: нових {done}, већ у кешу {report['cached']}, "
          f"избачено {dropped}, неуспешно {len(failed)} → {show(cache_file)}")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Геокодирање тачака (#10).")
    parser.add_argument("--city", required=True, metavar="ИД", help="ид града из cities.yml")
    parser.add_argument("--refresh", action="store_true", help="поново геокодирај и адресе које су у кешу")
    parser.add_argument("--input", type=Path, help="подразумевано work/<град>/places-input.json")
    parser.add_argument("--cache", type=Path, help="подразумевано cache/<град>/geocode-cache.json")
    args = parser.parse_args(argv)
    try:
        cities = load_cities()
        if args.city not in cities:
            raise ValueError(f"непознат град: {args.city} (има: {', '.join(cities)})")
        return run(args.city, cities[args.city], args.input or WORK_DIR / args.city / "places-input.json",
                   args.cache or cache_path(args.city), args.refresh)
    except (OSError, ValueError) as exc:
        print(f"✖ {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
