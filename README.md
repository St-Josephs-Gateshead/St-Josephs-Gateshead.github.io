# St Joseph's Gateshead — Missale

GitHub Pages site for St Joseph's Gateshead. The main feature is a single-page
application for preparing Traditional Latin Mass booklets (missalettes and pew
sheets), backed by a Python data pipeline.

---

## What it does

### SPA (`index.html`)

- Load a mass by date to populate propers automatically.
- Add, remove, and reorder items (texts, chants, rubrics, titles) with drag-and-drop and undo/redo.
- Select a vernacular language to display translations alongside the Latin.
- Choose mass settings for the Ordinary (Kyrie, Gloria, Sanctus, Agnus Dei, Credo).
- Export the finished ordo as a PDF booklet via the **build-booklet** CI workflow,
  via a local lualatex installation using `serve.py`, or print the page.

### Data pipeline (`missale/scripts/`)

Fetches liturgical texts from [Divinum Officium](https://github.com/DivinumOfficium/divinum-officium)
and chant notation from [GregoBase](https://github.com/gregorio-project/GregoBase),
matches them, and writes pre-built JSON files that the SPA loads at runtime.

---

## Repository structure

```
index.html                    SPA
releases.html                 Booklet release notes
Dockerfile                    TeXLive + Gregorio image (used by build-booklet CI)

missale/
  scripts/
    refresh.py                Full clean + rebuild (entry point for CI)
    update.py                 Fetch GregoBase SQL dump and DO git repo
    index.py                  Generate tempora.csv / sancti.csv / commune.csv
    batch.py                  Generate propers JSON for all masses
    propers.py                Build propers + ordinary JSON; core data logic
    ordo.py                   Assemble flat ordo item list from propers data
    generate.py               Render TeX from export-format ordo JSON
    chants.py                 In-memory GregoBase index; chant matching + search
    serve.py                  Local dev server with /generate/tex and /generate/pdf
    _utils.py                 Shared utilities (_norm_lyrics)
    _fix_improperia.py        Post-processor for Good Friday propers

  templates/
    missalette.tex.jinja      Missalette TeX template
    pew-sheet.tex.jinja       Pew sheet TeX template
    rubrics.sty               Rubric formatting
    styling.sty               Page layout and typography
    titlepage.sty             Title page layout
    rubric_strings.json       Keyed rubric text in all languages

  data/                       Generated / fetched — mostly git-ignored
    tempora.csv               Temporale mass index (committed)
    sancti.csv                Sanctorale mass index (committed)
    commune.csv               Commune mass index (committed)
    ordinary.json             All ordinary chants and responses (committed)
    last_updated.json         Timestamps of last GregoBase + DO fetch (committed)
    propers/                  Per-mass ordo JSON (committed, ~800 files)
    gregobase_chants.json     Parsed GregoBase dump (git-ignored, ~60 MB)
    divinum-officium/         Sparse DO clone (git-ignored)

  ToniCommunes/               Submodule — GABC for liturgical tones
  MarianAntiphons/            Submodule — GABC for Marian antiphons

.github/workflows/
  generate-propers.yml        Manual regeneration of data (workflow_dispatch)
  build-booklet.yml           Manual PDF build (workflow_dispatch)
  build-docker.yml            Build and push the TeXLive+Gregorio image
```

---

## Getting started

### Prerequisites

- Python 3.11+
- `pip install jinja2` (for TeX generation)
- lualatex + Gregorio (optional — for local PDF builds; see `Dockerfile`)

### Run the dev server

```sh
python missale/scripts/serve.py
# Serves at http://localhost:8080
```

The SPA at `/` loads propers from committed `data/propers/` and `data/ordinary.json`.
The `/generate/tex` endpoint produces a `.zip` of TeX + style files;
`/generate/pdf` compiles it to PDF if lualatex is on PATH.

If lualatex and Gregorio are installed locally (see `Dockerfile` for the full
package list), the `/generate/pdf` endpoint compiles and downloads the booklet
directly — no git push or CI workflow required. This is the fastest path for
iterating on a single mass.

### Rebuild all data

Requires internet access (~60 MB GregoBase download, DO git clone).

```sh
python missale/scripts/refresh.py
```

This cleans and fully regenerates everything in `missale/data/`.
To regenerate propers only (source data already fetched):

```sh
python missale/scripts/batch.py
```

To update the ordinary chant library:

```python
from propers import write_ordinary_json
write_ordinary_json()
```

### Generate TeX for one mass

```sh
# Place export-format propers.json at:
#   missale/output/tempora/Adv1-0/propers.json
python missale/scripts/generate.py tempora Adv1-0
# Writes missalette.tex + pew-sheet.tex alongside
```

---

## CI/CD

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| `generate-propers` | Manual (`workflow_dispatch`) | Runs `refresh.py`, commits generated data |
| `build-booklet` | Manual (`workflow_dispatch`) | Builds PDF booklet from SPA export JSON |
| `build-docker` | Manual | Builds and pushes `texlive-gregorio` Docker image |

The `build-booklet` workflow runs in `ghcr.io/st-josephs-gateshead/texlive-gregorio`
and uploads the resulting PDF as a GitHub Actions artifact (1-day retention).

---

## Data sources

| Source | Used for | Licence |
|--------|----------|---------|
| [GregoBase](https://github.com/gregorio-project/GregoBase) | Solesmes GABC for all chanted propers and ordinaries | Public domain |
| [Divinum Officium](https://github.com/DivinumOfficium/divinum-officium) | Multi-language liturgical texts | GPL-3.0 |
| [ToniCommunes](missale/ToniCommunes/) | Liturgical tones (preface, Per Dominum, etc.) | — |
