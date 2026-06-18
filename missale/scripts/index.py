"""
Generate tempora.csv, sancti.csv, and commune.csv from Divinum Officium source files.

Columns: path_name, name
  path_name — DO filename stem (e.g. Adv1-0, 01-25, Coronatio)
  name      — feast name from [Officium] or embedded in [Rank]

Tempora and Sancti entries are scanned from DO Latin source files with suffix
filtering and section detection.  Commune entries are curated in _COMMUNE_ENTRIES
(no DO source files to scan).  Manual entries in _MANUAL_ENTRIES handle sancti that
have no DO file (e.g. Christ the King).

Usage:
    python index.py
"""

import csv
import re
from pathlib import Path

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_DO_ROOT = _DATA_DIR / "divinum-officium/web/www/missa/Latin"


# Base patterns (match the structural prefix; suffix = everything after)
_SANCTI_BASE = re.compile(r"^\d{2}-\d{2}")
_TEMPORA_BASE = re.compile(r"^[A-Za-z][A-Za-z0-9]*-\d+")

# 1962 TLM suffix allowlists (keyed by mass_type)
_ALLOWED: dict[str, set] = {
    "sancti": {"", "m1", "m2", "m3", "oct", "bmv", "a", "c"},
    "tempora": {
        "",
        "a",
        "m1",
        "m2",
    },  # m1 = Chrism Mass, m2 = Mass of the Lord's Supper
}

# Detects any Mass proper section in a DO file (Prelude catches Triduum days
# that have no standard Mass but do have their own liturgical content)
_MASS_SECTION_RE = re.compile(
    r"\[(Introitus|Graduale|Lectio|Oratio|Evangelium|Offertorium|Communio|Postcommunio|Prelude)\]"
)
# Detects an explicit ex/vide inheritance directive
_EX_VIDE_RE = re.compile(r"^\s*(?:ex|vide)\s+\w+/\S", re.MULTILINE)


def _has_own_propers(path: Path) -> bool:
    """Return False for ferial files that only exist to fall back to their Sunday."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return True
    stripped = text.strip()
    # Files starting with @ inherit propers from the referenced file — keep them
    if stripped.startswith("@"):
        return True
    # Explicit ex/vide directive — keep them
    if _EX_VIDE_RE.search(text):
        return True
    # Has at least one Mass proper section — keep them
    if _MASS_SECTION_RE.search(text):
        return True
    return False


def _parse_file(path: Path, _depth: int = 0) -> str:
    """Return feast_name for a DO mass file.

    If the entire file is a bare @Reference with no section markers, follow it
    (up to 3 levels deep) to resolve the feast name from the target file.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return ""

    stripped = text.strip()

    # Bare @Reference: whole file is just "@Dir/File" with no [sections]
    if _depth < 3 and stripped.startswith("@") and "[" not in stripped:
        ref_line = stripped.splitlines()[0].lstrip("@").split(":")[0].strip()
        if "/" in ref_line:
            ref_dir, ref_file = ref_line.split("/", 1)
            ref_path = path.parent.parent / ref_dir / f"{ref_file}.txt"
            if ref_path.exists():
                return _parse_file(ref_path, _depth + 1)

    sections: dict[str, str] = {}
    for chunk in stripped.split("[")[1:]:
        parts = chunk.split("]", 1)
        if len(parts) == 2:
            # setdefault keeps the first (unqualified) entry, ignoring later
            # variants like [Rank] (rubrica 1960) which overwrite the key.
            sections.setdefault(parts[0].strip(), parts[1].strip())

    # Feast name: [Officium] content (first non-empty line)
    name = ""
    if "Officium" in sections:
        for line in sections["Officium"].splitlines():
            line = line.strip()
            if line and not line.startswith("@") and not line.startswith("!"):
                name = line
                break

    # Rank line: "FeastName;;RankLabel;;rank_num" — fallback source for feast name
    if "Rank" in sections and not name:
        rank_line = sections["Rank"].splitlines()[0].strip() if sections["Rank"] else ""
        if ";;" in rank_line:
            prefix = rank_line.split(";;")[0].strip()
            if prefix:
                name = prefix

    return name


