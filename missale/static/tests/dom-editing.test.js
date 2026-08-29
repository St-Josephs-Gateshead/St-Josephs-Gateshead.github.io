const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, realDataFetch } = require("./dom-harness.js");

// propers/ordo live only as script-scope bindings (see dom-mass.test.js), so
// state changes from these interactions are asserted either on the rendered
// DOM directly, or via _buildFullSessionExport()'s snapshot of the live item
// (targets, text, etc.), never by reading propers itself.

describe("delete + undo/redo", () => {
  test("deleting an item removes its DOM node and enables Undo; Undo restores it exactly, Redo removes it again", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");

    const mainHtmlBefore = document.getElementById("main").innerHTML;
    const countBefore = document.querySelectorAll("#main .obj-wrap").length;
    assert.equal(document.getElementById("undoBtn").disabled, true);

    document.querySelectorAll("#main .obj-wrap")[0].querySelector(".ctrl-btn.delete").click();

    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countBefore - 1);
    assert.equal(document.getElementById("undoBtn").disabled, false);
    assert.equal(document.getElementById("undoRedoGroup").hidden, false);

    window._doUndo();
    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countBefore);
    assert.equal(document.getElementById("main").innerHTML, mainHtmlBefore);
    assert.equal(document.getElementById("redoBtn").disabled, false);

    window._doRedo();
    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countBefore - 1);
  });

  test("Undo/Redo with nothing on the stack is a silent no-op", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");

    assert.doesNotThrow(() => window._doUndo());
    assert.doesNotThrow(() => window._doRedo());
    assert.equal(document.getElementById("undoBtn").disabled, true);
    assert.equal(document.getElementById("redoBtn").disabled, true);
  });
});

describe("GABC live editing", () => {
  test("editing a chant's GABC via the ✎ control updates what gets exported, after the debounce settles", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");

    // A concrete-gabc item, not an Ordinary-driven one (Kyrie/Gloria/etc.):
    // those don't wire up item._getGabc, so a live GABC edit on them isn't
    // captured by the session export -- only the chosen Ordinary key/index
    // is (see _snapshotOrdoItem). That's a separate, narrower case; this
    // test covers the item kind the edit UI is actually meant to persist.
    const plainMusicIdx = window
      ._buildFullSessionExport()
      .ordo.findIndex((i) => i.type === "music" && i.gabc && !i.ordinary);
    const wrap = document.querySelectorAll("#main .obj-wrap")[plainMusicIdx];
    const editCtrlBtn = wrap.querySelector(".ctrl-btn[title='Edit GABC']");
    editCtrlBtn.click();
    const textarea = wrap.querySelector(".gabc-editor");
    assert.ok(textarea);

    textarea.value = "(c3) TEST(f)";
    textarea.dispatchEvent(new window.Event("input"));
    // The textarea's own input handler debounces re-rendering by 600ms.
    await new Promise((r) => setTimeout(r, 700));

    const exported = window._buildFullSessionExport();
    assert.equal(exported.ordo[plainMusicIdx].gabc, "(c3) TEST(f)");
  });
});

describe("Missalette/Pew sheet target toggles", () => {
  test("clicking the M/P buttons on an item updates its exported targets", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");

    const wrap = document.querySelectorAll("#main .obj-wrap")[3]; // Introitus title
    const pBtn = [...wrap.querySelectorAll(".ctrl-btn")].find((b) => b.title === "Pew sheet");
    const targetsBefore = window._buildFullSessionExport().ordo[3].targets;
    assert.ok(!targetsBefore.includes("pewsheet"), `expected pewsheet absent, got ${targetsBefore}`);

    pBtn.click();

    assert.equal(pBtn.classList.contains("active"), true);
    const targetsAfter = window._buildFullSessionExport().ordo[3].targets;
    assert.ok(targetsAfter.includes("pewsheet"), `expected pewsheet added, got ${targetsAfter}`);

    pBtn.click();

    assert.equal(pBtn.classList.contains("active"), false);
    const targetsToggledOff = window._buildFullSessionExport().ordo[3].targets;
    assert.ok(!targetsToggledOff.includes("pewsheet"));
  });
});
