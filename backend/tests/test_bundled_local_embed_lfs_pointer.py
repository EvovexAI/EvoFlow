"""Guard: an unresolved Git LFS pointer must never pass as a usable model.

【self-evolution-bot · 2026-11-25 · 模型:deepseek-v4.1-flash】
现网实证：``backend/packaging/windows/local-embed-models/BAAI/bge-small-zh-v1.5/
model.safetensors`` 在仓库里是 133 字节的 LFS 指针（真实权重 95,827,648 字节），
而 .gitattributes 缺 ``*.safetensors`` 规则 → 指针作为普通文本 blob 提交，checkout
也不 smudge。后果链：

1. ``prepare_local_embed_model.py::_already_staged`` 见文件存在就判定「已就绪」，
   打包脚本因此**跳过下载**，把指针原样复制进安装包；
2. ``bundled._looks_like_model_dir`` 同样只判 ``is_file()``，于是
   ``bundled_local_model_available()`` 对坏模型返回 True，调用方不再回退到联网下载；
3. 运行时 sentence_transformers 读该文件直接
   ``SafetensorError: Error while deserializing header: header too large``
   （实测，见下），本地向量（知识库检索 + 代码索引）整条链路静默降级。

本测试锁住「指针 ≠ 模型」这一判定，避免它再被改回去。
"""

from __future__ import annotations

from pathlib import Path

import pytest

_POINTER = (
    b"version https://git-lfs.github.com/spec/v1\n"
    b"oid sha256:354763b9b1357bc9c44f62c6be2276321081ed2567773608c0d0785b61d5a026\n"
    b"size 95827648\n"
)


def _make_model_dir(root: Path, weight_bytes: bytes) -> Path:
    model_dir = root / "tools" / "local-embed" / "models" / "BAAI" / "bge-small-zh-v1.5"
    model_dir.mkdir(parents=True)
    (model_dir / "config.json").write_text("{}", encoding="utf-8")
    (model_dir / "modules.json").write_text("[]", encoding="utf-8")
    (model_dir / "model.safetensors").write_bytes(weight_bytes)
    return model_dir


def test_is_lfs_pointer_detects_pointer(tmp_path: Path) -> None:
    from evoflow.knowledge.embedding.bundled import is_lfs_pointer

    pointer = tmp_path / "model.safetensors"
    pointer.write_bytes(_POINTER)
    assert is_lfs_pointer(pointer) is True


def test_is_lfs_pointer_rejects_real_weights(tmp_path: Path) -> None:
    from evoflow.knowledge.embedding.bundled import is_lfs_pointer

    real = tmp_path / "model.safetensors"
    # 真实 safetensors 头部（>1KB 直接短路，这里也验证小文件走魔数分支）
    real.write_bytes(b'{"__metadata__": {"format": "pt"}}' + b"\x00" * 64)
    assert is_lfs_pointer(real) is False


def test_bundled_dir_with_only_pointer_is_not_available(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from evoflow.knowledge.embedding import bundled as b

    _make_model_dir(tmp_path, _POINTER)
    # 只让 tmp 目录成为候选根：否则会扫到仓库里那份真实模型（现网有真权重），
    # 测不出「只有指针 → 不可用」这条分支。
    monkeypatch.setattr(b, "_candidate_roots", lambda: [tmp_path])
    assert b.find_bundled_local_model_dir("BAAI/bge-small-zh-v1.5") is None
    assert b.bundled_local_model_available() is False


def test_bundled_dir_with_real_weights_is_available(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from evoflow.knowledge.embedding import bundled as b

    model_dir = _make_model_dir(tmp_path, b"\x00" * 2048)
    monkeypatch.setattr(b, "_candidate_roots", lambda: [tmp_path])
    assert b.find_bundled_local_model_dir("BAAI/bge-small-zh-v1.5") == model_dir.resolve()
    assert b.bundled_local_model_available() is True


def test_prepare_script_does_not_treat_pointer_as_staged(tmp_path: Path) -> None:
    """打包前置脚本必须继续走下载分支，否则安装包永远带的是指针。"""
    import importlib.util

    prepare = (
        Path(__file__).resolve().parents[1]
        / "packaging"
        / "windows"
        / "prepare_local_embed_model.py"
    )
    spec = importlib.util.spec_from_file_location("_prepare_local_embed_model", prepare)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    pointer_dir = _make_model_dir(tmp_path / "ptr", _POINTER)
    assert mod._already_staged(pointer_dir) is False

    real_dir = _make_model_dir(tmp_path / "real", b"\x00" * 2048)
    assert mod._already_staged(real_dir) is True


def test_shipped_packaging_model_is_not_a_pointer() -> None:
    """仓库里自带的那份模型权重必须是真的（防止指针再次被提交）。

    注意：该断言在未执行 ``git lfs fetch`` 的干净克隆上会失败——这正是本测试的
    用意：让「打包会带上假模型」在 CI / 本地测试里立刻暴露，而不是等用户在
    安装版里遇到 SafetensorError。
    """
    from evoflow.knowledge.embedding.bundled import is_lfs_pointer

    weight = (
        Path(__file__).resolve().parents[1]
        / "packaging"
        / "windows"
        / "local-embed-models"
        / "BAAI"
        / "bge-small-zh-v1.5"
        / "model.safetensors"
    )
    if not weight.is_file():
        pytest.skip("packaging model weights not present in this checkout")
    assert is_lfs_pointer(weight) is False, (
        f"{weight} is an unresolved Git LFS pointer — run: "
        "git lfs fetch origin && git lfs checkout -- <path>"
    )
