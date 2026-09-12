"""Heal drive-stripped Windows absolute paths in workspace file resolution."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.gateway.routers.workspaces import (
    _fuzzy_match_sibling_file,
    _heal_stripped_windows_absolute,
    _is_host_absolute,
    _normalize_rel_path,
    _resolve_workspace_file_target,
    _strip_embedded_workspace_root_prefix,
)


def test_is_host_absolute_windows_and_posix() -> None:
    assert _is_host_absolute("D:/dev/proj/x")
    assert _is_host_absolute("/Users/a/b")
    assert not _is_host_absolute(":/dev/proj/x")
    assert not _is_host_absolute("outputs/a.md")


def test_heal_stripped_windows_absolute(tmp_path: Path) -> None:
    root = tmp_path
    # Use a path that looks like D:/… when stringified — on Windows tmp_path already is.
    root_s = str(root.resolve()).replace("\\", "/")
    if not re.match(r"^[a-zA-Z]:/", root_s):
        pytest.skip("Windows-style root required for drive-letter heal")

    drive = root_s[0]
    sample = root / "output" / "smart-employee-test"
    sample.mkdir(parents=True)
    (sample / "a.txt").write_text("ok", encoding="utf-8")
    rel = f"{sample.as_posix().split(':', 1)[-1]}"  # `/Users…` or `/dev…` form without drive
    # Force colon-kept form: :/…
    colon_form = ":" + rel if rel.startswith("/") else f":/{rel}"
    healed = _heal_stripped_windows_absolute(colon_form, root_s)
    assert healed == sample.as_posix().replace("\\", "/") or healed == str(sample.resolve()).replace(
        "\\", "/"
    )

    slash_form = rel if rel.startswith("/") else f"/{rel}"
    healed2 = _heal_stripped_windows_absolute(slash_form, root_s)
    assert healed2 is not None
    assert healed2.lower().startswith(f"{drive.lower()}:/")


def test_resolve_does_not_join_colon_stripped_path(tmp_path: Path) -> None:
    root = tmp_path
    root_s = str(root.resolve()).replace("\\", "/")
    if not re.match(r"^[a-zA-Z]:/", root_s):
        pytest.skip("Windows-style root required")

    f = root / "output" / "note.md"
    f.parent.mkdir(parents=True)
    f.write_text("hi", encoding="utf-8")
    stripped = ":" + f.as_posix().replace("\\", "/").split(":", 1)[-1]
    assert stripped.startswith(":/")
    target = _resolve_workspace_file_target(root=root_s, thread_id=None, rel=stripped)
    assert target.resolve() == f.resolve()
    # Reject mangled joins like ``D:\root\:\dev\…`` / ``…/:/…``, not the normal ``C:\`` drive form.
    joined = str(target).replace("\\", "/")
    assert "/:/" not in joined and not re.search(r":/[^/]", joined[2:] if len(joined) > 2 else "")


def test_normalize_keeps_windows_drive() -> None:
    assert _normalize_rel_path("D:/dev/github/EvoFlow/output/x") == "D:/dev/github/EvoFlow/output/x"


def test_strip_embedded_workspace_root_prefix() -> None:
    root = r"D:\dev\github\EvoFlow\outputs\smart-employee-test\workspace\qa-engineer"
    key = (
        "outputs/smart-employee-test/workspace/qa-engineer/"
        "docs/roles/qa-engineer/20260808-17/test_report.md"
    )
    assert (
        _strip_embedded_workspace_root_prefix(key, root)
        == "docs/roles/qa-engineer/20260808-17/test_report.md"
    )


def test_resolve_strips_embedded_root_before_join(tmp_path: Path) -> None:
    role = tmp_path / "outputs" / "app" / "workspace" / "qa-engineer"
    f = role / "docs" / "roles" / "qa-engineer" / "r.md"
    f.parent.mkdir(parents=True)
    f.write_text("ok", encoding="utf-8")
    root_s = str(role.resolve())
    bogus = "outputs/app/workspace/qa-engineer/docs/roles/qa-engineer/r.md"
    target = _resolve_workspace_file_target(root=root_s, thread_id=None, rel=bogus)
    assert target.resolve() == f.resolve()


def test_fuzzy_match_sibling_suffix_basename(tmp_path: Path) -> None:
    real = tmp_path / "深度问题挖掘报告.md"
    real.write_text("ok", encoding="utf-8")
    cited = tmp_path / "问题挖掘报告.md"
    assert not cited.exists()
    got = _fuzzy_match_sibling_file(cited)
    assert got is not None
    assert got.resolve() == real.resolve()


def test_resolve_allows_absolute_outside_bound_root(tmp_path: Path) -> None:
    """Chat may cite @@绝对路径@@ written outside the bound workspace; preview must open it."""
    bound = tmp_path / "bound"
    bound.mkdir()
    outside = tmp_path / "other" / "doc"
    outside.mkdir(parents=True)
    f = outside / "FastGPT LLM 驱动智能文档拆分方案设计文档.md"
    f.write_text("design", encoding="utf-8")
    target = _resolve_workspace_file_target(
        root=str(bound.resolve()),
        thread_id=None,
        rel=str(f.resolve()).replace("\\", "/"),
    )
    assert target.resolve() == f.resolve()


def test_read_file_impl_returns_outside_abs_content(tmp_path: Path) -> None:
    from app.gateway.routers.workspaces import _read_workspace_file_impl

    bound = tmp_path / "workspace"
    bound.mkdir()
    (bound / "inside.md").write_text("inside", encoding="utf-8")
    outside = tmp_path / "github" / "temp" / "doc" / "direct-model-call"
    outside.mkdir(parents=True)
    f = outside / "FastGPT LLM 驱动智能文档拆分方案设计文档.md"
    f.write_text("# 拆分方案\n", encoding="utf-8", newline="\n")
    abs_posix = str(f.resolve()).replace("\\", "/")

    out = _read_workspace_file_impl(root=str(bound.resolve()), thread_id=None, rel=abs_posix)
    assert out.ok is True
    assert out.content == "# 拆分方案\n"
    assert out.binary is False


def test_missing_outside_abs_is_not_found_not_outside_workspace(tmp_path: Path) -> None:
    from fastapi import HTTPException

    from app.gateway.routers.workspaces import _read_workspace_file_impl

    bound = tmp_path / "workspace"
    bound.mkdir()
    missing = tmp_path / "github" / "temp" / "missing.md"
    abs_posix = str(missing.resolve()).replace("\\", "/")
    try:
        _read_workspace_file_impl(root=str(bound.resolve()), thread_id=None, rel=abs_posix)
    except HTTPException as exc:
        assert exc.status_code == 404
        assert "file not found" in str(exc.detail)
        assert "path outside workspace" not in str(exc.detail)
    else:
        raise AssertionError("expected 404 for missing outside file")


def test_http_preview_outside_abs_path_like_chat_click(tmp_path: Path) -> None:
    """EvoPanel preview: POST /read-file + GET /resolve-target with bound root ≠ cited file."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.gateway.routers.workspaces import router

    bound = tmp_path / "EvoFlow"
    bound.mkdir()
    (bound / "README.md").write_text("bound", encoding="utf-8")
    outside = tmp_path / "github" / "temp" / "doc" / "direct-model-call"
    outside.mkdir(parents=True)
    f = outside / "FastGPT LLM 驱动智能文档拆分方案设计文档.md"
    f.write_text("ok-preview\n", encoding="utf-8", newline="\n")
    abs_posix = str(f.resolve()).replace("\\", "/")
    root = str(bound.resolve())

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    read = client.post(
        "/api/workspaces/read-file",
        json={"root": root, "path": abs_posix},
    )
    assert read.status_code == 200, read.text
    body = read.json()
    assert body.get("ok") is True
    assert body.get("content") == "ok-preview\n"
    assert "path outside workspace" not in (read.text or "")

    get_read = client.get(
        "/api/workspaces/read",
        params={"root": root, "path": abs_posix},
    )
    assert get_read.status_code == 200
    assert get_read.json().get("content") == "ok-preview\n"

    resolved = client.get(
        "/api/workspaces/resolve-target",
        params={"root": root, "path": abs_posix},
    )
    assert resolved.status_code == 200, resolved.text
    payload = resolved.json()
    assert payload.get("exists") is True
    assert payload.get("is_dir") is False
    assert Path(payload["resolved"]).resolve() == f.resolve()

    served = client.get(
        "/api/workspaces/serve-file",
        params={"root": root, "path": abs_posix},
    )
    assert served.status_code == 200
    assert served.content == b"ok-preview\n"

    inside = client.post(
        "/api/workspaces/read-file",
        json={"root": root, "path": "README.md"},
    )
    assert inside.status_code == 200
    assert inside.json().get("content") == "bound"
