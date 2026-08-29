const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, realDataFetch } = require("./dom-harness.js");

describe("type tabs", () => {
  test("clicking a tab switches typeSelect, repopulates the mass dropdown, and clears the current mass from the URL", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    assert.match(document.location.search, /pn=Adv1-0/);

    document.querySelector('.tab-btn[data-type="sancti"]').click();

    assert.equal(document.getElementById("typeSelect").value, "sancti");
    assert.equal(
      document.querySelector('.tab-btn[data-type="sancti"]').classList.contains("active"),
      true,
    );
    assert.equal(
      document.querySelector('.tab-btn[data-type="tempora"]').classList.contains("active"),
      false,
    );
    assert.ok(document.getElementById("massSelect").options.length > 1);
    // currentPn is cleared on tab switch, so it drops out of the URL
    assert.doesNotMatch(document.location.search, /pn=/);
  });
});

describe("about modal", () => {
  test("toggleAbout shows the modal and fills in the pipeline version/data dates from the loaded mass, once", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Nat1-0");

    assert.equal(document.getElementById("aboutModal").hidden, true);
    assert.equal(document.getElementById("about-version").textContent, "—");

    window.toggleAbout();

    assert.equal(document.getElementById("aboutModal").hidden, false);
    assert.notEqual(document.getElementById("about-version").textContent, "—");

    window.toggleAbout();
    assert.equal(document.getElementById("aboutModal").hidden, true);
  });
});

describe("export popover", () => {
  test("toggleExportPopover toggles the .open class", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { document } = dom.window;
    const wrap = document.getElementById("exportWrap");
    assert.equal(wrap.classList.contains("open"), false);

    dom.window.toggleExportPopover();
    assert.equal(wrap.classList.contains("open"), true);

    dom.window.toggleExportPopover();
    assert.equal(wrap.classList.contains("open"), false);
  });
});

describe("langSelect / ordinarySelect / creedSelect change handlers", () => {
  test("changing langSelect re-renders a text item's translation and syncs the URL", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Nat1-0");

    const trEl = document.querySelector(".text-tr");
    assert.equal(trEl.textContent, "");

    document.getElementById("langSelect").value = "Espanol";
    document.getElementById("langSelect").dispatchEvent(new window.Event("change"));

    assert.notEqual(document.querySelector(".text-tr").textContent, "");
    assert.match(document.location.search, /lang=Espanol/);
  });

  test("changing ordinarySelect resolves the Gloria/Kyrie/Sanctus/Agnus Dei/Dismissal choice and syncs the URL", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Nat1-0");

    // Every Ordinary section is always shown for editing regardless of
    // whether a setting has been chosen -- it's the chant notation inside
    // that appears once a choice resolves it (whole-section dropping only
    // happens in _buildExportJson's booklet-flattening pass, covered in
    // dom-export-json.test.js).
    const wraps = [...document.querySelectorAll("#main .obj-wrap")];
    const glTitleIdx = wraps.findIndex(
      (w) => w.querySelector(".section-title")?.textContent === "Gloria",
    );
    const glMusicWrap = wraps[glTitleIdx + 2]; // title, rubric, music
    assert.equal(glMusicWrap.querySelector(".ordinary-sel").value, "");
    assert.equal(glMusicWrap.querySelector(".chant-card"), null);

    document.getElementById("ordinarySelect").value = "1";
    document.getElementById("ordinarySelect").dispatchEvent(new window.Event("change"));

    assert.match(document.location.search, /ord=1/);
    assert.equal(glMusicWrap.querySelector(".ordinary-sel").value, "1");
    assert.ok(glMusicWrap.querySelector(".chant-card"));
    const exported = window._buildFullSessionExport();
    const gloriaItem = exported.ordo.find((i) => i.type === "music" && i.ordinary === "gloria");
    assert.equal(gloriaItem._ordChoice, "1");
  });

  test("changing creedSelect resolves the Credo choice and syncs the URL", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Nat1-0");

    document.getElementById("creedSelect").value = "1";
    document.getElementById("creedSelect").dispatchEvent(new window.Event("change"));

    assert.match(document.location.search, /creed=1/);
    const exported = window._buildFullSessionExport();
    const credoItem = exported.ordo.find((i) => i.type === "music" && i.ordinary === "credo");
    assert.equal(credoItem._ordChoice, "1");
  });
});
