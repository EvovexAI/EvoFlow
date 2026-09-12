"""Type extends/implements indexing."""

from pathlib import Path

from evoflow.code_index.store import build_index, search_index
from evoflow.code_index.type_relations import extract_python_type_relations, extract_type_relations


def test_python_class_extends(tmp_path: Path):
    base = tmp_path / "base.py"
    base.write_text("class Base:\n    pass\n", encoding="utf-8")
    child = tmp_path / "child.py"
    child.write_text("from base import Base\n\nclass Child(Base):\n    pass\n", encoding="utf-8")
    rows = extract_python_type_relations(child, child.read_text(encoding="utf-8"), tmp_path)
    assert any(r.get("from_type") == "Child" and r.get("to_type") == "Base" for r in rows)


def test_ts_class_extends(tmp_path: Path):
    (tmp_path / "base.ts").write_text("export class Base {}\n", encoding="utf-8")
    child = tmp_path / "child.ts"
    child.write_text("import { Base } from './base';\nexport class Child extends Base {}\n", encoding="utf-8")
    rows = extract_type_relations(child, child.read_text(encoding="utf-8"), tmp_path)
    assert any(r.get("from_type") == "Child" and r.get("rel_kind") == "extends" and r.get("to_path") == "base.ts" for r in rows)


def test_ts_implements_type_import_cross_file(tmp_path: Path):
    (tmp_path / "types.ts").write_text("export interface IUser { id: string }\n", encoding="utf-8")
    app = tmp_path / "app.ts"
    app.write_text(
        "import type { IUser } from './types';\nexport class UserService implements IUser {}\n",
        encoding="utf-8",
    )
    rows = extract_type_relations(app, app.read_text(encoding="utf-8"), tmp_path)
    assert any(r.get("rel_kind") == "implements" and r.get("to_type") == "IUser" and r.get("to_path") == "types.ts" for r in rows)


def test_ts_implements_namespace_qualifier(tmp_path: Path):
    (tmp_path / "types.ts").write_text("export interface IFoo { run(): void }\n", encoding="utf-8")
    app = tmp_path / "app.ts"
    app.write_text(
        "import * as Types from './types';\nexport class App implements Types.IFoo {}\n",
        encoding="utf-8",
    )
    rows = extract_type_relations(app, app.read_text(encoding="utf-8"), tmp_path)
    assert any(r.get("rel_kind") == "implements" and r.get("to_type") == "IFoo" and r.get("to_path") == "types.ts" for r in rows)


def test_java_implements(tmp_path: Path):
    src = tmp_path / "com" / "example"
    src.mkdir(parents=True)
    (src / "Iface.java").write_text("package com.example;\npublic interface Iface {}\n", encoding="utf-8")
    impl = src / "Impl.java"
    impl.write_text(
        "package com.example;\npublic class Impl implements Iface {}\n",
        encoding="utf-8",
    )
    rows = extract_type_relations(impl, impl.read_text(encoding="utf-8"), tmp_path)
    assert any(r.get("from_type") == "Impl" and r.get("rel_kind") == "implements" for r in rows)


def test_search_type_subtypes_by_path(tmp_path: Path):
    (tmp_path / "base.py").write_text("class Base:\n    pass\n", encoding="utf-8")
    (tmp_path / "child.py").write_text("from base import Base\n\nclass Child(Base):\n    pass\n", encoding="utf-8")
    build_index(str(tmp_path), force=True)
    data = search_index(str(tmp_path), "base", limit=10)
    subs = data.get("type_subtypes") or []
    assert any(s.get("from_type") == "Child" for s in subs)


def test_search_type_relations_by_symbol_name(tmp_path: Path):
    (tmp_path / "base.py").write_text("class Base:\n    pass\n", encoding="utf-8")
    (tmp_path / "child.py").write_text("from base import Base\n\nclass Child(Base):\n    pass\n", encoding="utf-8")
    build_index(str(tmp_path), force=True)
    data = search_index(str(tmp_path), "Base", limit=10)
    subs = data.get("type_subtypes") or []
    assert any(s.get("from_type") == "Child" and s.get("to_type") == "Base" for s in subs)
