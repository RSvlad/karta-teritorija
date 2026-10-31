"""Territory report (issue #9): checks the output of territories.py and fails the build on critical errors.

    python data-pipeline/report.py --city novi-sad

Reads   data-pipeline/work/<city>/territories.json   (territories.py)
        public/data/<city>.json                      (build-data.mjs: streets and rules, for the border check)
        data-pipeline/cache/<city>/streets.json      (streets.py, optional: for the OSM pairing warning)
        data-pipeline/work/<city>/geocode-report.json (geocode.py, optional: reasons for missing coordinates)
Writes  data-pipeline/work/<city>/report.json
Exit    0 = no critical errors (warnings are fine), 1 = critical errors, 2 = an input is missing.

Critical: a leak (territory touches the city boundary or is far bigger than the others), a territory
without a capital / with the capital outside its polygon / without any block, blocks claimed by two
territories, a street on the border of two territories without rules for both sides (odd and even),
a capital without coordinates (it cannot seed the drawing; geocode.py failed or was not run).
Warnings: blocks without a territory (shown grey on the map), Sheet streets without a pair in OSM,
other places without coordinates, a city without places.
Exactly one capital per territory is enforced earlier, by the build (lib/build-city.mjs, #10).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

from territories import CACHE_DIR, PUBLIC_DIR, WORK_DIR, slug

LEAK_RATIO = 4.0   # a territory this many times bigger than the median one is a leak ...
LEAK_MIN_TERRITORIES = 3  # ... judged only when there are enough territories to have a median
SIDES = {"odd": "непарни", "even": "парни"}


def item(code: str, message: str, territory: str | None = None, where: dict | None = None) -> dict:
    out = {"code": code, "message": message}
    if territory is not None:
        out["territory"] = territory
    if where:
        out["where"] = {**where, "url": "https://www.openstreetmap.org/?mlat={lat}&mlon={lng}#map=17/{lat}/{lng}"
                        .format(**where)}
    return out


def same_settlement(a: str, b: str) -> bool:
    a, b = slug(a), slug(b)
    return a == "" or b == "" or a == b


def describe(name: str, settlement: str) -> str:
    return f"„{name}“" + (f" ({settlement})" if settlement else "")


def check_territories(report: dict) -> list[dict]:
    critical = []
    stats = report["territories"]
    areas = [s["areaM2"] for s in stats.values() if s["areaM2"] > 0]
    median = statistics.median(areas) if len(areas) >= LEAK_MIN_TERRITORIES else None
    for tid, s in stats.items():
        if not s["hasCapital"]:
            critical.append(item("no-capital", f"Територија „{tid}“ нема престоницу.", tid))
            continue
        if s["source"] == "auto":
            if s["capital"]["block"] is None:
                critical.append(item("capital-off-network",
                                     f"Престоница територије „{tid}“ није близу ниједног блока уличне мреже.", tid))
                continue
            if s["areaM2"] == 0:
                critical.append(item("no-blocks", f"Територија „{tid}“ нема ниједан блок "
                                     "(престоница је унутар ручне границе друге територије?).", tid))
                continue
        if s["capitalInsidePolygon"] is False:
            critical.append(item("capital-outside", f"Престоница територије „{tid}“ је ван њеног полигона.", tid))
        if s["source"] == "auto" and s["touchesCityBoundary"]:
            critical.append(item("leak-boundary", f"Територија „{tid}“ додирује границу града: обим није затворен "
                                 "(цури). Место додира:", tid, s["boundaryContact"]))
        if s["source"] == "auto" and median and s["areaM2"] >= LEAK_RATIO * median:
            critical.append(item("leak-area", f"Територија „{tid}“ је {s['areaM2'] / median:.1f} пута већа од "
                                 "медијане територија: обим вероватно није затворен.", tid))
    for c in report["conflicts"]:
        critical.append(item(
            "conflict", f"{len(c['blocks'])} блок(ова) ({c['areaM2']} m²) деле територије "
            f"{', '.join(c['territories'])}: обим између њих није затворен. Место:", None, c.get("center")))
    return critical


def rules_for(city: dict, name: str, settlement: str) -> set[str]:
    """Parities (all/odd/even) of the rules of a street, by name + settlement (same match as the build)."""
    ids = {s["id"] for s in city["streets"]
           if slug(s["name"]) == slug(name) and same_settlement(s.get("settlement", ""), settlement)}
    return {r["parity"] for r in city["rules"] if r["streetId"] in ids}


def check_border_streets(report: dict, city: dict) -> list[dict]:
    critical = []
    for b in report["border"]:
        parities = rules_for(city, b["name"], b["settlement"])
        missing = [] if "all" in parities else [SIDES[p] for p in ("odd", "even") if p not in parities]
        if missing:
            critical.append(item(
                "border-street-no-rules",
                f"Ивична улица {describe(b['name'], b['settlement'])} (територије {', '.join(b['territories'])}) "
                f"нема правила за: {', '.join(missing)}."))
    return critical


def check_places(city: dict, geocode: dict | None) -> tuple[list[dict], list[dict]]:
    """-> (critical, warnings) about places that have no coordinates."""
    reasons = {f["id"]: f["reason"] for f in (geocode or {}).get("failed", [])}
    places = city.get("places") or []
    critical, warnings = [], []
    if not places:
        warnings.append(item("no-places", "Град нема тачке (лист „Тачке“): картице немају престоницу."))
    for p in places:
        if "lat" in p and "lng" in p:
            continue
        why = reasons.get(p["id"], "geocode.py није покренут за ову адресу")
        text = f"{p['name']}, {p['address']}: {why}"
        if p["kind"] == "capital":
            critical.append(item("capital-not-geocoded", f"Престоница територије „{p['territoryId']}“ нема "
                                 f"координате ({text}).", p["territoryId"]))
        else:
            warnings.append(item("place-not-geocoded", f"Тачка без координата ({text}).", p["territoryId"]))
    return critical, warnings


def check_warnings(report: dict, city: dict, osm: dict | None) -> list[dict]:
    warnings = []
    u = report["unassigned"]
    if u["blocks"]:
        warnings.append(item("unassigned-blocks", f"{u['blocks']} блок(ова) ({u['areaM2']} m²) без територије "
                             "(на мапи сиво „неподељено“)."))
    if osm is None:
        warnings.append(item("no-osm-index", "Нема OSM индекса улица (data-pipeline/streets.py): "
                             "улице из Sheet-а се не могу упарити."))
        return warnings
    known = [(slug(s["name"]), s.get("settlement", "")) for s in osm["streets"]]
    with_rules = {r["streetId"] for r in city["rules"]}
    for s in city["streets"]:
        if s["id"] in with_rules and not any(
                n == slug(s["name"]) and same_settlement(st, s.get("settlement", "")) for n, st in known):
            warnings.append(item("no-osm-pair", f"Улица {describe(s['name'], s.get('settlement', ''))} из Sheet-а "
                                 "нема пар у OSM-у (проверите писање или освежите индекс)."))
    return warnings


def read(path: Path, what: str, required: bool = True):
    if not path.exists():
        if required:
            raise FileNotFoundError(f"Нема {what}: {path}")
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def build_report(city_id: str, territories: dict, city: dict, osm: dict | None, geocode: dict | None = None) -> dict:
    place_critical, place_warnings = check_places(city, geocode)
    critical = check_territories(territories) + check_border_streets(territories, city) + place_critical
    return {"city": city_id, "critical": critical,
            "warnings": check_warnings(territories, city, osm) + place_warnings}


def print_report(result: dict) -> None:
    def show(mark: str, items: list) -> None:
        for i in items:
            where = f" {i['where']['lat']:.5f}, {i['where']['lng']:.5f} ({i['where']['url']})" if "where" in i else ""
            print(f"  {mark} {i['message']}{where}", file=sys.stderr if mark == "✖" else sys.stdout)

    c, w = result["critical"], result["warnings"]
    print(f"{'✖' if c else '✔'} {result['city']}: критичних грешака {len(c)}, упозорења {len(w)}")
    show("✖", c)
    show("!", w)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Извештај о територијама (#9).")
    parser.add_argument("--city", required=True, metavar="ИД", help="ид града из cities.yml")
    parser.add_argument("--data", type=Path, help="подразумевано public/data/<град>.json")
    args = parser.parse_args(argv)
    work = WORK_DIR / args.city
    try:
        territories = read(work / "territories.json", "резултат цртања (покрените territories.py)")
        city = read(args.data or PUBLIC_DIR / f"{args.city}.json", "податке града (покрените билд)")
        osm = read(CACHE_DIR / args.city / "streets.json", "OSM индекс", required=False)
        geocode = read(work / "geocode-report.json", "извештај геокодирања", required=False)
    except (FileNotFoundError, ValueError) as e:
        print(f"✖ {e}", file=sys.stderr)
        return 2
    result = build_report(args.city, territories, city, osm, geocode)
    (work / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print_report(result)
    return 1 if result["critical"] else 0


if __name__ == "__main__":
    sys.exit(main())
