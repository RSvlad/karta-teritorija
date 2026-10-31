#!/usr/bin/env python3
"""Automatic territory drawing (issue #8).

Cuts the street network into blocks, treats the streets listed in the Sheet's "Обим" (scope) tab,
railways, rivers/canals and the city boundary as barriers, and grows every territory from its
capital across neighbouring blocks without crossing a barrier. A territory is the union of its blocks.
Streets that lie inside a territory become "internal" and inherit its default assignee.

    python data-pipeline/territories.py --city novi-sad --refresh   # download the street network (OSM)
    python data-pipeline/territories.py --city novi-sad             # draw

Input  data-pipeline/work/<city>/territories-input.json (git-ignored, written by the build):
    {"territories": [{"id": "1", "capital": {"lat": 45.25, "lng": 19.84}}, ...],
     "scope": [{"territory": "1", "street": "Футошка", "settlement": "",
                "from": "Јанка Веселиновића", "to": "Железничка"}, ...]}
  "from"/"to" are optional cross streets: only the part of the street between them is a barrier.
  Give both or neither. A missing "capital" is reported, not guessed.
  data-pipeline/work/<city>/overrides/<territory id>.geojson (from the Sheet's "Границе" tab) or
  data-pipeline/overrides/<city>/<territory id>.geojson, when present, replaces the automatic border.
Output data-pipeline/work/<city>/territories.json   internal streets and diagnostics (for report.py, #9)
       public/data/<city>.territories.geojson       territory polygons (WGS84)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Point, mapping, shape
from shapely.ops import polygonize, substring, unary_union
from shapely.strtree import STRtree

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE_DIR = HERE / "cache"
WORK_DIR = HERE / "work"
OVERRIDES_DIR = HERE / "overrides"
PUBLIC_DIR = ROOT / "public" / "data"

# All distances are metres; geometry is processed in a local projected CRS.
TOL_M = 0.5           # linework closer than this is the same line
MIN_OPEN_M = 1.0      # two blocks are connected when this much of their shared edge is not a barrier
MIN_BLOCK_M2 = 1.0    # smaller faces are slivers of the noding, not blocks
SNAP_M = 25.0         # a capital this close to a block (e.g. on the street) still seeds it
INNER_M = 2.0         # a street within this distance of a border is a border street, not an internal one
INTERNAL_SHARE = 0.9  # a street is internal when this much of its length is inside one territory
BORDER_MIN_M = 10.0   # a street runs along a territory's border when at least this much of it lies on it
# Drawing from the streets alone (no capitals, no "Обим"):
VOTE_BUFFER_M = 1.5   # a block edge this close to a rule's street counts as lying on it
TIE_M = 1.0           # two territories whose shares differ by less than this decide nothing
FILL_ROUNDS = 3       # how many blocks deep unlisted streets are filled in from the labelled ones
MAX_BLOCK_M2 = 1_500_000  # larger faces (forest, fields) are not a neighbourhood and are never labelled

BARRIER_RAILWAY = {"rail", "light_rail"}
BARRIER_WATERWAY = {"river", "canal"}

# Same transliteration as slug() in lib/build-city.mjs (which owns it); keep the two in step.
_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "ђ": "dj", "е": "e", "ж": "z", "з": "z",
    "и": "i", "ј": "j", "к": "k", "л": "l", "љ": "lj", "м": "m", "н": "n", "њ": "nj", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "ћ": "c", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "c", "џ": "dz", "ш": "s",
}


def slug(text: str) -> str:
    out = "".join(_TRANSLIT.get(ch, ch) for ch in str(text).lower()).replace("đ", "dj")
    out = "".join(ch for ch in unicodedata.normalize("NFKD", out) if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", "-", out).strip("-")


def compatible(a: str, b: str) -> bool:
    """An empty settlement matches any; two given ones must be equal."""
    return a == "" or b == "" or a == b


# ---------------------------------------------------------------------------------------------
# Geometry core (pure: shapely only, any planar CRS in metres)
# ---------------------------------------------------------------------------------------------

def make_street(name: str, settlement: str, line) -> dict:
    return {"name": name, "settlement": settlement, "line": line,
            "key": slug(name), "skey": slug(settlement)}


def points_of(geom) -> list:
    if geom.is_empty:
        return []
    if geom.geom_type == "Point":
        return [geom]
    if hasattr(geom, "geoms"):
        return [p for g in geom.geoms for p in points_of(g)]
    return [geom.centroid]  # a shared stretch of line: use its middle


def cut_between(lines: list, cross_a: list, cross_b: list) -> list:
    """Parts of one street between its crossings with streets A and B.

    Each separate part of the street (e.g. the two carriageways of a boulevard) is cut on its own,
    between the pair of crossings that are closest to each other along it. Parts without both
    crossings are left out.
    """
    merged = shapely.line_merge(unary_union(lines))
    parts = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
    ua, ub = unary_union(cross_a), unary_union(cross_b)
    cuts = []
    for part in parts:
        along_a = [part.project(p) for p in points_of(part.intersection(ua))]
        along_b = [part.project(p) for p in points_of(part.intersection(ub))]
        pairs = [(abs(a - b), min(a, b), max(a, b)) for a in along_a for b in along_b if abs(a - b) >= TOL_M]
        if pairs:
            _, lo, hi = min(pairs)
            cuts.append(substring(part, lo, hi))
    return cuts


def match_scope(streets: list, scope: list) -> tuple[list, list]:
    """Scope rows -> (barrier lines, problems). Unknown streets are problems, never ignored."""
    def lines_of(name: str, settlement: str) -> list:
        key, skey = slug(name), slug(settlement)
        return [s["line"] for s in streets if s["key"] == key and compatible(skey, s["skey"])]

    barriers, problems = [], []
    for i, row in enumerate(scope, start=1):
        where = f"Обим, ред {i}"
        name = str(row.get("street", "")).strip()
        settlement = str(row.get("settlement", "")).strip()
        a, b = str(row.get("from", "")).strip(), str(row.get("to", "")).strip()
        label = f"„{name}“" + (f" ({settlement})" if settlement else "")
        lines = lines_of(name, settlement)
        if not lines:
            problems.append(f"{where}: улица {label} није нађена у OSM мрежи (проверите писање и насеље)")
            continue
        if bool(a) != bool(b):
            problems.append(f"{where}: за {label} наведите обе укрснице („од“ и „до“) или ниједну")
            continue
        if not a:
            barriers.extend(lines)
            continue
        cross_a, cross_b = lines_of(a, settlement), lines_of(b, settlement)
        missing = [n for n, found in ((a, cross_a), (b, cross_b)) if not found]
        if missing:
            problems.append(f"{where}: укрсница „{'“, „'.join(missing)}“ није нађена у OSM мрежи")
            continue
        cuts = cut_between(lines, cross_a, cross_b)
        if not cuts:
            problems.append(f"{where}: улица {label} нема две различите укрснице са „{a}“ и „{b}“")
            continue
        barriers.extend(cuts)
    return barriers, problems


def split_blocks(lines: list) -> list:
    """Node all linework and return the faces it encloses."""
    return [p for p in polygonize(unary_union(lines)) if p.area >= MIN_BLOCK_M2]


def block_graph(blocks: list, barriers: list) -> dict[int, set[int]]:
    """Neighbouring blocks, except where their shared edge lies on a barrier."""
    return {i: set(nb) for i, nb in open_edges(blocks, barriers).items()}


def open_edges(blocks: list, barriers: list) -> dict[int, dict[int, float]]:
    """Neighbouring blocks -> length (m) of their shared edge that is not a barrier."""
    graph: dict[int, dict[int, float]] = {i: {} for i in range(len(blocks))}
    walls = unary_union(barriers).buffer(TOL_M) if barriers else None
    edges = [b.boundary for b in blocks]
    tree = STRtree(blocks)
    for i, block in enumerate(blocks):
        for j in tree.query(block, predicate="intersects"):
            j = int(j)
            if j <= i:
                continue
            shared = edges[i].intersection(edges[j])
            if shared.length < TOL_M:
                continue
            open_len = shared.length if walls is None else shared.difference(walls).length
            if open_len >= MIN_OPEN_M:
                graph[i][j] = open_len
                graph[j][i] = open_len
    return graph


def votes_from_streets(blocks: list, tree: STRtree, claims: list) -> dict[int, dict[str, float]]:
    """claims: [(territory id, street geometry)] -> per block, metres of its edge lying on each territory's streets."""
    votes: dict[int, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for tid, line in claims:
        zone = line.buffer(VOTE_BUFFER_M)
        for j in tree.query(zone, predicate="intersects"):
            length = blocks[int(j)].boundary.intersection(zone).length
            if length >= TOL_M:
                votes[int(j)][tid] += length
    return votes


def label_blocks(blocks: list, edges: dict, votes: dict, claimed: set) -> tuple[dict[int, str], int]:
    """Block -> territory, from the streets alone. -> (labels, number of blocks left undecided by a tie).

    1. A block belongs to the territory whose streets make up most of its edge (a tie decides nothing).
    2. The blocks around a few labelled ones (streets not listed in any rule) take the territory they
       share most edge with, for at most FILL_ROUNDS rounds, so an unlisted enclave is filled but the
       outskirts are not painted over. Blocks larger than MAX_BLOCK_M2 (forest, fields) never get one.
    """
    labels: dict[int, str] = {}
    ties = 0
    for i, v in votes.items():
        if i in claimed or blocks[i].area > MAX_BLOCK_M2:
            continue
        ranked = sorted(v.items(), key=lambda kv: -kv[1])
        if len(ranked) > 1 and ranked[0][1] - ranked[1][1] < TIE_M:
            ties += 1
            continue
        labels[i] = ranked[0][0]
    for _ in range(FILL_ROUNDS):
        new: dict[int, str] = {}
        for i, block in enumerate(blocks):
            if i in labels or i in claimed or block.area > MAX_BLOCK_M2:
                continue
            weight: dict[str, float] = defaultdict(float)
            for j, length in edges[i].items():
                if j in labels:
                    weight[labels[j]] += length
            if not weight:
                continue
            ranked = sorted(weight.items(), key=lambda kv: -kv[1])
            if len(ranked) == 1 or ranked[0][1] - ranked[1][1] >= TIE_M:
                new[i] = ranked[0][0]
        if not new:
            break
        labels.update(new)
    return labels, ties


def locate_seed(blocks: list, tree: STRtree, point) -> tuple[int | None, float]:
    """Block containing the point, else the nearest one within SNAP_M. -> (index, distance)."""
    for j in tree.query(point, predicate="intersects"):
        return int(j), 0.0
    if not len(blocks):
        return None, 0.0
    j = int(tree.nearest(point))
    dist = float(blocks[j].distance(point))
    return (j, dist) if dist <= SNAP_M else (None, dist)


def flood(graph: dict[int, set[int]], start: int, blocked: set[int]) -> set[int]:
    seen, stack = {start}, [start]
    while stack:
        for nxt in graph[stack.pop()]:
            if nxt not in seen and nxt not in blocked:
                seen.add(nxt)
                stack.append(nxt)
    return seen


@dataclass
class Drawing:
    polygons: dict = field(default_factory=dict)    # territory id -> geometry
    sources: dict = field(default_factory=dict)     # territory id -> "auto" | "override"
    blocks_of: dict = field(default_factory=dict)   # territory id -> sorted block indices
    seeds: dict = field(default_factory=dict)       # territory id -> {"block": int|None, "distance": float}
    conflicts: list = field(default_factory=list)   # [{"blocks": [...], "territories": [...], "areaM2": float}]
    unassigned: list = field(default_factory=list)  # block indices outside every territory


def draw(blocks: list, graph: dict, seeds: dict, overrides: dict) -> Drawing:
    """seeds: territory id -> Point | None; overrides: territory id -> polygonal geometry.

    Every territory is flooded on its own, so a block reached by two territories shows up as a
    conflict (an open border) instead of silently going to whoever got there first. Blocks claimed
    by an override are walls for everyone else's flood.
    """
    out = Drawing()
    tree = STRtree(blocks)
    reps = np.array([b.representative_point() for b in blocks], dtype=object)

    owners: dict[int, list[str]] = defaultdict(list)
    for tid, geom in overrides.items():
        inside = shapely.contains(geom, reps) if len(blocks) else []
        for i in np.flatnonzero(inside):
            owners[int(i)].append(tid)
        out.sources[tid] = "override"
    claimed = set(owners)

    for tid, point in seeds.items():
        if tid in overrides:
            continue
        out.sources[tid] = "auto"
        if point is None:
            out.seeds[tid] = {"block": None, "distance": None}
            continue
        idx, dist = locate_seed(blocks, tree, point)
        out.seeds[tid] = {"block": idx, "distance": round(dist, 1)}
        if idx is None or idx in claimed:
            continue
        for i in flood(graph, idx, claimed):
            owners[i].append(tid)

    mine: dict[str, list[int]] = defaultdict(list)
    for i, tids in sorted(owners.items()):
        if len(tids) > 1:
            area = unary_union([blocks[i]]).area
            out.conflicts.append({"blocks": [i], "territories": sorted(tids), "areaM2": round(area)})
        else:
            mine[tids[0]].append(i)
    out.conflicts = _merge_conflicts(out.conflicts)
    out.unassigned = [i for i in range(len(blocks)) if i not in owners]

    for tid in out.sources:
        out.blocks_of[tid] = mine.get(tid, [])
        if tid in overrides:
            out.polygons[tid] = overrides[tid]
        elif mine.get(tid):
            out.polygons[tid] = unary_union([blocks[i] for i in mine[tid]])
    return out


def draw_from_streets(blocks: list, streets: list, walls: list, rules: list, seeds: dict, overrides: dict):
    """Territories from the Sheet's street rules alone. -> (Drawing, unmatched street labels, tied blocks).

    rules: [{"street", "settlement", "territories": [ids]}], one per street that has rules. A street whose
    rules all point to one territory is that territory's; a street split between territories (odd/even
    sides, number ranges) is a border street and claims nothing. A block goes to the territory owning most
    of its edge (see label_blocks). Rail, water and the city boundary stay walls for the gap filling.
    """
    claims, unmatched = [], []
    for row in rules:
        name, settlement = str(row.get("street", "")).strip(), str(row.get("settlement", "")).strip()
        key, skey = slug(name), slug(settlement)
        lines = [s["line"] for s in streets if s["key"] == key and compatible(skey, s["skey"])]
        if not lines:
            unmatched.append(name + (f" ({settlement})" if settlement else ""))
            continue
        owners = {str(t) for t in row["territories"]}
        if len(owners) == 1:
            claims.append((next(iter(owners)), unary_union(lines)))

    out = Drawing()
    reps = np.array([b.representative_point() for b in blocks], dtype=object)
    claimed: set[int] = set()
    for tid, geom in overrides.items():
        inside = shapely.contains(geom, reps) if len(blocks) else []
        claimed.update(int(i) for i in np.flatnonzero(inside))
        out.sources[tid] = "override"
    for tid in seeds:
        out.sources.setdefault(tid, "streets")
        out.seeds[tid] = None

    edges = open_edges(blocks, walls)
    votes = votes_from_streets(blocks, STRtree(blocks), [c for c in claims if c[0] not in overrides])
    labels, ties = label_blocks(blocks, edges, votes, claimed)

    mine: dict[str, list[int]] = defaultdict(list)
    for i, tid in sorted(labels.items()):
        mine[tid].append(i)
    out.unassigned = [i for i in range(len(blocks)) if i not in labels and i not in claimed]
    for tid in out.sources:
        out.blocks_of[tid] = mine.get(tid, [])
        if tid in overrides:
            out.polygons[tid] = overrides[tid]
        elif mine.get(tid):
            out.polygons[tid] = unary_union([blocks[i] for i in mine[tid]])
    return out, sorted(set(unmatched)), ties


def _merge_conflicts(items: list) -> list:
    """One entry per contested set of territories, listing all its blocks."""
    grouped: dict[tuple, dict] = {}
    for c in items:
        key = tuple(c["territories"])
        g = grouped.setdefault(key, {"blocks": [], "territories": c["territories"], "areaM2": 0})
        g["blocks"] += c["blocks"]
        g["areaM2"] += c["areaM2"]
    return list(grouped.values())


def find_internal(streets: list, polygons: dict) -> list:
    """Streets lying (almost) entirely inside one territory, away from its border."""
    inner = {tid: poly.buffer(-INNER_M) for tid, poly in polygons.items()}
    inner = {tid: g for tid, g in inner.items() if not g.is_empty}
    groups: dict[tuple, list] = defaultdict(list)
    for s in streets:
        if s["key"]:
            groups[(s["key"], s["skey"])].append(s)
    found = []
    for members in groups.values():
        line = unary_union([m["line"] for m in members])
        if line.length <= 0:
            continue
        for tid, area in inner.items():
            if area.intersection(line).length / line.length >= INTERNAL_SHARE:
                found.append({"name": members[0]["name"], "settlement": members[0]["settlement"],
                              "territory": tid})
                break
    found.sort(key=lambda f: (f["territory"], f["name"], f["settlement"]))
    return found


def find_border(streets: list, polygons: dict) -> list:
    """Streets running along the border between two or more territories.

    Such a street needs rules for both sides (odd and even numbers), see report.py (#9).
    """
    edges = {tid: poly.boundary.buffer(INNER_M) for tid, poly in polygons.items()}
    groups: dict[tuple, list] = defaultdict(list)
    for s in streets:
        if s["key"]:
            groups[(s["key"], s["skey"])].append(s)
    found = []
    for members in groups.values():
        line = unary_union([m["line"] for m in members])
        if line.length <= 0:
            continue
        touched = sorted(tid for tid, edge in edges.items()
                         if edge.intersection(line).length >= BORDER_MIN_M)
        if len(touched) > 1:
            found.append({"name": members[0]["name"], "settlement": members[0]["settlement"],
                          "territories": touched})
    found.sort(key=lambda f: (f["name"], f["settlement"]))
    return found


def lnglat(geom, metric) -> dict:
    """Representative point of a metric-CRS geometry as {"lat", "lng"} (for the report's "where")."""
    lng, lat = to_wgs84_json(geom.representative_point(), metric)["coordinates"]
    return {"lat": lat, "lng": lng}


# ---------------------------------------------------------------------------------------------
# OSM network cache
# ---------------------------------------------------------------------------------------------

def network_path(city_id: str) -> Path:
    return CACHE_DIR / city_id / "network.json"


def fetch_network(city: dict) -> dict:
    """Streets (with settlement), railways, waterways and the city boundary, straight from OSM."""
    import geopandas as gpd
    import osmnx as ox
    from osmnx._errors import InsufficientResponseError
    import streets as street_index  # same filters and settlement rules as the street index

    ox.settings.use_cache = True
    ox.settings.cache_folder = str(CACHE_DIR / "osmnx")
    ox.settings.log_console = False

    boundary = ox.geocode_to_gdf(city["place"])
    area = boundary.geometry.union_all()

    def lines(tags: dict):
        # Only "nothing matches" means none; a server error must abort, or the cache would
        # silently lack barriers and territories would leak.
        try:
            gdf = ox.features_from_polygon(area, tags=tags)
        except InsufficientResponseError:
            return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
        gdf = gdf[gdf.index.get_level_values(0) == "way"].explode(index_parts=False)
        return gdf[gdf.geom_type == "LineString"]

    ways = lines({"highway": True})
    ways = ways[ways["highway"].map(street_index.is_street)]
    if ways.empty:
        raise ValueError("нису нађене улице; провери „place“ у cities.yml")
    ways = ways.assign(street=ways.apply(street_index.pick_name, axis=1), settlement="")
    named = ways["street"] != ""
    settlements = street_index.fetch_settlements(ox, area, city["settlement_admin_levels"])
    if named.any() and not settlements.empty:
        metric_ways = ways.loc[named].to_crs(ways.estimate_utm_crs())
        mids = gpd.GeoDataFrame(
            {"street": ways.loc[named, "street"].to_numpy()},
            geometry=metric_ways.geometry.interpolate(0.5, normalized=True).to_numpy(),
            crs=metric_ways.crs,
        ).to_crs(settlements.crs)
        joined = gpd.sjoin(mids, settlements, how="left", predicate="within")
        joined = joined.sort_values("_area", na_position="last")
        joined = joined[~joined.index.duplicated(keep="first")]
        ways.loc[named, "settlement"] = joined.sort_index()["settlement"].fillna("").to_numpy()

    def drop_tunnels(gdf):
        if "tunnel" in gdf.columns:
            gdf = gdf[gdf["tunnel"].isna() | (gdf["tunnel"] == "no")]
        return gdf

    rail = drop_tunnels(lines({"railway": sorted(BARRIER_RAILWAY)}))
    water = drop_tunnels(lines({"waterway": sorted(BARRIER_WATERWAY)}))
    edge = area.boundary
    edge_parts = list(edge.geoms) if hasattr(edge, "geoms") else [edge]

    def coords(geom) -> list:
        return [[round(x, 6), round(y, 6)] for x, y in geom.coords]

    return {
        "city": None,  # filled by the caller
        "place": city["place"],
        "fetched": date.today().isoformat(),
        "source": "© OpenStreetMap contributors (ODbL)",
        "streets": [{"name": n, "settlement": s, "coords": coords(g)}
                    for n, s, g in zip(ways["street"], ways["settlement"], ways.geometry)],
        "barriers": [{"kind": kind, "coords": coords(g)}
                     for kind, frame in (("railway", rail), ("waterway", water)) for g in frame.geometry],
        "boundary": [coords(g) for g in edge_parts],
    }


# ---------------------------------------------------------------------------------------------
# Input / output
# ---------------------------------------------------------------------------------------------

def read_json(path: Path, what: str):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"{what}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"{what} ({path.name}): није исправан JSON ({exc})") from exc


def load_input(path: Path) -> tuple[list, list, list | None]:
    """-> (territories, scope, rules). `rules` is None unless the input asks to draw from the streets alone."""
    data = read_json(path, "улаз")
    territories, scope, rules = data.get("territories"), data.get("scope", []), data.get("rules")
    if not isinstance(territories, list) or not territories:
        raise ValueError(f"{path.name}: „territories“ мора бити непразна листа")
    if not isinstance(scope, list):
        raise ValueError(f"{path.name}: „scope“ мора бити листа")
    if rules is not None and not isinstance(rules, list):
        raise ValueError(f"{path.name}: „rules“ мора бити листа")
    seen = set()
    for t in territories:
        tid = str(t.get("id", "")).strip() if isinstance(t, dict) else ""
        if not tid or tid in seen:
            raise ValueError(f"{path.name}: територија без ида или са поновљеним идом „{tid}“")
        seen.add(tid)
        cap = t.get("capital")
        if cap is not None and not (isinstance(cap, dict) and {"lat", "lng"} <= cap.keys()):
            raise ValueError(f"{path.name}: престоница територије „{tid}“ мора имати lat и lng")
    for row in scope:
        if not isinstance(row, dict) or str(row.get("territory", "")) not in seen:
            raise ValueError(f"{path.name}: ред Обима упућује на непознату територију: {row}")
    for row in rules or []:
        ids = row.get("territories") if isinstance(row, dict) else None
        if not isinstance(ids, list) or not ids or not {str(i) for i in ids} <= seen:
            raise ValueError(f"{path.name}: правило упућује на непознату територију: {row}")
    return territories, scope, rules


def load_override(path: Path):
    """GeoJSON (geometry, Feature or FeatureCollection) -> one polygonal geometry (WGS84)."""
    data = read_json(path, "ручна граница")
    kind = data.get("type")
    if kind == "FeatureCollection":
        geoms = [shape(f["geometry"]) for f in data.get("features", [])]
    elif kind == "Feature":
        geoms = [shape(data["geometry"])]
    else:
        geoms = [shape(data)]
    geom = shapely.make_valid(unary_union(geoms))
    polys = [g for g in getattr(geom, "geoms", [geom]) if g.geom_type in ("Polygon", "MultiPolygon")]
    if not polys:
        raise ValueError(f"{path.name}: нема полигона")
    return unary_union(polys)


def to_wgs84_json(geom, metric) -> dict:
    import geopandas as gpd

    wgs = gpd.GeoSeries([geom], crs=metric).to_crs(4326).iloc[0]
    return mapping(shapely.set_precision(wgs, 1e-6))


def run(city_id: str, input_path: Path, out_dir: Path) -> int:
    import geopandas as gpd

    net = read_json(network_path(city_id), "мрежа")
    kinds, names, settlements, geoms = [], [], [], []
    for s in net["streets"]:
        kinds.append("street"), names.append(s["name"]), settlements.append(s["settlement"])
        geoms.append(shapely.LineString(s["coords"]))
    for b in net["barriers"]:
        kinds.append(b["kind"]), names.append(""), settlements.append("")
        geoms.append(shapely.LineString(b["coords"]))
    for ring in net["boundary"]:
        kinds.append("boundary"), names.append(""), settlements.append("")
        geoms.append(shapely.LineString(ring))
    frame = gpd.GeoDataFrame({"kind": kinds, "name": names, "settlement": settlements},
                             geometry=geoms, crs="EPSG:4326")
    metric = frame.estimate_utm_crs()
    frame = frame.to_crs(metric)

    streets = [make_street(n, s, g) for k, n, s, g in zip(frame["kind"], frame["name"], frame["settlement"],
                                                          frame.geometry) if k == "street"]
    walls = [g for k, g in zip(frame["kind"], frame.geometry) if k in ("railway", "waterway", "boundary")]
    boundary = unary_union([g for k, g in zip(frame["kind"], frame.geometry) if k == "boundary"])

    territories, scope, rules = load_input(input_path)
    from_streets = rules is not None
    scope_barriers, problems = ([], []) if from_streets else match_scope(streets, scope)
    if problems:
        print("✖ Обим:\n" + "\n".join(f"    • {p}" for p in problems), file=sys.stderr)
        return 1

    seeds = {}
    for t in territories:
        cap = t.get("capital")
        seeds[str(t["id"])] = None if cap is None or from_streets else gpd.GeoSeries(
            [Point(float(cap["lng"]), float(cap["lat"]))], crs="EPSG:4326").to_crs(metric).iloc[0]

    overrides = {}
    for tid in seeds:
        # The Sheet's "Границе" tab (written by the build into work/, git-ignored) wins over committed files.
        path = WORK_DIR / city_id / "overrides" / f"{tid}.geojson"
        if not path.exists():
            path = OVERRIDES_DIR / city_id / f"{tid}.geojson"
        if path.exists():
            overrides[tid] = gpd.GeoSeries([load_override(path)], crs="EPSG:4326").to_crs(metric).iloc[0]

    blocks = split_blocks([s["line"] for s in streets] + walls)
    unmatched, ties = [], 0
    if from_streets:
        drawing, unmatched, ties = draw_from_streets(blocks, streets, walls, rules, seeds, overrides)
    else:
        graph = block_graph(blocks, scope_barriers + walls)
        drawing = draw(blocks, graph, seeds, overrides)
    internal = find_internal(streets, drawing.polygons)
    border = find_border(streets, drawing.polygons)
    for c in drawing.conflicts:
        c["center"] = lnglat(unary_union([blocks[i] for i in c["blocks"]]), metric)

    edge = boundary.buffer(2 * TOL_M) if not boundary.is_empty else None
    stats = {}
    for tid in seeds:
        poly = drawing.polygons.get(tid)
        touches = bool(poly is not None and edge is not None and poly.intersects(edge))
        stats[tid] = {
            "source": drawing.sources[tid],
            "blocks": len(drawing.blocks_of[tid]),
            "areaM2": round(poly.area) if poly is not None else 0,
            "touchesCityBoundary": touches,
            "boundaryContact": lnglat(poly.intersection(edge), metric) if touches else None,
            "capital": drawing.seeds.get(tid),
            "hasCapital": seeds[tid] is not None,
            "capitalInsidePolygon": None if seeds[tid] is None or poly is None
            else bool(poly.buffer(TOL_M).contains(seeds[tid])),
        }
    report = {
        "city": city_id,
        "generated": date.today().isoformat(),
        "territories": stats,
        "conflicts": drawing.conflicts,
        "unassigned": {"blocks": len(drawing.unassigned),
                       "areaM2": round(sum(blocks[i].area for i in drawing.unassigned))},
        "internal": internal,
        "border": border,
    }

    work = WORK_DIR / city_id
    work.mkdir(parents=True, exist_ok=True)
    (work / "territories.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                                           encoding="utf-8")
    out_dir.mkdir(parents=True, exist_ok=True)
    features = [{"type": "Feature", "properties": {"id": tid, "source": drawing.sources[tid]},
                 "geometry": to_wgs84_json(poly, metric)} for tid, poly in drawing.polygons.items()]
    (out_dir / f"{city_id}.territories.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False) + "\n",
        encoding="utf-8")

    print(f"✔ {city_id}: територија {len(drawing.polygons)}/{len(seeds)}, блокова {len(blocks)}, "
          f"унутрашњих улица {len(internal)}")
    for tid, s in stats.items():
        note = ""
        if s["source"] == "auto" and seeds[tid] is None:
            note = "  ! нема престонице"
        elif s["source"] == "auto" and s["capital"]["block"] is None:
            note = "  ! престоница није близу ниједног блока"
        elif s["touchesCityBoundary"] and s["source"] != "streets":
            note = "  ! додирује границу града (обим можда није затворен)"
        print(f"  {tid}: {s['source']}, блокова {s['blocks']}, {s['areaM2']} m²{note}")
    for c in drawing.conflicts:
        print(f"  ! блокови које деле територије {', '.join(c['territories'])}: {len(c['blocks'])}")
    if drawing.unassigned:
        print(f"  ! блокова без територије: {report['unassigned']['blocks']}")
    if from_streets:
        empty = [tid for tid in seeds if tid not in drawing.polygons]
        if empty:
            print(f"  ! територије без иједног блока (нема им додељених улица у OSM мрежи): {', '.join(empty)}")
        if ties:
            print(f"  ! блокова између две територије без премоћи: {ties}")
        if unmatched:
            print("  ! улице из Правила којих нема у OSM мрежи (проверите писање):\n"
                  + "\n".join(f"      • {name}" for name in unmatched))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Аутоматско исцртавање територија (#8).")
    parser.add_argument("--city", required=True, metavar="ИД", help="ид града из cities.yml")
    parser.add_argument("--refresh", action="store_true",
                        help="поново преузми уличну мрежу из OSM-а (иначе се користи кеш)")
    parser.add_argument("--input", type=Path, help="подразумевано work/<град>/territories-input.json")
    parser.add_argument("--out", type=Path, default=PUBLIC_DIR, help="фасцикла за <град>.territories.geojson")
    args = parser.parse_args(argv)

    try:
        if args.refresh:
            import streets as street_index

            cities = street_index.load_cities()
            if args.city not in cities:
                print(f"✖ непознат град: {args.city} (има: {', '.join(cities)})", file=sys.stderr)
                return 2
            print(f"→ {args.city}: преузимање уличне мреже из OSM-а ({cities[args.city]['place']})")
            net = fetch_network(cities[args.city])
            net["city"] = args.city
            out = network_path(args.city)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(net, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
            print(f"✔ {args.city}: {out.relative_to(ROOT)} (улица: {len(net['streets'])}, "
                  f"баријера: {len(net['barriers'])})")
            by_settlement = Counter(s["settlement"] for s in net["streets"] if s["name"])
            print("  насеља (именоване улице): " + ", ".join(
                f"{name or 'без насеља'} {count}" for name, count in by_settlement.most_common()))
        if not network_path(args.city).exists():
            print(f"✖ {args.city}: нема мреже; покрените са --refresh", file=sys.stderr)
            return 2
        input_path = args.input or WORK_DIR / args.city / "territories-input.json"
        if args.refresh and not input_path.exists():
            return 0  # refreshing the cache needs no input
        return run(args.city, input_path, args.out)
    except (OSError, ValueError) as exc:
        print(f"✖ {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
