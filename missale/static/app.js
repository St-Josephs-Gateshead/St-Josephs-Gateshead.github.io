/**
 * Main application logic for the missale webpage (index.html) — state,
 * rendering, event wiring, network fetches. Everything here is DOM-coupled;
 * the genuinely pure logic lives in missale/static/pure.js instead, where
 * it's covered by real tests.
 *
 * Loaded as a plain classic script (NOT type="module") — dozens of inline
 * onclick="..." attributes across the markup call functions here directly,
 * which requires them to be real globals. Must load after pure.js.
 *
 * Relocated verbatim from index.html's inline <script> block (verified
 * byte-for-byte identical before reformatting), then reformatted with
 * Prettier from the HTML-nesting indentation it inherited.
 */

"use strict";

// ── Exsurge ──────────────────────────────────────────────────────────────────

const exsurgeReady = typeof exsurge !== "undefined";

// ── UI chrome i18n ───────────────────────────────────────────────────────────
// Keyed the same way as rubricStrings: by the #langSelect option value, with
// "Latin" as both the literal fallback and the default when no language is
// chosen. See missale/templates/chrome_strings.json.

function _t(key) {
  const lang = document.getElementById("langSelect")?.value || "Latin";
  return chromeStrings?.[lang]?.[key] ?? chromeStrings?.["Latin"]?.[key] ?? key;
}

function _applyChromeLabels() {
  if (!chromeStrings) return;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = _t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = _t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = _t(el.dataset.i18nPlaceholder);
  });
  // The export button's label is stateful (idle/working/ready/…), not static
  // markup, so it re-renders itself for the current state rather than reading
  // a data-i18n attribute.
  if (typeof _setExportBtnState === "function") _setExportBtnState(_exportBtnState);
}

async function renderGabc(gabc, container, useDropCap = true, mode = null, width = null) {
  container.dataset.gabc = gabc || "";
  container.dataset.dropCap = useDropCap ? "1" : "0";
  container.dataset.mode = mode != null ? String(mode) : "";
  let notation = _gabcForExsurge(gabc || "");
  let modeStr = mode != null ? String(mode) : null;
  // Strip %% header if present (Exsurge doesn't support it); parse mode from it as fallback
  const sep = notation.indexOf("%%");
  if (sep !== -1) {
    if (!modeStr) {
      const modeMatch = notation.slice(0, sep).match(/\bmode\s*:\s*(\S+)/i);
      if (modeMatch) modeStr = modeMatch[1];
    }
    notation = notation.slice(sep + 2);
  }
  if (!exsurgeReady || !notation.trim()) {
    showFallback(notation || gabc, container);
    return;
  }
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        showFallback(notation, container);
        resolve();
      }
    }, 4000);
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
      resolve();
    };
    try {
      const ctxt = new exsurge.ChantContext();
      ctxt.lyricTextFont = "'Crimson Text', serif";
      ctxt.dropCapTextFont = ctxt.lyricTextFont;
      ctxt.lyricTextSize *= 1.15;
      const mappings = exsurge.Gabc.createMappingsFromSource(ctxt, cleanGabc(notation));
      const score = new exsurge.ChantScore(ctxt, mappings, useDropCap);
      const modeAnnotation = _modeAnnotation(modeStr);
      if (modeAnnotation && exsurge.Annotation)
        score.annotation = new exsurge.Annotation(ctxt, modeAnnotation);
      score.performLayoutAsync(ctxt, () => {
        try {
          const w =
            width != null ? width : Math.max((container.clientWidth || 0) - 8, 40);
          score.layoutChantLines(ctxt, w, () => {
            finish(() => {
              // Render full SVG into container first (live DOM = reliable getBBox)
              const fullSvgStr = score.createSvg(ctxt);
              container.innerHTML = fullSvgStr;
              const svgEl = container.querySelector("svg");
              const lines = score.lines;
              if (!svgEl || !lines || lines.length < 2) {
                // Single stave or no SVG — add viewBox and leave as-is
                if (svgEl && !svgEl.hasAttribute("viewBox")) {
                  const sw = parseFloat(svgEl.getAttribute("width"));
                  const sh = parseFloat(svgEl.getAttribute("height"));
                  if (sw && sh) svgEl.setAttribute("viewBox", `0 0 ${sw} ${sh}`);
                }
                return;
              }
              try {
                const lineGroups = Array.from(svgEl.querySelectorAll("g.chantLine"));
                if (lineGroups.length !== lines.length) return;
                const defsEl = svgEl.querySelector("defs");
                const defsHtml = defsEl ? defsEl.outerHTML : "";
                // Collect per-stave data (getBBox on live elements)
                // getBBox returns LOCAL coords (before the <g>'s own translate),
                // so add lines[i].bounds.y to get the correct absolute viewBox origin.
                const staves = lineGroups.map((g, i) => {
                  const bb = g.getBBox();
                  const ty = lines[i].bounds.y;
                  return { bb, ty, html: g.outerHTML };
                });
                // Replace container with per-stave SVGs
                container.innerHTML = "";
                for (const { bb, ty, html } of staves) {
                  const div = document.createElement("div");
                  div.className = "chant-stave";
                  div.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" xmlns:xlink="http://www.w3.org/1999/xlink" class="ChantScore" width="${w}" height="${bb.height}" viewBox="0 ${ty + bb.y} ${w} ${bb.height}">${defsHtml}${html}</svg>`;
                  container.appendChild(div);
                }
              } catch (_) {
                // Leave full SVG in place
              }
            });
          });
        } catch (e) {
          finish(() => showFallback(gabc, container));
        }
      });
    } catch (e) {
      finish(() => showFallback(gabc, container));
    }
  });
}

function showFallback(gabc, container) {
  const text = cleanGabc(gabc || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  container.innerHTML = '<div class="gabc-fallback">' + esc(text) + "</div>";
}

// ── Utility ──────────────────────────────────────────────────────────────────

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.text();
}
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.json();
}

// ── State ─────────────────────────────────────────────────────────────────────

let _renderReady = Promise.resolve();
let allMasses = {};
let ordinary = null;
let rubricStrings = null;
let chromeStrings = null;
let propers = { feast: "", subtitle: "", ordo: [] };
let currentMt = "tempora";
let currentPn = null;
let _marianChoice = null;
let _aspergesChoice = null;
const _undo = [];
const _redo = [];

const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
if (IS_LOCAL) {
  document.getElementById("epLocal").hidden = false;
  fetch("/health")
    .then((r) => r.json())
    .then((d) => {
      if (d.lualatex) document.getElementById("epLocalPdfBtn").disabled = false;
    })
    .catch(() => {});
}

const BASE = "missale/";

// ── Chant index (lazy-loaded from chant_index.json on first search) ──
let _chantIndex = null;
async function _loadChantIndex() {
  if (_chantIndex !== null) return _chantIndex;
  _chantIndex = [];
  try {
    const r = await fetch(BASE + "data/chant_index.json");
    _chantIndex = await r.json();
  } catch (_) {}
  return _chantIndex;
}
async function _fetchGabc(chantId) {
  try {
    const r = await fetch(`${BOOKLET_WORKER_URL}/gabc/${chantId}`);
    if (!r.ok) return null;
    const data = await r.json();
    return data.gabc || null;
  } catch (_) {
    return null;
  }
}
function _parseChantQuery(val) {
  val = val.trim();
  const urlId = val.match(/[?&]id=(\d+)/);
  if (urlId) return { type: "id", id: parseInt(urlId[1]) };
  if (/^\d+$/.test(val)) return { type: "id", id: parseInt(val) };
  if (val.length >= 2) return { type: "text", q: val.toLowerCase() };
  return null;
}

// ── Boot data ─────────────────────────────────────────────────────────────────

function _findMass(pn) {
  for (const [mt, list] of Object.entries(allMasses)) {
    if (list.find((m) => m.path_name === pn)) return mt;
  }
  return null;
}

function _slugNormalize(s) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .toLowerCase();
}

function _findMassBySlug(slug) {
  const target = _slugNormalize(slug.replace(/-/g, " "));
  for (const [mt, list] of Object.entries(allMasses)) {
    const m = list.find((e) => _slugNormalize(e.name) === target);
    if (m) return { mt, pn: m.path_name };
  }
  return null;
}

async function _checkGitRelease(slug, doctype) {
  const suffix =
    doctype === "missalette-booklet" ? "missalette-booklet" : "missalette-a4";
  const assetName = slug + "_" + suffix + ".pdf";
  try {
    const resp = await fetch(
      "https://api.github.com/repos/St-Josephs-Gateshead/Masses/releases/latest",
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const asset = (data.assets || []).find((a) => a.name === assetName);
    return asset ? asset.browser_download_url : null;
  } catch {
    return null;
  }
}

function _syncUrl() {
  const p = new URLSearchParams();
  if (currentPn) p.set("pn", currentPn);
  const lang = document.getElementById("langSelect").value;
  const ord = document.getElementById("ordinarySelect").value;
  const creed = document.getElementById("creedSelect").value;
  if (lang) p.set("lang", lang);
  if (ord) p.set("ord", ord);
  if (creed) p.set("creed", creed);
  const qs = p.toString();
  history.replaceState(null, "", qs ? "?" + qs : location.pathname);
}

async function loadIndex() {
  const [t, s, c, ord, rs, cs] = await Promise.all([
    fetchText(BASE + "data/tempora.csv"),
    fetchText(BASE + "data/sancti.csv"),
    fetchText(BASE + "data/commune.csv").catch(() => ""),
    fetchJSON(BASE + "data/ordinary.json"),
    fetchJSON(BASE + "templates/rubric_strings.json").catch(() => null),
    fetchJSON(BASE + "templates/chrome_strings.json").catch(() => null),
  ]);
  allMasses = { tempora: parseCSV(t), sancti: parseCSV(s), commune: parseCSV(c) };
  ordinary = ord;
  rubricStrings = rs;
  chromeStrings = cs;
  _applyChromeLabels();

  // QR hash routing — #FeastName-hyphenated or #FeastName-hyphenated_missalette(-booklet)?
  const rawHash = location.hash.slice(1);
  if (rawHash) {
    const slug = rawHash.replace(/_missalette(-booklet)?$/, "");
    const doctype = rawHash.includes("_missalette-booklet")
      ? "missalette-booklet"
      : "missalette";
    const found = _findMassBySlug(slug);

    if (found) {
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.toggle("active", b.dataset.type === found.mt));
      populateDropdown(found.mt);
      document.getElementById("massSelect").value = found.pn;
    } else {
      const banner = document.getElementById("hashError");
      banner.textContent = "“" + slug.replace(/-/g, " ") + "” — not in current database.";
      banner.hidden = false;
      populateDropdown("tempora");
    }

    const [, downloadUrl] = await Promise.all([
      found ? loadMass(found.mt, found.pn) : Promise.resolve(),
      _checkGitRelease(slug, doctype),
    ]);

    if (downloadUrl) {
      const label = slug.replace(/-/g, " ");
      const typeLabel =
        doctype === "missalette-booklet" ? "missalette (booklet)" : "missalette";
      if (confirm("Download " + typeLabel + " of " + label + "?")) open(downloadUrl);
    }
    return;
  }

  const params = new URLSearchParams(location.search);
  const pn = params.get("pn");
  const lang = params.get("lang");
  const ord_ = params.get("ord");
  const creed = params.get("creed");

  // Restore selects (clear invalid values)
  const _restore = (id, val) => {
    if (!val) return;
    const el = document.getElementById(id);
    el.value = val;
    if (el.value !== val) el.value = ""; // option didn't exist — leave blank
  };
  _restore("langSelect", lang);
  _restore("ordinarySelect", ord_);
  _restore("creedSelect", creed);

  // Restore mass — detect tab from the mass list, not a URL param
  const mt = pn ? _findMass(pn) : null;
  if (pn && mt) {
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.type === mt));
    populateDropdown(mt);
    document.getElementById("massSelect").value = pn;
    await loadMass(mt, pn);
  } else {
    if (pn) _syncUrl(); // pn was invalid — clear it from URL
    populateDropdown("tempora");
    _updateControlStates();
    await renderMass();
  }
}

