#!/usr/bin/env python3
"""OSM street index for the data pipeline.

For every city in cities.yml it downloads the named streets from OpenStreetMap (OSMnx), assigns each
one to a settlement (OSM administrative boundary) and writes data-pipeline/cache/<city>/streets.json.

The result is public OSM data and is committed, so the normal build (`npm run build`) never touches
OSM services. Refreshing is deliberate:

    pip install -r data-pipeline/requirements.txt
    python data-pipeline/streets.py --city novi-sad --refresh

build-data.mjs reads the cache, pairs it with the Sheet and reports Sheet streets with no OSM match.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
CITIES_FILE = HERE / "cities.yml"
SHEET_CITIES_FILE = HERE / "work" / "cities.json"  # from the Sheet's "Градови" tab, written by build-data.mjs
CACHE_DIR = HERE / "cache"
ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

# highway=* values that are not streets a house number belongs to.
EXCLUDED_HIGHWAYS = {
    "footway", "path", "cycleway", "steps", "bridleway", "track", "corridor", "platform",
    "proposed", "construction", "service", "elevator", "raceway", "bus_guideway", "escape",
    "via_ferrata",
}


def clean(value) -> str:
    """Tag value -> single-spaced string; anything that is not a string (NaN, None) -> ''."""
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())


def pick_name(tags) -> str:
    """Prefer the Serbian name (Cyrillic in OSM), fall back to plain `name`."""
    for key in ("name:sr", "name"):
        name = clean(tags.get(key))
        if name:
            return name
    return ""


def is_street(highway) -> bool:
    value = clean(highway)
    return bool(value) and value not in EXCLUDED_HIGHWAYS and not value.endswith("_link")


def build_index(pairs) -> list[dict]:
    """[(name, settlement)] -> sorted unique [{'name', 'settlement'?}].

    Duplicates (one street is many OSM ways) are matched ignoring case and spacing. Script variants
    such as Cyrillic/Latin spellings are collapsed later, in build-city.mjs, which owns the
    transliteration.
    """
    seen: dict[tuple[str, str], tuple[str, str]] = {}
    for name, settlement in pairs:
        name, settlement = clean(name), clean(settlement)
        if not name:
            continue
        seen.setdefault((name.casefold(), settlement.casefold()), (name, settlement))
    ordered = sorted(seen.values(), key=lambda p: (p[1].casefold(), p[0].casefold()))
    return [{"name": n, **({"settlement": s} if s else {})} for n, s in ordered]


def summarize(index: list[dict]) -> list[str]:
    """Human-readable report; a wrong admin_level shows up as 'без насеља' dominating."""
    by_settlement = Counter(s.get("settlement", "") for s in index)
    lines = [f"  улица: {len(index)}"]
    for settlement, count in sorted(by_settlement.items(), key=lambda kv: (kv[0] == "", kv[0])):
        lines.append(f"  {settlement or 'без насеља'}: {count}")
    return lines


def load_cities(path: Path = CITIES_FILE, sheet_path: Path = SHEET_CITIES_FILE) -> dict[str, dict]:
    """Cities from cities.yml (optional) with the Sheet's "Градови" tab (work/cities.json, written by the
    build) on top: for the same id the Sheet's place and settlement levels win."""
    import yaml  # imported here so the helpers above need no third-party package

    cities = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    if not isinstance(cities, dict):
        raise ValueError(f"{path.name}: очекује се мапа градова")
    if sheet_path.exists():
        for city_id, city in json.loads(sheet_path.read_text(encoding="utf-8")).items():
            cities[city_id] = {**(cities.get(city_id) or {}), **city}
    if not cities:
        raise ValueError(
            f"нема градова: попуните cities.yml или покрените билд са SHEETS_ID ({show(sheet_path)} из листа „Градови“)"
        )
    for city_id, city in cities.items():
        if not ID_PATTERN.match(str(city_id)):
            raise ValueError(f"{path.name}: ид града „{city_id}“ мора бити облика novi-sad")
        if not isinstance(city, dict) or not clean(city.get("place")):
            raise ValueError(f"{path.name}: град „{city_id}“ мора имати „place“")
        levels = city.get("settlement_admin_levels", [9])
        if not isinstance(levels, list) or not levels or not all(isinstance(x, int) for x in levels):
            raise ValueError(f"{path.name}: „{city_id}“: settlement_admin_levels мора бити листа целих бројева")
        city["settlement_admin_levels"] = levels
    return cities


def show(path: Path) -> str:
    """Repo-relative path for messages (falls back to the full path)."""
    try:
        return str(path.relative_to(HERE.parent))
    except ValueError:
        return str(path)


def cache_path(city_id: str) -> Path:
    return CACHE_DIR / city_id / "streets.json"


