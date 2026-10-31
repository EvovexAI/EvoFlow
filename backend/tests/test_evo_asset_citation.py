from evoflow.assets.citation import extract_evo_asset_citations, strip_evo_asset_citations


def test_strip_proper_xml_block():
    raw = (
        "结论如下。\n\n"
        "<evo-asset-citation>\n"
        "<citation_entries>\n"
        "memory/facts/foo.md:1-3|note=[偏好]\n"
        "</citation_entries>\n"
        "</evo-asset-citation>"
    )
    parsed = extract_evo_asset_citations(raw)
    assert parsed["text"].strip() == "结论如下。"
    assert parsed["entries"][0]["path"] == "memory/facts/foo.md"
    assert parsed["entries"][0]["note"] == "偏好"


def test_strip_loose_citation_entries_kb_leak():
    raw = (
        "已核对报价。\n\n"
        "citation_entries: kb_ed4de5d2768e4a398753533ea7ed5234 | note=["
        "参考图实物一致性、assetPublicBaseUrl 阻塞、category 跑偏处理、报价 cost 为 null]"
    )
    assert strip_evo_asset_citations(raw) == "已核对报价。"
    parsed = extract_evo_asset_citations(raw)
    assert parsed["entries"][0]["path"] == "kb_ed4de5d2768e4a398753533ea7ed5234"


def test_strip_orphan_citation_entries():
    raw = "正文\n\n<citation_entries>\nmemory/a.md|note=[x]\n</citation_entries>"
    parsed = extract_evo_asset_citations(raw)
    assert parsed["text"].strip() == "正文"
    assert parsed["entries"][0]["path"] == "memory/a.md"


def test_tolerate_spaces_around_note():
    raw = (
        "<evo-asset-citation>\n"
        "<citation_entries>\n"
        "craft/x.md | note=[简要]\n"
        "</citation_entries>\n"
        "</evo-asset-citation>"
    )
    parsed = extract_evo_asset_citations(raw)
    assert parsed["entries"][0]["path"] == "craft/x.md"
    assert parsed["entries"][0]["note"] == "简要"


def test_strips_markdown_list_markers_on_paths():
    raw = (
        "<evo-asset-citation>\n"
        "<citation_entries>\n"
        "- memory/_inbox/notes/experience-foo.md | note=[本轮新沉淀]\n"
        "* craft/continuity-report-chain.md|note=[场记]\n"
        "</citation_entries>\n"
        "</evo-asset-citation>"
    )
    parsed = extract_evo_asset_citations(raw)
    assert [e["path"] for e in parsed["entries"]] == [
        "memory/_inbox/notes/experience-foo.md",
        "craft/continuity-report-chain.md",
    ]
    assert parsed["entries"][0]["note"] == "本轮新沉淀"
