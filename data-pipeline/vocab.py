"""Words of the active profile for the Python steps.

The same profiles/<name>/profile.json the app and the Node pipeline use (profiles/load.mjs picks the name:
APP_PROFILE, else profiles/ACTIVE). build-data.mjs has already checked the profile when Python runs, so this
only reads it. (Not called "profile": the standard library has a module of that name.)"""
import json
import os
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILES_DIR = ROOT / "profiles"
DEFAULT_PROFILE = "teritorije"


def profile_name() -> str:
    env = os.environ.get("APP_PROFILE", "").strip()
    if env:
        return env
    active = PROFILES_DIR / "ACTIVE"
    return (active.read_text(encoding="utf-8").strip() if active.exists() else "") or DEFAULT_PROFILE


@lru_cache(maxsize=1)
def load() -> dict:
    return json.loads((PROFILES_DIR / profile_name() / "profile.json").read_text(encoding="utf-8"))


def tr(key: str, **values) -> str:
    """Text of the active profile with its {placeholders} filled: tr("report.noCapital", id=tid)."""
    return load()["text"][key].format(**values)