// ── Mass dropdown ─────────────────────────────────────────────────────────────

function populateDropdown(mt) {
  currentMt = mt;
  document.getElementById("typeSelect").value = mt;
  const sel = document.getElementById("massSelect");
  sel.innerHTML =
    mt === "commune"
      ? '<option value="">&#8212; Commune &#8212;</option>'
      : '<option value="">&#8212; Proprium &#8212;</option>';
  let list = (allMasses[mt] || []).slice();
  if (mt === "tempora")
    list.sort((a, b) => temporaSort(a.path_name) - temporaSort(b.path_name));

  // Circular rotation: today's Mass at top, yesterday's at bottom
  let todayPn = null;
  let todayMoveablePn = null;
  if (mt === "sancti") {
    const n = new Date();
    todayPn =
      String(n.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(n.getDate()).padStart(2, "0");
    // Check moveable sancti feasts (MM-DU = last Sunday of month)
    const midnight = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    for (const m of list) {
      if (/^\d{2}-DU$/.test(m.path_name)) {
        const d = _massDate("sancti", m.path_name);
        if (d && d.getTime() === midnight.getTime()) {
          todayMoveablePn = m.path_name;
          break;
        }
      }
    }
  } else if (mt === "tempora") {
    todayPn = _todayTempora();
  }
  if (todayPn || todayMoveablePn) {
    // Find index of today's entry for circular rotation.
    // For sancti: star all entries whose MM-DD prefix matches today.
    // For tempora: use startsWith so multi-Mass days (Quad6-4m2 etc.) are found.
    let idx = list.findIndex(
      (m) =>
        (todayPn && m.path_name.startsWith(todayPn)) ||
        (todayMoveablePn && m.path_name === todayMoveablePn),
    );
    if (idx < 0 && mt === "tempora") {
      // No Mass for today's exact weekday — fall back to the
      // nearest upcoming entry (a weekday feast/feria if one falls
      // before the next Sunday, otherwise that Sunday), not one
      // already past.
      const today0 = new Date();
      today0.setHours(0, 0, 0, 0);
      let bestDate = null;
      list.forEach((m, i) => {
        const d = _temporaDate(m.path_name);
        if (
          d &&
          d.getTime() >= today0.getTime() &&
          (!bestDate || d.getTime() < bestDate.getTime())
        ) {
          bestDate = d;
          idx = i;
        }
      });
    }
    if (idx < 0 && mt === "sancti") {
      // No feast today — rotate to the first entry on or after today
      // so the list still opens near the current date.
      idx = list.findIndex((m) => m.path_name.slice(0, 5) >= todayPn);
    }
    if (idx > 0) list = [...list.slice(idx), ...list.slice(0, idx)];
  }

  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.path_name;
    // Star all entries on the same calendar date. For sancti, compare
    // the MM-DD prefix (ignoring variant suffixes), plus the moveable
    // 10-DU feast. For tempora, use startsWith like the rotation match
    // above, since path prefixes vary in length (Pent02-5, Quad6-4m1).
    const isToday =
      mt === "sancti"
        ? (todayPn && m.path_name.slice(0, 5) === todayPn) ||
          (todayMoveablePn && m.path_name === todayMoveablePn)
        : todayPn && m.path_name.startsWith(todayPn);
    const label =
      mt === "sancti" && /^\d{2}-\d{2}/.test(m.path_name)
        ? m.path_name.slice(0, 5) + (m.name ? " — " + m.name : "")
        : mt === "sancti" && /^\d{2}-DU$/.test(m.path_name)
          ? m.path_name.slice(0, 2) + "-?? — " + (m.name || m.path_name)
          : m.name || m.path_name;
    opt.textContent = (isToday ? "★ " : "") + label;
    sel.appendChild(opt);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function _updateControlStates() {
  const hasMass = !!currentPn;
  document.getElementById("ordinarySelect").disabled = !hasMass;
  document.getElementById("creedSelect").disabled = !hasMass;
}

function getSettings() {
  return {
    lang: document.getElementById("langSelect").value,
    ordNum: parseInt(document.getElementById("ordinarySelect").value) || 0,
    credNum: parseInt(document.getElementById("creedSelect").value) || 0,
  };
}

async function renderMass() {
  if (!propers || !ordinary) return;
  const { lang, ordNum, credNum } = getSettings();
  const rule = propers.rule || [];
  const hasGloria = rule.includes("Gloria");
  const hasCredo = rule.includes("Credo");
  const main = document.getElementById("main");
  main.classList.toggle("has-lang", !!lang);

  const ruleBadges = document.getElementById("ruleBadges");
  if (ruleBadges) {
    ruleBadges.innerHTML = ["Gloria", "Credo"]
      .map((r) => {
        const has = rule.includes(r);
        return `<span class="rule-badge ${has ? "yes" : "no"}">${has ? "&#10003;" : "&#10007;"} ${r}</span>`;
      })
      .join("");
  }

  const frag = document.createDocumentFragment();
  const queue = [];

  // Print-only title block
  const feast = document.getElementById("epFeast")?.value.trim() || propers.feast || "";
  const subtitle =
    document.getElementById("epSubtitle")?.value.trim() ||
    propers.subtitle ||
    "Missa Cantata";
  if (feast) {
    const titleBlock = document.createElement("div");
    titleBlock.className = "print-only";
    const feastEl = document.createElement("div");
    feastEl.className = "print-feast";
    feastEl.textContent = feast;
    titleBlock.appendChild(feastEl);
    const subEl = document.createElement("div");
    subEl.className = "print-subtitle";
    subEl.textContent = subtitle;
    titleBlock.appendChild(subEl);
    frag.appendChild(titleBlock);
  }

  // Flat list — all objects shown on screen; targets only affect PDF export
  const ordo = propers.ordo || [];
  for (let i = 0; i < ordo.length; i++) {
    frag.appendChild(
      mkObjectWrap(ordo[i], ordo, lang, ordNum, credNum, hasGloria, hasCredo, queue),
    );
  }
  frag.appendChild(mkObjZone(ordo, null)); // single add-zone at bottom

  main.innerHTML = "";
  main.appendChild(frag);

  _renderReady = (async () => {
    for (const { gabc, el, useDropCap, mode } of queue) {
      el.innerHTML = '<span style="color:#ccc;font-size:.8em">…</span>';
      await renderGabc(gabc, el, useDropCap, mode ?? null);
    }
  })();
  await _renderReady;
}

function mkVariantChant(variants, queue, onSelect, initialIdx = 0) {
  const wrap = document.createElement("div");
  wrap.className = "chant-card";

  const strip = document.createElement("div");
  strip.className = "variant-strip no-print";

  const editWrap = document.createElement("div");
  editWrap.className = "gabc-edit-wrap";
  const gabcEl = document.createElement("div");
  gabcEl.className = "chant-gabc";
  editWrap.appendChild(gabcEl);

  const safeIdx = initialIdx >= 0 && initialIdx < variants.length ? initialIdx : 0;
  queue.push({
    gabc: variants[safeIdx].gabc,
    el: gabcEl,
    mode: variants[safeIdx].mode ?? null,
  });

  variants.forEach((v, i) => {
    const btn = document.createElement("button");
    btn.className = "variant-btn" + (i === safeIdx ? " active" : "");
    btn.textContent = v.label || String(i + 1);
    btn.addEventListener("click", async () => {
      strip.querySelectorAll(".variant-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      gabcEl.innerHTML = '<span style="color:#ccc;font-size:.8em">…</span>';
      await renderGabc(v.gabc, gabcEl, true, v.mode ?? null);
      onSelect?.(i);
    });
    strip.appendChild(btn);
  });

  wrap.appendChild(strip);
  wrap.appendChild(editWrap);
  return wrap;
}

function mkChant(gabcSrc, trans, queue, useDropCap = true, mode = null, item = null) {
  const card = document.createElement("div");
  card.className = "chant-card";

  const editWrap = document.createElement("div");
  editWrap.className = "gabc-edit-wrap";

  const gabcEl = document.createElement("div");
  gabcEl.className = "chant-gabc";
  editWrap.appendChild(gabcEl);

  let liveGabc = gabcSrc;
  let liveMode = mode;
  queue.push({ gabc: liveGabc, el: gabcEl, useDropCap, mode: liveMode });

  const editBtn = document.createElement("button");
  editBtn.className = "gabc-edit-btn no-print";
  editBtn.textContent = "Edit GABC";
  let textarea = null;
  let modeSelEdit = null;
  editBtn.addEventListener("click", () => {
    if (textarea) {
      textarea.remove();
      modeSelEdit.remove();
      textarea = null;
      modeSelEdit = null;
      editBtn.textContent = "Edit GABC";
      return;
    }
    modeSelEdit = document.createElement("div");
    modeSelEdit.className = "gabc-mode-row no-print";
    const modeLabel = document.createElement("span");
    modeLabel.className = "gabc-mode-lbl";
    modeLabel.textContent = "Mode";
    const modeInput = document.createElement("input");
    modeInput.type = "text";
    modeInput.className = "gabc-mode-sel";
    modeInput.placeholder = "e.g. 7, 1g";
    modeInput.value = liveMode || "";
    modeInput.addEventListener("input", async () => {
      liveMode = modeInput.value.trim() || null;
      gabcEl.innerHTML = "";
      await renderGabc(liveGabc, gabcEl, useDropCap, liveMode);
    });
    modeSelEdit.appendChild(modeLabel);
    modeSelEdit.appendChild(modeInput);
    editWrap.appendChild(modeSelEdit);
    textarea = document.createElement("textarea");
    textarea.className = "gabc-editor no-print";
    textarea.value = liveGabc;
    let debounce;
    textarea.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        liveGabc = textarea.value;
        gabcEl.innerHTML = "";
        await renderGabc(liveGabc, gabcEl, useDropCap, liveMode);
      }, 600);
    });
    editWrap.appendChild(textarea);
    editBtn.textContent = "Close";
    textarea.focus();
  });
  editBtn.style.display = "none"; // exposed via card._triggerEdit; hidden in chant card itself
  editWrap.appendChild(editBtn);
  card._triggerEdit = () => editBtn.click();
  card.appendChild(editWrap);

  const t = document.createElement("div");
  t.className = "chant-trans";
  t.contentEditable = "true";
  t.textContent = trans || "";
  if (trans) t.classList.add("has-content");
  t.addEventListener("input", () => {
    t.classList.toggle("has-content", !!t.textContent.trim());
    if (item) item.translation = t.textContent;
  });
  if (item) item._trEl = t;
  card.appendChild(t);
  card._getLiveGabc = () => liveGabc;
  card._getLiveMode = () => liveMode;
  return card;
}

