const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, realDataFetch } = require("./dom-harness.js");

// An Ordinary chant with only one variant for its chosen setting (e.g. most
// Gloria/Credo settings) is freely editable via the same ✎ control as a
// plain propers chant (see dom-editing.test.js's GABC live editing suite).
// Both _buildFullSessionExport() and _buildExportJson() carry that edit as
// its own "gabc" field, blank while it still matches the setting's own
// default -- variant-choice chants (multiple musical settings for the same
// key) have no free-text edit at all, so theirs stays blank unconditionally.

async function loadGloriaWithChoice1() {
  const dom = await loadPage({ fetchImpl: realDataFetch });
  const { window, document } = dom.window;
  await window.loadIndex();
  await window.loadMass("tempora", "Nat1-0"); // has Gloria in its rule
  document.getElementById("ordinarySelect").value = "1";
  document.getElementById("ordinarySelect").dispatchEvent(new window.Event("change"));
  return { window, document };
}

function findGloriaMusicWrap(document) {
  const wraps = [...document.querySelectorAll("#main .obj-wrap")];
  const titleIdx = wraps.findIndex(
    (w) => w.querySelector(".section-title")?.textContent === "Gloria",
  );
  return wraps[titleIdx + 2]; // title, rubric, music
}

async function editGabc(window, wrap, newGabc) {
  wrap.querySelector(".ctrl-btn[title='Edit GABC']").click();
  const textarea = wrap.querySelector(".gabc-editor");
  textarea.value = newGabc;
  textarea.dispatchEvent(new window.Event("input"));
  await new Promise((r) => setTimeout(r, 700)); // 600ms debounce
}

describe("Ordinary chant GABC editing", () => {
  test("an unedited resolved Ordinary chant exports with a blank gabc field", async () => {
    const { window } = await loadGloriaWithChoice1();
    const gloria = window
      ._buildFullSessionExport()
      .ordo.find((i) => i.type === "music" && i.ordinary === "gloria");
    assert.equal(gloria.gabc, "");
  });

  test("editing it fills in gabc/mode in both the session export and the booklet export", async () => {
    const { window, document } = await loadGloriaWithChoice1();
    await editGabc(window, findGloriaMusicWrap(document), "(c3) EDITEDGLORIA(f)");

    const sessionGloria = window
      ._buildFullSessionExport()
      .ordo.find((i) => i.type === "music" && i.ordinary === "gloria");
    assert.equal(sessionGloria.gabc, "(c3) EDITEDGLORIA(f)");
    assert.equal(sessionGloria.mode, "4");

    const titles = window._buildExportJson().ordo;
    const titleIdx = titles.findIndex((i) => i.type === "title" && i.text === "Gloria");
    assert.equal(titles[titleIdx + 2].gabc, "(c3) EDITEDGLORIA(f)");
  });

  test("re-importing a session with an edited Ordinary gabc restores it into the rendered chant", async () => {
    const { window, document } = await loadGloriaWithChoice1();
    await editGabc(window, findGloriaMusicWrap(document), "(c3) EDITEDGLORIA(f)");
    const exported = window._buildFullSessionExport();

    await window.handleImportSessionFile({ text: async () => JSON.stringify(exported) });

    assert.equal(
      findGloriaMusicWrap(document).querySelector(".chant-gabc")?.dataset.gabc,
      "(c3) EDITEDGLORIA(f)",
    );
    const reExported = window
      ._buildFullSessionExport()
      .ordo.find((i) => i.type === "music" && i.ordinary === "gloria");
    assert.equal(reExported.gabc, "(c3) EDITEDGLORIA(f)");
  });

  test("choosing a different Ordinary setting discards the edit", async () => {
    const { window, document } = await loadGloriaWithChoice1();
    await editGabc(window, findGloriaMusicWrap(document), "(c3) EDITEDGLORIA(f)");

    document.getElementById("ordinarySelect").value = "2";
    document.getElementById("ordinarySelect").dispatchEvent(new window.Event("change"));

    const gloria = window
      ._buildFullSessionExport()
      .ordo.find((i) => i.type === "music" && i.ordinary === "gloria");
    assert.equal(gloria._ordChoice, "2");
    assert.equal(gloria.gabc, "");
  });
});
