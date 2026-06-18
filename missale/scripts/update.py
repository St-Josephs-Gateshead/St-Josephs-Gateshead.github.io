"""
Fetch external data sources and write local data files.

  python update.py            # fetch both GregoBase and Divinum Officium
  python update.py gregobase  # GregoBase only
  python update.py do         # Divinum Officium only

Data is stored under missale/data/ inside the repo:
  gregobase_chants.json          — GregoBase chant database (git-ignored)
  divinum-officium/              — DO missa source, all languages (sparse clone, git-ignored)
  tempora.csv / sancti.csv  — mass index (regenerated after each DO update)
"""

import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from _utils import _norm_lyrics

_SCRIPTS = Path(__file__).resolve().parent
_DATA = _SCRIPTS.parent / "data"

SQL_URL = "https://raw.githubusercontent.com/gregorio-project/GregoBase/master/gregobase_online.sql"
OUT_PATH = _DATA / "gregobase_chants.json"

DO_REPO = "https://github.com/DivinumOfficium/divinum-officium"
DO_DIR = _DATA / "divinum-officium"
# Covers missa (for propers + Asperges responses) and horas Psalterium (for Marian V/R)
DO_SPARSE_PATHS = ["web/www/missa", "web/www/horas"]

# Column order in the SQL dump — used only to parse rows; we write a subset to JSON.
COLUMNS = [
    "id",
    "cantusid",
    "version",
    "incipit",
    "initial",
    "office-part",
    "mode",
    "mode_var",
    "transcriber",
    "commentary",
    "headers",
    "gabc",
    "gabc_verses",
    "tex_verses",
    "remarks",
    "copyrighted",
    "duplicateof",
]

_LAST_UPDATED_PATH = _DATA / "last_updated.json"
_CHANT_INDEX_PATH = _DATA / "chant_index.json"