// ── Floating format toolbar (bold / italic for .text-la blocks) ──────
const _fmtBar = document.createElement("div");
_fmtBar.id = "fmt-bar";
_fmtBar.innerHTML =
  '<button onmousedown="event.preventDefault();document.execCommand(\'bold\')" data-i18n-title="bold_title" title="Pinguis [Ctrl+B]"><b>B</b></button>' +
  '<button onmousedown="event.preventDefault();document.execCommand(\'italic\')" data-i18n-title="italic_title" title="Cursivus [Ctrl+I]"><i>I</i></button>';
document.body.appendChild(_fmtBar);

document.addEventListener("selectionchange", () => {
  const active = document.activeElement;
  if (active && active.classList.contains("text-la")) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      _fmtBar.style.top = r.top + window.scrollY - 40 + "px";
      _fmtBar.style.left = r.left + window.scrollX + "px";
      _fmtBar.style.display = "flex";
      return;
    }
  }
  _fmtBar.style.display = "none";
});

function mkText(html, trans, item = null) {
  const block = document.createElement("div");
  block.className = "text-block";
  const cols = document.createElement("div");
  cols.className = "text-cols";
  const la = document.createElement("div");
  la.className = "text-la";
  la.contentEditable = "true";
  la.innerHTML = html;
  cols.appendChild(la);
  const tr = document.createElement("div");
  tr.className = "text-tr";
  tr.contentEditable = "true";
  tr.textContent = trans || "";
  if (item) {
    item._trEl = tr;
    tr.addEventListener("input", () => {
      item.translation = tr.textContent;
    });
  }
  cols.appendChild(tr);
  block.appendChild(cols);
  return block;
}

function mkObjControls(item, wrap, ordo) {
  const div = document.createElement("div");
  div.className = "obj-controls no-print";

  // Drag grip
  const grip = document.createElement("span");
  grip.className = "grip-btn";
  grip.title = "Drag to reorder";
  grip.textContent = "⠿";
  grip.addEventListener("mousedown", () => {
    wrap.draggable = true;
  });
  grip.addEventListener("mouseup", () => {
    wrap.draggable = false;
  });
  div.appendChild(grip);

  // Edit GABC — music items with concrete gabc or an ordinary slot (once resolved)
  if (item.type === "music" && (item.gabc || item.ordinary)) {
    const btn = document.createElement("button");
    btn.className = "ctrl-btn";
    btn.textContent = "✎";
    btn.title = "Edit GABC";
    btn.addEventListener("click", () => item._triggerEdit?.());
    div.appendChild(btn);
  }

  // + add object before this one
  const addBtn = document.createElement("button");
  addBtn.className = "ctrl-btn";
  addBtn.textContent = "+";
  addBtn.title = "Add object before this";
  addBtn.addEventListener("click", () => {
    if (wrap.previousSibling?.classList?.contains("add-form")) {
      wrap.previousSibling.remove();
      return;
    }
    const form = _mkItemForm(ordo, item);
    wrap.before(form);
  });
  div.appendChild(addBtn);

  // M / P target toggles
  ["missalette", "pewsheet"].forEach((t) => {
    const btn = document.createElement("button");
    btn.className = "ctrl-btn" + ((item.targets || []).includes(t) ? " active" : "");
    btn.textContent = t === "missalette" ? "M" : "P";
    btn.title = t === "missalette" ? "Missalette" : "Pew sheet";
    btn.addEventListener("click", () => {
      if (!Array.isArray(item.targets)) item.targets = [];
      const has = item.targets.includes(t);
      item.targets = has ? item.targets.filter((x) => x !== t) : [...item.targets, t];
      btn.classList.toggle("active", !has);
    });
    div.appendChild(btn);
  });

  div.appendChild(mkDeleteObjBtn(item, wrap, ordo));
  return div;
}

function mkObjectWrap(item, ordo, lang, ordNum, credNum, hasGloria, hasCredo, queue) {
  const wrap = document.createElement("div");
  wrap.className = "obj-wrap";
  const content = document.createElement("div");
  content.className = "obj-content";

  if (item.type === "title") {
    const el = document.createElement("div");
    el.className = "section-title";
    el.contentEditable = "true";
    el.textContent = item.text || "";
    el.addEventListener("input", () => {
      item.text = el.textContent.trim();
    });
    content.appendChild(el);
  } else if (item.type === "rubric") {
    const el = document.createElement("div");
    el.className = "prelude-rubric";
    el.contentEditable = "true";
    const resolvedRubric = item.key
      ? rubricStrings?.[lang || "Latin"]?.[item.key] || ""
      : "";
    el.textContent = item._dirty ? item.text || "" : resolvedRubric || item.text || "";
    el.addEventListener("input", () => {
      item._dirty = true;
      item.text = el.textContent;
    });
    item._el = el;
    content.appendChild(el);
  } else if (item.type === "text" && item.ordinary) {
    const respWrap = document.createElement("div");
    function _rerenderOrdResp() {
      respWrap.innerHTML = "";
      const choiceKey =
        item.ordinary === "asperges"
          ? _aspergesChoice || ""
          : item.ordinary === "antiphona-mariana"
            ? _marianChoice || ""
            : "";
      if (!choiceKey || !ordinary) return;
      const responses = (ordinary[item.ordinary + "-resp"] || {})[choiceKey] || [];
      const { lang: curLang } = getSettings();
      for (const resp of responses) {
        if (resp.type === "rubric") {
          const el = document.createElement("div");
          el.className = "prelude-rubric";
          el.textContent = resp.text || "";
          respWrap.appendChild(el);
        } else if (resp.type === "text") {
          const t = curLang ? (resp.availableTranslations || {})[curLang] || "" : "";
          respWrap.appendChild(mkText(resp.latin, t));
        }
      }
    }
    _rerenderOrdResp();
    item._rerender = _rerenderOrdResp;
    content.appendChild(respWrap);
  } else if (item.type === "text") {
    const trans = lang
      ? (item.availableTranslations || {})[lang] || item.translation || ""
      : item.translation || "";
    const textEl = mkText(_renderTex(item.tex || item.latin), trans, item);
    item._el = textEl.querySelector(".text-la");
    content.appendChild(textEl);
  } else if (item.type === "music") {
    if (item.gabc && !item.ordinary) {
      const trans = lang
        ? (item.availableTranslations || {})[lang] || item.translation || ""
        : item.translation || "";
      const chantCard = mkChant(
        item.gabc,
        trans || "",
        queue,
        true,
        item.mode ?? null,
        item,
      );
      item._getGabc = () => chantCard._getLiveGabc();
      item._getMode = () => chantCard._getLiveMode();
      item._triggerEdit = () => chantCard._triggerEdit();
      content.appendChild(chantCard);
    } else if (item.ordinary === "asperges") {
      if (ordinary) {
        const massDate = _massDate(currentMt, currentPn);
        const _aspSuggested = _suggestAsperges(massDate, currentMt);
        content.appendChild(
          mkOrdinaryBlock(
            "asperges",
            item,
            {
              initialChoice: _aspSuggested || "",
              suggest: (k) => k === _aspSuggested,
              onChange: (v) => {
                _aspergesChoice = v;
                for (const it of propers.ordo || [])
                  if (it.type === "text" && it.ordinary === "asperges") it._rerender?.();
              },
            },
            queue,
          ),
        );
      }
    } else if (item.ordinary === "antiphona-mariana") {
      const massDate = _massDate(currentMt, currentPn);
      const _marSuggested = _suggestMarian(massDate);
      content.appendChild(
        mkOrdinaryBlock(
          "antiphona-mariana",
          item,
          {
            initialChoice: _marSuggested || "",
            suggest: (k) => k === _marSuggested,
            onChange: (v) => {
              _marianChoice = v;
              for (const it of propers.ordo || [])
                if (it.type === "text" && it.ordinary === "antiphona-mariana")
                  it._rerender?.();
            },
            massDate,
          },
          queue,
        ),
      );
    } else if (item.ordinary === "dismissal") {
      content.appendChild(
        mkOrdinaryBlock(
          "dismissal",
          item,
          {
            initialChoice: item._ordChoice || (ordNum ? String(ordNum) : ""),
            getInitialVariantIdx: (variants) => {
              const idx = variants.findIndex((v) => v.gloria === hasGloria);
              return idx >= 0 ? idx : 0;
            },
          },
          queue,
        ),
      );
    } else if (item.ordinary === "gloria") {
      content.appendChild(
        mkOrdinaryBlock(
          "gloria",
          item,
          {
            initialChoice: item._ordChoice ?? (hasGloria && ordNum ? String(ordNum) : ""),
          },
          queue,
        ),
      );
    } else if (item.ordinary === "credo") {
      content.appendChild(
        mkOrdinaryBlock(
          "credo",
          item,
          {
            initialChoice:
              item._ordChoice ?? (hasCredo && credNum ? String(credNum) : ""),
          },
          queue,
        ),
      );
    } else if (item.ordinary) {
      content.appendChild(
        mkOrdinaryBlock(
          item.ordinary,
          item,
          {
            initialChoice: item._ordChoice ?? (ordNum ? String(ordNum) : ""),
          },
          queue,
        ),
      );
    }
  }

  wrap.appendChild(content);
  wrap.appendChild(mkObjControls(item, wrap, ordo));

  // Drag-to-reorder
  wrap._item = item;
  wrap.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", ""); // required by Firefox
    setTimeout(() => wrap.classList.add("dragging"), 0);
  });
  wrap.addEventListener("dragend", () => {
    wrap.draggable = false;
    wrap.classList.remove("dragging");
    document
      .querySelectorAll(".drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
  });
  wrap.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const dragging = document.querySelector(".obj-wrap.dragging");
    if (dragging && dragging !== wrap) wrap.classList.add("drag-over");
  });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("drag-over"));
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    wrap.classList.remove("drag-over");
    if (!ordo) return;
    const dragging = document.querySelector(".obj-wrap.dragging");
    if (!dragging || dragging === wrap) return;
    const dragItem = dragging._item;
    const dropItem = item;
    const srcIdx = ordo.indexOf(dragItem);
    const dstIdx = ordo.indexOf(dropItem);
    if (srcIdx < 0 || dstIdx < 0 || srcIdx === dstIdx) return;
    // Insert before or after drop target based on vertical position
    const rect = wrap.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    ordo.splice(srcIdx, 1);
    const adj = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
    const finalIdx = before ? adj : adj + 1;
    ordo.splice(finalIdx, 0, dragItem);
    if (before) wrap.before(dragging);
    else wrap.after(dragging);
    dragging.draggable = false;
    // Place el at targetIdx by finding the preceding item's DOM wrap
    const placeAt = (el, targetIdx) => {
      if (targetIdx === 0) {
        const first = [...document.querySelectorAll("#main > .obj-wrap")].find(
          (w) => w !== el,
        );
        if (first) first.before(el);
      } else {
        const prevEl = [...document.querySelectorAll("#main > .obj-wrap")].find(
          (w) => w._item === ordo[targetIdx - 1],
        );
        if (prevEl) prevEl.after(el);
      }
    };
    _pushUndo(
      () => {
        ordo.splice(ordo.indexOf(dragItem), 1);
        ordo.splice(srcIdx, 0, dragItem);
        placeAt(dragging, srcIdx);
      },
      () => {
        ordo.splice(ordo.indexOf(dragItem), 1);
        ordo.splice(finalIdx, 0, dragItem);
        placeAt(dragging, finalIdx);
      },
    );
  });

  return wrap;
}

