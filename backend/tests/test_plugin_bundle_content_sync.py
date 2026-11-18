"""bundle → 运行副本的内容收敛。

【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
为什么有这组测试：官方插件真正被读取的是
``<storage>/plugins/cache/evoflow-plugins-official/<name>/<version>``，
而 ``packaging/official-plugins-bundle`` 只是种子源。原实现里
``seed_official_marketplace`` 在 ``__seededVersion`` 命中时直接 return，
``_install_default_enabled_plugins`` 又对已存在记录一律 continue，
于是 bundle 里改过的技能文档永远不会进入运行副本。
现网实测：control-browser/SKILL.md 的运行副本停在 2026-10-13，
仍硬性要求「每次 js 调用开头都 bootstrap」——宿主文案改成「不要写」后两者冲突，
观测到的 107/308 次重复 bootstrap 因此不会下降。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evoflow.plugins import builtin as builtin_mod
from evoflow.plugins.storage import InstalledPluginRecord, InstalledPluginsState


def _write(path: Path, text: str, mtime_ns: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    if mtime_ns is not None:
        import os as _os

        _os.utime(path, ns=(mtime_ns, mtime_ns))


def _make_state(storage_root: Path, install_path: Path, name: str = "browser-use") -> None:
    state = InstalledPluginsState()
    state.plugins = [
        InstalledPluginRecord(
            id=f"{name}@evoflow-plugins-official",
            name=name,
            marketplace="evoflow-plugins-official",
            version="0.5.1",
            installPath=str(install_path),
            installedAt="2026-10-13T09:49:11+00:00",
            scope="user",
            source={"source": "settings"},
        )
    ]
    path = storage_root / "installed_plugins.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "plugins": [
                    {
                        "id": r.id,
                        "name": r.name,
                        "marketplace": r.marketplace,
                        "version": r.version,
                        "installPath": r.installPath,
                        "installedAt": r.installedAt,
                        "scope": r.scope,
                        "source": r.source,
                    }
                    for r in state.plugins
                ],
                "enabledPlugins": {},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    bundle_root = tmp_path / "bundle"
    storage_root = tmp_path / "storage"
    runtime_copy = (
        storage_root
        / "plugins"
        / "cache"
        / "evoflow-plugins-official"
        / "browser-use"
        / "0.5.1"
    )
    monkeypatch.setattr(builtin_mod, "discover_bundled_official_cache", lambda: bundle_root)
    return bundle_root, storage_root, runtime_copy


def test_newer_bundle_file_reaches_runtime_copy(sandbox):
    """bundle 更新（mtime 更晚）→ 运行副本被刷新成新内容。"""
    bundle_root, storage_root, runtime_copy = sandbox
    old_ns = 1_600_000_000_000_000_000
    new_ns = 1_700_000_000_000_000_000

    _write(bundle_root / "browser-use" / "0.5.1" / "skills" / "control-browser" / "SKILL.md",
           "# new guidance: do not bootstrap\n", new_ns)
    _write(runtime_copy / "skills" / "control-browser" / "SKILL.md",
           "# old guidance: bootstrap every call\n", old_ns)
    _make_state(storage_root, runtime_copy)

    refreshed = builtin_mod._sync_bundled_plugin_content(storage_root)

    assert refreshed == ["browser-use"]
    got = (runtime_copy / "skills" / "control-browser" / "SKILL.md").read_text(encoding="utf-8")
    assert got == "# new guidance: do not bootstrap\n"


def test_older_bundle_does_not_clobber_runtime_copy(sandbox):
    """运行副本比 bundle 新（用户后改过）→ 必须保留用户内容。"""
    bundle_root, storage_root, runtime_copy = sandbox
    old_ns = 1_600_000_000_000_000_000
    new_ns = 1_700_000_000_000_000_000

    _write(bundle_root / "browser-use" / "0.5.1" / "skills" / "control-browser" / "SKILL.md",
           "# bundle older\n", old_ns)
    _write(runtime_copy / "skills" / "control-browser" / "SKILL.md",
           "# user edited later\n", new_ns)
    _make_state(storage_root, runtime_copy)

    refreshed = builtin_mod._sync_bundled_plugin_content(storage_root)

    assert refreshed == []
    assert "user edited later" in (
        runtime_copy / "skills" / "control-browser" / "SKILL.md"
    ).read_text(encoding="utf-8")


def test_missing_file_in_runtime_copy_is_filled(sandbox):
    """运行副本缺文件 → 补上。"""
    bundle_root, storage_root, runtime_copy = sandbox
    _write(bundle_root / "browser-use" / "0.5.1" / "docs" / "overview.md", "# overview\n")
    runtime_copy.mkdir(parents=True, exist_ok=True)
    _make_state(storage_root, runtime_copy)

    refreshed = builtin_mod._sync_bundled_plugin_content(storage_root)

    assert refreshed == ["browser-use"]
    assert (runtime_copy / "docs" / "overview.md").is_file()


def test_converged_tree_is_stable(sandbox):
    """收敛一次后再跑必须幂等——copytree 保留 mtime，不允许每次启动重拷。"""
    bundle_root, storage_root, runtime_copy = sandbox
    new_ns = 1_700_000_000_000_000_000
    _write(bundle_root / "browser-use" / "0.5.1" / "skills" / "x" / "SKILL.md", "# v2\n", new_ns)
    _write(runtime_copy / "skills" / "x" / "SKILL.md", "# v1\n", 1_600_000_000_000_000_000)
    _make_state(storage_root, runtime_copy)

    assert builtin_mod._sync_bundled_plugin_content(storage_root) == ["browser-use"]
    # 第二次必须收敛：mtime 被 copy2 保留，不再判定为 stale。
    assert builtin_mod._sync_bundled_plugin_content(storage_root) == []


def test_seed_cached_path_still_syncs(sandbox, monkeypatch):
    """__seededVersion 命中提前 return 的那条路径也必须收敛内容。"""
    bundle_root, storage_root, runtime_copy = sandbox
    new_ns = 1_700_000_000_000_000_000
    _write(bundle_root / "browser-use" / "0.5.1" / "skills" / "x" / "SKILL.md", "# v2\n", new_ns)
    _write(runtime_copy / "skills" / "x" / "SKILL.md", "# v1\n", 1_600_000_000_000_000_000)
    _make_state(storage_root, runtime_copy)

    calls: list[int] = []
    original = builtin_mod._sync_bundled_plugin_content

    def _spy(root):
        calls.append(1)
        return original(root)

    monkeypatch.setattr(builtin_mod, "_sync_bundled_plugin_content", _spy)

    class _Cached:
        raw = {
            "__seededVersion": builtin_mod.SEED_MANIFEST_VERSION,
            "plugins": [{"name": "browser-use"}],
        }

    monkeypatch.setattr(
        "evoflow.plugins.storage.load_marketplace_manifest_cached",
        lambda *a, **k: _Cached(),
    )
    monkeypatch.setattr(builtin_mod, "_cleanup_excluded_installed_plugins", lambda root: None)

    builtin_mod.seed_official_marketplace(storage_root)

    assert calls == [1], "缓存命中路径必须调用内容收敛"
    assert "# v2" in (runtime_copy / "skills" / "x" / "SKILL.md").read_text(encoding="utf-8")


def test_user_edit_survives_sibling_file_refresh(sandbox):
    """同一插件内 A 文件需要刷新时，B 文件（用户后改）必须原样保留。

    这是「逐文件复制」相对「整树 copytree」的关键差异，也是本轮实现里
    我自己先写错过一次的地方：整树覆盖会把用户改过的同插件其它文件一起冲掉。
    """
    bundle_root, storage_root, runtime_copy = sandbox
    old_ns = 1_600_000_000_000_000_000
    new_ns = 1_700_000_000_000_000_000

    # A：bundle 更新了 → 应该被刷新
    _write(bundle_root / "browser-use" / "0.5.1" / "skills" / "a" / "SKILL.md", "# a v2\n", new_ns)
    _write(runtime_copy / "skills" / "a" / "SKILL.md", "# a v1\n", old_ns)
    # B：用户在运行副本上后改 → 必须保留
    _write(bundle_root / "browser-use" / "0.5.1" / "skills" / "b" / "SKILL.md", "# b v1\n", old_ns)
    _write(runtime_copy / "skills" / "b" / "SKILL.md", "# b USER EDIT\n", new_ns)

    _make_state(storage_root, runtime_copy)

    refreshed = builtin_mod._sync_bundled_plugin_content(storage_root)

    assert refreshed == ["browser-use"]
    assert (runtime_copy / "skills" / "a" / "SKILL.md").read_text(encoding="utf-8") == "# a v2\n"
    assert "USER EDIT" in (runtime_copy / "skills" / "b" / "SKILL.md").read_text(encoding="utf-8")


def test_reverse_verification_whole_tree_copy_would_break_user_edit(sandbox):
    """反证：换成整树 copytree 语义时，上一个测试必须红——证明它真能抓到这个缺陷。"""
    import shutil as _shutil

    bundle_root, storage_root, runtime_copy = sandbox
    old_ns = 1_600_000_000_000_000_000
    new_ns = 1_700_000_000_000_000_000
    _write(bundle_root / "browser-use" / "0.5.1" / "skills" / "a" / "SKILL.md", "# a v2\n", new_ns)
    _write(runtime_copy / "skills" / "a" / "SKILL.md", "# a v1\n", old_ns)
    _write(bundle_root / "browser-use" / "0.5.1" / "skills" / "b" / "SKILL.md", "# b v1\n", old_ns)
    _write(runtime_copy / "skills" / "b" / "SKILL.md", "# b USER EDIT\n", new_ns)

    # 整树复制（旧语义）
    _shutil.copytree(bundle_root / "browser-use" / "0.5.1", runtime_copy, dirs_exist_ok=True)

    assert "USER EDIT" not in (runtime_copy / "skills" / "b" / "SKILL.md").read_text(encoding="utf-8"), \
        "若这里不再成立，说明整树复制其实不会覆盖用户改动，本组测试的前提需重估"
