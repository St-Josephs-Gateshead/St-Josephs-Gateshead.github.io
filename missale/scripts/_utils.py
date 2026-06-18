"""Shared utilities for the missale scripts."""

import re
import unicodedata

_LIGATURES = str.maketrans(
    {
        "æ": "ae",
        "Æ": "ae",
        "ǽ": "ae",
        "œ": "oe",
        "Œ": "oe",
    }
)

# Strips "Alleluia. ij. V/." (and close variants) from the start of a lyrics
# string so alleluia entries are indexed by verse text only.
_AL_LEADER = re.compile(
    r"^al+el[ui]+a[.,]?\s*(?:i+j?[.,]?\s*)?(?:v[/.]?\s*)?",
    re.IGNORECASE,
)


def _norm_lyrics(text: str, office_part: str = "") -> str:
    """Normalise lyrics for substring search: fold diacritics, strip liturgical markers.

    Pass office_part='al' to additionally strip the 'Alleluia ij V/.' leader
    so alleluia entries are indexed by verse text only, matching the query side
    which strips 'Allelúja, allelúja.' via _resolve_match_part.
    """
    # Expand ligatures before stripping non-ASCII so ae/oe are preserved
    text = text.translate(_LIGATURES)
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[VvRr]\s*[./]\s*/?", " ", text)
    text = re.sub(r"[†‡☩℣℟~]", " ", text)
    text = re.sub(r"\biij?\.?\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"[^a-zA-Z\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip().lower()
    if office_part == "al":
        text = _AL_LEADER.sub("", text).strip()
    return text