function _pushUndo(undoFn, redoFn) {
  _undo.push({ undo: undoFn, redo: redoFn });
  _redo.length = 0;
  _updateUndoRedoBtns();
}

function mkDeleteObjBtn(item, wrap, ordo) {
  const btn = document.createElement("button");
  btn.className = "ctrl-btn delete no-print";
  btn.title = "Delete (Ctrl+Z to undo)";
  btn.textContent = "×";
  btn.addEventListener("click", () => {
    const idx = ordo ? ordo.indexOf(item) : -1;
    const prevWrap = wrap.previousSibling; // zone before wrap
    wrap.remove();
    if (idx >= 0) ordo.splice(idx, 1);
    _pushUndo(
      () => {
        // undo: re-insert item and wrap
        if (idx >= 0 && ordo) ordo.splice(idx, 0, item);
        if (prevWrap) prevWrap.after(wrap);
      },
      () => {
        // redo: remove again
        wrap.remove();
        if (idx >= 0 && ordo) ordo.splice(idx, 1);
      },
    );
  });
  return btn;
}

function mkNewObj(item, ordo) {
  const wrap = document.createElement("div");
  wrap.className = "obj-wrap";
  const content = document.createElement("div");
  content.className = "obj-content";

  if (item.type === "title") {
    const el = document.createElement("div");
    el.className = "section-title";
    el.contentEditable = "true";
    el.textContent = item.text || "";
    el.addEventListener("input", () => {
      item.text = el.textContent.trim();
    });
    content.appendChild(el);
  } else if (item.type === "rubric") {
    const el = document.createElement("div");
    el.className = "prelude-rubric";
    el.contentEditable = "true";
    el.textContent = item.text || "";
    item._el = el;
    content.appendChild(el);
  } else if (item.type === "text" && item.ordinary) {
    const respWrap = document.createElement("div");
    function _rerenderOrdRespNew() {
      respWrap.innerHTML = "";
      const choiceKey =
        item.ordinary === "asperges"
          ? _aspergesChoice || ""
          : item.ordinary === "antiphona-mariana"
            ? _marianChoice || ""
            : "";
      if (!choiceKey || !ordinary) return;
      const responses = (ordinary[item.ordinary + "-resp"] || {})[choiceKey] || [];
      const { lang: curLang } = getSettings();
      for (const resp of responses) {
        if (resp.type === "rubric") {
          const el = document.createElement("div");
          el.className = "prelude-rubric";
          el.textContent = resp.text || "";
          respWrap.appendChild(el);
        } else if (resp.type === "text") {
          const t = curLang ? (resp.availableTranslations || {})[curLang] || "" : "";
          respWrap.appendChild(mkText(resp.latin, t));
        }
      }
    }
    _rerenderOrdRespNew();
    item._rerender = _rerenderOrdRespNew;
    content.appendChild(respWrap);
  } else if (item.type === "text") {
    const textEl = mkText(_renderTex(item.tex || ""), item.translation || "", item);
    item._el = textEl.querySelector(".text-la");
    content.appendChild(textEl);
  } else if (item.type === "music" && item.gabc) {
    const localQueue = [];
    const chantCard = mkChant(
      item.gabc,
      item.translation || "",
      localQueue,
      true,
      item.mode ?? null,
      item,
    );
    item._getGabc = () => chantCard._getLiveGabc();
    item._getMode = () => chantCard._getLiveMode();
    item._triggerEdit = () => chantCard._triggerEdit();
    content.appendChild(chantCard);
    for (const { gabc, el, useDropCap, mode } of localQueue)
      renderGabc(gabc, el, useDropCap, mode ?? null);
  }

  wrap.appendChild(content);
  wrap.appendChild(mkObjControls(item, wrap, ordo));
  return wrap;
}

// mkObjZone: bottom-of-page "+" that adds at end of ordo
function mkObjZone(ordo, insertBefore) {
  const zone = document.createElement("div");
  zone.className = "add-zone no-print";
  const btn = document.createElement("button");
  btn.className = "add-btn";
  btn.textContent = "+";
  zone.appendChild(btn);

  btn.addEventListener("click", () => {
    if (zone.previousSibling?.classList?.contains("add-form")) {
      zone.previousSibling.remove();
      zone.classList.remove("add-open");
      return;
    }
    zone.classList.add("add-open");
    const form = _mkItemForm(ordo, insertBefore);
    // When form removes itself, clear the add-open class
    new MutationObserver((_, obs) => {
      if (!form.isConnected) {
        zone.classList.remove("add-open");
        obs.disconnect();
      }
    }).observe(document.getElementById("main"), { childList: true, subtree: true });
    zone.before(form);
  });

  return zone;
}

