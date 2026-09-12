"""Internal refs for Python / JS / TS / Java."""

from pathlib import Path

from evoflow.code_index.internal_refs import (
    extract_internal_refs,
    extract_js_ts_internal_refs,
    extract_python_internal_refs,
)
from evoflow.code_index.store import build_index, search_index


def test_python_attr_ref(tmp_path: Path):
    (tmp_path / "lib.py").write_text("VALUE = 1\n", encoding="utf-8")
    main = tmp_path / "main.py"
    main.write_text("import lib\n\ndef run():\n    return lib.VALUE\n", encoding="utf-8")
    refs = extract_python_internal_refs(main, main.read_text(encoding="utf-8"), tmp_path)
    assert any(r.get("symbol") == "lib.VALUE" and r.get("to_path") == "lib.py" for r in refs)


def test_ts_import_use(tmp_path: Path):
    (tmp_path / "util.ts").write_text("export const x = 1;\n", encoding="utf-8")
    main = tmp_path / "app.ts"
    main.write_text("import { x } from './util';\nconsole.log(x);\n", encoding="utf-8")
    refs = extract_js_ts_internal_refs(main, main.read_text(encoding="utf-8"), tmp_path)
    assert any(r.get("to_path") == "util.ts" for r in refs)


def test_java_type_use(tmp_path: Path):
    src = tmp_path / "com" / "example"
    src.mkdir(parents=True)
    (src / "Foo.java").write_text("package com.example;\npublic class Foo {}\n", encoding="utf-8")
    bar = src / "Bar.java"
    bar.write_text(
        "package com.example;\nimport com.example.Foo;\npublic class Bar { Foo f; }\n",
        encoding="utf-8",
    )
    refs = extract_internal_refs(bar, bar.read_text(encoding="utf-8"), tmp_path)
    assert any(r.get("to_path") == "com/example/Foo.java" for r in refs)


def test_build_index_internal_refs_search(tmp_path: Path):
    (tmp_path / "lib.py").write_text("VALUE = 1\n", encoding="utf-8")
    (tmp_path / "main.py").write_text("import lib\nx = lib.VALUE\n", encoding="utf-8")
    build_index(str(tmp_path), force=True)
    data = search_index(str(tmp_path), "VALUE", limit=10)
    users = data.get("internal_ref_users") or []
    assert any(u.get("from_path") == "main.py" and u.get("to_path") == "lib.py" for u in users)
