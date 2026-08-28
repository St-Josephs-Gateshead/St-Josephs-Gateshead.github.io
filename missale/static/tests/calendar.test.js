const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  esc,
  _normLyrics,
  parseCSV,
  _getEaster,
  _temporaYearAnchors,
  temporaSort,
  _temporaPeriodForSunday,
  _todayTempora,
  _lastSundayOfMonth,
  _massDate,
  _temporaDate,
  _suggestMarian,
  _suggestAsperges,
} = require("../pure.js");

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("esc", () => {
  test("escapes & < > for safe HTML text content", () => {
    assert.equal(esc(`<script>alert("x")</script> & "quotes"`), `&lt;script&gt;alert("x")&lt;/script&gt; &amp; "quotes"`);
  });

  test("non-string input is stringified", () => {
    assert.equal(esc(123), "123");
  });
});

describe("_normLyrics", () => {
  test("strips combining diacritics and lowercases", () => {
    assert.equal(_normLyrics("Ký́rie"), "kyrie");
  });

  test("strips V./ R./ versicle markers and liturgical symbols", () => {
    assert.equal(_normLyrics("V./ Dominus vobiscum R./ Et cum spiritu tuo"), "dominus vobiscum et cum spiritu tuo");
  });

  test("strips ij/iij repeat tokens as whole words only", () => {
    assert.equal(_normLyrics("Kyrie eleison iij"), "kyrie eleison");
    // "ij" inside a real word must not be stripped
    assert.equal(_normLyrics("adiija"), "adiija");
  });

  test("collapses whitespace", () => {
    assert.equal(_normLyrics("  a   b  "), "a b");
  });
});