function _mkItemForm(ordo, insertBefore) {
  const { lang } = getSettings();
  const form = document.createElement("div");
  form.className = "add-form";

  // Type selector: Title | Rubric | Text | Music
  const typeRow = document.createElement("div");
  typeRow.className = "type-row";
  let selectedType = "rubric";
  [
    ["Title", "title"],
    ["Rubric", "rubric"],
    ["Text", "text"],
    ["Music", "music"],
  ].forEach(([label, key], i) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "ep-btn" + (i === 1 ? " active" : "");
    b.addEventListener("click", () => {
      typeRow.querySelectorAll(".ep-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      selectedType = key;
      updateFields();
      updateAddBtn();
    });
    typeRow.appendChild(b);
  });

  const mkField = (labelText, tag = "textarea") => {
    const row = document.createElement("div");
    row.className = "add-form-field";
    const lbl = document.createElement("div");
    lbl.className = "add-form-label";
    lbl.textContent = labelText;
    const el = document.createElement(tag);
    el.placeholder = labelText;
    if (tag === "textarea") el.rows = 2;
    row.appendChild(lbl);
    row.appendChild(el);
    return { row, el };
  };

  const { row: rowTitle, el: inTitle } = mkField("Section title", "input");
  inTitle.type = "text";
  const { row: rowRubric, el: taRubric } = mkField("Rubric");
  const { row: rowLatin, el: taLatin } = mkField("Latin");
  const { row: rowTrans, el: taTrans } = mkField("Translation");
  const { row: rowGabc, el: taGabc } = mkField("GABC");

  // ── Music mode: Raw GABC ↔ Search ─────────────────────────────────────────
  let musicMode = "raw";
  let resolvedGabc = "";
  let selectedEntry = null;
  const modeRow = document.createElement("div");
  modeRow.className = "add-form-field music-mode-row";
  [
    ["Raw GABC", "raw"],
    ["Search", "search"],
  ].forEach(([label, mode], i) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "ep-btn" + (i === 0 ? " active" : "");
    b.addEventListener("click", () => {
      modeRow.querySelectorAll(".ep-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      musicMode = mode;
      resolvedGabc = "";
      selectedEntry = null;
      updateFields();
      updateAddBtn();
    });
    modeRow.appendChild(b);
  });

  // Search mode UI
  const searchRow = document.createElement("div");
  searchRow.className = "add-form-field";

  const searchInputWrap = document.createElement("div");
  searchInputWrap.className = "search-input-wrap";
  const inSearch = document.createElement("input");
  inSearch.type = "text";
  inSearch.placeholder = "ID, GregoBase URL, or opening words…";
  const searchBtn = document.createElement("button");
  searchBtn.textContent = "Search";
  searchBtn.className = "ep-btn";
  searchInputWrap.appendChild(inSearch);
  searchInputWrap.appendChild(searchBtn);

  const previewBox = document.createElement("div");
  previewBox.className = "search-preview-box";
  previewBox.style.display = "none";
  const searchResults = document.createElement("div");
  searchResults.className = "search-results";

  searchRow.appendChild(searchInputWrap);
  searchRow.appendChild(previewBox);
  searchRow.appendChild(searchResults);

  const _OFFICE_PART_LABELS = {
    in: "Introitus",
    gr: "Graduale",
    al: "Alleluia",
    tr: "Tractus",
    sq: "Sequentia",
    of: "Offertorium",
    co: "Communio",
    ky: "Kyrie",
    gl: "Gloria",
    an: "Antiphon",
    hy: "Hymn",
    re: "Responsorium",
  };

  function _showPreview(entry) {
    previewBox.style.display = "";
    previewBox.innerHTML = "";
    renderGabc(entry.gabc[0], previewBox, false).then(() => {
      const staves = previewBox.querySelectorAll(".chant-stave");
      for (let i = 1; i < staves.length; i++) staves[i].style.display = "none";
    });
  }

  function _showResults(hits) {
    searchResults.innerHTML = "";
    if (!hits.length) {
      searchResults.textContent = "No results found.";
      return;
    }
    hits.forEach((entry) => {
      const div = document.createElement("div");
      div.className = "search-result-item";
      const words = entry.lyrics.split(" ");
      const lyricPreview = words.slice(0, 10).join(" ");
      const lyricsEl = document.createElement("span");
      lyricsEl.textContent =
        lyricPreview.charAt(0).toUpperCase() +
        lyricPreview.slice(1) +
        (words.length > 10 ? "…" : "");
      const partEl = document.createElement("span");
      partEl.className = "search-result-part";
      partEl.textContent =
        _OFFICE_PART_LABELS[entry.office_part] || entry.office_part || "";
      const versionEl = document.createElement("span");
      versionEl.className = "search-result-version";
      versionEl.textContent = (entry.version || "").replace("Solesmes ", "Sol. ");
      div.appendChild(lyricsEl);
      div.appendChild(partEl);
      div.appendChild(versionEl);
      div.addEventListener("click", async () => {
        searchResults
          .querySelectorAll(".search-result-item")
          .forEach((el) => el.classList.remove("active"));
        div.classList.add("active");
        selectedEntry = entry;
        resolvedGabc = "";
        previewBox.style.display = "";
        previewBox.innerHTML = '<div class="placeholder">Loading…</div>';
        updateAddBtn();
        const gabc = await _fetchGabc(entry.id);
        if (gabc) {
          resolvedGabc = gabc[0];
          _showPreview({ ...entry, gabc });
        } else {
          previewBox.innerHTML = '<div class="placeholder">GABC not available.</div>';
        }
        updateAddBtn();
      });
      searchResults.appendChild(div);
    });
  }

  async function _doSearch() {
    const q = inSearch.value.trim();
    if (!q) return;
    searchBtn.textContent = "…";
    searchBtn.disabled = true;
    resolvedGabc = "";
    previewBox.style.display = "none";
    previewBox.innerHTML = "";
    searchResults.innerHTML = "";
    updateAddBtn();

    try {
      const index = await _loadChantIndex();
      const parsed = _parseChantQuery(q);

      if (parsed?.type === "id") {
        const entry = index.find((e) => e.id === parsed.id);
        if (entry) {
          selectedEntry = entry;
          previewBox.style.display = "";
          previewBox.innerHTML = '<div class="placeholder">Loading…</div>';
          const gabc = await _fetchGabc(parsed.id);
          if (gabc) {
            resolvedGabc = gabc[0];
            _showPreview({ ...entry, gabc });
          } else {
            previewBox.innerHTML =
              '<div class="placeholder">GABC not available for id ' +
              parsed.id +
              ".</div>";
          }
        } else {
          previewBox.style.display = "";
          previewBox.innerHTML =
            '<div class="placeholder">No chant found for id ' + parsed.id + ".</div>";
        }
      } else if (parsed?.type === "text") {
        _showResults(
          index
            .filter((e) => (e.lyrics || "").includes(_normLyrics(parsed.q)))
            .slice(0, 20),
        );
      }
    } finally {
      searchBtn.textContent = "Search";
      searchBtn.disabled = false;
      updateAddBtn();
    }
  }

  searchBtn.addEventListener("click", _doSearch);
  inSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      _doSearch();
    }
  });
  inSearch.addEventListener("input", () => {
    if (!inSearch.value.trim()) {
      resolvedGabc = "";
      selectedEntry = null;
      searchResults.innerHTML = "";
      previewBox.style.display = "none";
      previewBox.innerHTML = "";
      updateAddBtn();
    }
  });

  function updateFields() {
    rowTitle.style.display = selectedType === "title" ? "" : "none";
    rowRubric.style.display = selectedType === "rubric" ? "" : "none";
    rowLatin.style.display = selectedType === "text" ? "" : "none";
    rowTrans.style.display = selectedType === "text" && lang ? "" : "none";
    modeRow.style.display = selectedType === "music" ? "" : "none";
    rowGabc.style.display = selectedType === "music" && musicMode === "raw" ? "" : "none";
    searchRow.style.display =
      selectedType === "music" && musicMode === "search" ? "" : "none";
  }
  updateFields();

  const actions = document.createElement("div");
  actions.className = "add-form-actions";

  const addBtn = document.createElement("button");
  addBtn.textContent = "Add";
  addBtn.className = "btn-confirm";
  addBtn.disabled = true;

  function updateAddBtn() {
    if (selectedType === "title") {
      addBtn.disabled = false;
      return;
    }
    addBtn.disabled = !(selectedType === "rubric"
      ? taRubric.value.trim()
      : selectedType === "text"
        ? taLatin.value.trim() && (!lang || taTrans.value.trim())
        : /* music */ musicMode === "raw"
          ? taGabc.value.trim()
          : resolvedGabc);
  }

  [inTitle, taRubric, taLatin, taTrans, taGabc].forEach((el) =>
    el.addEventListener("input", updateAddBtn),
  );
  updateAddBtn();

  addBtn.addEventListener("click", () => {
    let items = null;
    let item;
    if (selectedType === "title") {
      item = {
        type: "title",
        text: inTitle.value.trim(),
        targets: ["missalette", "pewsheet"],
      };
    } else if (selectedType === "rubric") {
      item = {
        type: "rubric",
        text: taRubric.value.trim(),
        targets: ["missalette", "pewsheet"],
      };
    } else if (selectedType === "text") {
      item = {
        type: "text",
        tex: taLatin.value.trim(),
        targets: ["missalette", "pewsheet"],
      };
      const tr = taTrans.value.trim();
      if (tr) item.translation = tr;
    } else {
      const _modeFromGabc = (g) => {
        const m = g
          .slice(0, g.indexOf("%%") + 1 || g.length)
          .match(/\bmode\s*:\s*(\d+)/i);
        return m ? m[1] : "";
      };
      if (musicMode === "search" && selectedEntry && selectedEntry.gabc.length > 1) {
        items = selectedEntry.gabc.map((g, i) => {
          const it = { type: "music", gabc: g, targets: ["missalette", "pewsheet"] };
          const m = i === 0 ? selectedEntry.mode || _modeFromGabc(g) : _modeFromGabc(g);
          if (m) it.mode = m;
          return it;
        });
      } else {
        const gabc = musicMode === "raw" ? taGabc.value.trim() : resolvedGabc;
        item = { type: "music", gabc, targets: ["missalette", "pewsheet"] };
        const m =
          musicMode === "search"
            ? selectedEntry?.mode || _modeFromGabc(gabc)
            : _modeFromGabc(gabc);
        if (m) item.mode = m;
      }
    }

    const idx = insertBefore ? ordo.indexOf(insertBefore) : ordo.length;
    const insertIdx = idx < 0 ? ordo.length : idx;
    const prevSib = form.previousSibling;

    if (items) {
      ordo.splice(insertIdx, 0, ...items);
      const newWraps = items.map((it) => mkNewObj(it, ordo));
      newWraps.forEach((w) => form.before(w));
      form.remove();
      _pushUndo(
        () => {
          items.forEach((it) => {
            const i = ordo.indexOf(it);
            if (i >= 0) ordo.splice(i, 1);
          });
          newWraps.forEach((w) => w.remove());
        },
        () => {
          ordo.splice(insertIdx, 0, ...items);
          if (prevSib?.isConnected) {
            let ref = prevSib;
            newWraps.forEach((w) => {
              ref.after(w);
              ref = w;
            });
          } else {
            newWraps.forEach((w) => document.getElementById("main").appendChild(w));
          }
        },
      );
    } else {
      ordo.splice(insertIdx, 0, item);
      const newWrap = mkNewObj(item, ordo);
      form.before(newWrap);
      form.remove();
      _pushUndo(
        () => {
          const i = ordo.indexOf(item);
          if (i >= 0) ordo.splice(i, 1);
          newWrap.remove();
        },
        () => {
          ordo.splice(insertIdx, 0, item);
          if (prevSib?.isConnected) prevSib.after(newWrap);
          else document.getElementById("main").appendChild(newWrap);
        },
      );
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => form.remove());

  actions.appendChild(addBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(typeRow);
  form.appendChild(rowTitle);
  form.appendChild(rowRubric);
  form.appendChild(rowLatin);
  form.appendChild(rowTrans);
  form.appendChild(modeRow);
  form.appendChild(rowGabc);
  form.appendChild(searchRow);
  form.appendChild(actions);
  return form;
}

// Unified ordinary block: dropdown + optional variant buttons, for all ordinary.json keys.
// opts: { initialChoice, suggest(key)->bool, onChange(key), getInitialVariantIdx(variants)->int, massDate }
function mkOrdinaryBlock(key, item, opts, queue) {
  opts = opts || {};
  const wrap = document.createElement("div");
  if (!ordinary) return wrap;

  const allSettings = ordinary[key] || {};
  const keys = Object.keys(allSettings);
  const isNumeric = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
  if (isNumeric) keys.sort((a, b) => Number(a) - Number(b));

  const sel = document.createElement("select");
  sel.className = "ordinary-sel no-print";

  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = opts.placeholder || `— ${_keyLabel(key)} —`;
  sel.appendChild(blank);

  keys.forEach((k) => {
    const opt = document.createElement("option");
    opt.value = k;
    const displayLabel = _keyLabel(k);
    opt.textContent = (opts.suggest?.(k) ? "★ " : "") + displayLabel;
    sel.appendChild(opt);
  });

  const cur = item._ordChoice != null ? item._ordChoice : opts.initialChoice || "";
  sel.value = cur;
  if (cur) {
    item._ordChoice = cur;
    opts.onChange?.(cur);
  }

  item._selEl = sel;

  const chantWrap = document.createElement("div");

  function _attachTranslation(card, chosenKey) {
    const savedTrans = (item._transMap || {})[chosenKey] || item.translation || "";
    let trEl = card.querySelector(".chant-trans");
    if (!trEl) {
      trEl = document.createElement("div");
      trEl.className = "chant-trans";
      trEl.contentEditable = "true";
      trEl.textContent = savedTrans;
      if (savedTrans) trEl.classList.add("has-content");
      card.appendChild(trEl);
    } else {
      trEl.textContent = savedTrans;
      trEl.classList.toggle("has-content", !!savedTrans);
    }
    trEl.addEventListener("input", () => {
      trEl.classList.toggle("has-content", !!trEl.textContent.trim());
      if (!item._transMap) item._transMap = {};
      item._transMap[chosenKey] = trEl.textContent;
      item.translation = trEl.textContent;
    });
  }

  function showVariants(chosenKey, resetVariantChoice) {
    chantWrap.innerHTML = "";
    item._triggerEdit = null;
    item._getGabc = null;
    item._getMode = null;
    item._ordDefaultGabc = null;
    if (!chosenKey) return;
    const variants = allSettings[String(chosenKey)] || [];
    if (!variants.length) return;
    const initialIdx =
      resetVariantChoice && opts.getInitialVariantIdx
        ? opts.getInitialVariantIdx(variants)
        : (item._varChoice ?? 0);
    if (resetVariantChoice) item._varChoice = initialIdx;
    const q = [];
    let card;
    if (variants.length === 1) {
      card = mkChant(variants[0].gabc, "", q, true, variants[0].mode ?? null);
      item._ordDefaultGabc = variants[0].gabc;
      item._getGabc = () => card._getLiveGabc();
      item._getMode = () => card._getLiveMode();
    } else {
      card = mkVariantChant(
        variants,
        q,
        (idx) => {
          item._varChoice = idx;
        },
        initialIdx,
      );
    }
    _attachTranslation(card, chosenKey);
    item._triggerEdit = () => card._triggerEdit?.();
    chantWrap.appendChild(card);
    for (const { gabc, el, mode } of q) {
      el.innerHTML = '<span style="color:#ccc;font-size:.8em">…</span>';
      renderGabc(gabc, el, true, mode || 0);
    }
  }

  sel.addEventListener("change", () => {
    item._ordChoice = sel.value || null;
    item._varChoice = null;
    opts.onChange?.(sel.value);
    showVariants(sel.value, true);
  });

  wrap.appendChild(sel);
  wrap.appendChild(chantWrap);

  // Initial render via outer queue (batched with page render)
  if (cur) {
    const variants = allSettings[String(cur)] || [];
    if (variants.length) {
      const initialIdx = opts.getInitialVariantIdx
        ? opts.getInitialVariantIdx(variants)
        : (item._varChoice ?? 0);
      if (item._varChoice == null) item._varChoice = initialIdx;
      let card;
      if (variants.length === 1) {
        const defaultGabc = variants[0].gabc;
        const edited = item.gabc && item.gabc !== defaultGabc;
        card = mkChant(
          edited ? item.gabc : defaultGabc,
          "",
          queue,
          true,
          edited ? item.mode || variants[0].mode || null : (variants[0].mode ?? null),
        );
        item._ordDefaultGabc = defaultGabc;
        item._getGabc = () => card._getLiveGabc();
        item._getMode = () => card._getLiveMode();
      } else {
        card = mkVariantChant(
          variants,
          queue,
          (idx) => {
            item._varChoice = idx;
          },
          item._varChoice,
        );
      }
      _attachTranslation(card, cur);
      item._triggerEdit = () => card._triggerEdit?.();
      chantWrap.appendChild(card);
    }
  }

  return wrap;
}

// ── Load a Mass ───────────────────────────────────────────────────────────────

async function loadMass(mt, pn) {
  // Save ordinary choices and translations before replacing propers
  const savedOrdinary = {};
  if (propers) {
    for (const item of propers.ordo || []) {
      if (item.ordinary) {
        savedOrdinary[item.ordinary] = {
          _ordChoice: item._ordChoice ?? null,
          _varChoice: item._varChoice ?? null,
          _transMap: { ...(item._transMap || {}) },
          translation: item.translation || "",
        };
      }
    }
  }

  currentPn = pn;
  _syncUrl();
  const main = document.getElementById("main");
  main.innerHTML = '<p class="hint">Oneratur…</p>';
  try {
    propers = await fetchJSON(BASE + "data/propers/" + mt + "/" + pn + ".json");
  } catch (e) {
    main.innerHTML =
      '<p class="hint" style="color:#c44">Not yet generated: ' +
      esc(mt + "/" + pn) +
      "</p>";
    propers = { feast: "", subtitle: "", ordo: [] };
    return;
  }

  // Restore ordinary choices to the new mass's items.
  // Asperges and antiphona-mariana are driven by seasonal suggestion — don't restore.
  const _noRestore = new Set(["asperges", "antiphona-mariana"]);
  for (const item of propers.ordo || []) {
    if (item.ordinary && !_noRestore.has(item.ordinary) && savedOrdinary[item.ordinary]) {
      const s = savedOrdinary[item.ordinary];
      if (s._ordChoice != null) item._ordChoice = s._ordChoice;
      if (s._varChoice != null) item._varChoice = s._varChoice;
      if (Object.keys(s._transMap).length) item._transMap = s._transMap;
      if (s.translation) item.translation = s.translation;
    }
  }

  const feastInput = document.getElementById("epFeast");
  if (feastInput) feastInput.value = propers.feast || "";

  _aspergesChoice = _suggestAsperges(_massDate(mt, pn), mt);
  _syncUrl();
  _updateControlStates();

  await renderMass();
}

// ── Events ────────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentPn = null;
    populateDropdown(btn.dataset.type);
    _syncUrl();
    _updateControlStates();
  });
});

