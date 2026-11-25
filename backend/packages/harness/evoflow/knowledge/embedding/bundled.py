"""Locate the installer-bundled local embedding model (bge-small-zh).

Desktop ships ``tools/local-embed/models/BAAI/bge-small-zh-v1.5`` next to the
Gateway binary so knowledge base + code index work offline without a first-run
Hugging Face download (poor networks in CN).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from evoflow.knowledge.embedding.base import DEFAULT_LOCAL_MODEL

# Relative to Gateway install root (sibling of evoflow-gateway.exe / _internal).
_BUNDLED_REL = Path("tools") / "local-embed" / "models" / "BAAI" / "bge-small-zh-v1.5"

# Repo / packaging staging (dev builds + prepare script output).
_PACKAGING_REL = (
    Path("packaging") / "windows" / "local-embed-models" / "BAAI" / "bge-small-zh-v1.5"
)


_WEIGHT_FILES = ("model.safetensors", "pytorch_model.bin", "model.onnx")

_LFS_POINTER_MAGIC = b"version https://git-lfs.github.com/spec/"


def is_lfs_pointer(path: Path) -> bool:
    """True when *path* is an unresolved Git LFS pointer rather than real weights.

    【self-evolution-bot · 2026-11-25 · 模型:deepseek-v4.1-flash】
    现网实证：仓库里的 ``local-embed-models/BAAI/bge-small-zh-v1.5/model.safetensors``
    是 133 字节的 LFS 指针（真实权重 95,827,648 字节），而 .gitattributes 里没有
    ``*.safetensors`` 的 LFS 规则 → 指针被当成普通文本 blob 提交，checkout 也不会
    smudge。结果：安装包原样复制指针，「模型目录看起来存在」，运行时
    sentence_transformers 读 safetensors 直接
    ``SafetensorError: Error while deserializing header: header too large``，
    本地向量全链路静默降级（code index / 知识库检索都没有向量）。
    指针很小（<1KB），所以用「体积小 + 魔数开头」判定，零成本。
    """
    try:
        if path.stat().st_size > 1024:
            return False
        with path.open("rb") as fh:
            return fh.read(len(_LFS_POINTER_MAGIC)) == _LFS_POINTER_MAGIC
    except OSError:
        return False


def _looks_like_model_dir(path: Path) -> bool:
    if not path.is_dir():
        return False
    # ST needs config; weights may be safetensors or bin.
    if not (path / "config.json").is_file():
        return False
    weight_files = [path / name for name in _WEIGHT_FILES if (path / name).is_file()]
    if weight_files:
        # A pointer is not a model: reject unless at least one real weight exists.
        # 【self-evolution-bot · 2026-11-25】原来只判 is_file()，LFS 指针也通过，
        # 于是 bundled_local_model_available() 对坏模型返回 True，调用方不再下载/回退。
        return any(not is_lfs_pointer(p) for p in weight_files)
    # Some snapshots nest weights; accept modules.json as enough for ST load.
    return (path / "modules.json").is_file()


def _candidate_roots() -> list[Path]:
    roots: list[Path] = []
    env_root = (os.environ.get("EVOFLOW_LOCAL_EMBED_ROOT") or "").strip()
    if env_root:
        roots.append(Path(env_root).expanduser())
    # Gateway onedir: exe lives in …/evoflow-gateway/; tools/ sits beside it.
    try:
        roots.append(Path(sys.executable).resolve().parent)
    except Exception:
        pass
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        # PyInstaller _internal → parent is install root that may hold tools/.
        roots.append(Path(meipass).resolve().parent)
        roots.append(Path(meipass).resolve())
    # Dev: backend/ as cwd or harness-relative.
    try:
        here = Path(__file__).resolve()
        # …/packages/harness/evoflow/knowledge/embedding/bundled.py → backend/
        backend = here.parents[5] if len(here.parents) > 5 else here.parents[-1]
        roots.append(backend)
        roots.append(backend.parent)  # repo root
    except Exception:
        pass
    cwd = Path.cwd()
    roots.append(cwd)
    if cwd.name != "backend":
        roots.append(cwd / "backend")
    # Dedupe while preserving order
    out: list[Path] = []
    seen: set[str] = set()
    for r in roots:
        key = str(r)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def find_bundled_local_model_dir(model_id: str | None = None) -> Path | None:
    """Return filesystem path to bundled weights, or None.

    Recognizes ``BAAI/bge-small-zh-v1.5`` and empty/default.
    """
    mid = str(model_id or "").strip() or DEFAULT_LOCAL_MODEL
    if mid not in (DEFAULT_LOCAL_MODEL, "bge-small-zh", "bge-small-zh-v1.5"):
        # Only the product-default small model is bundled today.
        if "bge-small-zh" not in mid.lower():
            return None
    for root in _candidate_roots():
        for rel in (_BUNDLED_REL, _PACKAGING_REL):
            cand = root / rel
            if _looks_like_model_dir(cand):
                return cand.resolve()
        # Allow EVOFLOW_LOCAL_EMBED_ROOT to point directly at the model folder.
        if _looks_like_model_dir(root):
            return root.resolve()
    return None


def bundled_local_model_available() -> bool:
    return find_bundled_local_model_dir() is not None
