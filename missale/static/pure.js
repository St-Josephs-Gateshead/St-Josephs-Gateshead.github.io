/**
 * Pure, DOM-free logic shared by the missale webpage (index.html) and its
 * test suite (missale/static/tests/).
 *
 * Loaded as a plain classic script (NOT type="module") — index.html's main
 * inline script relies on every top-level function here being a genuine
 * global, the same way its own functions are, since dozens of inline
 * onclick="..." attributes across the page call them directly. This file
 * must be <script src>'d before that inline script.
 *
 * For Node (tests), the same file is require()'d as CommonJS — see the
 * module.exports guard at the bottom. Nothing here touches `document`,
 * `window`, or any index.html global, so it works unmodified in both.
 */

// ── GABC/text transforms ────────────────────────────────────────────────────

function cleanGabc(g) {
  return (g || "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/<sp>([VRAvra])\/<\/sp>\.?/g, "$1/.")
    .replace(/<sp>'?(?:ae|ae)<\/sp>/g, "ǽ")
    .replace(/<sp>'?(?:oe|oe)<\/sp>/g, "œ")
    .replace(/<i>([^<]*)<\/i>/g, "_$1_")
    .replace(/<sc>([^<]*)<\/sc>/g, "%$1%")
    .replace(/<[^>]+>/g, "")
    .replace(/\*(?!\()/g, "*()");
}

const _ROMAN_MODE = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

function _keyLabel(key) {
  return String(key).split(/[_-]/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

function _modeAnnotation(mode) {
  if (!mode) return null;
  const m = String(mode).match(/^(\d+)(.*)/);
  if (!m) return null;
  const num = parseInt(m[1]);
  if (num < 1 || num > 8) return null;
  return _ROMAN_MODE[num] + m[2];
}

function _latinFromGabc(gabc) {
  return gabc
    .replace(/\([^)]*\)/g, "")       // strip note groups
    .replace(/\{([^}]*)\}/g, "$1")   // unwrap {word}
    .replace(/<[^>]+>/g, "")          // strip HTML tags
    .replace(/[*:;|]/g, " ")          // neume marks → space
    .replace(/\s+/g, " ").trim();
}

function _gabcForExsurge(gabc) {
  return gabc
    .replace(/<sp>([VRAvra])\/<\/sp>\.?/g, "$1/.")
    .replace(/<sp>[^<]*<\/sp>/g, "")
    .replace(/<i>([^<]*)<\/i>/g, "_$1_")
    .replace(/<sc>([^<]*)<\/sc>/g, "%$1%")
    .replace(/<[^>]+>/g, "");
}

function _renderTex(s) {
  if (!s) return "";
  return s
    .replace(/\\textit\{([^}]*)\}/g, "<em>$1</em>")
    .replace(/\\textbf\{([^}]*)\}/g, "<strong>$1</strong>")
    .replace(/\{\\(?:it|textit)\s+([^}]*)\}/g, "<em>$1</em>")
    .replace(/\{\\(?:bf|textbf)\s+([^}]*)\}/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function _htmlToTex(html) {
  if (!html) return "";
  return html
    .replace(/<em>([\s\S]*?)<\/em>/gi, "\\textit{$1}")
    .replace(/<i>([\s\S]*?)<\/i>/gi, "\\textit{$1}")
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, "\\textbf{$1}")
    .replace(/<b>([\s\S]*?)<\/b>/gi, "\\textbf{$1}")
    .replace(/<br\s*\/?>/gi, "\\\\\n")
    .replace(/<div>/gi, "\\\\\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// ── Misc text helpers ────────────────────────────────────────────────────────

function _normLyrics(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")       // strip combining diacritics
    .replace(/[VvRr]\s*[./]\s*\/?/g, " ")  // V./ R./ markers
    .replace(/[†‡☩℣℟~]/g, " ")             // liturgical symbols
    .replace(/\biij?\b/gi, " ")             // ij / iij repeat tokens
    .replace(/[^a-zA-Z\s]/g, " ")           // remaining non-letter chars
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseCSV(text) {
  function splitRow(row) {
    const fields = [];
    let cur = "", inQ = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (inQ) {
        if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { fields.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  }
  const lines = text.trim().split("\n");
  const cols = splitRow(lines[0]);
  return lines
    .slice(1)
    .filter(Boolean)
    .map((row) => {
      const vals = splitRow(row);
      return Object.fromEntries(
        cols.map((c, i) => [c.trim(), (vals[i] || "").trim()]),
      );
    });
}

// ── Liturgical calendar ──────────────────────────────────────────────────────
// _massDate, _temporaDate, and _todayTempora take an optional trailing
// reference-date/time parameter (defaulting to `new Date()`, evaluated fresh
// per call — same behavior as before for every existing caller that omits
// it) purely so tests can pin "now" instead of depending on the real clock.

function _getEaster(year) {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100;
  const d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(
    year,
    Math.floor((h + l - 7 * m + 114) / 31) - 1,
    ((h + l - 7 * m + 114) % 31) + 1,
  );
}

const _PFX = {
  Adv: 1,
  Nat: 2,
  Epi: 3,
  Quadp: 4,
  Quad: 5,
  Pasc: 6,
  Pent: 7,
  PentEpi: 8,
};
function temporaSort(pn) {
  const m = pn.match(/^([A-Za-z]+?)(\d+)-(\d+)([a-z]?)(\d*)$/);
  if (!m) return 99999;
  const sub = m[5] ? parseInt(m[5]) * 0.1 : 0;
  return (
    (_PFX[m[1]] || 9) * 10000 + parseInt(m[2]) * 10 + parseInt(m[3]) + sub
  );
}

function _temporaYearAnchors(yr) {
  const D = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const sun = (d) => D(d, -d.getDay());

  const E = _getEaster(yr);

  const xmas = new Date(yr, 11, 25);
  const adv4 = xmas.getDay() === 0 ? D(xmas, -7) : sun(xmas);
  const adv1 = D(adv4, -21);

  const epi = new Date(yr, 0, 6);
  let epi1 = sun(epi);
  if (epi1.getTime() <= epi.getTime()) epi1 = D(epi1, 7);

  // "Sunday within the Octave of the Nativity" must fall strictly after
  // Christmas (Dec 26-31) — ceiling to the next Sunday, not sun()'s floor.
  // When Christmas IS a Sunday, Jan 1 (the following Sunday) is the Octave
  // Day/Holy Name, a class 1 feast that takes precedence — there is no
  // separate "Sunday within the Octave" that year.
  const nat1 = xmas.getDay() === 0 ? null : D(xmas, 7 - xmas.getDay());

  // The following Sunday can land on or after Epiphany (Jan 6) — in that
  // case it's Epiphany itself or the first Sunday after it, not a second
  // Nativity-season Sunday, so it doesn't exist as a distinct period.
  // Nothing to compute it from if Nat1 itself doesn't exist this year.
  const nextEpiphany = new Date(yr + 1, 0, 6);
  const nat2Raw = nat1 && D(nat1, 7);
  const nat2 = nat2Raw && nat2Raw.getTime() < nextEpiphany.getTime() ? nat2Raw : null;

  return { D, sun, E, xmas, adv1, adv4, epi1, nat1, nat2 };
}

// Every named Sunday of one tempora year, as [name, Date] pairs: Quadp1-3,
// Quad1-6, Pasc0-7, Pent01-24 (+ any deferred PentEpi weeks), Adv1-4,
// Epi1-6, and Nat1/Nat2 where they exist. Shared by _temporaPeriodForSunday
// and _temporaDate (which looks entries up by name) so there's exactly one
// place this arithmetic can get wrong.
function _temporaNamedPeriods(yr) {
  const { D, E, adv1, epi1, nat1, nat2 } = _temporaYearAnchors(yr);
  const entries = [];
  ["Quadp1", "Quadp2", "Quadp3"].forEach((n, i) =>
    entries.push([n, D(E, -63 + i * 7)]),
  );
  for (let w = 1; w <= 6; w++)
    entries.push([`Quad${w}`, D(E, -42 + (w - 1) * 7)]);
  for (let w = 0; w <= 7; w++) entries.push([`Pasc${w}`, D(E, 7 * w)]);

  // Pentecost 24 is always the last Sunday before Advent, not a fixed
  // 168-days-after-Pentecost offset — it can land earlier than that in a
  // late-Easter year (or exactly on Advent 1 itself, in the extreme case).
  // Weeks 1-23 use the plain weekly offset for as long as that stays
  // strictly before Pentecost 24's slot; how many of them actually fit
  // varies by year, so this isn't a fixed cutoff. Any remaining gap (a
  // season with more than 24 Sundays) is filled with propers recycled from
  // the Epiphany Sundays skipped earlier that year — an early Easter
  // shortens Epiphanytide the same way a late Easter shortens
  // Pentecost-tide, so the two shortfalls offset each other.
  const pent24 = D(adv1, -7);
  const deferred = [];
  for (let w = 1; w <= 6; w++) {
    if (D(epi1, (w - 1) * 7).getTime() >= D(E, -63).getTime())
      deferred.push(w);
  }
  let slot = D(E, 49 + 7);
  let rawWeek = 1;
  let deferredIdx = 0;
  while (slot.getTime() < pent24.getTime()) {
    if (rawWeek <= 23) {
      entries.push([`Pent${String(rawWeek).padStart(2, "0")}`, slot]);
      rawWeek++;
    } else if (deferredIdx < deferred.length) {
      entries.push([`PentEpi${deferred[deferredIdx]}`, slot]);
      deferredIdx++;
    } else {
      break;
    }
    slot = D(slot, 7);
  }
  entries.push(["Pent24", pent24]);

  for (let w = 1; w <= 4; w++)
    entries.push([`Adv${w}`, D(adv1, (w - 1) * 7)]);
  for (let w = 1; w <= 6; w++) entries.push([`Epi${w}`, D(epi1, (w - 1) * 7)]);
  if (nat1) entries.push(["Nat1", nat1]);
  if (nat2) entries.push(["Nat2", nat2]);
  return entries;
}

function _temporaPeriodForSunday(ts) {
  const year = ts.getFullYear();
  const eq = (a, b) => a.getTime() === b.getTime();

  for (const [name, s] of [
    ..._temporaNamedPeriods(year),
    ..._temporaNamedPeriods(year - 1),
  ]) {
    if (eq(ts, s)) return name;
  }
  return null;
}

function _todayTempora(now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const ts = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - dow,
  );
  const name = _temporaPeriodForSunday(ts);
  return name ? name + "-" + dow : null;
}

function _lastSundayOfMonth(year, month0) {
  const last = new Date(year, month0 + 1, 0);
  return new Date(year, month0, last.getDate() - last.getDay());
}

function _massDate(mt, pn, refDate = new Date()) {
  if (!pn) return null;
  if (mt === "sancti") {
    const sm = pn.match(/^(\d{2})-(\d{2})/);
    if (sm) return new Date(refDate.getFullYear(), parseInt(sm[1]) - 1, parseInt(sm[2]));
    const dm = pn.match(/^(\d{2})-DU$/);
    if (dm) return _lastSundayOfMonth(refDate.getFullYear(), parseInt(dm[1]) - 1);
    return null;
  }
  if (mt === "tempora") return _temporaDate(pn, refDate);
  return null;
}

function _temporaDate(pn, refDate = new Date()) {
  // Given a tempora path_name like "Quad6-5", return its calendar date in the nearest year.
  const m = pn.match(/^([A-Za-z]+?)(\d+)-(\d+)/);
  if (!m) return null;
  const key = m[1] + m[2];
  const day = parseInt(m[3]);
  const D = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  for (const y of [refDate.getFullYear(), refDate.getFullYear() - 1]) {
    const map = Object.fromEntries(_temporaNamedPeriods(y));
    if (map[key]) return D(map[key], day);
  }
  return null;
}

function _suggestMarian(forDate) {
  // Alma:   Advent 1 → Feb 2 (inclusive)
  // Ave:    Feb 3 → Holy Saturday (before Easter Vigil)
  // Regina: Easter Sunday → Pentecost Sunday (inclusive)
  // Salve:  after Pentecost → day before Advent 1
  const today = forDate
    ? new Date(
        forDate.getFullYear(),
        forDate.getMonth(),
        forDate.getDate(),
      )
    : (() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
      })();
  const yr = today.getFullYear();
  const D = (d, n) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const sun = (d) => {
    const s = new Date(d);
    s.setDate(s.getDate() - s.getDay());
    return s;
  };
  const E = _getEaster(yr);
  const feb3 = new Date(yr, 1, 3); // Feb 3: first day of Ave
  const pent = D(E, 49); // Pentecost Sunday: last day of Regina
  const xmas = new Date(yr, 11, 25);
  const adv4 = xmas.getDay() === 0 ? D(xmas, -7) : sun(xmas);
  const adv1 = D(adv4, -21); // Advent 1: first day of Alma
  const t = today.getTime();
  if (t >= adv1.getTime()) return "alma-redemptoris-mater";
  if (t > pent.getTime()) return "salve-regina";
  if (t >= E.getTime()) return "regina-caeli";
  if (t >= feb3.getTime()) return "ave-regina-caelorum";
  return "alma-redemptoris-mater";
}

function _suggestAsperges(forDate, mt) {
  // Vidi Aquam: Easter Sunday through Pentecost Sunday inclusive
  // Asperges: other Sundays in tempora; null for sancti (day varies by year) or weekdays
  if (!forDate || mt === "sancti") return null;
  if (forDate.getDay() !== 0) return null; // not a Sunday
  const today = new Date(
    forDate.getFullYear(),
    forDate.getMonth(),
    forDate.getDate(),
  );
  const yr = today.getFullYear();
  const D = (d, n) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const E = _getEaster(yr);
  const pent = D(E, 49);
  const t = today.getTime();
  if (t >= E.getTime() && t <= pent.getTime()) return "vidi-aquam";
  return "asperges";
}

// ── Export-ordo segmenting ───────────────────────────────────────────────────
// Used by _buildExportJson() in index.html. A "segment" is a title item plus
// the resolved items under it: a title/rubric pair (e.g. "Kyrie" + "Immediately
// after the Introit:") must not be exported alone when the Ordinary slot under
// it (Kyrie/Gloria/Sanctus/Agnus Dei/Credo/Asperges/Marian antiphon/dismissal)
// never got a setting chosen and so contributed no music.

function shouldKeepSegment(segItems, hadUnresolvedOrdinary) {
  if (!segItems.length) return false;
  const resolvedMusic = segItems.filter((i) => i.type === "music").length;
  return !hadUnresolvedOrdinary || resolvedMusic > 0;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    cleanGabc,
    _keyLabel,
    _modeAnnotation,
    _latinFromGabc,
    _gabcForExsurge,
    _renderTex,
    _htmlToTex,
    _normLyrics,
    esc,
    parseCSV,
    _getEaster,
    _temporaYearAnchors,
    _temporaNamedPeriods,
    temporaSort,
    _temporaPeriodForSunday,
    _todayTempora,
    _lastSundayOfMonth,
    _massDate,
    _temporaDate,
    _suggestMarian,
    _suggestAsperges,
    shouldKeepSegment,
  };
}