document.getElementById("typeSelect").addEventListener("change", (e) => {
  document
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.type === e.target.value));
  currentPn = null;
  populateDropdown(e.target.value);
  _syncUrl();
  _updateControlStates();
});

document.getElementById("massSelect").addEventListener("change", (e) => {
  if (e.target.value) loadMass(currentMt, e.target.value);
});

document.getElementById("langSelect").addEventListener("change", () => {
  _syncUrl();
  _applyChromeLabels();
  if (!propers) return;
  const { lang } = getSettings();
  document.getElementById("main").classList.toggle("has-lang", !!lang);
  for (const item of propers.ordo || []) {
    if ((item.type === "text" || (item.type === "music" && item.gabc)) && item._trEl) {
      const newTr = lang ? (item.availableTranslations || {})[lang] || "" : "";
      item.translation = newTr;
      item._trEl.textContent = newTr;
      // .chant-trans uses has-content for print visibility; .text-tr uses has-lang on parent
      if (item.type === "music") item._trEl.classList.toggle("has-content", !!newTr);
    } else if (item.type === "rubric" && item._el && !item._dirty) {
      const resolved = item.key ? rubricStrings?.[lang || "Latin"]?.[item.key] || "" : "";
      item._el.textContent = resolved || item.text || "";
    }
    if (item.type === "text" && item.ordinary) item._rerender?.();
  }
});

document.getElementById("ordinarySelect").addEventListener("change", () => {
  _syncUrl();
  if (!propers) return;
  const { ordNum } = getSettings();
  const hasGloria = (propers.rule || []).includes("Gloria");
  const _ORD_KEYS = new Set(["kyrie", "gloria", "sanctus", "agnus-dei", "dismissal"]);
  for (const item of propers.ordo || []) {
    if (
      item.type === "music" &&
      item.ordinary &&
      _ORD_KEYS.has(item.ordinary) &&
      item._selEl
    ) {
      const newVal =
        item.ordinary === "gloria"
          ? hasGloria && ordNum
            ? String(ordNum)
            : ""
          : ordNum
            ? String(ordNum)
            : "";
      item._ordChoice = null;
      item._varChoice = null;
      item._selEl.value = newVal;
      item._selEl.dispatchEvent(new Event("change"));
    }
  }
});

document.getElementById("creedSelect").addEventListener("change", () => {
  _syncUrl();
  if (!propers) return;
  const { credNum } = getSettings();
  const hasCredo = (propers.rule || []).includes("Credo");
  for (const item of propers.ordo || []) {
    if (item.type === "music" && item.ordinary === "credo" && item._selEl) {
      item._ordChoice = null;
      item._varChoice = null;
      item._selEl.value = hasCredo && credNum ? String(credNum) : "";
      item._selEl.dispatchEvent(new Event("change"));
    }
  }
});

// ── Undo / Redo ──────────────────────────────────────────────────────────────

function _updateUndoRedoBtns() {
  if (_undo.length > 0 || _redo.length > 0) {
    document.getElementById("undoRedoGroup").hidden = false;
  }
  document.getElementById("undoBtn").disabled = _undo.length === 0;
  document.getElementById("redoBtn").disabled = _redo.length === 0;
}

