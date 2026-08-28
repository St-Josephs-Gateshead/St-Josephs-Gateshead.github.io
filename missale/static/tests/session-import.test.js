const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  SESSION_EXPORT_FORMAT,
  SESSION_EXPORT_VERSION,
  validateImportedSession,
} = require("../pure.js");

function validDoc(overrides = {}) {
  return {
    _format: SESSION_EXPORT_FORMAT,
    _version: SESSION_EXPORT_VERSION,
    mass_type: "tempora",
    path_name: "Adv1-0",
    feast: "Dominica I Adventus",
    subtitle: "Missa Cantata",
    rule: ["Gloria"],
    settings: { lang: "", ordNum: 0, credNum: 0, marianChoice: "", aspergesChoice: "" },
    ordo: [
      { type: "title", text: "Introitus", targets: ["missalette", "pewsheet"] },
      { type: "rubric", text: "Stand.", targets: ["missalette"] },
      { type: "music", gabc: "(c3) A(c)B(d)", targets: ["missalette"] },
      { type: "music", ordinary: "kyrie", targets: ["missalette"] },
      { type: "text", latin: "Dóminus vobíscum.", targets: ["missalette"] },
      { type: "text", ordinary: "asperges", targets: ["missalette", "pewsheet"] },
    ],
    ...overrides,
  };
}

describe("validateImportedSession — accepts good input", () => {
  test("a well-formed export has no errors", () => {
    assert.deepEqual(validateImportedSession(validDoc()), []);
  });

  test("targets/rule are optional", () => {
    const doc = validDoc();
    delete doc.rule;
    doc.ordo.forEach((i) => delete i.targets);
    assert.deepEqual(validateImportedSession(doc), []);
  });
});

describe("validateImportedSession — rejects bad input without crashing", () => {
  test("null / non-object", () => {
    assert.deepEqual(validateImportedSession(null), ["Not a valid JSON object."]);
    assert.deepEqual(validateImportedSession(undefined), ["Not a valid JSON object."]);
    assert.deepEqual(validateImportedSession("a string"), ["Not a valid JSON object."]);
    assert.deepEqual(validateImportedSession(42), ["Not a valid JSON object."]);
    assert.deepEqual(validateImportedSession([1, 2, 3]), ["Not a valid JSON object."]);
  });

  test("wrong or missing _format is flagged, not silently accepted", () => {
    const errors = validateImportedSession(validDoc({ _format: "some-other-tool" }));
    assert.ok(errors.some((e) => e.includes("_format")));
  });

  test("a file from a newer exporter version is flagged", () => {
    const errors = validateImportedSession(validDoc({ _version: SESSION_EXPORT_VERSION + 1 }));
    assert.ok(errors.some((e) => e.includes("newer version")));
  });

  test("missing ordo array", () => {
    const doc = validDoc();
    delete doc.ordo;
    const errors = validateImportedSession(doc);
    assert.ok(errors.some((e) => e.includes('"ordo"')));
  });

  test("ordo item that's not an object", () => {
    const errors = validateImportedSession(validDoc({ ordo: [null, "not an object", 5] }));
    assert.equal(errors.length, 3);
    errors.forEach((e) => assert.ok(e.includes("not an object")));
  });

  test("unknown item type", () => {
    const errors = validateImportedSession(
      validDoc({ ordo: [{ type: "script", text: "alert(1)" }] }),
    );
    assert.ok(errors.some((e) => e.includes('unknown type "script"')));
  });

  test("rubric without text", () => {
    const errors = validateImportedSession(validDoc({ ordo: [{ type: "rubric" }] }));
    assert.ok(errors.some((e) => e.includes("rubric item needs")));
  });

  test("music item with neither gabc nor ordinary", () => {
    const errors = validateImportedSession(validDoc({ ordo: [{ type: "music", targets: [] }] }));
    assert.ok(errors.some((e) => e.includes("music item needs")));
  });

  test("music item with non-string gabc", () => {
    const errors = validateImportedSession(validDoc({ ordo: [{ type: "music", gabc: 123 }] }));
    assert.ok(errors.some((e) => e.includes('music "gabc" must be a string')));
  });

  test("text item with neither latin nor ordinary", () => {
    const errors = validateImportedSession(validDoc({ ordo: [{ type: "text" }] }));
    assert.ok(errors.some((e) => e.includes("text item needs")));
  });

  test("targets that isn't a list", () => {
    const errors = validateImportedSession(
      validDoc({ ordo: [{ type: "title", text: "x", targets: "missalette" }] }),
    );
    assert.ok(errors.some((e) => e.includes('"targets" must be a list')));
  });

  test("feast/subtitle must be strings", () => {
    const errors = validateImportedSession(validDoc({ feast: 123, subtitle: null }));
    assert.ok(errors.some((e) => e.includes('"feast"')));
    assert.ok(errors.some((e) => e.includes('"subtitle"')));
  });

  test("multiple problems are all reported, not just the first", () => {
    const errors = validateImportedSession({ _format: "wrong", ordo: "not a list" });
    assert.ok(errors.length >= 2);
  });
});
