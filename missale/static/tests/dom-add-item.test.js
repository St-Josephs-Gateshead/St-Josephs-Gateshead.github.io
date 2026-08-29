const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, realDataFetch } = require("./dom-harness.js");

// Covers the bottom-of-page "+" add-zone form (_mkItemForm/mkObjZone) for
// Title, Rubric, and Text -- Music is covered separately in
// dom-chant-search.test.js, since it additionally branches into a
// chant-index search UI backed by network calls.

describe("add-zone: creating a new item", () => {
  test("the Add button starts disabled and enables once the (default) Rubric field has text", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");

    document.querySelector(".add-zone .add-btn").click();
    const form = document.querySelector(".add-form");
    assert.ok(form);
    assert.equal(
      [...form.querySelectorAll(".type-row .ep-btn")].find((b) => b.classList.contains("active"))
        .textContent,
      "Rubric",
    );
    const addBtn = form.querySelector(".btn-confirm");
    assert.equal(addBtn.disabled, true);

    const rubricField = form.querySelectorAll(".add-form-field")[1].querySelector("textarea");
    rubricField.value = "A test rubric";
    rubricField.dispatchEvent(new window.Event("input"));

    assert.equal(addBtn.disabled, false);
  });

  test("adding a Rubric appends it just before the add-zone, and Undo removes it again", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    const countBefore = document.querySelectorAll("#main .obj-wrap").length;

    document.querySelector(".add-zone .add-btn").click();
    const form = document.querySelector(".add-form");
    const rubricField = form.querySelectorAll(".add-form-field")[1].querySelector("textarea");
    rubricField.value = "A test rubric";
    rubricField.dispatchEvent(new window.Event("input"));
    form.querySelector(".btn-confirm").click();

    assert.equal(document.querySelector(".add-form"), null);
    const wraps = [...document.querySelectorAll("#main .obj-wrap")];
    assert.equal(wraps.length, countBefore + 1);
    const newWrap = wraps[wraps.length - 1];
    assert.equal(newWrap.querySelector(".prelude-rubric")?.textContent, "A test rubric");
    assert.equal(document.getElementById("undoBtn").disabled, false);

    window._doUndo();

    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countBefore);
  });

  test("adding a Title item requires no text field to be filled", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    const countBefore = document.querySelectorAll("#main .obj-wrap").length;

    document.querySelector(".add-zone .add-btn").click();
    const form = document.querySelector(".add-form");
    [...form.querySelectorAll(".type-row .ep-btn")].find((b) => b.textContent === "Title").click();
    const addBtn = form.querySelector(".btn-confirm");
    assert.equal(addBtn.disabled, false);

    addBtn.click();

    const wraps = [...document.querySelectorAll("#main .obj-wrap")];
    assert.equal(wraps.length, countBefore + 1);
    assert.equal(wraps[wraps.length - 1].querySelector(".section-title")?.textContent, "");
  });

  test("adding a Text item with no language selected requires only Latin, not a translation", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    assert.equal(document.getElementById("langSelect").value, "");
    const countBefore = document.querySelectorAll("#main .obj-wrap").length;

    document.querySelector(".add-zone .add-btn").click();
    const form = document.querySelector(".add-form");
    [...form.querySelectorAll(".type-row .ep-btn")].find((b) => b.textContent === "Text").click();
    const latinField = form.querySelectorAll(".add-form-field")[2].querySelector("textarea");
    latinField.value = "Dominus vobiscum.";
    latinField.dispatchEvent(new window.Event("input"));
    const addBtn = form.querySelector(".btn-confirm");
    assert.equal(addBtn.disabled, false);

    addBtn.click();

    const wraps = [...document.querySelectorAll("#main .obj-wrap")];
    assert.equal(wraps.length, countBefore + 1);
    assert.equal(wraps[wraps.length - 1].querySelector(".text-la")?.textContent, "Dominus vobiscum.");
  });

  test("Cancel removes the form without changing the item count", async () => {
    const dom = await loadPage({ fetchImpl: realDataFetch });
    const { window, document } = dom.window;
    await window.loadIndex();
    await window.loadMass("tempora", "Adv1-0");
    const countBefore = document.querySelectorAll("#main .obj-wrap").length;

    document.querySelector(".add-zone .add-btn").click();
    const form = document.querySelector(".add-form");
    [...form.querySelectorAll(".add-form-actions button")]
      .find((b) => b.textContent === "Cancel")
      .click();

    assert.equal(document.querySelector(".add-form"), null);
    assert.equal(document.querySelectorAll("#main .obj-wrap").length, countBefore);
  });
});
