"""
serve.py — local development server for the missale SPA.

Serves the repo root as a static site and exposes a local build API:

  GET  /health         → {"lualatex": bool}
  POST /generate/tex   → zip of .tex + .sty files
  POST /generate/pdf   → compiled PDF (requires lualatex)

POST body (JSON):
  { mass_type, path_name, document, layout, propers_json (base64-encoded ordo JSON) }

Usage:
    python missale/scripts/serve.py [port]    (default: 8080)
"""

import base64
import http.server
import io
import json
import shutil
import subprocess
import sys
import tempfile
import traceback
import zipfile
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
_REPO = _SCRIPTS.parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

sys.path.insert(0, str(_SCRIPTS))


def _has_lualatex() -> bool:
    """Return True if lualatex is available on PATH."""
    return shutil.which("lualatex") is not None


def _compile_pdf(tex_path: Path, outdir: Path) -> Path | None:
    """Run lualatex on tex_path (up to 5 passes for cross-refs); return PDF path or raise."""
    log = outdir / tex_path.with_suffix(".log").name
    r = None
    for _ in range(5):
        r = subprocess.run(
            [
                "lualatex",
                "--shell-escape",
                "--interaction=nonstopmode",
                "--output-directory",
                ".",
                tex_path.name,
            ],
            capture_output=True,
            cwd=outdir,
        )
        if log.exists() and "Rerun" not in log.read_text(errors="replace"):
            break
    pdf = outdir / tex_path.with_suffix(".pdf").name
    if pdf.exists():
        return pdf
    snippet = (
        log.read_text(errors="replace")[-3000:]
        if log.exists()
        else (r.stdout.decode(errors="replace") if r else "")
    )
    raise RuntimeError(f"LuaLaTeX failed:\n{snippet}")


_DOC_TEX = {
    "missalette": ["missalette.tex"],
    "pew": ["pew-sheet.tex"],
    "both": ["missalette.tex", "pew-sheet.tex"],
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(_REPO), **kwargs)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json({"lualatex": _has_lualatex()})
        else:
            super().do_GET()

    def do_POST(self):
        if self.path in ("/generate/tex", "/generate/pdf"):
            fmt = self.path.split("/")[-1]
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length))
            except Exception:
                return self._error(400, "Invalid JSON body")
            self._generate(body, fmt)
        else:
            self.send_error(404)

    def _generate(self, body: dict, fmt: str):
        import generate as gen

        path_name = body.get("path_name", "mass")
        doc = body.get("document", "missalette")
        layout = body.get("layout", "regular")
        b64 = body.get("propers_json", "")

        try:
            data = json.loads(base64.b64decode(b64))
        except Exception as e:
            return self._error(400, f"Bad propers_json: {e}")

        tex_names = _DOC_TEX.get(doc, ["missalette.tex"])

        with tempfile.TemporaryDirectory() as tmp:
            outdir = Path(tmp)
            try:
                gen.generate_from_data(data, outdir)
            except Exception as e:
                traceback.print_exc()
                return self._error(500, f"TeX generation failed: {e}")

            if fmt == "tex":
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w") as zf:
                    for name in tex_names:
                        p = outdir / name
                        if p.exists():
                            zf.write(p, name)
                    for sty in outdir.glob("*.sty"):
                        zf.write(sty, sty.name)
                return self._send(
                    buf.getvalue(), "application/zip", f"{path_name}-tex.zip"
                )

            # fmt == "pdf"
            if not _has_lualatex():
                return self._error(501, "lualatex not found on this machine")

            try:
                regular_pdfs = [
                    _compile_pdf(outdir / n, outdir)
                    for n in tex_names
                    if (outdir / n).exists()
                ]
            except RuntimeError as e:
                return self._error(500, str(e))

            if not regular_pdfs:
                return self._error(500, "No PDFs produced")

            want_regular = layout in ("regular", "both")
            want_booklet = layout in ("booklet", "both")

            booklet_pdfs = []
            if want_booklet:
                if not gen._has_pdfjam():
                    return self._error(501, "pdfjam not found — install TeX Live for booklet layout")
                try:
                    booklet_pdfs = [gen._apply_pdfjam(p, outdir) for p in regular_pdfs]
                except RuntimeError as e:
                    return self._error(500, str(e))

            out_pdfs = []
            if want_regular:
                out_pdfs.extend(regular_pdfs)
            if want_booklet:
                out_pdfs.extend(booklet_pdfs)

            if len(out_pdfs) == 1:
                return self._send(
                    out_pdfs[0].read_bytes(), "application/pdf", f"{path_name}.pdf"
                )

            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as zf:
                for pdf in out_pdfs:
                    zf.write(pdf, pdf.name)
            return self._send(buf.getvalue(), "application/zip", f"{path_name}.zip")

    # ── helpers ───────────────────────────────────────────────────────────────

    def _json(self, data: dict):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send(self, data: bytes, mime: str, filename: str):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", len(data))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _error(self, code: int, msg: str):
        body = json.dumps({"error": msg}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, fmt, *args):
        print(f"  {fmt % args}")


if __name__ == "__main__":
    has_ll = _has_lualatex()
    print(
        f"LuaLaTeX : {'✓ found' if has_ll else '✗ not found — PDF endpoint will return 501'}"
    )
    print(f"Serving  : http://localhost:{PORT}")
    with http.server.HTTPServer(("", PORT), Handler) as httpd:
        httpd.serve_forever()
