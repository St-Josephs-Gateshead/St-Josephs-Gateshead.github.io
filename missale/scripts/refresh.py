"""
refresh.py — clean and rebuild all generated data from scratch.

Cleans generated and fetched data, then re-fetches and regenerates everything:
  1. Remove gregobase_chants.json, divinum-officium/, ordinary.json, propers/,
     and all three index CSVs (tempora, sancti, commune)
  2. Sparse-clone / update Divinum Officium
  3. Regenerate tempora.csv, sancti.csv, and commune.csv
  4. Fetch GregoBase SQL dump — metadata + tex_verses only (GABC deferred to step 5)
  5. Refresh all GABC from live GregoBase site (SQL dump GABC may be stale)
  6. Scan for new chants above SQL dump ceiling
  7. Build chant_index.json (all entries, gabc stripped, for browser search)
  8. Generate propers JSON for all tempora + sancti + commune masses
  9. Write ordinary.json

Usage:
    python refresh.py            # full clean + rebuild
    python refresh.py --clean    # clean only (no fetch / generate)
"""

import os
import shutil
import stat
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
_DATA = _SCRIPTS.parent / "data"


def _force_remove(func, path, exc_info):
    """Error handler for shutil.rmtree: clear read-only bit and retry."""
    os.chmod(path, stat.S_IWRITE)
    func(path)


def clean() -> None:
    """Remove all generated and fetched data files."""
    targets = [
        _DATA / "gregobase_chants.json",
        _DATA / "divinum-officium",
        _DATA / "ordinary.json",
        _DATA / "propers",
        _DATA / "tempora.csv",
        _DATA / "sancti.csv",
        _DATA / "commune.csv",
        _DATA / "last_updated.json",
        _DATA / "chant_index.json",
    ]
    for t in targets:
        if t.is_dir():
            shutil.rmtree(t, onexc=_force_remove)
            print(f"  removed {t.name}/")
        elif t.exists():
            t.unlink()
            print(f"  removed {t.name}")
        else:
            print(f"  (absent) {t.name}")


def rebuild_all() -> None:
    """Fetch all external data and regenerate every derived artifact."""
    sys.path.insert(0, str(_SCRIPTS))

    print("\n=== Fetch Divinum Officium ===")
    from update import fetch_do

    fetch_do()

    print("\n=== Regenerate index CSVs ===")
    import index as _idx

    _idx.generate("tempora")
    _idx.generate("sancti")
    _idx.generate_commune()

    print("\n=== Fetch GregoBase chants (SQL dump — metadata + tex_verses only) ===")
    from update import fetch_and_convert

    rc = fetch_and_convert(gabc_and_lyrics=False)
    if rc != 0:
        raise RuntimeError(f"fetch_and_convert() returned {rc}")

    print("\n=== Refresh all GABC from live site (SQL dump GABC may be stale) ===")
    from fetch_gabc import refresh_all_gabc, scan_new_chants

    refresh_all_gabc()

    print("\n=== Scan for new chants above SQL dump ceiling ===")
    scan_new_chants()

    print("\n=== Build chant index for browser search ===")
    from update import build_chant_index

    build_chant_index()

    print("\n=== Generate propers JSON ===")
    from batch import run

    run(["tempora", "sancti", "commune"])

    print("\n=== Generate ordinary.json ===")
    from propers import write_ordinary_json

    write_ordinary_json()

    print("\n=== Done ===")


if __name__ == "__main__":
    if "--clean" in sys.argv:
        print("=== Clean ===")
        clean()
    else:
        print("=== Clean ===")
        clean()
        rebuild_all()
