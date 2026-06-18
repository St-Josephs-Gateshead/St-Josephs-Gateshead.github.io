"""
In-memory index of GregoBase chants, used for matching and search.

Chants loads gregobase_chants.json (written by update.py) and builds lookup
structures keyed by (version, office-part).  The primary consumer is propers.py,
which calls best_match() to find the closest GregoBase chant for each chanted
proper (Introitus, Graduale, etc.) using SequenceMatcher on normalised lyrics.

The search() method is used by the SPA's editorial chant-search UI.
"""

import json
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from _utils import _norm_lyrics

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_JSON_PATH = _DATA_DIR / "gregobase_chants.json"


PART_TO_ABBREV = {
    "Introitus": "in",
    "Graduale": "gr",
    "Alleluia": "al",
    "Tractus": "tr",
    "Sequentia": "se",
    "Offertorium": "of",
    "Communio": "co",
}

# Office-part codes searched when matching Prelude antiphons/processional chants
# "im" = improperia (Good Friday Adoratio crucis verses)
PRELUDE_PARTS = ["an", "pr", "im"]


def _version_year(version: str) -> int:
    """Extract the trailing year from a GregoBase version string, or 0 if absent."""
    parts = version.split()
    if len(parts) > 1 and parts[-1].isdigit():
        return int(parts[-1])
    return 0


_MATCH_CHARS = 120


class Chants:
    def __init__(self, json_path: Path = _JSON_PATH):
        # (version, office_part) → [(id, normalised_lyrics)]
        self._index: dict[tuple[str, str], list[tuple[int, str]]] = defaultdict(list)
        # id → first cleaned GABC string
        self._gabc: dict[int, str] = {}
        # id → all GABC blocks (for multi-verse chants)
        self._all_gabcs: dict[int, list[str]] = {}
        # id → metadata dict {lyrics, mode, version, office_part}
        self._meta: dict[int, dict] = {}
        # id → raw tex_verses string (only for chants that have it)
        self._tex_verses: dict[int, str] = {}

        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)

        for row in data:
            gabcs: list[str] = row.get("gabc", [])
            if not gabcs:
                continue
            lyrics: str = row.get("lyrics", "")
            norm = _norm_lyrics(lyrics)
            if not norm:
                continue
            chant_id: int = row["id"]
            key = (row["version"], row["office_part"])
            self._index[key].append((chant_id, norm))
            self._gabc[chant_id] = gabcs[0]
            self._all_gabcs[chant_id] = gabcs
            self._meta[chant_id] = {
                "lyrics": lyrics,
                "mode": row.get("mode", ""),
                "version": row["version"],
                "office_part": row["office_part"],
            }
            if row.get("tex_verses"):
                self._tex_verses[chant_id] = row["tex_verses"]

    # ------------------------------------------------------------------
    # Matching
    # ------------------------------------------------------------------

    def _candidates(
        self, version: str, parts: list[str], max_year: int
    ) -> list[tuple[int, str]]:
        """Return all (chant_id, normalised_lyrics) entries matching version prefix, office parts, and year cap."""
        return [
            entry
            for (v, p), entries in self._index.items()
            if p in parts and v.startswith(version) and _version_year(v) <= max_year
            for entry in entries
        ]

    def _score_candidates(
        self, candidates: list[tuple[int, str]], do_text: str
    ) -> int | None:
        """Return the chant_id whose normalised lyrics best match do_text via SequenceMatcher."""
        if not candidates:
            return None
        do_norm = _norm_lyrics(do_text)[:_MATCH_CHARS]
        best_id, best_score = None, 0.0
        for chant_id, chant_norm in candidates:
            score = SequenceMatcher(None, do_norm, chant_norm[:_MATCH_CHARS]).ratio()
            if score > best_score:
                best_score = score
                best_id = chant_id
        return best_id

    def best_match(
        self, version: str, part: str, do_text: str, max_year: int = 1962
    ) -> int | None:
        """Match a mass proper (Introitus, Graduale, etc.) against GregoBase."""
        abbrev = PART_TO_ABBREV.get(part, part.lower()[:2])
        return self._score_candidates(
            self._candidates(version, [abbrev], max_year), do_text
        )

    def best_match_prelude(
        self, version: str, do_text: str, max_year: int = 1962
    ) -> int | None:
        """Match a Prelude antiphon/processional chant against GregoBase."""
        return self._score_candidates(
            self._candidates(version, PRELUDE_PARTS, max_year), do_text
        )

    def best_match_tractus(self, do_text: str, max_year: int = 1962) -> int | None:
        """Match a prelude Tractus/Responsory across all editions.

        Good Friday 'Dómine, audívi' (id=3177) and 'Eripe me' (id=22) are
        classified as responsories (re) in the Solesmes edition, and as tractus
        (tr) only in the Vatican edition.  Searching both parts across all editions
        ensures the best Solesmes version is preferred.
        """
        all_tr_re = [
            entry
            for (v, p), entries in self._index.items()
            if p in ("tr", "re") and _version_year(v) <= max_year
            for entry in entries
        ]
        return self._score_candidates(all_tr_re, do_text)

    # ------------------------------------------------------------------
    # Retrieval
    # ------------------------------------------------------------------

    def get_gabc(self, chant_id: int) -> str | None:
        """Return the first (primary) cleaned GABC block for a chant, or None."""
        return self._gabc.get(chant_id)

    def get_all_gabcs(self, chant_id: int) -> list[str]:
        """Return all cleaned GABC blocks for a chant (multi-verse chants have several)."""
        return self._all_gabcs.get(chant_id, [])

    def get_meta(self, chant_id: int) -> dict | None:
        """Return metadata dict {lyrics, mode, version, office_part} for a chant, or None."""
        return self._meta.get(chant_id)

    def get_tex_verses(self, chant_id: int) -> str:
        """Return the raw tex_verses string for a chant, or empty string if none."""
        return self._tex_verses.get(chant_id, "")

    def search(
        self,
        query: str,
        parts: list[str] | None = None,
        version_prefix: str = "Solesmes",
        max_year: int = 1962,
        limit: int = 20,
    ) -> list[dict]:
        """
        Search for chants by lyrics substring.  Returns a list of metadata
        dicts (with chant_id added) sorted by match order.
        Used by the editorial web UI.
        """
        q_norm = _norm_lyrics(query) if query.strip() else ""
        results = []
        seen: set[int] = set()
        for chant_id, meta in self._meta.items():
            if chant_id in seen:
                continue
            if parts and meta["office_part"] not in parts:
                continue
            if not meta["version"].startswith(version_prefix):
                continue
            if _version_year(meta["version"]) > max_year:
                continue
            if q_norm and q_norm not in _norm_lyrics(meta["lyrics"]):
                continue
            seen.add(chant_id)
            results.append(
                {"chant_id": chant_id, **meta, "gabc": self._gabc.get(chant_id, "")}
            )
            if len(results) >= limit:
                break
        return results