def _record_fetch(key: str) -> None:
    """Write the current UTC timestamp for key into last_updated.json."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data: dict = {}
    if _LAST_UPDATED_PATH.exists():
        try:
            data = json.loads(_LAST_UPDATED_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    data[key] = ts
    _LAST_UPDATED_PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"Recorded {key} fetch time: {ts}")


# ---------------------------------------------------------------------------
# GABC cleaning and lyrics extraction — applied once at write time
# ---------------------------------------------------------------------------


def _clean_gabc(gabc: str) -> str:
    """Normalise raw GregoBase GABC for storage.

    HTML tags (<i>, <sc>, <sp> etc.) are preserved so gregoriotex can use them
    directly; the SPA converts them to Exsurge markdown at render time.
    Only Exsurge-specific bracket annotations and non-standard bare * are fixed.
    """
    gabc = re.sub(r"\[[^\]]*\]", "", gabc)  # strip [oh:h] [hl:1] spacing hints
    gabc = re.sub(r"<sp>'?(?:ae|æ)</sp>", "ǽ", gabc)  # ae ligature → unicode
    gabc = re.sub(r"<sp>'?(?:oe|œ)</sp>", "œ", gabc)  # oe ligature → unicode
    gabc = re.sub(r"\*(?!\()", "*()", gabc)  # bare * → *()
    return gabc


def _make_lyrics(gabc: str) -> str:
    """Strip notation from GABC to produce searchable sung text.

    Syllables within a word are adjacent in GABC (no space between them), so
    stripping the () neume groups naturally re-joins them — no hyphen artifacts.
    """
    text = re.sub(r"\([^)]*\)", "", gabc)  # remove neumes
    text = re.sub(r"\{([^}]*)\}", r"\1", text)  # unwrap {} — keep content
    text = re.sub(r"<[^>]+>", "", text)  # strip HTML tags
    text = re.sub(r"[*:;|]", " ", text)  # barlines and score markers → space
    return " ".join(text.split())


def _extract_all_gabcs(raw: str) -> list[str]:
    """Return all cleaned GABC blocks from the JSON-encoded gabc column."""
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, str):
            blocks = [parsed]
        else:
            blocks = [
                item[1]
                for item in parsed
                if isinstance(item, list) and len(item) >= 2 and item[0] == "gabc"
            ]
    except Exception:
        blocks = [raw] if raw else []
    return [_clean_gabc(b) for b in blocks if b]


# ---------------------------------------------------------------------------
# SQL parser (unchanged)
# ---------------------------------------------------------------------------


def _unescape(s: str) -> str:
    """Unescape MySQL-style backslash sequences from a SQL string literal."""
    out, i = [], 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            out.append(
                {
                    "'": "'",
                    '"': '"',
                    "\\": "\\",
                    "n": "\n",
                    "r": "\r",
                    "t": "\t",
                    "0": "\0",
                    "Z": "\x1a",
                    "b": "\b",
                }.get(nxt, "\\" + nxt)
            )
            i += 2
        else:
            out.append(s[i])
            i += 1
    return "".join(out)


def _iter_rows(sql: str):
    """
    Yield each VALUES row from all INSERT INTO gregobase_chants statements as
    a list of strings.  phpMyAdmin splits large tables across many INSERT
    statements, so every occurrence is scanned.  The state machine correctly
    handles parentheses and quotes that appear inside field values (e.g. the
    JSON stored in the gabc column).
    """
    INSERT_MARKER = "INSERT INTO `gregobase_chants`"

    BETWEEN = 0
    IN_ROW = 1
    IN_STR = 2

    search_from = 0
    while True:
        marker = sql.find(INSERT_MARKER, search_from)
        if marker == -1:
            break
        search_from = marker + len(INSERT_MARKER)

        values_start = sql.index("VALUES", marker) + len("VALUES")
        state = BETWEEN
        field_buf: list[str] = []
        row: list[str] = []
        i = values_start

        while i < len(sql):
            c = sql[i]

            if state == BETWEEN:
                if c == "(":
                    state = IN_ROW
                    field_buf = []
                    row = []
                    i += 1
                elif c == ";":
                    break
                else:
                    i += 1

            elif state == IN_ROW:
                if c == "'":
                    field_buf = []
                    state = IN_STR
                    i += 1
                elif sql[i : i + 4] == "NULL":
                    row.append("")
                    i += 4
                    if i < len(sql) and sql[i] == ",":
                        i += 1
                elif c == ",":
                    val = "".join(field_buf).strip()
                    if val:
                        row.append(val)
                    field_buf = []
                    i += 1
                elif c == ")":
                    val = "".join(field_buf).strip()
                    if val:
                        row.append(val)
                    field_buf = []
                    yield row
                    state = BETWEEN
                    i += 1
                else:
                    field_buf.append(c)
                    i += 1

            elif state == IN_STR:
                if c == "\\" and i + 1 < len(sql):
                    field_buf.append(c)
                    field_buf.append(sql[i + 1])
                    i += 2
                elif c == "'":
                    row.append(_unescape("".join(field_buf)))
                    field_buf = []
                    state = IN_ROW
                    i += 1
                    if i < len(sql) and sql[i] == ",":
                        i += 1
                else:
                    field_buf.append(c)
                    i += 1


# ---------------------------------------------------------------------------
# Public fetch functions
# ---------------------------------------------------------------------------


def fetch_and_convert(
    url: str = SQL_URL,
    out_path: Path = OUT_PATH,
    gabc_and_lyrics: bool = True,
) -> int:
    """Parse the GregoBase SQL dump and write gregobase_chants.json.

    When gabc_and_lyrics=False (used by refresh.py which follows up with a
    live GABC fetch), only metadata and tex_verses are stored.  The live fetch
    does the single cleaning and lyrics pass, avoiding redundant work.
    """
    print(f"Downloading {url} ...")
    with urllib.request.urlopen(url) as response:
        sql = response.read().decode("utf-8", errors="replace")
    print(f"Downloaded {len(sql):,} bytes. Parsing ...")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    written = skipped = 0
    chants = []

    for row_vals in _iter_rows(sql):
        if len(row_vals) != len(COLUMNS):
            skipped += 1
            if skipped <= 5:
                print(
                    f"  WARNING: row has {len(row_vals)} cols (expected {len(COLUMNS)}): {row_vals[:3]}"
                )
            continue

        row = dict(zip(COLUMNS, row_vals))

        if gabc_and_lyrics:
            gabcs = _extract_all_gabcs(row["gabc"])
            if not gabcs:
                continue
            entry: dict = {
                "id": int(row["id"]),
                "version": row["version"],
                "office_part": row["office-part"],
                "mode": row["mode"],
                "gabc": gabcs,
                "lyrics": _norm_lyrics(_make_lyrics(gabcs[0]), row["office-part"]),
            }
        else:
            # Metadata-only: gabc and lyrics will be populated by the live fetch
            if not row["id"]:
                continue
            entry = {
                "id": int(row["id"]),
                "version": row["version"],
                "office_part": row["office-part"],
                "mode": row["mode"],
            }

        if row["tex_verses"]:
            entry["tex_verses"] = row["tex_verses"]

        chants.append(entry)
        written += 1

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(chants, f, ensure_ascii=False)

    label = "chants" if gabc_and_lyrics else "metadata skeletons"
    print(f"Written {written:,} {label} to {out_path}")
    if skipped:
        print(f"Skipped {skipped} malformed rows.")
    _record_fetch("gregobase")
    return 0


def fetch_do(
    repo: str = DO_REPO,
    target: Path = DO_DIR,
    sparse_paths: list[str] = DO_SPARSE_PATHS,
) -> None:
    """Sparse-clone or update Divinum Officium data (missa + horas psalterium)."""
    git = ["git"]
    if target.exists():
        print(f"Updating DO ({target}) ...")
        subprocess.run(
            git + ["-C", str(target), "fetch", "--depth=1", "origin", "master"],
            check=True,
        )
        subprocess.run(
            git + ["-C", str(target), "sparse-checkout", "set"] + sparse_paths,
            check=True,
        )
        subprocess.run(git + ["-C", str(target), "checkout", "FETCH_HEAD"], check=True)
    else:
        print(f"Cloning DO (sparse: {sparse_paths}) ...")
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            git
            + [
                "clone",
                "--depth=1",
                "--filter=blob:none",
                "--sparse",
                repo,
                str(target),
            ],
            check=True,
        )
        subprocess.run(
            git + ["-C", str(target), "sparse-checkout", "set"] + sparse_paths,
            check=True,
        )
        # Materialise the sparse paths — sparse-checkout set configures but
        # does not populate the working tree after a blobless clone.
        subprocess.run(git + ["-C", str(target), "checkout", "HEAD"], check=True)
    print("DO update complete.")
    _record_fetch("do")


def build_chant_index(
    src_path: Path = OUT_PATH,
    out_path: Path = _CHANT_INDEX_PATH,
) -> int:
    """Strip gabc/tex_verses from gregobase_chants.json and write chant_index.json.

    The index is fetched by the browser for client-side chant search on the
    deployed site.  Excluding gabc keeps it under ~2 MB vs ~60 MB for the full file.
    """
    if not src_path.exists():
        print(f"Source not found: {src_path}", file=sys.stderr)
        return 1
    print(f"Building chant index from {src_path} ...")
    with open(src_path, encoding="utf-8") as f:
        chants = json.load(f)
    index = [
        {k: v for k, v in entry.items() if k not in ("gabc", "tex_verses")}
        for entry in chants
    ]
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)
    print(f"Written {len(index):,} entries to {out_path}")
    return 0


if __name__ == "__main__":
    arg = sys.argv[1].lower() if len(sys.argv) > 1 else "both"

    if arg in ("gregobase", "both"):
        rc = fetch_and_convert()
        if rc == 0:
            build_chant_index()
        sys.exit(rc)

    if arg in ("do", "both"):
        fetch_do()
        # Regenerate index CSVs after DO update
        import index as _idx

        _idx.generate("tempora")
        _idx.generate("sancti")
