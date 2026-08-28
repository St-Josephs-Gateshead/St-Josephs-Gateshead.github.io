const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanGabc,
  _keyLabel,
  _modeAnnotation,
  _latinFromGabc,
  _gabcForExsurge,
  _renderTex,
  _htmlToTex,
  shouldKeepSegment,
} = require("../pure.js");

describe("cleanGabc", () => {
  test("null/empty input", () => {
    assert.equal(cleanGabc(null), "");
    assert.equal(cleanGabc(""), "");
  });

  test("strips [bracketed] editorial comments", () => {
    assert.equal(cleanGabc("[a comment] Kyrie"), " Kyrie");
  });

  test("V/. versicle marker", () => {
    assert.equal(cleanGabc("<sp>V/</sp>. Dominus"), "V/. Dominus");
  });

  test("ae/oe ligatures", () => {
    assert.equal(cleanGabc("<sp>'ae</sp>t"), "ǽt");
    assert.equal(cleanGabc("<sp>oe</sp>"), "œ");
  });

  test("italic and small-caps markers", () => {
    assert.equal(cleanGabc("<i>word</i>"), "_word_");
    assert.equal(cleanGabc("<sc>word</sc>"), "%word%");
  });

  test("unrecognised tags are stripped, content kept", () => {
    assert.equal(cleanGabc("<v>stray</v>"), "stray");
  });

  test("bare * gets a following () added, but not if already there", () => {
    assert.equal(cleanGabc("word* more"), "word*() more");
    assert.equal(cleanGabc("word*() more"), "word*() more");
  });
});

describe("_keyLabel", () => {
  test("splits on _ and - and title-cases each word", () => {
    assert.equal(_keyLabel("hello_world"), "Hello World");
    assert.equal(_keyLabel("foo-bar_baz"), "Foo Bar Baz");
  });

  test("single word", () => {
    assert.equal(_keyLabel("already"), "Already");
  });

  test("empty string", () => {
    assert.equal(_keyLabel(""), "");
  });

  test("doesn't throw on empty segments from a doubled separator", () => {
    assert.equal(_keyLabel("a__b"), "A  B");
  });
});

describe("_modeAnnotation", () => {
  test("falsy mode returns null", () => {
    assert.equal(_modeAnnotation(null), null);
    assert.equal(_modeAnnotation(0), null);
    assert.equal(_modeAnnotation(""), null);
  });

  test("valid mode number renders as roman numeral", () => {
    assert.equal(_modeAnnotation("5"), "V");
    assert.equal(_modeAnnotation(3), "III");
  });

  test("keeps a trailing letter suffix", () => {
    assert.equal(_modeAnnotation("5a"), "Va");
  });

  test("out of 1-8 range returns null even though the string is truthy", () => {
    assert.equal(_modeAnnotation("9"), null);
    // "0" is a non-empty string (truthy) unlike the number 0 above, so this
    // exercises the range check rather than the falsy short-circuit.
    assert.equal(_modeAnnotation("0"), null);
  });

  test("non-numeric mode returns null", () => {
    assert.equal(_modeAnnotation("abc"), null);
  });
});

describe("_latinFromGabc", () => {
  test("strips (note group) parens", () => {
    assert.equal(_latinFromGabc("Ký(g)ri(h)e(hg)"), "Kýrie");
  });

  test("unwraps {word}", () => {
    assert.equal(_latinFromGabc("{Al}leluia"), "Alleluia");
  });

  test("strips HTML tags but keeps their text", () => {
    assert.equal(_latinFromGabc("Al<i>le</i>luia"), "Alleluia");
  });

  test("neume marks become spaces", () => {
    assert.equal(_latinFromGabc("Ký*ri:e;a|b"), "Ký ri e a b");
  });

  test("collapses and trims whitespace", () => {
    assert.equal(_latinFromGabc("  extra   spaces  "), "extra spaces");
  });
});

