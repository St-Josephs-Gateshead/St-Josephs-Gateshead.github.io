"""
Refresh GABC in gregobase_chants.json from the live GregoBase website.

The existing update.py pulls a static SQL dump from GitHub, which can lag
behind the live database.  This script hits the per-chant endpoints on
gregobase.selapa.net and updates existing entries or discovers new ones.

Usage:
    python fetch_gabc.py                        # update all stale existing entries
    python fetch_gabc.py --force                # re-fetch every existing entry
    python fetch_gabc.py --ids 1 2 3            # fetch specific IDs only
    python fetch_gabc.py --scan                 # discover and add new IDs above current max
    python fetch_gabc.py --scan --from-id 1     # full rebuild from scratch (slow: ~2h)
    python fetch_gabc.py --delay 0.3            # set inter-request delay (default 0.2 s)
    python fetch_gabc.py --dry-run              # report what would happen, no writes

Progress is saved every 500 chants so an interrupted run resumes cleanly.
In --scan mode, each new ID requires two requests (GABC + HTML for version).
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from update import _clean_gabc, _make_lyrics
from _utils import _norm_lyrics

sys.stdout.reconfigure(line_buffering=True)

_DATA = Path(__file__).resolve().parent.parent / "data"
_DB_PATH = _DATA / "gregobase_chants.json"

_GABC_URL = "https://gregobase.selapa.net/download.php?id={id}&format=gabc&elem={elem}"
_CHANT_URL = "https://gregobase.selapa.net/chant.php?id={id}"

_SCAN_CEILING = 99999  # hard upper bound — scan stops earlier via _SCAN_MISS_LIMIT
_SCAN_MISS_LIMIT = 100  # consecutive "Wrong id" responses before stopping (only counted above existing max)
_SAVE_EVERY = 500


# ── GABC file parsing ──────────────────────────────────────────────────────────


def _parse_gabc_file(text: str) -> tuple[dict[str, str], list[str]]:
    """Parse a GregoBase GABC download into (headers, gabc_blocks)."""
    if "%%" not in text:
        return {}, [_clean_gabc(text.strip())] if text.strip() else []

    header_part, _, body = text.partition("%%")

    headers: dict[str, str] = {}
    for line in header_part.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip().rstrip(";").strip()

    # Body may have multiple blocks separated by VERSES%% or similar markers
    blocks = re.split(r"[A-Z]+%%", body)
    cleaned = [_clean_gabc(b.strip()) for b in blocks if b.strip()]
    return headers, cleaned


def _parse_version(html: str) -> str:
    """Extract the Version field from a chant HTML page."""
    m = re.search(r"<h4>Version</h4>\s*<ul>\s*<li>(.*?)</li>", html, re.S)
    if m:
        return re.sub(r"<[^>]+>", "", m.group(1)).strip()
    return ""


def _parse_office_part(html: str) -> str:
    """Extract office-part from the Usage section of a chant HTML page."""
    m = re.search(r'class="usage\s+(\w+)"', html)
    return m.group(1).lower() if m else ""


# ── HTTP helpers ───────────────────────────────────────────────────────────────


def _get(url: str, delay: float) -> str | None:
    time.sleep(delay)
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            print(f"  HTTP {e.code}: {url}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  Error: {url} — {e}", file=sys.stderr)
        return None


def _fetch_gabc(chant_id: int, delay: float) -> tuple[dict[str, str], list[str]] | None:
    """Fetch all GABC elements for a chant, returning (headers_from_elem1, all_gabc_blocks)."""
    all_gabcs: list[str] = []
    first_headers: dict[str, str] = {}
    seen: set[tuple[str, ...]] = set()

    for elem in range(1, 99):
        url = _GABC_URL.format(id=chant_id, elem=elem)
        text = _get(url, delay if elem == 1 else 0)  # only sleep on first request
        if not text or text.strip() in ("Wrong id", ""):
            break
        headers, gabcs = _parse_gabc_file(text)
        if not gabcs:
            break
        key = tuple(gabcs)
        if key in seen:
            # Server is cycling — no more unique elements
            break
        seen.add(key)
        if elem == 1:
            first_headers = headers
        all_gabcs.extend(gabcs)

    if not all_gabcs:
        return None
    return first_headers, all_gabcs


def _fetch_html(chant_id: int, delay: float) -> str | None:
    html = _get(_CHANT_URL.format(id=chant_id), delay)
    if not html or html.strip() == "Wrong id":
        return None
    return html


# ── Update existing entries ────────────────────────────────────────────────────


def _update_entries(
    chants: list[dict],
    by_id: dict[int, dict],
    target_ids: list[int],
    delay: float,
    dry_run: bool,
) -> tuple[int, int]:
    total = len(target_ids)
    print(f"{total} existing entries to refresh")
    if dry_run:
        print(f"Would fetch IDs: {target_ids[:10]}{'...' if total > 10 else ''}")
        return 0, 0

    updated = errors = 0
    for i, chant_id in enumerate(target_ids, 1):
        result = _fetch_gabc(chant_id, delay)
        if not result:
            errors += 1
            if i % 100 == 0:
                print(f"[{i}/{total}] updated={updated}  errors={errors}")
            continue

        headers, gabcs = result
        entry = by_id[chant_id]
        entry["gabc"] = gabcs
        entry["lyrics"] = _norm_lyrics(
            _make_lyrics(gabcs[0]), entry.get("office_part", "")
        )
        if headers.get("mode"):
            entry["mode"] = headers["mode"]
        updated += 1

        if i % 100 == 0 or i == total:
            print(f"[{i}/{total}] updated={updated}  errors={errors}")
        if updated % _SAVE_EVERY == 0:
            _save(chants)
            print(f"  Checkpoint saved ({updated} updated)")

    return updated, errors


# ── Scan for new IDs ──────────────────────────────────────────────────────────


def _scan_new(
    chants: list[dict],
    by_id: dict[int, dict],
    from_id: int,
    to_id: int,
    delay: float,
    dry_run: bool,
    miss_limit_after: int = 0,
) -> tuple[int, int]:
    """
    miss_limit_after: ID above which consecutive misses are counted toward the
    stop threshold.  IDs at or below this value are known to have legitimate
    gaps (they fall within the existing DB range) so misses there are ignored.
    """
    scan_ids = [i for i in range(from_id, to_id + 1) if i not in by_id]
    total = len(scan_ids)
    print(
        f"Scanning IDs {from_id}–{to_id} for new chants ({total} to probe, 2 requests each)"
    )
    if dry_run:
        print(f"Would probe IDs: {scan_ids[:10]}{'...' if total > 10 else ''}")
        return 0, 0

    added = errors = consecutive_misses = 0
    for i, chant_id in enumerate(scan_ids, 1):
        result = _fetch_gabc(chant_id, delay)
        if not result:
            if chant_id > miss_limit_after:
                consecutive_misses += 1
                if consecutive_misses >= _SCAN_MISS_LIMIT:
                    print(
                        f"  {_SCAN_MISS_LIMIT} consecutive misses at id={chant_id} — stopping scan"
                    )
                    break
            if i % 500 == 0:
                print(f"  [{i}/{total}] probed, added={added}")
            continue

        headers, gabcs = result
        if not gabcs:
            if chant_id > miss_limit_after:
                consecutive_misses += 1
            continue

        consecutive_misses = 0

        # Fetch HTML page for version (not in the GABC download)
        html = _fetch_html(chant_id, delay)
        version = _parse_version(html) if html else ""

        office_part = headers.get("office-part", "").lower()
        if not office_part and html:
            office_part = _parse_office_part(html)

        entry: dict = {
            "id": chant_id,
            "version": version,
            "office_part": office_part,
            "mode": headers.get("mode", ""),
            "gabc": gabcs,
            "lyrics": _norm_lyrics(_make_lyrics(gabcs[0]), office_part),
        }
        chants.append(entry)
        by_id[chant_id] = entry
        added += 1

        print(
            f"  [{i}/{total}] +id={chant_id}  version={version!r}  part={office_part}"
        )
        if added % _SAVE_EVERY == 0:
            _save(chants)
            print(f"  Checkpoint saved ({added} added)")

    return added, errors


# ── Helpers ───────────────────────────────────────────────────────────────────


def _save(chants: list[dict]) -> None:
    with open(_DB_PATH, "w", encoding="utf-8") as f:
        json.dump(chants, f, ensure_ascii=False)


# ── Public API (for refresh.py) ───────────────────────────────────────────────


def refresh_all_gabc(delay: float = 0.2) -> None:
    """
    Re-fetch GABC from the live site for every existing entry in gregobase_chants.json.
    Preserves tex_verses (only in SQL dump) and other metadata; updates only gabc,
    lyrics, and mode.  Called by refresh.py after the SQL dump fetch.
    """
    with open(_DB_PATH, encoding="utf-8") as f:
        chants: list[dict] = json.load(f)
    by_id: dict[int, dict] = {c["id"]: c for c in chants}
    target_ids = [c["id"] for c in chants]
    print(f"  Refreshing GABC for {len(target_ids)} entries ...")
    updated, errors = _update_entries(chants, by_id, target_ids, delay, dry_run=False)
    _save(chants)
    print(f"  {updated} updated, {errors} errors.")


def scan_new_chants(ceiling: int = _SCAN_CEILING, delay: float = 0.2) -> None:
    """
    Discover and add chants with IDs above the current max in gregobase_chants.json.
    Called by refresh.py after the SQL dump is fetched.
    """
    with open(_DB_PATH, encoding="utf-8") as f:
        chants: list[dict] = json.load(f)
    by_id: dict[int, dict] = {c["id"]: c for c in chants}
    from_id = max(by_id) + 1
    existing_max = from_id - 1
    print(f"  Current max id={existing_max}, scanning up to {ceiling} ...")
    added, _ = _scan_new(
        chants,
        by_id,
        from_id,
        ceiling,
        delay,
        dry_run=False,
        miss_limit_after=existing_max,
    )
    _save(chants)
    print(f"  {added} new chants added.")


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Refresh/extend GregoBase chants from live site"
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="Re-fetch every existing entry even if already up-to-date",
    )
    ap.add_argument(
        "--ids", nargs="+", type=int, metavar="ID", help="Fetch specific chant IDs only"
    )
    ap.add_argument(
        "--scan",
        action="store_true",
        help="Probe for new IDs above the current max and add them",
    )
    ap.add_argument(
        "--from-id",
        type=int,
        default=None,
        help="Start of scan range (default: max existing ID + 1; use 1 for full rebuild)",
    )
    ap.add_argument(
        "--to-id",
        type=int,
        default=_SCAN_CEILING,
        help=f"Hard upper bound for scan (default: {_SCAN_CEILING}); "
        f"scan stops earlier after {_SCAN_MISS_LIMIT} consecutive misses",
    )
    ap.add_argument(
        "--delay",
        type=float,
        default=0.2,
        help="Seconds between requests (default: 0.2)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would happen without making requests or writes",
    )
    args = ap.parse_args()

    if not _DB_PATH.exists():
        print(f"Database not found: {_DB_PATH}", file=sys.stderr)
        print("Run: python update.py gregobase", file=sys.stderr)
        return 1

    print(f"Loading {_DB_PATH} ...")
    with open(_DB_PATH, encoding="utf-8") as f:
        chants: list[dict] = json.load(f)
    by_id: dict[int, dict] = {c["id"]: c for c in chants}
    print(f"  {len(chants)} existing entries  (max id={max(by_id)})")

    total_updated = total_added = total_errors = 0

    # ── Update existing entries ──────────────────────────────────────────────
    if not args.scan or args.ids or args.force:
        if args.ids:
            target_ids = [i for i in args.ids if i in by_id]
            missing = [i for i in args.ids if i not in by_id]
            if missing:
                print(
                    f"IDs not in database (use --scan to add): {missing}",
                    file=sys.stderr,
                )
        elif args.force:
            target_ids = [c["id"] for c in chants]
        elif not args.scan:
            target_ids = [c["id"] for c in chants if not c.get("gabc")]
        else:
            target_ids = []

        if target_ids:
            u, e = _update_entries(chants, by_id, target_ids, args.delay, args.dry_run)
            total_updated += u
            total_errors += e

    # ── Scan for new IDs ────────────────────────────────────────────────────
    if args.scan:
        existing_max = max(by_id)
        from_id = args.from_id if args.from_id is not None else existing_max + 1
        a, e = _scan_new(
            chants,
            by_id,
            from_id,
            args.to_id,
            args.delay,
            args.dry_run,
            miss_limit_after=existing_max,
        )
        total_added += a
        total_errors += e

    if not args.dry_run:
        print("Saving ...")
        _save(chants)

    print(f"Done.  updated={total_updated}  added={total_added}  errors={total_errors}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
