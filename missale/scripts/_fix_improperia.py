"""
Fix Quad6-5.json (Good Friday) after each regeneration.

The pipeline auto-generates content that is incorrect for Good Friday:
wrong chant IDs for Crux fidelis / Vexilla Regis, missing Trisagion
choir structure, missing Crucem tuam, missing de communione antiphons.

This script patches the final ordo-format JSON directly.  It is idempotent
and called automatically by batch.py after generating tempora/Quad6-5.
"""

import json
import re
import unicodedata
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chants import Chants

_ch = Chants()

JSON_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "missale/data/propers/tempora/Quad6-5.json"
)

_TARGETS_ALL = ["missalette", "pewsheet"]
_TARGETS_MISSALETTE = ["missalette"]


# ---------------------------------------------------------------------------
# GregoBase helpers (delegate to Chants class)
# ---------------------------------------------------------------------------


def all_gabcs(cid: int) -> list[str]:
    """Return all pre-cleaned GABC blocks for the given GregoBase chant ID."""
    return _ch.get_all_gabcs(cid)


def first_gabc(cid: int) -> str:
    """Return the first pre-cleaned GABC block for the given GregoBase chant ID."""
    blocks = all_gabcs(cid)
    return blocks[0] if blocks else ""


def _tex_verse_block(tex: str) -> str:
    """Clean a GregoBase tex_verses string into a single newline-separated block.

    Verses are stored as one unit with plain newlines between them.
    _renderTex() in the SPA converts \\n → <br> for display;
    _htmlToTex() on export converts <br> → \\\\ for LaTeX output.
    """
    tex = re.sub(r"\\hyphenation\{[^}]*\}", "", tex)
    tex = tex.replace("$\\dag$", "†")
    tex = re.sub(
        r'\\"\{([a-zA-Z])\}',
        lambda m: unicodedata.normalize("NFC", m.group(1) + "̈"),
        tex,
    )
    tex = tex.replace("~", " ")
    tex = re.sub(r"\\\\\r?\n", "\n", tex)  # LaTeX \\ line-break → plain newline
    return tex.strip()


def _clean_hymn_verse(gabc: str) -> str:
    gabc = re.sub(r"^(\([a-g][0-9bf]\))\s+[^(]*?\d+\.\s*", r"\1 ", gabc)
    return gabc.strip()


def _prep_pange_block(gabc: str, verse_num: int, keep_clef: bool = False) -> str:
    """Normalise a Pange lingua GregoBase block to 'N. text(notes)...(::)' form."""
    gabc = re.sub(r"^\(Z[-+]?\)\s*", "", gabc)
    clef_m = re.match(r"^(\([a-g][0-9bf]\))\s+", gabc)
    clef = clef_m.group(1) if clef_m else "(c4)"
    if clef_m:
        gabc = gabc[clef_m.end() :]
    gabc = re.sub(r"^V/\.\s*", "", gabc)
    gabc = re.sub(r"^\d+\.\s*", "", gabc)
    last_bar = gabc.rfind("(::)")
    if last_bar >= 0:
        gabc = gabc[: last_bar + 4]
    gabc = re.sub(r"\bV/\.\s+(\d+\.)", r"\1", gabc)
    gabc = re.sub(
        r"\b([A-Z])([A-Z]+)(?=[a-z])", lambda m: m.group(1) + m.group(2).lower(), gabc
    )
    gabc = f"{verse_num}. {gabc}".strip()
    if keep_clef:
        gabc = f"{clef} {gabc}"
    return gabc


# ---------------------------------------------------------------------------
# Ordo item helpers (final JSON format)
# ---------------------------------------------------------------------------


def _music(gabc: str, latin: str = "") -> dict:
    """Build a music ordo item for all targets, optionally with a Latin display label."""
    item: dict = {"type": "music", "gabc": gabc, "targets": _TARGETS_ALL}
    if latin:
        item["latin"] = latin
    return item


def _rubric(text: str) -> dict:
    """Build a rubric ordo item scoped to the missalette only."""
    return {"type": "rubric", "text": text, "targets": _TARGETS_MISSALETTE}


