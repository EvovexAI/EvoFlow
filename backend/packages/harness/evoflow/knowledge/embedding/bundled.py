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


def _looks_like_model_dir(path: Path) -> bool:
    if not path.is_dir():
        return False
    # ST needs config; weights may be safetensors or bin.
    if not (path / "config.json").is_file():
        return False
    for name in ("model.safetensors", "pytorch_model.bin", "model.onnx"):
        if (path / name).is_file():
            return True
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