function _doUndo() {
  const op = _undo.pop();
  if (op) {
    _redo.push(op);
    op.undo();
    _updateUndoRedoBtns();
  }
}

function _doRedo() {
  const op = _redo.pop();
  if (op) {
    _undo.push(op);
    op.redo();
    _updateUndoRedoBtns();
  }
}

document.getElementById("undoBtn").addEventListener("click", _doUndo);
document.getElementById("redoBtn").addEventListener("click", _doRedo);

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  // Let the browser handle undo/redo natively inside text fields
  const t = e.target;
  if (
    t.isContentEditable ||
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT"
  )
    return;
  if (e.key === "p") {
    e.preventDefault();
    _printing = true;
    _renderReady.then(() => _rerenderChants(_A5_PRINT_W)).then(() => window.print());
  } else if (!e.shiftKey && e.key.toLowerCase() === "z") {
    _doUndo();
    e.preventDefault();
  } else if (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z")) {
    _doRedo();
    e.preventDefault();
  }
});

// ── Sticky header collapse (mobile) ──
// Below the 640px breakpoint, once the page scrolls past the header's
// natural position, the header collapses to a slim undo/redo bar so the
// dropdown-heavy header doesn't permanently eat screen space.
new IntersectionObserver(
  ([entry]) =>
    document.querySelector("header").classList.toggle("collapsed", !entry.isIntersecting),
  { threshold: 0 },
).observe(document.getElementById("headerSentinel"));

// ── Export / Build PDF ────────────────────────────────────────────────────────

// Set to your deployed Cloudflare Worker URL after deploying booklet-worker.js.
const BOOKLET_WORKER_URL =
  "https://stjosephs-booklet.st-josephs-gateshead-missalette.workers.dev";

function toggleAbout() {
  const m = document.getElementById("aboutModal");
  if (m.hidden) {
    const verEl = document.getElementById("about-version");
    if (verEl && verEl.textContent === "—") {
      verEl.textContent =
        (typeof propers !== "undefined" && propers.pipeline_version) || "—";
      const lu = (typeof propers !== "undefined" && propers.data_updated) || {};
      const fmt = (s) => (s ? s.slice(0, 10) : "—");
      document.getElementById("about-do-date").textContent = fmt(lu.do);
      document.getElementById("about-gregobase-date").textContent = fmt(lu.gregobase);
    }
  }
  m.hidden = !m.hidden;
}

function toggleExportPopover() {
  document.getElementById("exportWrap").classList.toggle("open");
}

// ── Export button state machine ─────────────────────────────────────────────
// idle → working → dispatching → building → downloading → ready → (click) → idle
// "ready" is a distinct terminal state rather than an auto-download so the
// click that actually saves the file is always a direct user gesture (some
// browsers, notably Safari, can silently drop a delayed programmatic download).
let _exportBtnState = "idle";
let _exportReadyAction = null;

const _EXPORT_STATE_KEYS = {
  idle: "export_idle",
  working: "export_working",
  dispatching: "export_dispatching",
  building: "export_building",
  downloading: "export_downloading",
  ready: "export_ready",
};

function _setExportBtnState(state) {
  _exportBtnState = state;
  const btn = document.getElementById("exportBtn");
  btn.textContent = _t(_EXPORT_STATE_KEYS[state] || _EXPORT_STATE_KEYS.idle);
  btn.classList.toggle("ready", state === "ready");
  btn.disabled = state !== "idle" && state !== "ready";
}

function onExportBtnClick() {
  if (_exportBtnState === "ready" && _exportReadyAction) {
    _exportReadyAction();
    return;
  }
  toggleExportPopover();
}

// A5 column: 148mm - 10mm*2 margins = 128mm ≈ 484px at 96dpi
const _A5_PRINT_W = 484;

function _rerenderChants(w) {
  const els = [...document.querySelectorAll("#main .chant-gabc[data-gabc]")];
  return Promise.all(
    els.map((el) =>
      renderGabc(
        el.dataset.gabc,
        el,
        el.dataset.dropCap !== "0",
        el.dataset.mode || null,
        w,
      ),
    ),
  );
}

let _printing = false;

function doPrint() {
  document.getElementById("exportWrap").classList.remove("open");
  _printing = true;
  _renderReady.then(() => _rerenderChants(_A5_PRINT_W)).then(() => window.print());
}

window.addEventListener("afterprint", () => {
  _printing = false;
  _lastInnerW = window.innerWidth;
  _rerenderChants(null);
});

document.getElementById("epFeast").addEventListener("input", function () {
  const el = document.querySelector(".print-feast");
  if (el) el.textContent = this.value.trim() || propers?.feast || "";
});
document.getElementById("epSubtitle").addEventListener("input", function () {
  const el = document.querySelector(".print-subtitle");
  if (el) el.textContent = this.value.trim() || propers?.subtitle || "Missa Cantata";
});

document.addEventListener("click", (e) => {
  const wrap = document.getElementById("exportWrap");
  if (wrap && !wrap.contains(e.target)) wrap.classList.remove("open");
});

function epToggle(btn) {
  const active = btn.closest(".ep-toggles").querySelectorAll(".ep-btn.active");
  if (btn.classList.contains("active") && active.length === 1) return;
  btn.classList.toggle("active");
}

function _epGet(groupId) {
  return [...document.querySelectorAll("#" + groupId + " .ep-btn.active")].map(
    (b) => b.dataset.val,
  );
}

function _jsonToB64(data) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data))));
}

