const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage } = require("./dom-harness.js");

describe("page load", () => {
  test("index.html + pure.js + app.js load together without throwing", async () => {
    const dom = await loadPage();
    const { window } = dom;
    assert.equal(typeof window.doExport, "function");
    assert.equal(typeof window._t, "function");
    assert.equal(typeof window.cleanGabc, "function"); // from pure.js
  });

  test("IS_LOCAL is false for a non-localhost hostname (the default)", async () => {
    // IS_LOCAL itself is a top-level `const` -- by spec that's a script-scope
    // binding, not a window property, so it isn't reachable as
    // window.IS_LOCAL even though plain top-level `function`/`var` are.
    // Its observable effect is what's worth asserting on.
    const dom = await loadPage();
    assert.equal(dom.window.document.getElementById("epLocal").hidden, true);
  });

  test("IS_LOCAL is true for a localhost hostname", async () => {
    const dom = await loadPage({ hostname: "localhost" });
    assert.equal(dom.window.document.getElementById("epLocal").hidden, false);
  });
});

describe("epToggle", () => {
  test("clicking an inactive toggle in a multi-select group activates it without deactivating its sibling", async () => {
    const dom = await loadPage();
    const { document } = dom.window;
    const missalette = document.querySelector('#epDoc [data-val="missalette"]');
    const pew = document.querySelector('#epDoc [data-val="pew"]');
    assert.equal(missalette.classList.contains("active"), true);
    assert.equal(pew.classList.contains("active"), false);

    dom.window.epToggle(pew);

    assert.equal(missalette.classList.contains("active"), true);
    assert.equal(pew.classList.contains("active"), true);
  });

  test("clicking the last active toggle in a group is a no-op (at least one must stay selected)", async () => {
    const dom = await loadPage();
    const { document } = dom.window;
    const missalette = document.querySelector('#epDoc [data-val="missalette"]');

    dom.window.epToggle(missalette);

    assert.equal(missalette.classList.contains("active"), true);
  });
});

describe("_epGet", () => {
  test("reads the currently-active values out of a toggle group", async () => {
    // Array.from(): the array _epGet returns belongs to the jsdom window's
    // own Array realm, not this test file's -- deepStrictEqual treats that
    // as "same structure, not reference-equal" even though the contents
    // match. Copying into a native array sidesteps the cross-realm check.
    const dom = await loadPage();
    assert.deepEqual(Array.from(dom.window._epGet("epDoc")), ["missalette"]);
    assert.deepEqual(Array.from(dom.window._epGet("epLayout")), ["regular"]);
  });
});

describe("export button state machine", () => {
  test("_setExportBtnState updates the button's text, disabled state, and .ready class", async () => {
    const dom = await loadPage();
    const { document } = dom.window;
    const btn = document.getElementById("exportBtn");

    dom.window._setExportBtnState("working");
    assert.equal(btn.disabled, true);
    assert.equal(btn.classList.contains("ready"), false);

    dom.window._setExportBtnState("ready");
    assert.equal(btn.disabled, false);
    assert.equal(btn.classList.contains("ready"), true);

    dom.window._setExportBtnState("idle");
    assert.equal(btn.disabled, false);
    assert.equal(btn.classList.contains("ready"), false);
  });
});

describe("chrome i18n", () => {
  test("_applyChromeLabels defaults every labelled element to Latin once chrome_strings.json loads", async () => {
    const dom = await loadPage();
    const { window } = dom;
    const { document } = window;
    // Set directly rather than via fetchImpl: loadIndex()'s own fetch race
    // isn't guaranteed to have settled by the time the window's load event
    // fires, so this asserts what _applyChromeLabels() itself does once
    // chromeStrings is populated, independent of that race.
    window.chromeStrings = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", "..", "templates", "chrome_strings.json"),
        "utf8",
      ),
    );
    window._applyChromeLabels();
    assert.equal(document.querySelector('[data-i18n="print_btn"]').textContent, "Imprime");
    assert.equal(document.querySelector('[data-i18n="feast_label"]').textContent, "Festum");
  });
});