def _section_range(ordo: list, fragment: str) -> tuple[int, int, int]:
    """Return (title_idx, body_start, body_end) for the section matching fragment."""
    for i, item in enumerate(ordo):
        if item.get("type") == "title" and fragment in item.get("text", "").lower():
            body_start = i + 1
            body_end = len(ordo)
            for j in range(body_start, len(ordo)):
                if ordo[j].get("type") == "title":
                    body_end = j
                    break
            return i, body_start, body_end
    raise ValueError(f"Section not found: {fragment!r}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    """Patch Quad6-5.json with correct Good Friday Adoratio crucis and Communio content."""
    # --- load GABC from GregoBase ----------------------------------------
    g2847 = all_gabcs(2847)[0]  # Pópule meus
    g4311 = all_gabcs(4311)  # Hagios (6 blocks)
    g7808 = first_gabc(7808)  # Quia edúxi te
    g7809 = first_gabc(7809)  # Quid ultra débui
    g8749 = [_clean_hymn_verse(g) for g in all_gabcs(8749)]  # Ego propter (9)
    g428 = first_gabc(428)  # Crucem tuam
    g1128 = first_gabc(1128)  # Crux fidélis
    _pange_blocks = all_gabcs(2209)
    g2209 = _prep_pange_block(_pange_blocks[0], 1, keep_clef=True)
    for _blk, _vnum in zip(_pange_blocks[1:], [2, 10]):
        g2209 += " (Z-) " + _prep_pange_block(_blk, _vnum)
    g12742 = first_gabc(12742)  # Vexilla Regis
    g1238 = first_gabc(1238)  # De comm. ant. 1
    g940 = first_gabc(940)  # De comm. ant. 2
    g1335 = first_gabc(1335)  # De comm. ant. 3
    g447_blocks = all_gabcs(447)
    g447 = g447_blocks[0] if g447_blocks else ""  # Ps 21 tone
    g447_verses_tex = _tex_verse_block(_ch.get_tex_verses(447))  # verses 2–34

    assert len(g4311) == 6, f"Expected 6 GABC blocks for cid=4311, got {len(g4311)}"
    assert len(g8749) == 9, f"Expected 9 GABC blocks for cid=8749, got {len(g8749)}"

    with open(JSON_PATH, encoding="utf-8") as f:
        data = json.load(f)

    ordo: list[dict] = data["ordo"]

    # -----------------------------------------------------------------------
    # Communio section: de communione antiphons + Psalm 21
    # (patch communio first — it's later in the ordo, so its indices remain
    #  valid after we later resize the adoratio section)
    # -----------------------------------------------------------------------
    _, comm_start, comm_end = _section_range(ordo, "communio")
    citems: list[dict] = list(ordo[comm_start:comm_end])

    _skip_texts = {"Dum defertur Sanctissimum", "Dum sacra communio"}
    _skip_gabcs = {g for g in [g1238, g940, g1335, g447] if g}

    # Strip any content from a previous run (idempotency)
    citems = [
        item
        for item in citems
        if not any(t in (item.get("text") or "") for t in _skip_texts)
        and (item.get("gabc") or "") not in _skip_gabcs
        and "clamábo per diem" not in (item.get("tex") or "")
    ]

    de_communione: list[dict] = [
        _rubric(
            "De communione. Dum defertur Sanctissimum ad Altare, "
            "Schola cantat sequentes antiphonas:"
        ),
        _music(g1238),
        _music(g940),
        _music(g1335),
    ]

    idx_non_dicitur = next(
        (
            i
            for i, item in enumerate(citems)
            if "Non dicitur" in (item.get("text") or "")
        ),
        len(citems) - 1,
    )

    psalm_communio: list[dict] = [
        _rubric("Dum sacra communio distribuitur, cani potest Psalmus 21:"),
        _music(g447),
        {"type": "text", "tex": g447_verses_tex, "targets": _TARGETS_MISSALETTE},
    ]

    new_citems = (
        de_communione
        + citems[: idx_non_dicitur + 1]
        + psalm_communio
        + citems[idx_non_dicitur + 1 :]
    )
    ordo[comm_start:comm_end] = new_citems

    # -----------------------------------------------------------------------
    # Adoratio crucis section
    # -----------------------------------------------------------------------
    _, ador_start, ador_end = _section_range(ordo, "adoratio")
    items: list[dict] = list(ordo[ador_start:ador_end])

    def _find_rubric(fragment: str) -> int:
        for i, item in enumerate(items):
            if item.get("type") == "rubric" and fragment in (item.get("text") or ""):
                return i
        raise ValueError(f"Rubric not found in Adoratio items: {fragment!r}")

    idx_postea = _find_rubric("Postea Sacerdos")
    idx_circa = _find_rubric("Circa finem")

    # Fix Ecce lignum (cid=2087): patch response rubric.
    for item in items[:idx_postea]:
        if item.get("type") == "music" and "Ecce lignum" in (item.get("latin") or ""):
            gabc = first_gabc(2087)
            item["gabc"] = gabc.replace("_All :_ R/. V{e}", "_Omnes :_() R/. Ve")

    # Minor Improperia choir labels (9 verses of Ego propter te, cid=8749)
    _verse_labels = [
        "Duo de secundo choro cantant:",
        "Duo de primo choro:",
        "Duo de secundo choro:",
        "Duo de primo choro:",
        "Duo de secundo choro:",
        "Duo de primo choro:",
        "Duo de secundo choro:",
        "Duo de primo choro:",
        "Duo de secundo choro:",
    ]

    # Curated Adoratio body between "Postea Sacerdos" and "Circa finem"
    curated: list[dict] = [
        # Major Improperia I
        _rubric("Duo cantores in medio chori cantant:"),
        _music(g2847, latin="Pópule meus, quid feci tibi?"),
        # Trisagion: 3 pairs of Greek / Latin choir verses
        _rubric("Unus chorus cantat:"),
        _music(g4311[0], latin="Ágios o Theós."),
        _rubric("Alius chorus respondet:"),
        _music(g4311[1], latin="Sanctus Deus."),
        _rubric("Primus chorus:"),
        _music(g4311[2], latin="Ágios ischyrós."),
        _rubric("Secundus chorus:"),
        _music(g4311[3], latin="Sanctus fortis."),
        _rubric("Primus chorus:"),
        _music(g4311[4], latin="Ágios athánatos, eléison imás."),
        _rubric("Secundus chorus:"),
        _music(g4311[5], latin="Sanctus immortális, miserére nobis."),
        # Major Improperia II
        _music(g7808, latin="Quia edúxi te per desértum quadragínta annis,"),
        _rubric(
            "Chori respondent alternatim: Hagios o Theós, etc. "
            "Sanctus Deus, etc., ita tamen ut primus chorus semper repetat "
            "Hagios, ut supra."
        ),
        # Major Improperia III
        _music(g7809, latin="Quid ultra débui fácere tibi, et non feci?"),
        _rubric("Item chori alternatim respondent Hagios o Theós, Sanctus Deus."),
        # Minor Improperia intro
        _rubric(
            "Versus sequentis Improperii a duobus cantoribus alternatim cantantur, "
            "altero choro simul repetente post quemlibet versum: Pópule meus, ut infra."
        ),
    ]

    # 9 verses of Ego propter te with alternating choir labels
    for lbl, g in zip(_verse_labels, g8749):
        curated.append(_rubric(lbl))
        curated.append(_music(g))

    curated += [
        # Crucem tuam adorámus
        _rubric("Deinde cantatur communiter:"),
        _music(g428, latin="Crucem tuam adorámus, Dómine,"),
        _rubric("Et repetitur immediate antiphona Crucem tuam."),
        # Crux fidelis / Pange lingua
        _rubric(
            "Postea cantatur V/. Crux fidelis, cum hymno Pange, lingua, gloriosi, "
            "ut sequitur, et post quemlibet ejus versum, repetitur Crux fidelis, "
            "vel Dulce lignum, eo modo quo inferius notatur."
        ),
        _music(g1128 + " (Z-) " + g2209),
    ]

    # Tail: "Circa finem" rubric + Vexilla Regis (fix GABC to cid=12742)
    tail = list(items[idx_circa:])
    for item in tail:
        if item.get("type") == "music" and "Vexílla" in (item.get("latin") or ""):
            item["gabc"] = g12742
            break

    new_ador_items = items[: idx_postea + 1] + curated + tail
    ordo[ador_start:ador_end] = new_ador_items

    # -----------------------------------------------------------------------
    # Write back
    # -----------------------------------------------------------------------
    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # Sanity dump
    print(f"Adoratio crucis: {len(new_ador_items)} items")
    for i, item in enumerate(new_ador_items):
        t = item.get("type", "?")
        lat = (item.get("latin") or "")[:55]
        txt = (item.get("text") or "")[:55]
        gabc = (item.get("gabc") or "")[:30]
        print(f"  [{i:2}] {t:8} | {lat or txt or gabc!r}")

    print(f"\nCommunio: {len(new_citems)} items")
    for i, item in enumerate(new_citems[:8]):
        t = item.get("type", "?")
        txt = (item.get("text") or item.get("latin") or item.get("gabc") or "")[:65]
        print(f"  [{i:2}] {t:8} | {txt!r}")


if __name__ == "__main__":
    main()
