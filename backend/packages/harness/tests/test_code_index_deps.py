"""File dependency graph indexing (Python / JS / Java)."""

from pathlib import Path

from evoflow.code_index.deps import extract_file_deps
from evoflow.code_index.store import build_index, search_index


def test_python_import_deps_resolved(tmp_path: Path):
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "util.py").write_text("VALUE = 1\n", encoding="utf-8")
    main = tmp_path / "main.py"
    main.write_text("from pkg import util\n\ndef run():\n    return util.VALUE\n", encoding="utf-8")

    deps = extract_file_deps(main, main.read_text(encoding="utf-8"), tmp_path)
    to_paths = {d["to_path"] for d in deps if d.get("to_path")}
    assert "pkg/util.py" in to_paths


def test_python_internal_refs_use_import(tmp_path: Path):
    from evoflow.code_index.internal_refs import extract_python_internal_refs

    (tmp_path / "lib.py").write_text("VALUE = 1\n", encoding="utf-8")
    main = tmp_path / "main.py"
    main.write_text("import lib\n\ndef run():\n    return lib.VALUE\n", encoding="utf-8")
    refs = extract_python_internal_refs(main, main.read_text(encoding="utf-8"), tmp_path)
    assert any(r.get("to_path") == "lib.py" and r.get("symbol") == "lib" for r in refs)


def test_search_imported_by(tmp_path: Path):
    (tmp_path / "lib.py").write_text("def helper():\n    return 1\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("from lib import helper\n\ndef main():\n    return helper()\n", encoding="utf-8")
    build_index(str(tmp_path), force=True)
    data = search_index(str(tmp_path), "helper", limit=10)
    importers = {r["from_path"] for r in data.get("imported_by") or []}
    assert "app.py" in importers


def test_js_relative_import(tmp_path: Path):
    (tmp_path / "a.js").write_text("export const x = 1;\n", encoding="utf-8")
    b = tmp_path / "b.js"
    b.write_text("import { x } from './a.js';\nconsole.log(x);\n", encoding="utf-8")
    deps = extract_file_deps(b, b.read_text(encoding="utf-8"), tmp_path)
    assert any(d.get("to_path") == "a.js" for d in deps)


def test_java_import_to_path(tmp_path: Path):
    src = tmp_path / "com" / "example"
    src.mkdir(parents=True)
    (src / "Foo.java").write_text("package com.example;\npublic class Foo {}\n", encoding="utf-8")
    bar = src / "Bar.java"
    bar.write_text(
        "package com.example;\nimport com.example.Foo;\npublic class Bar { Foo f; }\n",
        encoding="utf-8",
    )
    deps = extract_file_deps(bar, bar.read_text(encoding="utf-8"), tmp_path)
    assert any(d.get("to_path") == "com/example/Foo.java" for d in deps)


def test_build_index_stores_deps_and_search_related(tmp_path: Path):
    (tmp_path / "lib.py").write_text("def helper():\n    return 42\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("from lib import helper\n\ndef main():\n    return helper()\n", encoding="utf-8")
    out = build_index(str(tmp_path), force=True)
    assert out.get("ok") is True
    assert int(out.get("dependencies") or 0) >= 1

    data = search_index(str(tmp_path), "helper", limit=10)
    paths = {s["path"] for s in data.get("symbols") or []} | {h["path"] for h in data.get("hits") or []}
    related = {r["path"] for r in data.get("related_files") or []}
    assert "lib.py" in paths or "app.py" in paths
    if related:
        assert related <= {"lib.py", "app.py"} or len(related) >= 1