async function _doLocalGenerate(fmt) {
  if (!propers) return;
  const btn = document.getElementById("exportBtn");
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = fmt === "pdf" ? _t("local_compiling") : _t("local_generating");
  try {
    const exportData = _buildExportJson();
    if (!exportData) throw new Error("No mass loaded.");
    const b64 = _jsonToB64(exportData);
    const docs = _epGet("epDoc");
    const layouts = _epGet("epLayout");
    const resp = await fetch(`/generate/${fmt}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mass_type: currentMt || "tempora",
        path_name: currentPn || "mass",
        propers_json: b64,
        document: docs.length === 2 ? "both" : docs[0],
        layout: layouts.length === 2 ? "both" : layouts[0] || "regular",
      }),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.error || `Server ${resp.status}`);
    }
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(await resp.blob()),
      download: `${currentPn}.${fmt === "pdf" ? "pdf" : "zip"}`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

function doLocal(fmt) {
  document.getElementById("exportWrap").classList.remove("open");
  _doLocalGenerate(fmt);
}

function doExportCustom() {
  document.getElementById("exportWrap").classList.remove("open");
  const docs = _epGet("epDoc");
  const layouts = _epGet("epLayout");
  const layout = layouts.length === 2 ? "both" : layouts[0] || "regular";
  if (!docs.length) return;
  doExport({ docs, layout });
}

function doExportTex() {
  document.getElementById("exportWrap").classList.remove("open");
  const docs = _epGet("epDoc");
  if (!docs.length) return;
  doExport({ docs, layout: "regular", format: "tex" });
}

// ── Session JSON export/import ───────────────────────────────────────────────
// Unlike _buildExportJson() (which flattens to what the booklet builder
// needs, dropping anything unresolved), this round-trips the full
// editable session — unresolved Ordinary choices included — so a
// reimport restores exactly what was being edited.

function _snapshotOrdoItem(item) {
  if (item.type === "title") {
    return { type: "title", text: item.text, targets: item.targets };
  }
  if (item.type === "rubric") {
    const text = item._el ? item._el.textContent : item.text || "";
    const out = { type: "rubric", targets: item.targets, text };
    if (item.key) out.key = item.key;
    return out;
  }
  if (item.type === "music") {
    // Ordinary items get _getGabc wired up too (see mkOrdinaryBlock), so
    // item.ordinary must take priority here -- otherwise a resolved
    // single-variant Ordinary chant would be exported as a plain chant,
    // losing its ordinary/_ordChoice/_varChoice.
    if (!item.ordinary && (item.gabc || item._getGabc)) {
      const gabc = item._getGabc ? item._getGabc() : item.gabc;
      const out = { type: "music", gabc, targets: item.targets };
      const mode = item._getMode ? item._getMode() : item.mode;
      if (mode != null) out.mode = mode;
      if (item.translation) out.translation = item.translation;
      if (item.availableTranslations)
        out.availableTranslations = item.availableTranslations;
      return out;
    }
    if (item.ordinary) {
      const out = { type: "music", ordinary: item.ordinary, targets: item.targets };
      if (item._ordChoice != null) out._ordChoice = item._ordChoice;
      if (item._varChoice != null) out._varChoice = item._varChoice;
      if (item.translation) out.translation = item.translation;
      const liveGabc = item._getGabc ? item._getGabc() : null;
      const edited = liveGabc != null && liveGabc !== item._ordDefaultGabc;
      out.gabc = edited ? liveGabc : "";
      if (edited) {
        const liveMode = item._getMode ? item._getMode() : null;
        if (liveMode) out.mode = String(liveMode);
      }
      return out;
    }
  }
  if (item.type === "text") {
    if (item.ordinary) {
      return { type: "text", ordinary: item.ordinary, targets: item.targets };
    }
    const srcHtml = item._el
      ? item._el.innerHTML
      : _renderTex(item.tex || item.latin || "");
    const out = { type: "text", latin: _htmlToTex(srcHtml), targets: item.targets };
    if (item.translation) out.translation = item.translation;
    if (item.availableTranslations)
      out.availableTranslations = item.availableTranslations;
    return out;
  }
  return null;
}

function _buildFullSessionExport() {
  if (!currentPn) return null;
  const { lang, ordNum, credNum } = getSettings();
  const ordo = (propers.ordo || []).map(_snapshotOrdoItem).filter(Boolean);
  return {
    _format: SESSION_EXPORT_FORMAT,
    _version: SESSION_EXPORT_VERSION,
    mass_type: currentMt || "tempora",
    path_name: currentPn || "",
    feast: document.getElementById("epFeast")?.value.trim() || propers.feast || "",
    subtitle:
      document.getElementById("epSubtitle")?.value.trim() ||
      propers.subtitle ||
      "Missa Cantata",
    rule: propers.rule || [],
    settings: {
      lang: lang || "",
      ordNum: ordNum || 0,
      credNum: credNum || 0,
      marianChoice: _marianChoice || "",
      aspergesChoice: _aspergesChoice || "",
    },
    ordo,
  };
}

function doExportSessionJson() {
  document.getElementById("exportWrap").classList.remove("open");
  const data = _buildFullSessionExport();
  if (!data) {
    alert("No mass loaded.");
    return;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `${data.mass_type}-${data.path_name || "session"}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

function doImportSessionJson() {
  document.getElementById("exportWrap").classList.remove("open");
  document.getElementById("importSessionInput").click();
}

async function handleImportSessionFile(file) {
  document.getElementById("importSessionInput").value = "";
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    alert("That file isn't valid JSON.");
    return;
  }

  const errors = validateImportedSession(data);
  if (errors.length) {
    alert("Can't import this file:\n\n" + errors.slice(0, 10).join("\n"));
    return;
  }

  const prevPropers = propers;
  const prevMt = currentMt;
  const prevPn = currentPn;
  const prevMarian = _marianChoice;
  const prevAsperges = _aspergesChoice;

  try {
    if (data.mass_type !== currentMt) populateDropdown(data.mass_type);
    currentMt = data.mass_type;
    currentPn = data.path_name || null;
    propers = {
      feast: data.feast || "",
      subtitle: data.subtitle || "Missa Cantata",
      rule: Array.isArray(data.rule) ? data.rule : [],
      ordo: data.ordo,
    };
    _marianChoice = (data.settings && data.settings.marianChoice) || null;
    _aspergesChoice = (data.settings && data.settings.aspergesChoice) || null;

    document.getElementById("massSelect").value = currentPn || "";
    document.getElementById("epFeast").value = propers.feast;
    document.getElementById("epSubtitle").value = propers.subtitle;
    if (data.settings) {
      document.getElementById("langSelect").value = data.settings.lang || "";
      document.getElementById("ordinarySelect").value = data.settings.ordNum || "";
      document.getElementById("creedSelect").value = data.settings.credNum || "";
    }
    _syncUrl();
    _updateControlStates();
    _applyChromeLabels();
    await renderMass();
  } catch (e) {
    propers = prevPropers;
    currentMt = prevMt;
    currentPn = prevPn;
    _marianChoice = prevMarian;
    _aspergesChoice = prevAsperges;
    alert("Import failed, restored your previous mass: " + e.message);
    try {
      await renderMass();
    } catch (_) {
      // last resort: nothing more we can safely do here
    }
  }
}

function _buildExportJson() {
  if (!propers || !ordinary) return null;
  const { lang } = getSettings();
  function _resolveItem(item) {
    if (item.type === "rubric") {
      const text = (item._el ? item._el.textContent : item.text || "").trim();
      if (!text) return null;
      return { type: "rubric", targets: item.targets, text };
    } else if (item.type === "music") {
      if (item.gabc) {
        const liveGabc = item._getGabc ? item._getGabc() : item.gabc;
        const ei = { type: "music", gabc: liveGabc, targets: item.targets };
        const latin = _latinFromGabc(liveGabc);
        if (latin) ei.latin = latin;
        const liveMode = item._getMode ? item._getMode() : (item.mode ?? null);
        if (liveMode) ei.mode = String(liveMode);
        const t =
          (lang && item.availableTranslations && item.availableTranslations[lang]) ||
          item.translation ||
          null;
        if (t) ei.translation = t;
        return ei;
      } else if (item.ordinary) {
        const choiceKey = item._ordChoice;
        if (!choiceKey) return null;
        const variants = (ordinary[item.ordinary] || {})[String(choiceKey)] || [];
        if (!variants.length) return null;
        const varIdx = item._varChoice ?? 0;
        const v = variants[varIdx] || variants[0];
        const liveGabc = item._getGabc ? item._getGabc() : null;
        const edited = liveGabc != null && liveGabc !== item._ordDefaultGabc;
        const ei = { type: "music", gabc: edited ? liveGabc : v.gabc, targets: item.targets };
        const liveMode = edited && item._getMode ? item._getMode() : null;
        if (liveMode) ei.mode = String(liveMode);
        else if (v.mode) ei.mode = v.mode;
        const t = item.translation || null;
        if (t) ei.translation = t;
        return ei;
      }
    } else if (item.type === "text") {
      if (item.ordinary) {
        // Resp slot: expand to individual text/rubric items from ordinary.json *-resp
        const choiceKey =
          item.ordinary === "asperges"
            ? _aspergesChoice || ""
            : item.ordinary === "antiphona-mariana"
              ? _marianChoice || ""
              : "";
        if (!choiceKey) return null;
        const responses = (ordinary[item.ordinary + "-resp"] || {})[choiceKey] || [];
        if (!responses.length) return null;
        const expanded = [];
        for (const resp of responses) {
          if (resp.type === "rubric") {
            if (resp.text)
              expanded.push({ type: "rubric", text: resp.text, targets: item.targets });
          } else if (resp.type === "text") {
            const t = lang ? (resp.availableTranslations || {})[lang] || "" : "";
            const ei = { type: "text", latin: resp.latin || "", targets: item.targets };
            if (t) ei.translation = t;
            expanded.push(ei);
          }
        }
        return expanded.length ? expanded : null;
      }
      const srcHtml = item._el
        ? item._el.innerHTML
        : _renderTex(item.tex || item.latin || "");
      const ei = { type: "text", latin: _htmlToTex(srcHtml), targets: item.targets };
      const t =
        (lang && item.availableTranslations && item.availableTranslations[lang]) ||
        item.translation ||
        null;
      if (t) ei.translation = t;
      return ei;
    }
    return null;
  }

  // Segment flat ordo by title items, skipping sections whose only content
  // was an Ordinary slot (Kyrie/Gloria/Sanctus/Agnus Dei/Credo/Asperges/
  // Marian antiphon/dismissal) that never got a setting chosen.
  const exportOrdo = [];
  const flatOrdo = propers.ordo || [];
  let segTitle = null;
  let segItems = [];
  let segHadUnresolvedOrdinary = false;

  function flushSeg() {
    if (shouldKeepSegment(segItems, segHadUnresolvedOrdinary)) {
      if (segTitle) exportOrdo.push(segTitle);
      exportOrdo.push(...segItems);
    }
    segTitle = null;
    segItems = [];
    segHadUnresolvedOrdinary = false;
  }

  for (const item of flatOrdo) {
    if (item.type === "title") {
      flushSeg();
      segTitle = { type: "title", text: item.text, targets: item.targets };
    } else {
      const ei = _resolveItem(item);
      if (ei) {
        if (Array.isArray(ei)) segItems.push(...ei);
        else segItems.push(ei);
      } else if (item.ordinary) {
        segHadUnresolvedOrdinary = true;
      }
    }
  }
  flushSeg();

  const _babelMap = {
    English: "british",
    Francais: "french",
    Espanol: "spanish",
    Italiano: "italian",
    Deutsch: "ngerman",
    Polski: "polish",
    Portugues: "portuges",
    Nederlands: "dutch",
    Magyar: "magyar",
    Ukrainian: "ukrainian",
  };
  return {
    feast: document.getElementById("epFeast")?.value.trim() || propers.feast || "",
    subtitle:
      document.getElementById("epSubtitle")?.value.trim() ||
      propers.subtitle ||
      "Missa Cantata",
    lang_babel: lang ? _babelMap[lang] || "" : "",
    ordo: exportOrdo,
  };
}

async function doExport({ docs, layout, format = "pdf" }) {
  if (!propers) return;
  _setExportBtnState("working");

  try {
    if (!BOOKLET_WORKER_URL)
      throw new Error("BOOKLET_WORKER_URL not set — deploy the Cloudflare Worker first.");
    const exportData = _buildExportJson();
    if (!exportData) throw new Error("No mass loaded.");
    const b64 = _jsonToB64(exportData);
    _setExportBtnState("dispatching");
    const dispatch = await fetch(`${BOOKLET_WORKER_URL}/booklet/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mass_type: currentMt || "tempora",
        path_name: currentPn || "mass",
        propers_json: b64,
        document: docs.length === 2 ? "both" : docs[0],
        layout,
        format,
      }),
    });
    if (!dispatch.ok) {
      const e = await dispatch.json().catch(() => ({}));
      throw new Error(e.error || `Worker ${dispatch.status}`);
    }
    const { run_id } = await dispatch.json();
    _setExportBtnState("building");
    let status = "queued";
    for (let i = 0; i < 75 && (status === "queued" || status === "in_progress"); i++) {
      await new Promise((r) => setTimeout(r, 8000));
      const st = await fetch(`${BOOKLET_WORKER_URL}/booklet/status/${run_id}`);
      if (st.ok) ({ status } = await st.json());
    }
    if (status !== "completed") throw new Error(`Build ${status}`);
    _setExportBtnState("downloading");
    const dl = await fetch(`${BOOKLET_WORKER_URL}/booklet/download/${run_id}`);
    if (!dl.ok) throw new Error("Download failed");
    const blobUrl = URL.createObjectURL(await dl.blob());
    const filename = `${currentMt}-${currentPn}.zip`;
    _exportReadyAction = () => {
      const a = Object.assign(document.createElement("a"), {
        href: blobUrl,
        download: filename,
      });
      a.click();
      URL.revokeObjectURL(blobUrl);
      _exportReadyAction = null;
      _setExportBtnState("idle");
    };
    _setExportBtnState("ready");
  } catch (e) {
    alert(e.message);
    _setExportBtnState("idle");
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

loadIndex().catch((err) => {
  document.getElementById("main").innerHTML =
    '<p class="hint" style="color:#c44">Error: ' + esc(String(err)) + "</p>";
});

// Re-render chant SVGs when the viewport width changes
let _reRenderTimer = null;
let _lastInnerW = window.innerWidth;
window.addEventListener("resize", () => {
  if (_printing) return;
  if (window.innerWidth === _lastInnerW) return;
  _lastInnerW = window.innerWidth;
  clearTimeout(_reRenderTimer);
  _reRenderTimer = setTimeout(() => {
    document.querySelectorAll("#main .chant-gabc[data-gabc]").forEach((el) => {
      renderGabc(
        el.dataset.gabc,
        el,
        el.dataset.dropCap !== "0",
        el.dataset.mode || null,
      );
    });
  }, 200);
});
