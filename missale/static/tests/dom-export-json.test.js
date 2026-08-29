const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, realDataFetch } = require("./dom-harness.js");

// _buildExportJson() is what doExport()/_doLocalGenerate() actually send to
// the booklet builder: unlike _buildFullSessionExport() (a verbatim,
// re-editable snapshot), it flattens live-edited translations, resolves
// chosen Ordinary variants to concrete gabc, and drops whole sections that
// never got a required Ordinary choice made. That resolution/dropping logic
// is exercised here against a real mass with Gloria+Credo in its rule
// (Nat1-0), since the segment-keeping decision itself (shouldKeepSegment) is
// already unit-tested in pure.test.js.

describe("_buildExportJson", () => {
  test("returns null before ordinary.json has loaded", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    assert.equal(dom.window._buildExportJson(), null);
  });

  test("returns an empty-ordo export once loadIndex has run but no mass is loaded", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window } = dom.window;
    await window.loadIndex();
    const data = window._buildExportJson();
    assert.ok(data);
    assert.deepEqual(Array.from(data.ordo), []);
  });

  test("sections whose only content is an unmade Ordinary choice are dropped entirely", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Nat1-0");

    const data = window._buildExportJson();
    const titles = data.ordo.filter((i) => i.type === "title").map((i) => i.text);
    // No Ordinary choice has been made yet (ordinarySelect/creedSelect are
    // both blank), so Kyrie/Gloria/Sanctus/Agnus Dei/Credo -- sections with
    // nothing else in them -- shouldn't survive the export.
    for (const t of ["Kyrie", "Gloria", "Sanctus", "Agnus Dei", "Credo"]) {
      assert.ok(!titles.includes(t), `expected "${t}" section to be dropped, got ${titles}`);
    }
    // Introitus etc. have real rubric/music content regardless of Ordinary
    // choices, so they must survive.
    assert.ok(titles.includes("Introitus"));
  });

  test("choosing an Ordinary setting resolves it to real gabc and keeps its section", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Nat1-0");

    document.getElementById("ordinarySelect").value = "1";
    document.getElementById("ordinarySelect").dispatchEvent(new window.Event("change"));
    document.getElementById("creedSelect").value = "1";
    document.getElementById("creedSelect").dispatchEvent(new window.Event("change"));

    const data = window._buildExportJson();
    const titles = data.ordo.filter((i) => i.type === "title").map((i) => i.text);
    for (const t of ["Kyrie", "Gloria", "Sanctus", "Agnus Dei", "Credo"]) {
      assert.ok(titles.includes(t), `expected "${t}" section to be kept, got ${titles}`);
    }
    const gloriaTitleIdx = data.ordo.findIndex((i) => i.type === "title" && i.text === "Gloria");
    const gloriaMusic = data.ordo[gloriaTitleIdx + 2]; // title, rubric, music
    assert.equal(gloriaMusic.type, "music");
    assert.ok(gloriaMusic.gabc && gloriaMusic.gabc.length > 0);
  });

  test("maps langSelect's value to the babel language name for TeX, not the display name", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Nat1-0");

    assert.equal(window._buildExportJson().lang_babel, "");

    document.getElementById("langSelect").value = "Espanol";
    document.getElementById("langSelect").dispatchEvent(new window.Event("change"));
    assert.equal(window._buildExportJson().lang_babel, "spanish");
  });
});
