"""
Generate missalette.tex and pew-sheet.tex from a propers.json (ordo blocks format).

Usage:
    python generate.py tempora Adv1-0
    python generate.py sancti 12-25 --lang en --pdf
    python generate.py commune C5 --lang en --pdf --booklet --missalette
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, Undefined

_SCRIPTS = Path(__file__).resolve().parent
_TEMPLATES = _SCRIPTS.parent / "templates"
_OUT_ROOT = _SCRIPTS.parent / "output"

_BABEL_MAP: dict[str, str] = {
    "en": "british",
    "la": "latin",
    "fr": "french",
    "de": "ngerman",
    "es": "spanish",
    "it": "italian",
    "pl": "polish",
}

_DOC_TEMPLATES: dict[str, tuple[str, str]] = {
    "missalette": ("missalette.tex.jinja", "missalette.tex"),
    "pew": ("pew-sheet.tex.jinja", "pew-sheet.tex"),
}


def _git_version() -> str:
    try:
        return subprocess.check_output(
            ["git", "describe", "--tags", "--always"],
            cwd=_SCRIPTS,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return ""


def _build_version(data: dict) -> str:
    """Combine pipeline git version with data fetch dates for the TeX footer."""
    ver = data.get("pipeline_version") or _git_version()
    lu = data.get("data_updated") or {}
    parts = [ver] if ver else []
    if lu.get("do"):
        parts.append("DO " + lu["do"][:10])
    if lu.get("gregobase"):
        parts.append("GB " + lu["gregobase"][:10])
    return "  ·  ".join(parts)


def _has_lualatex() -> bool:
    return shutil.which("lualatex") is not None


def _has_pdfjam() -> bool:
    return shutil.which("pdfjam") is not None


def _compile_pdf(tex: Path, workdir: Path) -> Path:
    for _ in range(3):
        r = subprocess.run(
            [
                "lualatex",
                "--interaction=nonstopmode",
                "--output-directory",
                str(workdir),
                str(tex),
            ],
            cwd=workdir,
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            tail = r.stdout[-2000:] if len(r.stdout) > 2000 else r.stdout
            print(tail, file=sys.stderr)
            raise RuntimeError(f"lualatex failed: {tex.name}")
    return tex.with_suffix(".pdf")


def _apply_pdfjam(pdf: Path, workdir: Path) -> Path:
    """Impose pdf as a 2-up landscape booklet using pdfjam (part of TeX Live)."""
    out = pdf.with_name(pdf.stem + "-booklet.pdf")
    r = subprocess.run(
        ["pdfjam", "--landscape", "--suffix", "booklet", "--booklet", "true", str(pdf)],
        cwd=workdir,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        tail = r.stderr[-1000:] if len(r.stderr) > 1000 else r.stderr
        print(tail, file=sys.stderr)
        raise RuntimeError(f"pdfjam failed: {pdf.name}")
    # Add duplex/tumble hint so printers flip on the short edge (non-fatal if gs absent)
    if shutil.which("gs"):
        tmp = out.with_name(out.stem + "-d.pdf")
        subprocess.run(
            ["gs", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite",
             "-dDuplex=true", "-dTumble=true",
             f"-sOutputFile={tmp}", str(out)],
            cwd=workdir, capture_output=True,
        )
        if tmp.exists():
            tmp.replace(out)
    return out


def _segment_ordo(ordo: list, target: str) -> list:
    """
    Segment a flat ordo list by title items into blocks, filtered to target.

    Returns [{title?: str, items: [Item, ...]}]. Rubric text is pre-resolved
    in the export format so no key/translation lookup is needed here.
    Segments with no non-title items after filtering are omitted.
    """
    result = []
    current_title: str | None = None
    items: list = []

    def flush():
        if items:
            block = {"items": items[:]}
            if current_title is not None:
                block["title"] = current_title
            result.append(block)
        items.clear()

    for item in ordo:
        if item.get("type") == "title":
            flush()
            current_title = item.get("text", "")
            continue
        if target not in (item.get("targets") or []):
            continue
        if item.get("type") == "rubric":
            text = item.get("text", "")
            if not text:
                continue
            items.append(item)
        else:
            items.append(item)

    flush()
    return result


def generate_from_data(data: dict, target: Path, lang: str | None = None) -> Path:
    """Render TeX templates from an already-loaded propers data dict."""
    target.mkdir(parents=True, exist_ok=True)

    ordo = data.get("ordo", [])
    feast = data.get("feast", "")
    subtitle = data.get("subtitle", "Missa Cantata")

    lang_babel = _BABEL_MAP.get(lang or "", data.get("lang_babel", ""))

    if lang:
        for item in ordo:
            if "availableTranslations" in item:
                item["translation"] = item["availableTranslations"].get(lang, "")

    ctx = {
        "feast": feast,
        "subtitle": subtitle,
        "lang_babel": lang_babel,
        "version": _build_version(data),
        "blocks": _segment_ordo(ordo, "missalette"),
        "sheet_blocks": _segment_ordo(ordo, "pewsheet"),
    }

    env = Environment(
        loader=FileSystemLoader(str(_TEMPLATES)),
        variable_start_string="[[",
        variable_end_string="]]",
        block_start_string="[%",
        block_end_string="%]",
        comment_start_string="[#",
        comment_end_string="#]",
        keep_trailing_newline=True,
        autoescape=False,
        undefined=Undefined,
    )

    for tmpl_name, out_name in _DOC_TEMPLATES.values():
        tmpl = env.get_template(tmpl_name)
        (target / out_name).write_text(tmpl.render(**ctx), encoding="utf-8")

    for sty in ("rubrics.sty", "styling.sty", "titlepage.sty"):
        shutil.copy2(_TEMPLATES / sty, target / sty)

    return target


def generate(
    mass_type: str,
    path_name: str,
    target: Path | None = None,
    lang: str | None = None,
    docs: list[str] | None = None,
    fmt: str = "tex",
) -> Path:
    json_path = _OUT_ROOT / mass_type.lower() / path_name / "propers.json"
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)
    out = target or json_path.parent
    generate_from_data(data, out, lang=lang)

    selected_docs = docs if docs is not None else list(_DOC_TEMPLATES)

    if fmt in ("pdf", "booklet"):
        if not _has_lualatex():
            print(
                "lualatex not found — install TeX Live to generate PDFs",
                file=sys.stderr,
            )
            return out
        pdfs: list[Path] = []
        for doc in selected_docs:
            _, tex_name = _DOC_TEMPLATES[doc]
            tex = out / tex_name
            if tex.exists():
                pdf = _compile_pdf(tex, out)
                pdfs.append(pdf)
                print(f"PDF: {pdf}")

        if fmt == "booklet":
            if not _has_pdfjam():
                print(
                    "pdfjam not found — install TeX Live to generate booklets",
                    file=sys.stderr,
                )
            else:
                for pdf in pdfs:
                    book = _apply_pdfjam(pdf, out)
                    print(f"Booklet: {book}")
    else:
        for doc in selected_docs:
            _, tex_name = _DOC_TEMPLATES[doc]
            print(f"Written: {out / tex_name}")

    return out


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Generate TeX/PDF from propers JSON")
    ap.add_argument("mass_type", help="tempora | sancti | commune")
    ap.add_argument("path_name", help="e.g. Adv1-0, 12-25, C5")
    ap.add_argument(
        "--target",
        type=Path,
        default=None,
        help="Output directory (default: output/<mass_type>/<path_name>/)",
    )
    ap.add_argument(
        "--lang",
        default=None,
        help="Translation language code for vernacular column (e.g. en, fr, de)",
    )

    fmt_group = ap.add_mutually_exclusive_group()
    fmt_group.add_argument(
        "--pdf", action="store_true", help="Compile TeX to PDF via lualatex"
    )
    fmt_group.add_argument(
        "--booklet",
        action="store_true",
        help="Compile PDF and apply pdfjam for booklet imposition",
    )

    doc_group = ap.add_mutually_exclusive_group()
    doc_group.add_argument(
        "--missalette",
        action="store_true",
        help="Generate missalette only (default: both)",
    )
    doc_group.add_argument(
        "--pew", action="store_true", help="Generate pew sheet only (default: both)"
    )

    args = ap.parse_args()

    fmt = "booklet" if args.booklet else ("pdf" if args.pdf else "tex")
    docs = ["missalette"] if args.missalette else (["pew"] if args.pew else None)

    generate(args.mass_type, args.path_name, args.target, args.lang, docs, fmt)
