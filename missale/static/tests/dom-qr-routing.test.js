const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, realDataFetch } = require("./dom-harness.js");

// A printed booklet's QR code links to #FeastName-hyphenated (optionally
// _missalette or _missalette-booklet), handled once, early, inside
// loadIndex(). The hash is set here only after the page has already loaded
// -- app.js's own top-level loadIndex().catch(...) call has already run by
// then (harmlessly, with no hash present), and our own explicit
// window.loadIndex() call is the only one that ever sees it, so these never
// double-fire the confirm()/open() download prompt.

function withFakeRelease(assets) {
  return async (url) => {
    if (String(url).includes("api.github.com/repos")) {
      return { ok: true, status: 200, json: async () => ({ assets }) };
    }
    return realDataFetch(url);
  };
}

describe("QR hash routing", () => {
  test("a matching slug selects and loads that mass", async () => {
    const dom = await loadPage({ fetchImpl: withFakeRelease([]) });
    const { window, document } = dom.window;
    window.location.hash = "#Dominica-I-Adventus";
    window.confirm = () => true;
    window.open = () => {
      throw new Error("no release asset configured -- shouldn't be called");
    };

    await window.loadIndex();

    assert.equal(document.getElementById("typeSelect").value, "tempora");
    assert.equal(
      document.querySelector('.tab-btn[data-type="tempora"]').classList.contains("active"),
      true,
    );
    assert.equal(document.getElementById("massSelect").value, "Adv1-0");
    assert.equal(document.getElementById("epFeast").value, "Dominica I Adventus");
    assert.equal(document.getElementById("hashError").hidden, true);
  });

  test("an unmatched slug shows the not-in-database banner and falls back to the Tempora tab", async () => {
    const dom = await loadPage({ fetchImpl: withFakeRelease([]) });
    const { window, document } = dom.window;
    window.location.hash = "#Nonexistent-Feast-Xyz";
    window.confirm = () => {
      throw new Error("shouldn't be called with no release asset");
    };

    await window.loadIndex();

    assert.equal(document.getElementById("hashError").hidden, false);
    assert.match(document.getElementById("hashError").textContent, /nonexistent feast xyz/i);
    assert.match(document.getElementById("hashError").textContent, /not in current database/);
    assert.equal(document.getElementById("typeSelect").value, "tempora");
  });

  test("a _missalette-booklet suffix checks for the booklet asset and offers it for download on confirm", async () => {
    const dom = await loadPage({
      fetchImpl: withFakeRelease([
        {
          name: "Dominica-I-Adventus_missalette-booklet.pdf",
          browser_download_url: "https://example.com/booklet.pdf",
        },
      ]),
    });
    const { window, document } = dom.window;
    window.location.hash = "#Dominica-I-Adventus_missalette-booklet";
    const confirmCalls = [];
    const openCalls = [];
    window.confirm = (msg) => {
      confirmCalls.push(msg);
      return true;
    };
    window.open = (url) => openCalls.push(url);

    await window.loadIndex();

    assert.deepEqual(confirmCalls, ["Download missalette (booklet) of Dominica I Adventus?"]);
    assert.deepEqual(openCalls, ["https://example.com/booklet.pdf"]);
  });

  test("declining the download confirm does not open anything", async () => {
    const dom = await loadPage({
      fetchImpl: withFakeRelease([
        {
          name: "Dominica-I-Adventus_missalette-a4.pdf",
          browser_download_url: "https://example.com/a4.pdf",
        },
      ]),
    });
    const { window, document } = dom.window;
    window.location.hash = "#Dominica-I-Adventus";
    const openCalls = [];
    window.confirm = () => false;
    window.open = (url) => openCalls.push(url);

    await window.loadIndex();

    assert.deepEqual(openCalls, []);
  });

  test("no matching release asset means no download prompt at all", async () => {
    const dom = await loadPage({ fetchImpl: withFakeRelease([]) });
    const { window, document } = dom.window;
    window.location.hash = "#Dominica-I-Adventus";
    window.confirm = () => {
      throw new Error("shouldn't be called -- no asset was configured");
    };

    await assert.doesNotReject(() => window.loadIndex());
    assert.equal(document.getElementById("epFeast").value, "Dominica I Adventus");
  });
});
