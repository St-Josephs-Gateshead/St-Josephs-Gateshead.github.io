"""
Build the Ordo Missae — flat ordered item list for a mass, consumed by the SPA
and by generate.py to produce TeX output.

Item types (data/propers JSON schema)
--------------------------------------
music (proper)  — { type, gabc, mode, availableTranslations?, targets }
music (slot)    — { type, ordinary, availableTranslations?, targets }
                  "ordinary" names a slot in ordinary.json; the SPA resolves
                  the actual GABC at runtime based on the user's mass setting.
text            — { type, latin, availableTranslations?, translation: null, targets }
rubric (keyed)  — { type, key, targets }
                  key is resolved against rubric_strings.json by generate.py
rubric (free)   — { type, text, availableTranslations?, targets }
title           — { type, text, targets }

targets
-------
("missalette", "pewsheet")  _ALL          propers music/text
("missalette",)             _MISSALETTE   ordinaries and ceremonial items

Ordinary slot names
-------------------
asperges, kyrie, gloria, credo, sanctus, agnus-dei,
dismissal (merges Ite/Benedicamus; SPA filters by gloria rule),
antiphona-mariana (SPA suggests season-appropriate antiphon)

Translatable items
------------------
availableTranslations: {lang: text} is the pre-built multi-language dict.
translation: null is the placeholder populated by the SPA at runtime when
the user selects a language.  Rubric items with a key use the matching entry
in rubric_strings.json; rubric items with text may also carry availableTranslations.
"""

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from propers import (
    build_propers_multi,
    _all_languages,
    _feast_name,
    _parse_sections,
)

_SCRIPTS = Path(__file__).resolve().parent
_MISSALE = _SCRIPTS.parent
_TONI = _MISSALE / "ToniCommunes" / "roman"
_DO_MISSA = _MISSALE / "data" / "divinum-officium" / "web" / "www" / "missa"
_RS_PATH = _MISSALE / "templates" / "rubric_strings.json"

_RS: dict = (
    json.loads(_RS_PATH.read_text(encoding="utf-8")) if _RS_PATH.exists() else {}
)

# Prayers.txt has no [Oremus] section; small fallback dict.
_OREMUS: dict[str, str] = {
    "Latin": "Orémus.",
    "English": "Let us pray.",
    "Deutsch": "Lasset uns beten.",
    "Italiano": "Preghiamo.",
    "Espanol": "Oremos.",
    "Francais": "Prions.",
    "Polski": "Módlmy się.",
    "Portugues": "Oremos.",
}

# Tone shortcut refs → Prayers.txt section names
_TONE_SECTION: dict[str, str] = {
    "per-dominum": "Per Dominum",
    "per-eundem": "Per eundem",
    "per-dominum-eiusdem": "Per Dominum eiusdem",
    "qui-tecum": "Qui tecum",
    "qui-tecum-eiusdem": "Qui tecum eiusdem",
    "qui-vivis": "Qui vivis",
    "qui-cum-patre": "Qui cum Patre",
}

_SPEAKER_RE = re.compile(r"^[VRSMvr]/?\.\s+")

# Item target lists — which output formats each item appears in
# Screen always shows all objects regardless of targets.
_ALL = ("missalette", "pewsheet")  # both PDFs
_MISSALETTE = ("missalette",)  # missalette only (not pew sheet)


# ---------------------------------------------------------------------------
# DO Prayers.txt  — source of all multi-language liturgical response texts
# ---------------------------------------------------------------------------


@lru_cache(maxsize=None)
def _prayers_file(lang: str) -> dict[str, list[str]]:
    """Load and cache Prayers.txt for lang; strip rubric (!) lines."""
    p = _DO_MISSA / lang / "Ordo" / "Prayers.txt"
    if not p.exists():
        return {}
    raw = _parse_sections(p.read_text(encoding="utf-8"))
    return {
        k: [l.strip() for l in v if l.strip() and not l.strip().startswith("!")]
        for k, v in raw.items()
    }


def _prayer_lines(section: str, lang: str) -> list[str]:
    """Lines for a Prayers.txt section in lang, falling back to Latin."""
    return _prayers_file(lang).get(section) or _prayers_file("Latin").get(section, [])


def _strip_speaker(line: str) -> str:
    """Strip leading speaker prefix (r./v./V./R./S./M.) — typesetting cue, not content."""
    m = _SPEAKER_RE.match(line)
    return line[m.end() :] if m else line


