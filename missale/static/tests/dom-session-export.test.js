const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, realDataFetch } = require("./dom-harness.js");

async function loadedMass(pn = "Adv1-0") {
  const dom = await loadPage({ fetchImpl: realDataFetch });
  const { window } = dom;
  const alerts = [];
  window.alert = (msg) => alerts.push(msg);
  await window.loadIndex();
  await window.loadMass("tempora", pn);
  return { dom, window, document: window.document, alerts };
}

// handleImportSessionFile() only ever calls file.text() -- a File duck-type
// is enough, and sidesteps a real gap in jsdom's Blob/File implementation
// (no .text()/.arrayBuffer() as of jsdom 25.0.1: only slice/size/type).
function fileFor(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { text: async () => text };
}

describe("_buildFullSessionExport", () => {
  test("produces a well-formed export for a loaded mass", async () => {
    const { window } = await loadedMass();
    const data = window._buildFullSessionExport();

    assert.equal(data._format, "stjosephs-missale-export");
    assert.equal(data._version, 1);
    assert.equal(data.mass_type, "tempora");
    assert.equal(data.path_name, "Adv1-0");
    assert.equal(data.feast, "Dominica I Adventus");
    assert.ok(Array.isArray(data.ordo));
    assert.ok(data.ordo.length > 0);
    // Exported entries must themselves pass the same validator an import
    // would run them through. validateImportedSession returns a jsdom-realm
    // array, which node:assert treats as unequal to a native [] by
    // reference -- copy it into the native realm first.
    assert.deepEqual(Array.from(window.validateImportedSession(data)), []);
  });

  test("returns null with no mass loaded", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    assert.equal(dom.window._buildFullSessionExport(), null);
  });
});

describe("handleImportSessionFile — round trip", () => {
  test("exporting then reimporting the same mass restores the rendered page without alerting", async () => {
    const { window, document, alerts } = await loadedMass();
    const exported = window._buildFullSessionExport();
    const mainHtmlBefore = document.getElementById("main").innerHTML;

    await window.handleImportSessionFile(fileFor(exported));

    assert.deepEqual(alerts, []);
    assert.equal(document.getElementById("epFeast").value, "Dominica I Adventus");
    assert.ok(document.getElementById("main").children.length > 0);
    assert.equal(document.getElementById("main").innerHTML, mainHtmlBefore);
  });

  test("importing a mass of a different type switches the tab and mass dropdown", async () => {
    const { window, document } = await loadedMass();
    // Build a plausible commune export without needing a second loadMass
    // round trip: the shape only needs to satisfy the validator plus
    // whatever populateDropdown/renderMass touch.
    const exported = window._buildFullSessionExport();
    exported.mass_type = "commune";
    exported.path_name = "C2";

    await window.handleImportSessionFile(fileFor(exported));

    assert.equal(document.getElementById("typeSelect").value, "commune");
    assert.equal(document.getElementById("massSelect").value, "C2");
  });
});

describe("handleImportSessionFile — rejects bad input without crashing", () => {
  test("invalid JSON: alerts, leaves the current mass exactly as it was", async () => {
    const { window, document, alerts } = await loadedMass();
    const mainHtmlBefore = document.getElementById("main").innerHTML;

    await window.handleImportSessionFile(fileFor("{not valid json"));

    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /valid JSON/);
    assert.equal(document.getElementById("epFeast").value, "Dominica I Adventus");
    assert.equal(document.getElementById("main").innerHTML, mainHtmlBefore);
  });

  test("well-formed JSON that fails schema validation: alerts with the specific problems, leaves state untouched", async () => {
    const { window, document, alerts } = await loadedMass();
    const mainHtmlBefore = document.getElementById("main").innerHTML;

    await window.handleImportSessionFile(fileFor({ _format: "not-us", ordo: "not-a-list" }));

    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /Can't import this file/);
    assert.match(alerts[0], /_format/);
    assert.equal(document.getElementById("epFeast").value, "Dominica I Adventus");
    assert.equal(document.getElementById("main").innerHTML, mainHtmlBefore);
  });

  test("no file selected (e.g. the picker was cancelled) is a silent no-op", async () => {
    const { window, document, alerts } = await loadedMass();
    const mainHtmlBefore = document.getElementById("main").innerHTML;

    await window.handleImportSessionFile(null);

    assert.deepEqual(alerts, []);
    assert.equal(document.getElementById("main").innerHTML, mainHtmlBefore);
  });
});