def write_cache(city_id: str, city: dict, index: list[dict]) -> Path:
    out = cache_path(city_id)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "city": city_id,
        "place": city["place"],
        "fetched": date.today().isoformat(),
        "source": "© OpenStreetMap contributors (ODbL)",
        "streets": index,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def fetch_pairs(city: dict) -> list[tuple[str, str]]:
    """Downloads named streets inside the city boundary -> [(name, settlement)]."""
    import geopandas as gpd
    import osmnx as ox

    ox.settings.use_cache = True
    ox.settings.cache_folder = str(CACHE_DIR / "osmnx")  # raw HTTP cache, git-ignored
    ox.settings.log_console = False

    boundary = ox.geocode_to_gdf(city["place"])
    area = boundary.geometry.union_all()

    ways = ox.features_from_polygon(area, tags={"highway": True})
    ways = ways[ways.index.get_level_values(0) == "way"]
    ways = ways[ways.geom_type == "LineString"]
    ways = ways[ways["highway"].map(is_street)]
    if ways.empty:
        return []
    ways = ways.assign(street=ways.apply(pick_name, axis=1))
    ways = ways[ways["street"] != ""]
    if ways.empty:
        return []

    # One point per way (its midpoint). A street running through two settlements has ways in both,
    # so it appears once per settlement.
    points = gpd.GeoDataFrame(
        {"street": ways["street"].to_numpy()},
        geometry=ways.geometry.interpolate(0.5, normalized=True).to_numpy(),
        crs=ways.crs,
    )

    settlements = fetch_settlements(ox, area, city["settlement_admin_levels"])
    if settlements.empty:
        print("  ! нису нађена насеља (admin_level "
              f"{city['settlement_admin_levels']}); све улице су без насеља", file=sys.stderr)
        return [(s, "") for s in points["street"]]

    joined = gpd.sjoin(points, settlements, how="left", predicate="within")
    # Overlapping polygons give several matches per point: keep the smallest area.
    joined = joined.sort_values("_area", na_position="last")
    joined = joined[~joined.index.duplicated(keep="first")]
    return list(zip(joined["street"], joined["settlement"].fillna("")))


def fetch_settlements(ox, area, levels):
    """Settlement polygons as a GeoDataFrame with columns settlement, _area, geometry."""
    import geopandas as gpd

    empty = gpd.GeoDataFrame({"settlement": [], "_area": []}, geometry=[], crs="EPSG:4326")
    try:
        boundaries = ox.features_from_polygon(area, tags={"boundary": "administrative"})
    except Exception as exc:  # OSMnx raises when nothing matches
        print(f"  ! насеља: {exc}", file=sys.stderr)
        return empty
    if "admin_level" not in boundaries.columns:
        return empty
    boundaries = boundaries[boundaries.geom_type.isin(["Polygon", "MultiPolygon"])]
    boundaries = boundaries[boundaries["admin_level"].isin([str(level) for level in levels])]
    if boundaries.empty:
        return empty
    boundaries = boundaries.assign(settlement=boundaries.apply(pick_name, axis=1))
    boundaries = boundaries[boundaries["settlement"] != ""]
    if boundaries.empty:
        return empty
    area_m2 = boundaries.to_crs(boundaries.estimate_utm_crs()).area.to_numpy()
    return gpd.GeoDataFrame(
        {"settlement": boundaries["settlement"].to_numpy(), "_area": area_m2},
        geometry=boundaries.geometry.to_numpy(),
        crs=boundaries.crs,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Индекс улица из OSM-а (кешира се у data-pipeline/cache/).")
    parser.add_argument("--city", action="append", metavar="ИД",
                        help="ид града из cities.yml (може више пута); подразумевано сви")
    parser.add_argument("--refresh", action="store_true",
                        help="поново преузми и када кеш већ постоји")
    args = parser.parse_args(argv)

    try:
        cities = load_cities()
    except (OSError, ValueError) as exc:
        print(f"✖ {exc}", file=sys.stderr)
        return 2

    wanted = args.city or list(cities)
    unknown = [c for c in wanted if c not in cities]
    if unknown:
        print(f"✖ непознат град: {', '.join(unknown)} (има: {', '.join(cities)})", file=sys.stderr)
        return 2

    status = 0
    for city_id in wanted:
        existing = cache_path(city_id)
        if existing.exists() and not args.refresh:
            print(f"= {city_id}: кеш већ постоји ({show(existing)}); "
                  "користи --refresh за ново преузимање")
            continue
        print(f"→ {city_id}: преузимање улица из OSM-а ({cities[city_id]['place']})")
        try:
            index = build_index(fetch_pairs(cities[city_id]))
        except Exception as exc:  # nothing is written on failure, so an old cache stays valid
            print(f"✖ {city_id}: {exc}", file=sys.stderr)
            status = 1
            continue
        if not index:
            print(f"✖ {city_id}: није нађена ниједна улица; провери „place“ у cities.yml", file=sys.stderr)
            status = 1
            continue
        out = write_cache(city_id, cities[city_id], index)
        print(f"✔ {city_id}: {show(out)}")
        print("\n".join(summarize(index)))
    return status


if __name__ == "__main__":
    sys.exit(main())