# ---------------------------------------------------------------------------
# ToniCommunes tone loader
# ---------------------------------------------------------------------------


def _tone(name: str) -> str:
    """Inline GABC from ToniCommunes/roman/{name}.gabc, header stripped."""
    p = _TONI / f"{name}.gabc"
    if not p.exists():
        return ""
    raw = p.read_text(encoding="utf-8")
    return raw.split("%%", 1)[1].strip() if "%%" in raw else raw.strip()


# ---------------------------------------------------------------------------
# Misc helpers
# ---------------------------------------------------------------------------


def _rubric_strings(lang: str) -> dict:
    en = _RS.get("English", {})
    return {**en, **_RS.get(lang, {})}


# ---------------------------------------------------------------------------
# Multi-language ordo blocks  (pre-generated for the static public site)
# ---------------------------------------------------------------------------


def _mb_pair_lines(section: str, languages: list[str]) -> list[dict]:
    """Text items for a Prayers.txt section with per-line multi-lang translations."""
    lat_lines = _prayer_lines(section, "Latin")
    trans_map: dict[int, dict[str, str]] = {}
    for lang in languages:
        for i, line in enumerate(_prayer_lines(section, lang)):
            if i < len(lat_lines) and line.strip():
                trans_map.setdefault(i, {})[lang] = line
    items = []
    for i, lat in enumerate(lat_lines):
        item: dict[str, Any] = {"type": "text", "latin": lat, "targets": list(_ALL)}
        if i in trans_map:
            item["availableTranslations"] = trans_map[i]
            item["translation"] = None
        items.append(item)
    return items


def _mb_prayer_ending(tone_ref: str, languages: list[str]) -> list[dict]:
    """Multi-lang prayer ending (Per Dominum etc.), excluding R. Amen."""
    section = _TONE_SECTION.get(tone_ref, "Per Dominum")
    lat_lines = [l for l in _prayer_lines(section, "Latin") if not l.startswith("R.")]
    trans_map: dict[int, dict[str, str]] = {}
    for lang in languages:
        lg_lines = [l for l in _prayer_lines(section, lang) if not l.startswith("R.")]
        for i, line in enumerate(lg_lines):
            if i < len(lat_lines) and line.strip():
                trans_map.setdefault(i, {})[lang] = _strip_speaker(line)
    items = []
    for i, lat in enumerate(lat_lines):
        item: dict[str, Any] = {
            "type": "text",
            "latin": _strip_speaker(lat),
            "targets": list(_ALL),
        }
        if i in trans_map:
            item["availableTranslations"] = trans_map[i]
            item["translation"] = None
        items.append(item)
    return items


def _mb_oremus(languages: list[str]) -> dict:
    """Oremus text item with multi-lang available translations."""
    avail = {lang: v for lang in languages if (v := _OREMUS.get(lang))}
    item: dict[str, Any] = {
        "type": "text",
        "latin": _OREMUS.get("Latin", "Orémus."),
        "targets": list(_ALL),
    }
    if avail:
        item["availableTranslations"] = avail
        item["translation"] = None
    return item


def _mb_items(title: str | None, items: list, rubric_key: str = "") -> list:
    """Return flat item list for a mass section; prepends title and optional rubric items."""
    flat = [i for i in items if i]
    if not flat and not rubric_key:
        return []
    result: list[dict] = []
    if title:
        result.append({"type": "title", "text": title, "targets": list(_MISSALETTE)})
    if rubric_key:
        result.append(
            {"type": "rubric", "key": rubric_key, "targets": list(_MISSALETTE)}
        )
    result.extend(flat)
    return result


