"""
Batch-generate propers JSON for all masses.

Modes:
    python batch.py                        # all tempora + sancti + commune
    python batch.py tempora                # tempora only
    python batch.py sancti                 # sancti only
    python batch.py commune                # commune only
    python batch.py tempora Adv1-0        # one specific mass
    python batch.py sancti 12-25          # one specific mass

JSON output:  missale/data/propers/{mt}/{pn}.json  (all languages embedded)

Good Friday (tempora/Quad6-5) is automatically post-processed by _fix_improperia.py
after generation to supply hand-curated Adoratio crucis and Communio content.
"""

import csv
import os
import sys
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPTS))

from propers import write_propers_json

_DATA = _SCRIPTS.parent / "data"


def _generate_one(mt: str, pn: str) -> tuple[str, str, str | None]:
    """Worker: generate one mass and return (status, key, detail)."""
    try:
        write_propers_json(mt, pn)
        return ("ok", f"{mt}/{pn}", None)
    except ValueError as e:
        return ("skipped", f"{mt}/{pn}", str(e))
    except Exception:
        return ("failed", f"{mt}/{pn}", traceback.format_exc())


def run(
    mass_types: list[str], only: str | None = None, workers: int | None = None
) -> None:
    """Generate propers JSON for every mass in mass_types, or just one if only is set."""
    tasks: list[tuple[str, str]] = []
    for mt in mass_types:
        if only:
            tasks.append((mt, only))
        else:
            csv_path = _DATA / f"{mt}.csv"
            with open(csv_path, encoding="utf-8", newline="") as f:
                for row in csv.DictReader(f):
                    tasks.append((mt, row["path_name"]))

    n_workers = workers or min(os.cpu_count() or 4, 8)
    print(f"\nGenerating {len(tasks)} masses with {n_workers} workers …\n")

    ok, skipped, failed = [], [], []

    with ProcessPoolExecutor(max_workers=n_workers) as pool:
        futures = {pool.submit(_generate_one, mt, pn): (mt, pn) for mt, pn in tasks}
        for fut in as_completed(futures):
            status, key, detail = fut.result()
            if status == "ok":
                print(f"  OK  {key}")
                ok.append(key)
            elif status == "skipped":
                print(f"  --  {key}  (skipped: {detail})")
                skipped.append(key)
            else:
                print(f"  ERR {key}")
                print(detail)
                failed.append(key)

    _postprocess(ok)

    print(f"\n{'=' * 60}")
    print(f"  Done — {len(ok)} OK, {len(skipped)} skipped, {len(failed)} failed")
    if failed:
        print("  Failed:")
        for f in failed:
            print(f"    {f}")
    print(f"{'=' * 60}\n")


def _postprocess(generated: list[str]) -> None:
    """Run curated post-generation fixes for masses that need hand-patched content."""
    if "tempora/Quad6-5" in generated:
        print("\n  [postprocess] Running _fix_improperia for Quad6-5 (Good Friday)...")
        try:
            import _fix_improperia

            _fix_improperia.main()
            print("  [postprocess] Done.")
        except Exception:
            import traceback

            print("  [postprocess] FAILED:")
            traceback.print_exc()


if __name__ == "__main__":
    args = sys.argv[1:]

    mt_map = {"tempora": ["tempora"], "sancti": ["sancti"], "commune": ["commune"]}

    if len(args) >= 2 and args[0].lower() in mt_map:
        mass_types = mt_map[args[0].lower()]
        only = args[1]
    elif len(args) == 1 and args[0].lower() in mt_map:
        mass_types = mt_map[args[0].lower()]
        only = None
    else:
        mass_types = ["tempora", "sancti", "commune"]
        only = None

    run(mass_types, only=only)
