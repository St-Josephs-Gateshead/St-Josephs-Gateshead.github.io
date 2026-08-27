import generate


class TestLatexEscape:
    def test_empty_and_none(self):
        assert generate._latex_escape(None) == ""
        assert generate._latex_escape("") == ""

    def test_no_special_chars_unchanged(self):
        assert generate._latex_escape("Missa Cantata") == "Missa Cantata"

    def test_ampersand(self):
        # "&" is a reserved LaTeX alignment character outside tables.
        assert generate._latex_escape("Graduale & Alleluia") == r"Graduale \& Alleluia"

    def test_all_specials_single_pass(self):
        # Several replacements introduce a backslash or brace of their own
        # (e.g. "&" -> "\&", "^" -> "\textasciicircum{}"). A naive sequential
        # str.replace() chain would re-escape those; str.translate() must not.
        s = generate._latex_escape("100% $5 #1 _x_ ~y^z \\ {a} }b{")
        assert s == (
            r"100\% \$5 \#1 \_x\_ \textasciitilde{}y\textasciicircum{}z "
            r"\textbackslash{} \{a\} \}b\{"
        )

    def test_non_string_input_is_stringified(self):
        assert generate._latex_escape(123) == "123"


class TestSegmentOrdo:
    def test_basic_title_and_items(self):
        ordo = [
            {"type": "title", "text": "Introitus"},
            {"type": "music", "gabc": "...", "targets": ["missalette"]},
        ]
        assert generate._segment_ordo(ordo, "missalette") == [
            {"title": "Introitus", "items": [ordo[1]]},
        ]

    def test_filters_by_target(self):
        ordo = [
            {"type": "title", "text": "Kyrie"},
            {"type": "music", "gabc": "...", "targets": ["pewsheet"]},
        ]
        assert generate._segment_ordo(ordo, "missalette") == []

    def test_drops_empty_rubric_text(self):
        ordo = [
            {"type": "title", "text": "Section"},
            {"type": "rubric", "text": "", "targets": ["missalette"]},
        ]
        assert generate._segment_ordo(ordo, "missalette") == []

    def test_keeps_nonempty_rubric(self):
        ordo = [
            {"type": "title", "text": "Section"},
            {"type": "rubric", "text": "Stand.", "targets": ["missalette"]},
        ]
        blocks = generate._segment_ordo(ordo, "missalette")
        assert len(blocks) == 1
        assert blocks[0]["title"] == "Section"

    def test_untitled_leading_items_have_no_title_key(self):
        ordo = [{"type": "music", "gabc": "...", "targets": ["missalette"]}]
        blocks = generate._segment_ordo(ordo, "missalette")
        assert "title" not in blocks[0]
        assert blocks[0]["items"] == ordo

    def test_multiple_titles_segment_independently(self):
        ordo = [
            {"type": "title", "text": "A"},
            {"type": "music", "gabc": "a", "targets": ["missalette"]},
            {"type": "title", "text": "B"},
            {"type": "music", "gabc": "b", "targets": ["missalette"]},
        ]
        blocks = generate._segment_ordo(ordo, "missalette")
        assert [b["title"] for b in blocks] == ["A", "B"]


class TestBuildVersion:
    def test_uses_pipeline_version_and_dates(self):
        data = {
            "pipeline_version": "v1.2.3",
            "data_updated": {
                "do": "2026-01-01T00:00:00Z",
                "gregobase": "2026-02-02T00:00:00Z",
            },
        }
        assert generate._build_version(data) == "v1.2.3  ·  DO 2026-01-01  ·  GB 2026-02-02"

    def test_no_pipeline_version_falls_back_to_git(self, monkeypatch):
        monkeypatch.setattr(generate, "_git_version", lambda: "abc123")
        assert generate._build_version({}) == "abc123"

    def test_no_version_and_no_git_gives_empty_string(self, monkeypatch):
        monkeypatch.setattr(generate, "_git_version", lambda: "")
        assert generate._build_version({}) == ""

    def test_dates_only_no_version(self, monkeypatch):
        monkeypatch.setattr(generate, "_git_version", lambda: "")
        data = {"data_updated": {"do": "2026-03-04T12:00:00Z"}}
        assert generate._build_version(data) == "DO 2026-03-04"