def _prelude_to_items(prelude: list[dict], languages: list[str]) -> list[dict]:
    """Convert prelude segment list to flat ordo items (multi-lang format)."""
    result: list[dict] = []
    pending_title: str | None = None

    for seg in prelude:
        t = seg.get("type")

        if t == "heading":
            pending_title = seg.get("text", "")

        elif t == "rubric":
            if pending_title is not None:
                result.append(
                    {
                        "type": "title",
                        "text": pending_title,
                        "targets": list(_MISSALETTE),
                    }
                )
                pending_title = None
            avail = {
                k: v for k, v in (seg.get("translations") or {}).items() if v
            } or None
            rb: dict[str, Any] = {
                "type": "rubric",
                "text": seg.get("text", ""),
                "targets": list(_MISSALETTE),
            }
            if avail:
                rb["availableTranslations"] = avail
            result.append(rb)

        elif t in ("antiphon", "hymn", "tractus"):
            gabc = seg.get("gabc", "")
            if not gabc:
                continue
            if pending_title is not None:
                result.append(
                    {
                        "type": "title",
                        "text": pending_title,
                        "targets": list(_MISSALETTE),
                    }
                )
                pending_title = None
            avail = {
                k: v for k, v in (seg.get("translations") or {}).items() if v
            } or None
            result.append(
                {
                    "type": "music",
                    "gabc": gabc,
                    "availableTranslations": avail,
                    "mode": None,
                    "targets": list(_ALL),
                }
            )

        elif t == "prayer":
            if pending_title is not None:
                result.append(
                    {
                        "type": "title",
                        "text": pending_title,
                        "targets": list(_MISSALETTE),
                    }
                )
                pending_title = None
            avail = {
                k: v for k, v in (seg.get("translations") or {}).items() if v
            } or None
            tx: dict[str, Any] = {
                "type": "text",
                "latin": seg.get("text", ""),
                "targets": list(_ALL),
            }
            if avail:
                tx["availableTranslations"] = avail
                tx["translation"] = None
            result.append(tx)

    return result


