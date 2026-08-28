const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, realDataFetch } = require("./dom-harness.js");

// allMasses/propers/ordinary/etc. are top-level `let`/`const` in app.js --
// by spec that's a script-scope binding, not a window property (same as
// IS_LOCAL in dom.test.js), so these tests assert on their DOM-observable
// effects instead of reading the variables directly.

describe("loadIndex + loadMass against real data", () => {
  test("loadIndex's CSV/JSON fetches all succeed and feed the rest of the page", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;

    await window.loadIndex();

    // allMasses.tempora populated -> populateDropdown can build real options.
    window.populateDropdown("tempora");
    assert.ok(
      document.getElementById("massSelect").options.length > 1,
      "expected real tempora.csv rows to populate the mass dropdown",
    );

    // chromeStrings populated -> loadIndex's own _applyChromeLabels() call
    // should already have switched the default-Latin labels in.
    assert.equal(document.querySelector('[data-i18n="print_btn"]').textContent, "Imprime");
  });

  test("loadMass renders a real mass (Advent 1) into #main without throwing", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;

    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");

    const main = document.getElementById("main");
    assert.ok(main.children.length > 0, "#main should have rendered content");
    assert.doesNotMatch(main.textContent, /Not yet generated/);
    assert.equal(document.getElementById("epFeast").value, "Dominica I Adventus");
  });

  test("switching mass a second time re-renders cleanly (exercises the saved-ordinary-choices restore path in loadMass)", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;

    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    const firstFeast = document.getElementById("epFeast").value;

    await window.loadMass("tempora", "Adv2-0");

    assert.notEqual(document.getElementById("epFeast").value, firstFeast);
    assert.ok(document.getElementById("main").children.length > 0);
  });

  test("rendered chant items get a fallback (plain-text) rendering, since exsurge is unavailable in this harness", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;

    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    await window._renderReady;

    const fallbacks = document.querySelectorAll(".gabc-fallback");
    assert.ok(fallbacks.length > 0, "expected at least one chant rendered via the fallback path");
  });
});
