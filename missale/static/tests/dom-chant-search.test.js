const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, realDataFetch } = require("./dom-harness.js");

// The chant search UI (add-zone -> Music -> Search) looks up entries in
// missale/data/chant_index.json, but fetching the actual GABC notation for a
// chosen entry goes through the Cloudflare Worker at an absolute https://
// URL that realDataFetch can't resolve to a file -- it correctly falls
// through to a 404, exercising the same "GABC not available" path a real
// network outage would hit.
//
// chant_index.json itself is ~20k entries / ~6MB -- fine for the real app,
// but reloading and linearly searching it fresh on every page load makes
// this file's tests dramatically slower than the rest of the suite for no
// real benefit. Real entries are used (not hand-written fixtures, so the
// shape can't drift from production), just trimmed to a small slice built
// once here.
const _fullChantIndex = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "data", "chant_index.json"),
    "utf8",
  ),
);
const _kyrieEntries = _fullChantIndex.filter((e) => (e.lyrics || "").includes("kyrie"));
const _chantIndexSlice = JSON.stringify(_kyrieEntries.slice(0, 5).concat(_fullChantIndex[0]));

async function trimmedChantIndexFetch(url) {
  if (String(url).endsWith("data/chant_index.json")) {
    return { ok: true, status: 200, text: async () => _chantIndexSlice, json: async () => JSON.parse(_chantIndexSlice) };
  }
  return realDataFetch(url);
}

async function openMusicSearch(document, window) {
  document.querySelector(".add-zone .add-btn").click();
  const form = document.querySelector(".add-form");
  [...form.querySelectorAll(".type-row .ep-btn")].find((b) => b.textContent === "Music").click();
  [...form.querySelectorAll(".music-mode-row .ep-btn")]
    .find((b) => b.textContent === "Search")
    .click();
  return form;
}

async function search(window, form, query) {
  const input = form.querySelector(".search-input-wrap input");
  input.value = query;
  input.dispatchEvent(new window.Event("input"));
  form.querySelector(".search-input-wrap button").click();
  // _doSearch is async; give its microtasks/fetch a tick to settle.
  await new Promise((r) => setTimeout(r, 50));
}

describe("add-zone music search", () => {
  test("a lyric-text query lists matching chant_index.json entries", async () => {
    const dom = await loadPage({ fetchImpl: trimmedChantIndexFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    const form = await openMusicSearch(document, window);

    await search(window, form, "kyrie");

    const results = form.querySelectorAll(".search-result-item");
    assert.ok(results.length > 0, "expected at least one kyrie result");
  });

  test("selecting a result tries to fetch its GABC; unavailable (no worker in this harness) leaves Add disabled", async () => {
    const dom = await loadPage({ fetchImpl: trimmedChantIndexFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    const form = await openMusicSearch(document, window);
    await search(window, form, "kyrie");

    const firstResult = form.querySelector(".search-result-item");
    firstResult.click();
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(firstResult.classList.contains("active"), true);
    assert.match(form.querySelector(".search-preview-box").textContent, /not available/i);
    assert.equal(form.querySelector(".btn-confirm").disabled, true);
  });

  test("an id query with no matching entry shows a not-found message", async () => {
    const dom = await loadPage({ fetchImpl: trimmedChantIndexFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    const form = await openMusicSearch(document, window);

    await search(window, form, "999999999");

    assert.match(form.querySelector(".search-preview-box").textContent, /No chant found/);
  });

  test("clearing the query clears results and hides the preview", async () => {
    const dom = await loadPage({ fetchImpl: trimmedChantIndexFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    const form = await openMusicSearch(document, window);
    await search(window, form, "kyrie");
    assert.ok(form.querySelectorAll(".search-result-item").length > 0);

    const input = form.querySelector(".search-input-wrap input");
    input.value = "";
    input.dispatchEvent(new window.Event("input"));

    assert.equal(form.querySelector(".search-results").innerHTML, "");
    assert.equal(form.querySelector(".search-preview-box").style.display, "none");
  });
});