def build_ordo_blocks(mt: str, pn: str, languages: list[str] | None = None) -> dict:
    """
    Build a flat ordo item list for a mass, for the static public site.

    Returns {"rule": [...], "feast": str, "subtitle": str, "ordo": [Item, ...]}.
    The ordo list follows the schema in the module docstring.  All available
    languages are embedded in each item's availableTranslations dict so the
    SPA can switch language without re-fetching.

    The "dismissal" slot covers both Ite missa est (gloria=true) and Benedicamus
    Domino (gloria=false) variants; ordinary.json tags each variant accordingly
    and the SPA filters by Rule at runtime.
    """
    if languages is None:
        languages = _all_languages()

    data = build_propers_multi(mt, pn, languages=languages)
    rule = data.get("rule", [])
    has_gloria = "Gloria" in rule
    has_credo = "Credo" in rule

    def _avail(key: str) -> dict[str, str] | None:
        ts = data.get(key + "Translations")
        return ts if isinstance(ts, dict) and ts else None

    def _mu(
        gabc: str, avail: dict | None = None, mode: str = "", targets: tuple = _ALL
    ) -> dict | None:
        if not gabc:
            return None
        return {
            "type": "music",
            "gabc": gabc,
            "availableTranslations": avail,
            "mode": mode or None,
            "targets": list(targets),
        }

    def _tx(latin: str, avail: dict | None = None, targets: tuple = _ALL) -> dict:
        item: dict[str, Any] = {
            "type": "text",
            "latin": latin,
            "targets": list(targets),
        }
        if avail:
            item["availableTranslations"] = avail
            item["translation"] = None
        return item

    def _slot(ordinary_key: str, targets: tuple = _MISSALETTE) -> dict:
        return {
            "type": "music",
            "ordinary": ordinary_key,
            "availableTranslations": None,
            "targets": list(targets),
        }

    def _resp_slot(ordinary_key: str, targets: tuple = _MISSALETTE) -> dict:
        """Sentinel item whose content is resolved at runtime from ordinary.json *-resp."""
        return {"type": "text", "ordinary": ordinary_key, "targets": list(targets)}

    ordo: list[dict] = []

    # Prelude (ceremony-specific days, e.g. Palm Sunday procession)
    if prelude := data.get("Prelude"):
        ordo.extend(_prelude_to_items(prelude, languages))

    # Asperges — comes after prelude; SPA chooses variant and fills in responses at runtime
    ordo.extend(
        _mb_items(
            "Asperges",
            [
                _slot("asperges", targets=_MISSALETTE),
                _resp_slot("asperges", targets=_MISSALETTE),
            ],
        )
    )

    # Standard Mass proper sequence
    if data.get("Introitus"):
        ordo.extend(
            _mb_items(
                "Introitus",
                [
                    _mu(
                        data.get("IntroitusGabc", ""),
                        avail=_avail("Introitus"),
                        mode=data.get("IntroitusMode", ""),
                    ),
                ],
                "when_celebrant_reaches_altar",
            )
        )

        ordo.extend(_mb_items("Kyrie", [_slot("kyrie")], "immediately_after_introit"))

        ordo.extend(
            _mb_items(
                "Gloria",
                [_slot("gloria", targets=_MISSALETTE if has_gloria else ())],
                "immediately_after_kyrie",
            )
        )

        if oratio := data.get("Oratio"):
            ordo.extend(
                _mb_items(
                    "Collecta",
                    [
                        _mu(_tone("dominus-vobiscum"), targets=_MISSALETTE),
                        _mb_oremus(languages),
                        _tx(oratio, avail=_avail("Oratio")),
                        *_mb_prayer_ending("per-dominum", languages),
                        _mu(_tone("amen"), targets=_MISSALETTE),
                    ],
                )
            )

        if lectio := data.get("Lectio"):
            ordo.extend(
                _mb_items(
                    "Lectio",
                    [
                        _tx(lectio, avail=_avail("Lectio")),
                    ],
                    "the_lesson_is_chanted",
                )
            )

        grad_gabc = data.get("GradualeGabc")
        al_gabc = data.get("AlleluiaGabc")
        tr_gabc = data.get("TractusGabc")
        gp1_gabc = data.get("GradualeP1Gabc")
        gp2_gabc = data.get("GradualeP2Gabc")
        has_grad = bool(grad_gabc)
        has_al = bool(al_gabc)
        has_tr = bool(tr_gabc)
        has_gradp = bool(gp1_gabc)

        if has_gradp or has_tr:
            # Multi-block structure: each seasonal context is self-contained.
            grad_items: list = []

            # Ordinary time: Graduale + Alleluia (from Graduale section)
            if has_grad:
                if m := _mu(
                    grad_gabc,
                    avail=_avail("Graduale"),
                    mode=data.get("GradualeMode", ""),
                ):
                    grad_items.append(m)
            if has_al:
                if m := _mu(
                    al_gabc, avail=_avail("Alleluia"), mode=data.get("AlleluiaMode", "")
                ):
                    grad_items.append(m)

            # Paschaltide block: GradualeP verses in DO source order
            if has_gradp:
                grad_items.append(
                    {
                        "type": "rubric",
                        "key": "in_paschali_tempore",
                        "targets": list(_MISSALETTE),
                    }
                )
                if m := _mu(
                    gp1_gabc,
                    avail=_avail("Alleluia"),
                    mode=data.get("GradualeP1Mode", ""),
                ):
                    grad_items.append(m)
                if gp2_gabc:
                    if m := _mu(
                        gp2_gabc,
                        avail=_avail("Alleluia"),
                        mode=data.get("GradualeP2Mode", ""),
                    ):
                        grad_items.append(m)

            # Lenten block: Graduale (repeated for self-containment) + Tractus
            if has_tr:
                grad_items.append(
                    {
                        "type": "rubric",
                        "key": "in_quadragesima",
                        "targets": list(_MISSALETTE),
                    }
                )
                if has_grad:
                    if m := _mu(
                        grad_gabc,
                        avail=_avail("Graduale"),
                        mode=data.get("GradualeMode", ""),
                    ):
                        grad_items.append(m)
                if m := _mu(
                    tr_gabc, avail=_avail("Tractus"), mode=data.get("TractusMode", "")
                ):
                    grad_items.append(m)

            gtitle = "Graduale"

            if grad_items:
                ordo.extend(_mb_items(gtitle, grad_items, "after_chanting_lesson"))
        else:
            grad_items = []
            if has_grad:
                if m := _mu(
                    grad_gabc,
                    avail=_avail("Graduale"),
                    mode=data.get("GradualeMode", ""),
                ):
                    grad_items.append(m)
            if has_al:
                if m := _mu(
                    al_gabc, avail=_avail("Alleluia"), mode=data.get("AlleluiaMode", "")
                ):
                    grad_items.append(m)
            if has_tr:
                if m := _mu(
                    tr_gabc, avail=_avail("Tractus"), mode=data.get("TractusMode", "")
                ):
                    grad_items.append(m)
            if grad_items:
                if has_tr and not has_grad:
                    gtitle = "Tractus"
                elif has_al and not has_grad:
                    gtitle = "Alleluia"
                elif has_grad and has_al:
                    gtitle = "Graduale & Alleluia"
                else:
                    gtitle = "Graduale"
                ordo.extend(_mb_items(gtitle, grad_items, "after_chanting_lesson"))

        if seq_gabc := data.get("SequentiaGabc"):
            ordo.extend(
                _mb_items(
                    "Sequentia",
                    [
                        _mu(
                            seq_gabc,
                            avail=_avail("Sequentia"),
                            mode=data.get("SequentiaMode", ""),
                        ),
                    ],
                )
            )

        if evangelium := data.get("Evangelium"):
            ordo.extend(
                _mb_items(
                    "Evangelium",
                    [
                        _mu(_tone("dominus-vobiscum"), targets=_MISSALETTE),
                        _mu(_tone("sequenti"), targets=_MISSALETTE),
                        _tx(evangelium, avail=_avail("Evangelium")),
                    ],
                    "choir_sings_responses_gospel",
                )
            )

        ordo.extend(
            _mb_items(
                "Credo",
                [_slot("credo", targets=_MISSALETTE if has_credo else ())],
                "the_creed_is_sung",
            )
        )

        ordo.extend(
            _mb_items(
                "Ante Offertorium",
                [
                    _mu(_tone("dominus-vobiscum"), targets=_MISSALETTE),
                ],
                "just_before_offertory",
            )
        )

        if off_gabc := data.get("OffertoriumGabc"):
            ordo.extend(
                _mb_items(
                    "Offertorium",
                    [
                        _mu(
                            off_gabc,
                            avail=_avail("Offertorium"),
                            mode=data.get("OffertoriumMode", ""),
                        ),
                    ],
                    "immediately_after_oremus",
                )
            )

        if secreta := data.get("Secreta"):
            ordo.extend(
                _mb_items(
                    "Secreta",
                    [
                        _tx(secreta, avail=_avail("Secreta")),
                        *_mb_prayer_ending("per-dominum", languages),
                    ],
                )
            )

        ordo.extend(
            _mb_items(
                "Praefatio",
                [
                    _mu(_tone("preface_standard"), targets=_MISSALETTE),
                ],
            )
        )

        ordo.extend(
            _mb_items("Sanctus", [_slot("sanctus")], "immediately_after_preface")
        )

        ordo.extend(
            _mb_items(
                "Post Canonem",
                [
                    _mu(_tone("amen"), targets=_MISSALETTE),
                ],
            )
        )

        ordo.extend(
            _mb_items(
                "Pater Noster",
                [
                    _mu(_tone("sed-libera-nos"), targets=_MISSALETTE),
                ],
                "celebrant_pater_noster",
            )
        )

        ordo.extend(
            _mb_items(
                "Fractio",
                [
                    _mu(_tone("pax-domini"), targets=_MISSALETTE),
                ],
            )
        )

        ordo.extend(_mb_items("Agnus Dei", [_slot("agnus-dei")]))

        if com_gabc := data.get("CommunioGabc"):
            ordo.extend(
                _mb_items(
                    "Communio",
                    [
                        _mu(
                            com_gabc,
                            avail=_avail("Communio"),
                            mode=data.get("CommunioMode", ""),
                        ),
                    ],
                    "once_celebrant_distributes",
                )
            )

        if post := data.get("Postcommunio"):
            ordo.extend(
                _mb_items(
                    "Postcommunio",
                    [
                        _mu(_tone("dominus-vobiscum"), targets=_MISSALETTE),
                        _mb_oremus(languages),
                        _tx(post, avail=_avail("Postcommunio")),
                        *_mb_prayer_ending("per-dominum", languages),
                        _mu(_tone("amen"), targets=_MISSALETTE),
                    ],
                )
            )

        if sp := data.get("Super populum"):
            ordo.extend(
                _mb_items(
                    "Oratio super Populum",
                    [
                        _tx(sp, avail=_avail("Super populum")),
                        *_mb_prayer_ending("per-dominum", languages),
                        _mu(_tone("amen"), targets=_MISSALETTE),
                    ],
                )
            )

        # Dismissal — single "dismissal" slot; ordinary.json merges Ite and
        # Benedicamus variants tagged with gloria:true/false so the SPA can
        # filter by Rule at runtime.
        ordo.extend(
            _mb_items(
                "Dimissio",
                [
                    _mu(_tone("dominus-vobiscum"), targets=_MISSALETTE),
                    _slot("dismissal"),
                    *_mb_pair_lines("Deo gratias", languages),
                ],
            )
        )

    # Marian Antiphon — ordinary slot; SPA suggests season-appropriate variant and fills responses
    ordo.extend(
        _mb_items(
            "Antiphona Mariana",
            [
                _slot("antiphona-mariana"),
                _resp_slot("antiphona-mariana"),
            ],
            "marian_at_conclusion",
        )
    )

    return {
        "rule": rule,
        "feast": _feast_name(mt, pn),
        "subtitle": "Missa Cantata",
        "ordo": ordo,
    }