describe("_gabcForExsurge", () => {
  test("V/. versicle marker, same as cleanGabc", () => {
    assert.equal(_gabcForExsurge("<sp>V/</sp>. Dominus"), "V/. Dominus");
  });

  test("unlike cleanGabc, a generic <sp> span is deleted entirely (content and all)", () => {
    assert.equal(_gabcForExsurge("<sp>vobiscum</sp>"), "");
  });

  test("italic and small-caps markers", () => {
    assert.equal(_gabcForExsurge("<i>word</i>"), "_word_");
    assert.equal(_gabcForExsurge("<sc>word</sc>"), "%word%");
  });

  test("unrecognised tags are stripped, content kept", () => {
    assert.equal(_gabcForExsurge("<v>x</v>"), "x");
  });
});

describe("_renderTex", () => {
  test("null/empty input", () => {
    assert.equal(_renderTex(null), "");
    assert.equal(_renderTex(""), "");
  });

  test("\\textit{} and \\textbf{}", () => {
    assert.equal(_renderTex("\\textit{word}"), "<em>word</em>");
    assert.equal(_renderTex("\\textbf{word}"), "<strong>word</strong>");
  });

  test("{\\it ...} and {\\bf ...} alternate TeX syntax", () => {
    assert.equal(_renderTex("{\\it word}"), "<em>word</em>");
    assert.equal(_renderTex("{\\bf word}"), "<strong>word</strong>");
  });

  test("newlines become <br>", () => {
    assert.equal(_renderTex("line1\nline2"), "line1<br>line2");
  });
});

describe("_htmlToTex", () => {
  test("null/empty input", () => {
    assert.equal(_htmlToTex(null), "");
    assert.equal(_htmlToTex(""), "");
  });

  test("<em>/<i> and <strong>/<b> round-trip to \\textit/\\textbf", () => {
    assert.equal(_htmlToTex("<em>word</em>"), "\\textit{word}");
    assert.equal(_htmlToTex("<i>word</i>"), "\\textit{word}");
    assert.equal(_htmlToTex("<strong>word</strong>"), "\\textbf{word}");
    assert.equal(_htmlToTex("<b>word</b>"), "\\textbf{word}");
  });

  test("<br> becomes a TeX linebreak, with the trailing newline trimmed off", () => {
    assert.equal(_htmlToTex("<br>"), "\\\\");
  });

  test("<div> also becomes a TeX linebreak, and its closing tag is stripped", () => {
    assert.equal(_htmlToTex("a<div>b</div>"), "a\\\\\nb");
  });

  test("HTML entities are decoded", () => {
    assert.equal(_htmlToTex("Fish &amp; chips"), "Fish & chips");
  });

  test("tag-stripping runs before entity-decoding, so a decoded entity can't be mistaken for a real tag", () => {
    assert.equal(_htmlToTex("&lt;tag&gt;"), "<tag>");
  });

  test("&nbsp; alone trims away to nothing", () => {
    assert.equal(_htmlToTex("&nbsp;"), "");
  });

  test("trims surrounding whitespace", () => {
    assert.equal(_htmlToTex("  padded  "), "padded");
  });
});

describe("shouldKeepSegment", () => {
  test("an empty segment is always dropped, regardless of the flag", () => {
    assert.equal(shouldKeepSegment([], false), false);
    assert.equal(shouldKeepSegment([], true), false);
  });

  test("a title+rubric orphaned by an unresolved Ordinary choice is dropped", () => {
    // e.g. "Kyrie" title + "Immediately after the Introit:" rubric, with no
    // Kyrie setting chosen — the rubric resolves but the music does not.
    assert.equal(shouldKeepSegment([{ type: "rubric" }], true), false);
  });

  test("a user-added rubric-only section that never had an Ordinary slot is kept", () => {
    assert.equal(shouldKeepSegment([{ type: "rubric" }], false), true);
  });

  test("a resolved Ordinary choice (or any other resolved music) is kept", () => {
    assert.equal(shouldKeepSegment([{ type: "music" }], true), true);
  });

  test("mixed segment with both a rubric and resolved music is kept", () => {
    assert.equal(
      shouldKeepSegment([{ type: "rubric" }, { type: "music" }], true),
      true,
    );
  });
});