describe("parseCSV", () => {
  test("basic rows", () => {
    assert.deepEqual(parseCSV("a,b\n1,2\n3,4"), [
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  test("quoted field containing a comma", () => {
    assert.deepEqual(parseCSV('name,note\n"Smith, John",hi'), [
      { name: "Smith, John", note: "hi" },
    ]);
  });

  test("escaped double-quote inside a quoted field", () => {
    assert.deepEqual(parseCSV('a\n"she said ""hi"""'), [{ a: 'she said "hi"' }]);
  });

  test("blank lines between rows are skipped", () => {
    assert.deepEqual(parseCSV("a,b\n1,2\n\n3,4\n"), [
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  test("missing trailing field defaults to empty string", () => {
    assert.deepEqual(parseCSV("a,b\n1"), [{ a: "1", b: "" }]);
  });
});

describe("_getEaster", () => {
  // Widely-published Western/Gregorian Easter Sundays, including two
  // full-century years (1900, 2000) to exercise the algorithm's century
  // correction terms.
  const known = [
    [1900, 3, 15],
    [2000, 3, 23],
    [2023, 3, 9],
    [2024, 2, 31],
    [2025, 3, 20],
    [2026, 3, 5],
    [2027, 2, 28],
    [2030, 3, 21],
  ];

  for (const [year, month0, day] of known) {
    test(`Easter ${year}`, () => {
      const e = _getEaster(year);
      assert.equal(e.getMonth(), month0);
      assert.equal(e.getDate(), day);
    });
  }
});

describe("temporaSort", () => {
  test("orders across seasons in liturgical-year order", () => {
    const names = ["Pent01-0", "Adv1-0", "Quad1-0", "Pasc0-0", "Nat1-0", "Epi1-0"];
    const sorted = [...names].sort((a, b) => temporaSort(a) - temporaSort(b));
    assert.deepEqual(sorted, ["Adv1-0", "Nat1-0", "Epi1-0", "Quad1-0", "Pasc0-0", "Pent01-0"]);
  });

  test("orders within a season by week then day", () => {
    assert.ok(temporaSort("Adv1-0") < temporaSort("Adv1-6"));
    assert.ok(temporaSort("Adv1-6") < temporaSort("Adv2-0"));
  });

  test("unparseable path_name sorts last", () => {
    assert.equal(temporaSort("not-a-real-one"), 99999);
  });
});

describe("_temporaPeriodForSunday / _temporaDate round-trip", () => {
  // For a handful of tempora path_names, the calendar date _temporaDate
  // resolves to (aligned back to that week's Sunday) should be recognised
  // by _temporaPeriodForSunday as the matching period.
  const cases = ["Adv1-0", "Quad1-0", "Pasc0-0", "Pent01-0", "Nat1-0"];
  const refDate = new Date(2026, 5, 1); // fixed "now" so results are deterministic

  for (const pn of cases) {
    test(`${pn} date resolves back to its own period`, () => {
      const d = _temporaDate(pn, refDate);
      assert.ok(d, `_temporaDate(${pn}) returned null`);
      const sunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
      const [, seasonWeek] = pn.match(/^([A-Za-z]+\d*)-/);
      assert.equal(_temporaPeriodForSunday(sunday), seasonWeek);
    });
  }

  test("Christmas Day (fixed date, not a tempora path) is not itself a tempora Sunday", () => {
    // Sanity check that _temporaPeriodForSunday returns null for an
    // arbitrary non-Sunday-aligned date rather than throwing.
    assert.equal(_temporaPeriodForSunday(new Date(2026, 11, 25)), null);
  });

  test("Nat1 (Sunday within the Octave of Christmas) is not shadowed by Adv4", () => {
    // Nat1's date must not collide with Adv4's — Dec 25, 2026 is a Friday,
    // exercising the case where the two would otherwise land on the same
    // Sunday.
    const xmas2026 = new Date(2026, 11, 25);
    assert.notEqual(xmas2026.getDay(), 0, "test assumes Christmas 2026 is not a Sunday");
    const nat1Sunday = _temporaDate("Nat1-0", new Date(2026, 5, 1));
    assert.equal(ymd(nat1Sunday), "2026-12-27");
    assert.equal(_temporaPeriodForSunday(nat1Sunday), "Nat1");
  });

  test("Christmas on a Sunday: there is no Sunday within the Octave that year", () => {
    // Dec 25, 2033 is a Sunday. Jan 1, 2034 (also necessarily a Sunday) is
    // the Octave Day/Holy Name, a class 1 feast that takes precedence, not
    // "Sunday within the Octave". Checking the anchor directly (rather than
    // through _temporaDate) since _temporaDate deliberately falls back to
    // the previous year when the requested period doesn't exist in the
    // reference year, which would mask this on its own.
    const anchors = _temporaYearAnchors(2033);
    assert.equal(anchors.xmas.getDay(), 0, "test assumes Christmas 2033 is a Sunday");
    assert.equal(anchors.nat1, null);
    assert.equal(anchors.nat2, null);
  });

  test("every named period recognises its own date, for every Christmas weekday phase (2024-2043)", () => {
    // Sweep 20 consecutive years so Dec 25 cycles through all 7 possible
    // weekdays (and Feb 29 leap shifts) several times each, and check every
    // period _temporaDate can resolve round-trips through
    // _temporaPeriodForSunday correctly.
    //
    // Epi3-6 are excluded from the strict assertion by design, not
    // oversight: _temporaDate computes their dates with a plain
    // unconditional formula regardless of whether that many Sundays
    // actually fit before Septuagesima that year, so in an early-Easter
    // year they can land on what's really a Septuagesima-tide Sunday —
    // already handled correctly by the "deferred" PentEpi mechanism, just
    // not reflected back through _temporaDate's naive per-key lookup.
    // Still exercised here (to confirm they resolve without throwing) but
    // not asserted to round-trip. Pent01-24 and Adv1 are asserted normally:
    // Pent24 is always D(adv1, -7) by construction, so it can never
    // collide with Advent regardless of how late Easter falls.
    const core = [
      "Quadp1", "Quadp2", "Quadp3",
      "Quad1", "Quad2", "Quad3", "Quad4", "Quad5", "Quad6",
      "Pasc0", "Pasc1", "Pasc2", "Pasc3", "Pasc4", "Pasc5", "Pasc6", "Pasc7",
      ...Array.from({ length: 24 }, (_, i) => `Pent${String(i + 1).padStart(2, "0")}`),
      "Adv1", "Adv2", "Adv3", "Adv4",
      "Epi1", "Epi2",
      "Nat1", "Nat2",
    ];
    const deferredProne = ["Epi3", "Epi4", "Epi5", "Epi6"];
    const mismatches = [];
    for (let year = 2024; year <= 2043; year++) {
      const refDate = new Date(year, 5, 1);
      for (const key of core) {
        const d = _temporaDate(`${key}-0`, refDate);
        if (!d) continue;
        const got = _temporaPeriodForSunday(d);
        if (got !== key) mismatches.push(`${key} in ${year}: date ${ymd(d)} resolved back as "${got}"`);
      }
      for (const key of deferredProne) {
        _temporaDate(`${key}-0`, refDate); // must not throw
      }
    }
    assert.deepEqual(mismatches, []);
  });

  test("Pentecost 24 is always the last Sunday before Advent, not a fixed offset, so it can't shadow Adv1", () => {
    // 2038: Easter April 25 (unusually late) puts the raw
    // Pentecost-plus-168-days offset exactly on Advent 1 (Nov 28, 2038).
    // Pent24 must instead land a week earlier, Nov 21 — not independently
    // checked against a published calendar (2038 has none yet), but the
    // underlying rule (24th Sunday = last Sunday before Advent) is.
    const realAdv1 = _temporaDate("Adv1-0", new Date(2038, 5, 1));
    assert.equal(ymd(realAdv1), "2038-11-28");
    assert.equal(_temporaPeriodForSunday(realAdv1), "Adv1");
    const pent24 = _temporaDate("Pent24-0", new Date(2038, 5, 1));
    assert.equal(ymd(pent24), "2038-11-21");
    assert.equal(_temporaPeriodForSunday(pent24), "Pent24");
  });
});

describe("_lastSundayOfMonth", () => {
  test("June 2026", () => {
    // June 2026: June 30 is a Tuesday, so the last Sunday is June 28.
    assert.equal(ymd(_lastSundayOfMonth(2026, 5)), "2026-06-28");
  });
});

describe("_massDate", () => {
  const refDate = new Date(2026, 5, 1);

  test("sancti MM-DD", () => {
    assert.equal(ymd(_massDate("sancti", "12-25", refDate)), "2026-12-25");
  });

  test("sancti MM-DU (last Sunday of month)", () => {
    assert.equal(ymd(_massDate("sancti", "06-DU", refDate)), "2026-06-28");
  });

  test("tempora delegates to _temporaDate", () => {
    assert.equal(_massDate("tempora", "Adv1-0", refDate).getTime(), _temporaDate("Adv1-0", refDate).getTime());
  });

  test("no path_name returns null", () => {
    assert.equal(_massDate("tempora", "", refDate), null);
  });

  test("defaults refDate to the real current time when omitted (still returns a Date, doesn't throw)", () => {
    assert.ok(_massDate("sancti", "12-25") instanceof Date);
  });
});

describe("_suggestMarian", () => {
  const refDate = new Date(2026, 5, 1);
  const E = _getEaster(2026);

  test("Advent through Feb 2 -> Alma Redemptoris Mater", () => {
    assert.equal(_suggestMarian(new Date(2026, 0, 15)), "alma-redemptoris-mater");
  });

  test("Feb 3 through Holy Saturday -> Ave Regina Caelorum", () => {
    assert.equal(_suggestMarian(new Date(2026, 1, 3)), "ave-regina-caelorum");
  });

  test("Easter Sunday through Pentecost -> Regina Caeli", () => {
    assert.equal(_suggestMarian(E), "regina-caeli");
  });

  test("after Pentecost -> Salve Regina", () => {
    const pentecost = new Date(E.getFullYear(), E.getMonth(), E.getDate() + 49);
    const dayAfter = new Date(pentecost.getFullYear(), pentecost.getMonth(), pentecost.getDate() + 1);
    assert.equal(_suggestMarian(dayAfter), "salve-regina");
  });

  test("no date defaults to real today without throwing", () => {
    assert.ok(typeof _suggestMarian(undefined) === "string");
  });
});

describe("_suggestAsperges", () => {
  const E = _getEaster(2026);

  test("Easter Sunday through Pentecost Sunday -> Vidi Aquam", () => {
    assert.equal(_suggestAsperges(E, "tempora"), "vidi-aquam");
  });

  test("other Sundays -> Asperges", () => {
    const someOtherSunday = new Date(2026, 0, 4); // a January Sunday, well outside Eastertide
    assert.equal(_suggestAsperges(someOtherSunday, "tempora"), "asperges");
  });

  test("weekdays return null", () => {
    const monday = new Date(2026, 0, 5);
    assert.equal(_suggestAsperges(monday, "tempora"), null);
  });

  test("sancti masses return null regardless of day", () => {
    assert.equal(_suggestAsperges(E, "sancti"), null);
  });

  test("no date returns null", () => {
    assert.equal(_suggestAsperges(null, "tempora"), null);
  });
});

describe("_todayTempora", () => {
  test("doesn't throw and returns a string or null for a fixed 'now'", () => {
    const result = _todayTempora(new Date(2026, 5, 1));
    assert.ok(result === null || typeof result === "string");
  });
});
