"""
Build propers data from Divinum Officium source texts and GregoBase chants.

Public API
----------
write_propers_json(mass_type, path_name)
    Parse DO source, match chants, write ordo-blocks JSON to
    data/propers/{mass_type}/{path_name}.json.  Called by batch.py for every
    mass and by the generate-propers CI workflow (via refresh.py).

write_ordinary_json()
    Assemble all ordinary chants (Kyrie–Agnus Dei, Credo, Asperges, Marian
    antiphons, Ite/Benedicamus) from GregoBase into data/ordinary.json.
    Also fetches V/R/prayer responses from DO Prayers.txt and Mariaant.txt.

build_propers_multi(mass_type, path_name)
    Lower-level: return the raw propers data dict consumed by build_ordo_blocks
    in ordo.py.  Ordinary chants are deliberately excluded (user-selected at
    runtime from ordinary.json).

Internal pipeline per mass
--------------------------
  DO .txt → _get_parts() [resolve @ refs + ex/vide inheritance]
           → _parse_prelude() [ceremony-specific days: Palm Sunday etc.]
           → _format() [strip directives; split Graduale/Alleluia; emit GradualeP
                        as a list; strip Graduale prefix from standalone Tractus]
           → Chants.best_match() [match each chanted proper against GregoBase]
           → _parse_gradualep_verses() + per-verse best_match() [GradualeP1/P2 GABC]
           → GABC + mode embedded, translations nested per language
           → build_ordo_blocks() [ordo.py] assembles flat item list
           → write_propers_json() serialises to JSON

Usage:
    python propers.py tempora Adv1-0
    python propers.py sancti 12-25
"""

import csv
import json
import re
import subprocess
import sys
from difflib import SequenceMatcher
from pathlib import Path

# Matches trailing " Allelúja, allelúja." or " Alleluia, alleluia." (and variants)
_ALLELUIA_SUFFIX = re.compile(r"\s+[Aa]llel[úu][ji]a,\s+allel[úu][ji]a\.\s*$")

# GradualeP patterns
_DUPLEX_HDR = re.compile(r"^Allel[uú][ji]a[,.]?\s+allel[uú][ji]a", re.IGNORECASE)
_SINGLE_AL_HDR = re.compile(r"^Allel[uú][ji]a[.,]?\s*$", re.IGNORECASE)
_AL_TRAIL = re.compile(
    r"\s*[,.]?\s*Allel[uú][ji]a[,.]?\s*(?:allel[uú][ji]a[,.]?\s*)?$", re.IGNORECASE
)
_V_PREFIX = re.compile(r"^[Vv]\.\s+")

# ex/vide inheritance patterns (used in _get_parts)
_EX_BARE_RE = re.compile(r"^(?:ex|vide)\s+([A-Za-z]\w*)/([^;\s]+)")
_EX_COMM_RE = re.compile(r"^(?:ex|vide)\s+(C[\w-]+)$")
_EX_RANK_RE = re.compile(r";;(?:ex|vide)\s+([A-Za-z]\w*)/([^;\s]+)")

from chants import Chants
from _utils import _norm_lyrics

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_DO_ROOT = _DATA_DIR / "divinum-officium/web/www/missa"
_DO_HORAS = _DATA_DIR / "divinum-officium/web/www/horas"
_OUT_ROOT = Path(__file__).resolve().parent.parent / "output"


