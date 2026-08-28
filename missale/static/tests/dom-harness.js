/**
 * Loads the real index.html + pure.js + app.js into a jsdom window, the
 * same way a browser would via <script src>, so tests exercise the actual
 * DOM-coupled code instead of a hand-rolled fake.
 *
 * Two things are deliberately stubbed rather than left real:
 *   - The external https://ex.surge.sh/exsurge.js <script> tag is stripped
 *     before jsdom ever sees the HTML, so tests never touch the network.
 *     app.js already has a fallback path for exsurge being unavailable
 *     (exsurgeReady becomes false) -- this exercises exactly that path.
 *   - `fetch` is replaced with whatever the caller passes as `fetchImpl`
 *     (default: reject everything), installed via jsdom's `beforeParse`
 *     hook so it's in place before app.js's top-level `loadIndex()` call
 *     runs at parse time.
 */

const fs = require("fs");
const path = require("path");
const { JSDOM, ResourceLoader } = require("jsdom");

const ROOT = path.join(__dirname, "..", "..", "..");
const INDEX_HTML_PATH = path.join(ROOT, "index.html");

function defaultFetch(url) {
  return Promise.reject(new Error(`dom-harness: unexpected fetch(${url}) -- pass fetchImpl`));
}

// app.js's fetchText/fetchJSON always call fetch() with a plain repo-relative
// path (e.g. "missale/data/tempora.csv", "missale/data/propers/tempora/Adv1-0.json")
// -- window.fetch is fully replaced here, not the real browser fetch, so
// there's no URL resolution to worry about; the string arrives as-is.
// Serving the real files off disk means tests exercise the actual rendering
// pipeline against real production data, not a hand-maintained fixture that
// can drift from it.
async function realDataFetch(url) {
  const rel = String(url).replace(/^\/+/, "");
  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) {
    return { ok: false, status: 404, text: async () => "", json: async () => { throw new Error(`404: ${url}`); } };
  }
  const content = fs.readFileSync(filePath, "utf8");
  return { ok: true, status: 200, text: async () => content, json: async () => JSON.parse(content) };
}

// index.html's own <script src> tags are repo-relative ("missale/static/...").
// The document's own url is an http(s) placeholder (so location.hostname
// behaves like a real deployment), which real fetch/XHR can't resolve
// against the filesystem -- so <script src> loads are intercepted here and
// served straight off disk instead. Nothing else is allowed to leave the
// process.
class LocalScriptsOnly extends ResourceLoader {
  fetch(url, options) {
    const m = url.match(/^https?:\/\/[^/]+\/(missale\/static\/[\w.-]+\.js)$/);
    if (m) {
      return fs.promises.readFile(path.join(ROOT, m[1]));
    }
    return Promise.reject(new Error(`dom-harness: refusing to fetch resource ${url}`));
  }
}

function loadPage({ fetchImpl = defaultFetch, hostname = "example.com" } = {}) {
  const html = fs
    .readFileSync(INDEX_HTML_PATH, "utf8")
    .replace(/<script src="https:\/\/ex\.surge\.sh\/exsurge\.js"><\/script>\n?/, "")
    // Google Fonts <link>s: real network requests jsdom would otherwise
    // wait on (slowly) before the load event fires. Cosmetic only.
    .replace(/<link rel="preconnect"[^>]*>\n?/, "")
    .replace(/<link\s+rel="stylesheet"\s+href="https:\/\/fonts\.googleapis\.com[^"]*"\s*\/>\n?/, "");

  return new Promise((resolve, reject) => {
    const dom = new JSDOM(html, {
      url: `http://${hostname}/`,
      runScripts: "dangerously",
      resources: new LocalScriptsOnly(),
      pretendToBeVisual: true,
      beforeParse(window) {
        window.fetch = fetchImpl;
        window.IntersectionObserver = class {
          observe() {}
          unobserve() {}
          disconnect() {}
        };
      },
    });

    // <script src> loading (via the resource loader above) is async, even
    // though execution of an already-fetched script is synchronous -- so
    // app.js's top-level bindings aren't necessarily on `window` yet the
    // instant `new JSDOM(...)` returns. Wait for the window's load event,
    // same as a real browser waiting for every subresource to finish.
    dom.window.addEventListener("load", () => resolve(dom));
    dom.window.addEventListener("error", (e) => reject(e.error || e));
  });
}

module.exports = { loadPage, realDataFetch };