# Manual entries that have no Divinum Officium source file.
# Add new entries here; they are merged into the generated CSV at build time.
_MANUAL_ENTRIES: dict[str, list[tuple[str, str]]] = {
    "sancti": [
        ("10-DU", "In Festo Domini Nostri Jesu Christi Regis"),
    ],
    "tempora": [],
}

# Curated list of standalone commune Masses (from horas/Latin/Commune/),
# ordered by category. Only files with complete Mass propers are included.
_COMMUNE_ENTRIES: list[tuple[str, str]] = [
    # Martyrs
    ("C2", "Commune Unius Martyris Pontificis"),
    ("C2a", "Commune Unius Martyris"),
    ("C2b", "Commune unius Summi Pontificis et Martyris"),
    ("C3", "Commune Plurimorum Martyrum Pontificum"),
    ("C3a", "Commune Plurimorum Martyrum"),
    ("C3b", "Commune plurium Summorum Pontificum Martyrum"),
    # Confessors
    ("C4", "Commune unius Confessoris Pontificis"),
    ("C4a", "Commune Doctoris Pontificis"),
    ("C4b", "Commune Summorum Pontificum Confessorum"),
    ("C5", "Commune Confessoris non Pontificis"),
    ("C5a", "Commune Doctoris non Pontificis"),
    ("C5b", "Commune Abbatis"),
    # Virgins and women
    ("C6", "Commune Unius Virginis et Martyris"),
    ("C6a", "Commune Virginum"),
    ("C7", "Commune non Virginis Martyris"),
    ("C7a", "Commune non Virginum non Martyrum"),
    ("C7b", "Commune plurimarum non Virginum Martyrum"),
    # Special
    ("C8", "Commune Dedicationis Ecclesiae"),
    ("C9", "Missa pro Defunctis"),
    # Blessed Virgin Mary
    ("C10", "Sanctæ Mariæ Sabbato"),
    ("C10Pasc", "Sanctæ Mariæ Tempore Paschali"),
    ("C10a", "Sanctæ Mariæ in Adventu"),
    ("C10b", "Sanctæ Mariæ a Nativitate ad Purificationem"),
    ("C11", "In Festis Beatæ Mariæ Virginis"),
    # Votive
    ("Coronatio", "Missa Votiva Papalis"),
]


def generate(mass_type: str) -> Path:
    if mass_type == "tempora":
        src_dir = _DO_ROOT / "Tempora"
        base_re = _TEMPORA_BASE
    elif mass_type == "sancti":
        src_dir = _DO_ROOT / "Sancti"
        base_re = _SANCTI_BASE
    else:
        raise ValueError(f"Unknown mass_type: {mass_type!r}")

    allowed = _ALLOWED[mass_type]
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = _DATA_DIR / f"{mass_type}.csv"

    manual_rows = _MANUAL_ENTRIES.get(mass_type, [])

    rows = []
    for p in sorted(src_dir.glob("*.txt")):
        m = base_re.match(p.stem)
        if not m:
            continue
        suffix = p.stem[m.end() :]
        if suffix not in allowed:
            continue
        if mass_type == "tempora" and not _has_own_propers(p):
            continue
        name = _parse_file(p)
        rows.append((p.stem, name))

    # Merge manual rows back in, sorted by path_name
    all_rows = sorted(rows + manual_rows, key=lambda r: r[0])

    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["path_name", "name"])
        for row in all_rows:
            w.writerow(row)

    print(f"Written {len(all_rows)} entries ({len(manual_rows)} manual) -> {out}")
    return out


def generate_commune() -> Path:
    """Write commune.csv from the curated _COMMUNE_ENTRIES list."""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = _DATA_DIR / "commune.csv"
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["path_name", "name"])
        for row in _COMMUNE_ENTRIES:
            w.writerow(row)
    print(f"Written {len(_COMMUNE_ENTRIES)} commune entries -> {out}")
    return out


if __name__ == "__main__":
    generate("tempora")
    generate("sancti")
    generate_commune()