def _feast_name(mass_type: str, path_name: str) -> str:
    """Return the feast name from the mass index CSV, or empty string if not found."""
    csv_path = _DATA_DIR / f"{mass_type}.csv"
    if not csv_path.exists():
        return ""
    with open(csv_path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("path_name") == path_name:
                return row.get("name", "")
    return ""


CHANTED_PARTS = [
    "Introitus",
    "Graduale",
    "Alleluia",
    "Tractus",
    "Sequentia",
    "Offertorium",
    "Communio",
]
SPOKEN_PARTS = [
    "Oratio",
    "Lectio",
    "Evangelium",
    "Secreta",
    "Postcommunio",
    "Super populum",
]
ALL_PARTS = CHANTED_PARTS + SPOKEN_PARTS


# ---------------------------------------------------------------------------
# Divinum Officium text parsing
# ---------------------------------------------------------------------------

_DO_TYPE_MAP = {"sancti": "Sancti", "tempora": "Tempora", "commune": "Commune"}


def _read_do_file(lang: str, mass_type: str, path_name: str) -> str | None:
    do_type = _DO_TYPE_MAP.get(mass_type.lower(), mass_type)
    for subdir in ("missa", "horas"):
        p = _DO_ROOT.parent / subdir / lang / do_type / f"{path_name}.txt"
        if p.exists():
            return p.read_text(encoding="utf-8")
    return None


_SECTION_RE = re.compile(r"^([^\]\n]+)\]\s*(\([^)]*\))?\n(.*)", re.DOTALL)


def _parse_sections(content: str) -> dict[str, list[str]]:
    """Split a DO text file into {section_name: [lines]} dict.

    Handles both plain [Name] and qualified [Name](rubrica ...) headers.
    When multiple versions of a section exist, rubrica 196* (1960/1962) wins;
    then unqualified; then any other qualifier.
    """
    out: dict[str, list[str]] = {}
    priority: dict[str, int] = {}  # tracks best version seen so far per key

    for chunk in content.split("[")[1:]:
        m = _SECTION_RE.match(chunk)
        if not m:
            continue
        key = m.group(1).strip()
        qualifier = m.group(2) or ""
        lines = [l for l in m.group(3).split("\n") if l.strip()]

        p = (
            1
            if re.search(r"196|ad missam", qualifier, re.I)
            else (0 if not qualifier else -1)
        )
        if p > priority.get(key, -2):
            out[key] = lines
            priority[key] = p

    return out


def _resolve(lines: list[str], sections: dict, mass_type: str, part: str) -> list[str]:
    """Expand @ references within a section's line list."""
    result = []
    for line in lines:
        if not line.startswith("@"):
            result.append(line)
            continue
        ref = line.lstrip("@").split("/")
        if len(ref) == 1:
            target = ref[0].strip(":")
            result += sections.get(target, [])
        elif len(ref) == 2:
            file_part = ref[1].split(":")
            sub = _get_parts(
                ref[0], file_part[0], [file_part[1] if len(file_part) == 2 else part]
            )
            result += sub.get(file_part[1] if len(file_part) == 2 else part, [])
    return result


def _get_parts(
    mass_type: str,
    path_name: str,
    parts: list[str],
    lang: str = "Latin",
    needs_rule: bool = False,
) -> dict[str, list[str]]:
    content = _read_do_file(lang, mass_type, path_name)
    if not content:
        return {}

    linked_file = content.splitlines()[0] if content.startswith("@") else None
    sections = _parse_sections(content)

    def _find_ex_ref(lines: list[str]) -> tuple[str, str] | None:
        for line in lines:
            stripped = line.strip().rstrip(";")
            m = _EX_BARE_RE.match(stripped)
            if m:
                return (m.group(1), m.group(2))
            m2 = _EX_COMM_RE.match(stripped)
            if m2:
                ref_name = m2.group(1)
                if not (mass_type.lower() == "commune" and ref_name == path_name):
                    return ("Commune", ref_name)
        return None

    ex_ref: tuple[str, str] | None = None
    if "Rule" in sections:
        ex_ref = _find_ex_ref(sections["Rule"])
    # Fallback: check [Rank] lines for embedded ex/vide refs (e.g. ";;ex Sancti/06-29")
    if ex_ref is None and "Rank" in sections:
        for rank_line in sections["Rank"]:
            m = _EX_RANK_RE.search(rank_line)
            if m:
                ex_ref = (m.group(1), m.group(2))
                break

    extra = [
        p for p in ("GradualeP", "Tractus", "Sequentia", "Prelude") if p in sections
    ]
    active_parts = parts + [p for p in extra if p not in parts]

    out: dict[str, list[str]] = {}

    if needs_rule and "Rule" in sections:
        rule_text = " ".join(sections["Rule"])
        # Ceremony-specific days (those with a [Prelude]) have no regular Mass;
        # suppress Gloria and Credo regardless of what the Rule text says.
        if "Prelude" in sections:
            out["rule"] = []
        else:
            out["rule"] = ([] if "no Gloria" in rule_text else ["Gloria"]) + (
                ["Credo"]
                if "Credo" in rule_text and "no Credo" not in rule_text
                else []
            )

    for part in active_parts:
        if part not in sections:
            continue
        out[part] = _resolve(sections[part], sections, mass_type, part)

    missing = set(parts) - out.keys()

    def _merge(target: dict, source: dict) -> None:
        """Fill missing keys from source; never overwrite keys already in target."""
        for k, v in source.items():
            if k not in target:
                target[k] = v

    # Follow "ex Dir/File" or "vide Dir/File" directive for any missing Mass sections
    if missing and ex_ref:
        fallback = _get_parts(
            ex_ref[0],
            ex_ref[1],
            list(missing),
            lang=lang,
            needs_rule=needs_rule and "rule" not in out,
        )
        _merge(out, fallback)
        missing = set(parts) - out.keys()

    # Follow bare @Reference at top of file for any still-missing sections
    if missing and linked_file:
        ref = linked_file.lstrip("@").split("/")
        fallback = _get_parts(
            *ref,
            parts=list(missing),
            lang=lang,
            needs_rule=needs_rule and "rule" not in out,
        )
        _merge(out, fallback)

    return out


# ---------------------------------------------------------------------------
# Prelude parser
# ---------------------------------------------------------------------------


def _parse_prelude(lines: list[str]) -> list[dict]:
    """
    Convert raw DO [Prelude] lines into a list of typed segment dicts.

    Segment types:
      heading  — section title (#... or !!...)
      antiphon — singable antiphon/responsory
      hymn     — strophic hymn text
      prayer   — spoken prayer text
      rubric   — liturgical instruction
      tone     — reference to a standard liturgical tone ($... or &...)

    Two-level mode system:
      persistent_mode — set by !! section heads (e.g. !!Adoratio crucis → antiphon),
                        survives intervening rubric lines until the next !! head.
      mode            — overridden by single-! markers (e.g. !Antiphona → antiphon),
                        reset to "prayer" by rubric lines.
    flush() uses persistent_mode when set, otherwise mode.
    """
    segments: list[dict] = []
    mode = "prayer"
    persistent_mode: str | None = None
    text_buf: list[str] = []

    def flush():
        if text_buf:
            text = " ".join(l for l in text_buf if l)
            if text:
                segments.append({"type": persistent_mode or mode, "text": text})
        text_buf.clear()

    for line in lines:
        s = line.strip()
        if not s or s == "_":
            flush()
            continue

        if s.startswith("#"):
            flush()
            segments.append({"type": "heading", "text": s.lstrip("#").strip()})
            continue

        if s.startswith("$") or s.startswith("&"):
            flush()
            mode = "prayer"
            continue  # prayer-conclusion refs ($Per Dominum etc.) not shown in web

        if s.startswith("@"):
            continue  # cross-references resolved before parsing

        if s.startswith("!!"):
            # Major section head — emits a heading and sets persistent mode
            rubric = s[2:].strip()
            rl = rubric.lower()
            flush()
            segments.append({"type": "heading", "text": rubric})
            if rl.startswith("adoratio") or rl.startswith("improperia"):
                persistent_mode = "antiphon"  # Popule meus + Crux fidelis follow
            else:
                persistent_mode = None
            mode = "prayer"
            continue

        if s.startswith("!"):
            if s.startswith("! "):
                # "! " (space after !) → visible rubric
                flush()
                segments.append({"type": "rubric", "text": s[2:].strip()})
                mode = "prayer"
            else:
                # "!" (no space) → hidden mode marker; handle known ones, ignore rest
                marker = s[1:].strip()
                ml = marker.lower()
                if "antiphona" in ml or "responsorium" in ml:
                    flush()
                    mode = "antiphon"
                elif ml.startswith("tractus"):
                    flush()
                    mode = "tractus"
                elif ml.startswith("graduale"):
                    flush()
                    mode = "graduale"
                elif "hymnus" in ml:
                    flush()
                    mode = "hymn"
                elif ml.startswith("lectio") or ml.startswith("epistola"):
                    flush()
                    mode = "prayer"
                    persistent_mode = None
                # else: silently ignored (citations, section labels, etc.)
            continue

        # Regular text — strip V./v. verse prefix
        text_line = s[3:] if s[:3].lower() == "v. " else s
        text_buf.append(text_line)

    flush()
    return segments


# ---------------------------------------------------------------------------
# Text formatting
# ---------------------------------------------------------------------------


def _clean_line(line: str) -> str | None:
    if not line:
        return None
    if line[0] in "!&-_$":
        return None
    if line[:3].lower() == "v. ":
        return line[3:]
    return line


def _join(lines: list[str]) -> str | None:
    cleaned = [_clean_line(l) for l in lines]
    joined = " ".join(l for l in cleaned if l)
    return joined or None


def _parse_gradualep_verses(lines: list[str]) -> list[str]:
    """Extract verse texts from GradualeP, returning one string per verse.

    Handles all DO format variants: standard two-line, inline header+v1,
    V. prefixed verses, and missing trailing Allelúja. on the first verse.
    Always returns list of stripped verse texts (no citations, no Allelúja suffix).
    """
    text = [_clean_line(l) for l in lines if l and not l.startswith("!")]
    text = [l for l in text if l]
    if not text:
        return []

    verses: list[str] = []
    start = 0
    first = text[0]

    if _DUPLEX_HDR.match(first):
        after = _DUPLEX_HDR.sub("", first).strip().lstrip(".,").strip()
        if after:
            v1 = _AL_TRAIL.sub("", after).strip()
            if v1:
                verses.append(_V_PREFIX.sub("", v1).strip())
        start = 1
    elif _SINGLE_AL_HDR.match(first):
        start = 1

    for l in text[start:]:
        v = _AL_TRAIL.sub("", l).strip()
        v = _V_PREFIX.sub("", v).strip()
        if v:
            verses.append(v)

    return verses


def _plain(s: str) -> str:
    s = re.sub(r"[^a-zA-Z\s]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def _strip_grad_prefix(tract_lines: list[str], grad_lines: list[str]) -> list[str]:
    """Remove leading lines from tract_lines that duplicate the Graduale text."""
    grad_content = [_clean_line(l) for l in grad_lines if l and not l.startswith("!")]
    grad_content = [l for l in grad_content if l]
    tract_content = [_clean_line(l) for l in tract_lines if l and not l.startswith("!")]
    tract_content = [l for l in tract_content if l]
    if not grad_content or not tract_content:
        return tract_lines

    prefix_len = 0
    for g, t in zip(grad_content, tract_content):
        if SequenceMatcher(None, _plain(g), _plain(t)).ratio() >= 0.8:
            prefix_len += 1
        else:
            break

    if prefix_len == 0:
        return tract_lines

    result = []
    removed = 0
    for l in tract_lines:
        stripped = l.strip()
        if not stripped or stripped.startswith("!"):
            if removed < prefix_len:
                continue
            result.append(l)
        else:
            if removed < prefix_len:
                removed += 1
            else:
                result.append(l)

    return result


def _format(raw: dict[str, list[str]]) -> dict[str, str | list[str]]:
    out: dict[str, str | list[str] | None] = {}
    for key, value in raw.items():
        if key == "rule":
            out[key] = value
        elif key == "Prelude":
            out[key] = value  # kept as raw line list for _parse_prelude
        elif key.startswith("Introitus"):
            out[key] = _join(value[:-1])
        elif key.startswith("Lectio"):
            out[key] = _join(value[1:])
        elif key.startswith("Evangelium"):
            out[key] = _join(value[1:])
        elif key in ("GradualeP", "GradualePTranslation"):
            out[key] = (
                value  # kept as raw lines; verses extracted in build_propers_multi
            )
        elif key.startswith("Tractus") and "Translation" not in key:
            grad_raw = raw.get("Graduale", [])
            out[key] = _join(_strip_grad_prefix(value, grad_raw) if grad_raw else value)
        elif key.startswith("Graduale"):
            tractus_i = next(
                (i for i, l in enumerate(value) if l.startswith("!Tractus")), None
            )
            if tractus_i is not None:
                out[key] = _join(value[: tractus_i - 1])
                out["Tractus" + key[len("Graduale") :]] = _join(value[tractus_i + 1 :])
            elif value and value[-1].endswith(("Allelúja.", "Alleluia.")):
                al_key = "Alleluia" + key[len("Graduale") :]
                out[al_key] = _join(["Allelúja, allelúja.", value[-1]])
                verse = _ALLELUIA_SUFFIX.sub("", value[-3])
                out[key] = _join(value[:-3] + [verse])
            elif (
                value
                and value[-1].startswith("V. ")
                and value[0].lower().startswith("allel")
            ):
                # Eastertide double alleluia where the 2nd alleluia verse doesn't
                # end with "Allelúja." (e.g. Pentecost "Veni Sancte Spiritus").
                al_key = "Alleluia" + key[len("Graduale") :]
                out[al_key] = _join(["Allelúja, allelúja.", value[-1]])
                out[key] = _join(value[:-1])
            else:
                out[key] = _join(value)
        else:
            out[key] = _join(value)
    return {k: v for k, v in out.items() if v is not None}


# ---------------------------------------------------------------------------
# Ordinary chant ID lookup tables (GregoBase IDs, office-part = "ky" / "an")
# ---------------------------------------------------------------------------

_KYRIE_IDS: dict[int, int | list[int]] = {
    1: 1143,
    2: 309,
    3: 825,
    4: 1061,
    5: 474,
    6: 2903,
    7: 1262,
    8: 1184,
    9: 2976,
    10: 795,
    11: 2982,
    12: 2068,
    13: 137,
    14: 441,
    15: 393,
    16: 545,
    17: [272, 168],
    18: 2522,
}
_GLORIA_IDS: dict[int, int | list[int]] = {
    1: 2980,
    2: 862,
    3: 71,
    4: 2978,
    5: 337,
    6: 321,
    7: 721,
    8: 961,
    9: 2771,
    10: 1204,
    11: 303,
    12: 2114,
    13: 2107,
    14: 908,
    15: 2975,
    # 16 & 17 have no numbered Gloria in GR; 18 (Requiem) has none
}
_SANCTUS_IDS: dict[int, int | list[int]] = {
    1: 300,
    2: 1279,
    3: 566,
    4: 2518,
    5: 2984,
    6: 431,
    7: 1089,
    8: 1384,
    9: 587,
    10: 2770,
    11: 1106,
    12: 1062,
    13: 1067,
    14: 2979,
    15: 386,
    16: 2990,
    17: 871,
    18: 298,
}
_AGNUS_IDS: dict[int, int | list[int]] = {
    1: 2977,
    2: 555,
    3: 578,
    4: 264,
    5: 1241,
    6: 387,
    7: 2985,
    8: 2760,
    9: 707,
    10: 2981,
    11: 1243,
    12: 759,
    13: 2886,
    14: 2076,
    15: 959,
    16: 1336,
    17: 1137,
    18: 2412,
}
_CREDO_IDS: dict[int, int | list[int]] = {
    1: 344,
    2: 2983,
    3: 749,
    4: 678,
    5: 955,
    6: 2934,
}
_ITE_IDS: dict[int, int | list[int]] = {
    1: [2988, 2987],
    2: [1280, 804],
    3: [1280, 804],  # IIa, IIb (III as II)
    4: 353,
    5: 1006,
    6: 1160,
    7: 31,
    8: 832,
    9: 2989,
    10: 2989,
    11: 856,
    12: 37,
    13: 878,
    14: 2986,
    15: 620,
    16: 620,
    17: 620,
    18: 620,  # XV–XVIII share the same melody
}
_BENEDICAMUS_IDS: dict[int, int | list[int]] = {
    # Sung in place of Ite when Gloria is omitted (Advent, Lent, ferias, Offices of the Dead)
    2: 16096,
    3: 16096,  # III as II
    4: 2856,
    8: 2901,
    9: 2902,
    10: 2902,  # X as IX
    11: 2920,
    13: 2952,
    17: [543, 3015],  # XVII and XVIIa
}
_MARIAN_IDS: dict[str, list[int]] = {
    "salve-regina": [2435, 2715, 3299],  # simple, solemn, monastic
    "alma-redemptoris-mater": [1851, 2238, 8146],  # simple, solemn, monastic
    "ave-regina-caelorum": [2153, 2602, 3300],  # simple, solemn, monastic
    "regina-caeli": [2290, 1976, 3301],  # simple, solemn, monastic
}


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

_ALLELUIA_START = re.compile(r"^Allel[úu][ji]a", re.IGNORECASE)
_DUPLEX_START = re.compile(r"^Allel[úu][ji]a,\s+allel[úu][ji]a\.\s*", re.IGNORECASE)


def _resolve_match_part(part: str, text: str) -> tuple[str, str]:
    """Return (gregobase_part, match_text) for a chanted proper.

    Eastertide replaces the Gradual with a duplex alleluia ("Allelúja,
    allelúja. [verse]"); DO stores it under Graduale but GregoBase files
    it as office-part=al with _ij._ in the GABC.  Prepending "Alleluia ij
    V/." to the query normalises to "alleluiaijv…" which scores higher
    against the duplex form than against single-alleluia entries.

    For the regular Alleluia slot the opening "Allelúja, allelúja." is
    stripped so the verse text alone drives the match.
    """
    if part == "Graduale" and _DUPLEX_START.match(text):
        verse = _DUPLEX_START.sub("", text).strip()
        return "Alleluia", f"Alleluia ij V/. {verse}"
    if part == "Alleluia":
        return "Alleluia", " ".join(text.split()[2:])
    return part, text


# ---------------------------------------------------------------------------
# DO file parsers for ordinary responses (Asperges, Marian antiphon V/R + prayer)
# ---------------------------------------------------------------------------


def _do_clean(s: str) -> str:
    """Strip DO formatting tags like {::} and {:S-AlmaRedemptoris:}."""
    return re.sub(r"\{[^}]*\}", "", s).strip()


def _parse_do_sections(text: str) -> dict[str, str]:
    """Split a DO text file into named [Section] blocks."""
    sections: dict[str, str] = {}
    current: str | None = None
    buf: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^\[([^\]]+)\]", line)
        if m:
            if current is not None:
                sections[current] = "\n".join(buf)
            current = m.group(1)
            buf = []
        elif current is not None:
            buf.append(line)
    if current is not None:
        sections[current] = "\n".join(buf)
    return sections


def _extract_vr_prayer_mariaant(block: str) -> dict[str, str] | None:
    """
    Extract first V., R., and prayer from a Mariaant.txt section block.
    Format: antiphon / _ / V. / R. / _ / $Oremus / v. prayer
    """
    V = R = prayer = ""
    after_oremus = False
    for line in block.splitlines():
        s = line.strip()
        c = _do_clean(s)
        if not c or c.startswith("!") or c.startswith("#"):
            continue
        if s.startswith("$Oremus"):
            after_oremus = True
            continue
        if after_oremus:
            if c.startswith("&"):
                continue
            m = re.match(r"^[vV]\.\s+(.*)", c)
            prayer = m.group(1).rstrip() if m else c
            after_oremus = False
            continue
        if not V and re.match(r"^V\.\s", c):
            V = c
        elif not R and V and re.match(r"^R\.\s", c):
            R = c
    return {"V": V, "R": R, "prayer": prayer} if V and R else None


def _extract_vr_prayer_prayers_txt(block: str) -> dict[str, str] | None:
    """
    Extract first V., R., and prayer from a Prayers.txt section block.

    Structure: [antiphon/Ps block] _ [V./R. pairs] _ [v. oremus / prayer]
    Some files omit the second _ (Italian); some use uppercase V. for the oremus call (French).
    """
    lines = [l.rstrip() for l in block.splitlines()]

    # Skip the antiphon/Ps block — start after the first _ separator
    start_from = 0
    for i, l in enumerate(lines):
        if l.strip() == "_":
            start_from = i + 1
            break

    V = R = prayer = ""
    state = "vr"
    prayer_parts: list[str] = []
    idx = start_from

    while idx < len(lines):
        s = lines[idx].strip()
        c = _do_clean(s)
        idx += 1

        if not c or s.startswith("!") or s.startswith("&") or s.startswith("#"):
            continue

        if state == "vr":
            if c == "_":
                if V and R:
                    state = "prayer"
                continue
            if re.match(r"^V\.\s", c) and not V:
                V = c
            elif re.match(r"^R\.\s", c) and not R and V:
                R = c
            elif re.match(r"^[VR]\.\s", c):
                pass  # additional liturgical V/R pairs — ignore
            elif V and R and re.match(r"^v\.\s", s):
                # Lowercase v. = oremus call (no _ separator, Italian-style)
                state = "prayer"
            elif V and R:
                # Non-V/R content after first pair → prayer section
                state = "prayer"
                if not re.match(r"^[vV]\.\s", s) and len(c) > 25:
                    prayer_parts.append(c)

        elif state == "prayer":
            if c == "_":
                continue
            if re.match(
                r"^R\.\s", c
            ):  # terminal response (R. Amen / R. Ainsi soit-il.)
                break
            if re.match(r"^[vV]\.\s", s) and not prayer_parts:
                continue  # skip leading oremus call line
            prayer_parts.append(c)

    return (
        {"V": V, "R": R, "prayer": " ".join(prayer_parts).strip()} if V and R else None
    )


def _fetch_asperges_data(langs: list[str]) -> dict[str, dict[str, dict[str, str]]]:
    """
    Fetch Asperges/Vidi Aquam V/R/prayer from DO Prayers.txt for all languages.
    Returns {"asperges": {lang: {V,R,prayer}}, "vidi-aquam": {lang: {V,R,prayer}}}.
    Languages whose Prayers.txt is untranslated (V text identical to English) are skipped.
    """
    result: dict[str, dict[str, dict[str, str]]] = {"asperges": {}, "vidi-aquam": {}}
    for lang in ["Latin"] + langs:
        path = _DO_ROOT / lang / "Ordo/Prayers.txt"
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            continue
        sections = _parse_do_sections(text)
        for key, sec_name in (
            ("asperges", "Asperges me"),
            ("vidi-aquam", "Vidi aquam"),
        ):
            if (block := sections.get(sec_name)) and (
                parsed := _extract_vr_prayer_prayers_txt(block)
            ):
                # Skip languages whose translation matches English (file not actually translated)
                eng = result[key].get("English", {})
                if (
                    lang not in ("Latin", "English")
                    and eng
                    and parsed["V"] == eng.get("V")
                ):
                    continue
                result[key][lang] = parsed
    return result


def _fetch_marian_data(langs: list[str]) -> dict[str, dict[str, dict[str, str]]]:
    """
    Fetch Marian antiphon V/R/prayer from DO Mariaant.txt for all languages.
    Returns {do_section_name: {lang: {V,R,prayer}}}.
    Section names: 'Advent', 'Nativiti', 'Quadragesimae', 'Paschalis', 'Postpentecost'.
    """
    result: dict[str, dict[str, dict[str, str]]] = {}
    for lang in ["Latin"] + langs:
        path = _DO_HORAS / lang / "Psalterium/Mariaant.txt"
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            continue
        for sec_name, block in _parse_do_sections(text).items():
            if parsed := _extract_vr_prayer_mariaant(block):
                result.setdefault(sec_name, {})[lang] = parsed
    return result


def _all_languages() -> list[str]:
    """Languages available under divinum-officium/web/www/missa/ (Latin excluded)."""
    if not _DO_ROOT.exists():
        return ["English"]
    langs = sorted(
        d.name
        for d in _DO_ROOT.iterdir()
        if d.is_dir() and d.name != "Latin" and not d.name.startswith(".")
    )
    return ["English"] + [l for l in langs if l != "English"]


def _store_match(
    chants: Chants, gregobase_part: str, text: str, prefix: str, chant_data: dict
) -> None:
    chant_id = chants.best_match("Solesmes", gregobase_part, text)
    if chant_id is not None:
        chant_data[prefix + "ChantId"] = chant_id
        if gabc := chants.get_gabc(chant_id):
            chant_data[prefix + "Gabc"] = gabc
        chant_data[prefix + "Mode"] = (chants.get_meta(chant_id) or {}).get("mode", "")


def build_propers_multi(
    mass_type: str, path_name: str, languages: list[str] | None = None
) -> dict:
    """
    Build propers with every available translation embedded.

    Instead of a flat {key}Translation: text, translations are nested:
      {key}Translations: {"English": "...", "Deutsch": "...", ...}

    Ordinary chants (Kyrie/Gloria/Sanctus/AgnusDei/Credo) are NOT included —
    they are user-selected at view time and loaded from ordinary.json.

    Intended for the pre-generated static JSON consumed by the public site.
    """
    if languages is None:
        languages = _all_languages()

    latin_raw = _get_parts(mass_type, path_name, ALL_PARTS, needs_rule=True)
    latin = _format(latin_raw)
    if not latin:
        raise ValueError(f"No Latin text found for {mass_type}/{path_name}")

    chants = Chants()

    # --- Chanted propers GABC matching ---
    chant_data: dict[str, object] = {}
    for part in CHANTED_PARTS:
        text = latin.get(part)
        if not text or not isinstance(text, str):
            continue
        match_part, match_text = _resolve_match_part(part, text)
        _store_match(chants, match_part, match_text, part, chant_data)

    # --- GradualeP verse matching ---
    # GradualeP stays as raw lines in latin; extract individual verse texts here.
    # Verses are matched in DO source order (preserving the original ordering).
    # A verse that matches the Graduale alleluia reuses AlleluiaGabc so both
    # seasonal blocks reference the same chant object.
    gradp_raw = latin.get("GradualeP")
    if isinstance(gradp_raw, list):
        verses = _parse_gradualep_verses(gradp_raw)
        grad_al_norm = _norm_lyrics(latin.get("Alleluia", ""), "al")
        for i, vtext in enumerate(verses[:2], 1):
            v_norm = _norm_lyrics(vtext)
            if SequenceMatcher(None, v_norm, grad_al_norm).ratio() >= 0.7:
                if "AlleluiaGabc" in chant_data:
                    chant_data[f"GradualeP{i}Gabc"] = chant_data["AlleluiaGabc"]
                if "AlleluiaMode" in chant_data:
                    chant_data[f"GradualeP{i}Mode"] = chant_data["AlleluiaMode"]
            else:
                _store_match(chants, "Alleluia", vtext, f"GradualeP{i}", chant_data)

    # --- Prelude ---
    prelude_raw = latin.pop("Prelude", None)
    prelude: list[dict] | None = None
    if prelude_raw and isinstance(prelude_raw, list):
        segments = _parse_prelude(prelude_raw)
        for seg in segments:
            if seg["type"] in ("antiphon", "hymn"):
                chant_id = chants.best_match_prelude("Solesmes", seg["text"])
            elif seg["type"] == "tractus":
                chant_id = chants.best_match_tractus(seg["text"])
            else:
                chant_id = None
            if chant_id is not None:
                seg["chant_id"] = chant_id
                gabc = chants.get_gabc(chant_id)
                if gabc:
                    seg["gabc"] = gabc
        prelude = segments

    # --- Collect translations for every language ---
    # trans_map[base_key][lang] = text  (e.g. trans_map["Introitus"]["English"] = "...")
    trans_map: dict[str, dict[str, str]] = {}

    for lang in languages:
        try:
            raw = _get_parts(mass_type, path_name, ALL_PARTS, lang=lang)
            if not raw:
                continue
            formatted = _format({k + "Translation": v for k, v in raw.items()})
            for tkey, text in formatted.items():
                if tkey in (
                    "PreludeTranslation",
                    "GradualePTranslation",
                ) or not tkey.endswith("Translation"):
                    continue
                if text and isinstance(text, str):
                    base = tkey[: -len("Translation")]
                    trans_map.setdefault(base, {})[lang] = text
        except Exception:
            pass

    # --- Prelude per-language translations ---
    if prelude:
        for lang in languages:
            try:
                raw = _get_parts(mass_type, path_name, ["Prelude"], lang=lang)
                if not raw or "Prelude" not in raw:
                    continue
                formatted = _format({"PreludeTranslation": raw["Prelude"]})
                pre_trans = formatted.get("PreludeTranslation")
                if not pre_trans or not isinstance(pre_trans, list):
                    continue
                trans_segs = _parse_prelude(pre_trans)
                trans_iter = (
                    s for s in trans_segs if s["type"] in ("antiphon", "hymn", "prayer")
                )
                for seg in prelude:
                    if seg["type"] in ("antiphon", "hymn", "prayer"):
                        try:
                            t = next(trans_iter)
                            text = t.get("text", "")
                            if text:
                                seg.setdefault("translations", {})[lang] = text
                        except StopIteration:
                            break
            except Exception:
                pass

    # --- Assemble result ---
    # Ordinary chants (Kyrie/Gloria/Sanctus/AgnusDei/Credo) are NOT included here.
    # They are user-selected at view time and loaded from ordinary.json separately.
    result: dict = {
        k: v for k, v in latin.items() if k not in ("GradualeP", "GradualePTranslation")
    }
    result.update(chant_data)
    if prelude:
        result["Prelude"] = prelude
    for base_key, langs in trans_map.items():
        result[base_key + "Translations"] = langs

    return result


def _pipeline_version() -> str:
    try:
        return subprocess.check_output(
            ["git", "describe", "--tags", "--always"],
            cwd=Path(__file__).parent,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return ""


def write_propers_json(
    mass_type: str,
    path_name: str,
    languages: list[str] | None = None,
    out_dir: Path | None = None,
) -> Path:
    """Write a multi-language ordo-blocks JSON file for the static public site."""
    from ordo import build_ordo_blocks

    data = build_ordo_blocks(mass_type, path_name, languages=languages)
    data["pipeline_version"] = _pipeline_version()
    _lu_path = _DATA_DIR / "last_updated.json"
    if _lu_path.exists():
        try:
            data["data_updated"] = json.loads(_lu_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    root = out_dir or (_DATA_DIR / "propers")
    out = root / mass_type.lower() / f"{path_name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return out


def write_ordinary_json(out_dir: Path | None = None) -> Path:
    """
    Assemble all ordinary chants and responses into data/ordinary.json.

    Top-level keys
    --------------
    kyrie / gloria / sanctus / agnus-dei / credo
        {"1": [variant, ...], "2": [...], ...}  keyed by mass number (string).
        Each variant: {chant_id, label, gabc, mode}.
        Single-form masses have one variant (label=""); masses with sub-forms
        (e.g. Ite IIa/IIb) have multiple variants labelled "a", "b", etc.

    dismissal
        Merges Ite missa est (gloria=true) and Benedicamus Domino (gloria=false)
        into one list per mass number.  Each variant has a "gloria" bool and
        label "Ite" or "Benedicamus" so the SPA can filter by rule at runtime.

    marian
        {"salve-regina": [simple, solemn, monastic], ...}
        Three variants per antiphon, labelled "Simple", "Solemn", "Monastic".

    marian-resp
        {antiphon-name: [ordo items]}  — V, R, prayer for each antiphon,
        fetched from DO Mariaant.txt with season rubrics where applicable.

    asperges
        {"asperges": [variant], "vidi-aquam": [variant]}

    asperges-resp
        {"asperges": [ordo items], "vidi-aquam": [ordo items]}
        V, R, prayer from DO Prayers.txt.
    """
    chants = Chants()

    def _entry(cid: int) -> dict | None:
        gabc = chants.get_gabc(cid)
        if not gabc:
            return None
        meta = chants.get_meta(cid) or {}
        return {
            "chant_id": cid,
            "label": "",
            "gabc": gabc,
            "mode": meta.get("mode", ""),
        }

    def _collect(ids: int | list[int]) -> list[dict]:
        cids = ids if isinstance(ids, list) else [ids]
        return [e for cid in cids if (e := _entry(cid))]

    def _section(id_table: dict) -> dict:
        out: dict = {}
        for key, ids in id_table.items():
            variants = _collect(ids)
            if variants:
                if len(variants) > 1:
                    for i, v in enumerate(variants):
                        v["label"] = chr(ord("a") + i)
                out[str(key)] = variants
        return out

    _ASPERGES_IDS = {
        "asperges": 497,  # Asperges me (Solesmes mode 7)
        "vidi-aquam": 958,  # Vidi aquam (Solesmes mode 8, used in Eastertide)
    }

    # --- Fetch responses from DO data files ---
    _langs = _all_languages()
    _asp_data = _fetch_asperges_data(_langs)
    _mar_data = _fetch_marian_data(_langs)

    def _build_tx(
        lang_data: dict[str, dict], field: str, season: str | None = None
    ) -> dict:
        latin = lang_data.get("Latin", {}).get(field, "")
        translations = {
            lg: d[field]
            for lg, d in lang_data.items()
            if lg != "Latin" and d.get(field)
        }
        item: dict = {
            "type": "text",
            "latin": latin,
            "availableTranslations": translations or None,
        }
        if season:
            item["season"] = season
        return item

    def _build_responses(
        lang_data: dict[str, dict], season: str | None = None
    ) -> list[dict]:
        items: list[dict] = []
        for field in ("V", "R"):
            item = _build_tx(lang_data, field, season)
            if item["latin"]:
                items.append(item)
        oremus: dict = {"type": "rubric", "text": "Orémus."}
        if season:
            oremus["season"] = season
        items.append(oremus)
        prayer = _build_tx(lang_data, "prayer", season)
        if prayer["latin"]:
            items.append(prayer)
        return items

    _ASPERGES_RESPONSES = _build_responses(_asp_data.get("asperges", {}))
    _VIDI_AQUAM_RESPONSES = _build_responses(_asp_data.get("vidi-aquam", {}))

    _MARIAN_SECTION_MAP: dict[str, list[tuple[str, str | None]]] = {
        "alma-redemptoris-mater": [("Advent", "advent"), ("Nativiti", "christmas")],
        "ave-regina-caelorum": [("Quadragesimae", None)],
        "regina-caeli": [("Paschalis", None)],
        "salve-regina": [("Postpentecost", None)],
    }
    _SEASON_RUBRICS = {
        "advent": "A Dominica I Adventus usque ad Vigiliam Nativitatis.",
        "christmas": "A primis Vesperis Nativitatis usque ad Purificationem B.M.V.",
    }
    _MARIAN_RESPONSES: dict[str, list[dict]] = {}
    for _ant, _secs in _MARIAN_SECTION_MAP.items():
        _items: list[dict] = []
        for _sec, _season in _secs:
            _ld = _mar_data.get(_sec, {})
            if not _ld:
                continue
            if _season:
                _items.append(
                    {
                        "type": "rubric",
                        "text": _SEASON_RUBRICS[_season],
                        "season": _season,
                    }
                )
            _items.extend(_build_responses(_ld, _season))
        if _items:
            _MARIAN_RESPONSES[_ant] = _items

    # Dismissal: Ite missa est (gloria=true) and Benedicamus Domino (gloria=false)
    # merged into one list per mass number so the SPA filters by Rule at runtime.
    dismissal: dict = {}
    for num in sorted(set(_ITE_IDS) | set(_BENEDICAMUS_IDS)):
        variants = []
        if ite_ids := _ITE_IDS.get(num):
            variants.extend(
                {**e, "gloria": True, "label": "Ite"} for e in _collect(ite_ids)
            )
        if bene_ids := _BENEDICAMUS_IDS.get(num):
            variants.extend(
                {**e, "gloria": False, "label": "Benedicamus"}
                for e in _collect(bene_ids)
            )
        if variants:
            dismissal[str(num)] = variants

    _MARIAN_VARIANT_LABELS = ["Simple", "Solemn", "Monastic"]
    marian = {}
    marian_resp = {}
    for name, ids in _MARIAN_IDS.items():
        if variants := _collect(ids):
            for i, v in enumerate(variants):
                v["label"] = (
                    _MARIAN_VARIANT_LABELS[i]
                    if i < len(_MARIAN_VARIANT_LABELS)
                    else str(i + 1)
                )
            marian[name] = variants
            if resp := _MARIAN_RESPONSES.get(name):
                marian_resp[name] = resp

    asperges_resp = {
        "asperges": _ASPERGES_RESPONSES,
        "vidi-aquam": _VIDI_AQUAM_RESPONSES,
    }
    asperges = {}
    for name, ids in _ASPERGES_IDS.items():
        if variants := _collect([ids] if isinstance(ids, int) else ids):
            asperges[name] = variants

    data = {
        "kyrie": _section(_KYRIE_IDS),
        "gloria": _section(_GLORIA_IDS),
        "sanctus": _section(_SANCTUS_IDS),
        "agnus-dei": _section(_AGNUS_IDS),
        "credo": _section(_CREDO_IDS),
        "dismissal": dismissal,
        "antiphona-mariana": marian,
        "antiphona-mariana-resp": marian_resp,
        "asperges": asperges,
        "asperges-resp": asperges_resp,
    }

    root = out_dir or _DATA_DIR
    out = root / "ordinary.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: propers.py <mass_type> <path_name>")
        sys.exit(1)
    mass_type, path_name = sys.argv[1], sys.argv[2]
    out = write_propers_json(mass_type, path_name)
    print(f"Written: {out}")
