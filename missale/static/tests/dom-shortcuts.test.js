const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, realDataFetch } = require("./dom-harness.js");

function ctrlKey(document, window, key, extra = {}) {
  document.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...extra,
    }),
  );
}

describe("Ctrl+Z / Ctrl+Y keyboard shortcuts", () => {
  test("Ctrl+Z undoes, Ctrl+Y redoes", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    const countBefore = document.querySelectorAll("#main .obj-wrap").length;

    document.querySelectorAll("#main .obj-wrap")[0].querySelector(".ctrl-btn.delete").click();
    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countBefore - 1);

    ctrlKey(document, window, "z");
    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countBefore);

    ctrlKey(document, window, "y");
    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countBefore - 1);
  });

  test("Ctrl+Shift+Z also redoes", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    const countBefore = document.querySelectorAll("#main .obj-wrap").length;

    document.querySelectorAll("#main .obj-wrap")[0].querySelector(".ctrl-btn.delete").click();
    ctrlKey(document, window, "z");
    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countBefore);

    ctrlKey(document, window, "z", { shiftKey: true });
    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countBefore - 1);
  });

  test("Ctrl+Z is left to the browser's native undo when focus is in an editable field", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    document.querySelectorAll("#main .obj-wrap")[0].querySelector(".ctrl-btn.delete").click();
    const countAfterDelete = document.querySelectorAll("#main .obj-wrap").length;

    const feastInput = document.getElementById("epFeast");
    const ev = new window.KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    feastInput.dispatchEvent(ev);

    // Our handler must not have intercepted this -- the app-level undo stack
    // stays untouched, since a real browser would run its native field undo
    // instead.
    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countAfterDelete);
    assert.equal(document.getElementById("undoBtn").disabled, false);
  });
});
