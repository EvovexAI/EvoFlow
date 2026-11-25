"""Stage BAAI/bge-small-zh-v1.5 into packaging/windows/local-embed-models/."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

_LFS_POINTER_MAGIC = b"version https://git-lfs.github.com/spec/"


def _is_lfs_pointer(path: Path) -> bool:
    """【self-evolution-bot · 2026-11-25】LFS 指针 ≠ 已就绪（见 bundled.is_lfs_pointer）。"""
    try:
        if path.stat().st_size > 1024:
            return False
        with path.open("rb") as fh:
            return fh.read(len(_LFS_POINTER_MAGIC)) == _LFS_POINTER_MAGIC
    except OSError:
        return False


def _already_staged(out: Path) -> bool:
    if not (out / "config.json").is_file():
        return False
    weight_present = False
    for name in ("model.safetensors", "pytorch_model.bin"):
        weight = out / name
        if not weight.is_file():
            continue
        weight_present = True
        # 有真实权重才算就绪；LFS 指针必须继续走下载分支。
        if not _is_lfs_pointer(weight):
            return True
    if weight_present:
        return False
    return (out / "modules.json").is_file()


def _candidate_endpoints() -> list[str | None]:
    """Prefer explicit HF_ENDPOINT; on GitHub Actions try official hub first."""
    explicit = (os.environ.get("HF_ENDPOINT") or "").strip() or None
    in_ci = bool(os.environ.get("GITHUB_ACTIONS") or os.environ.get("CI"))
    ordered: list[str | None] = []
    if explicit:
        ordered.append(explicit)
    if in_ci:
        # US runners often reach huggingface.co; hf-mirror may 403 / mis-detect.
        ordered.extend([None, "https://hf-mirror.com"])
    else:
        # Local/CN: mirror first, then official.
        ordered.extend(["https://hf-mirror.com", None])
    # de-dupe preserving order (None = default hub)
    seen: set[str] = set()
    out: list[str | None] = []
    for ep in ordered:
        key = ep or ""
        if key in seen:
            continue
        seen.add(key)
        out.append(ep)
    return out


def _snapshot_download(model_id: str) -> Path:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as e:
        raise SystemExit(
            "huggingface_hub is required to download local-embed weights. "
            "Install with: pip install huggingface_hub  (or uv add huggingface_hub)"
        ) from e

    last_err: BaseException | None = None
    for ep in _candidate_endpoints():
        if ep:
            os.environ["HF_ENDPOINT"] = ep
            label = ep
        else:
            os.environ.pop("HF_ENDPOINT", None)
            label = "huggingface.co (default)"
        print(f"[local-embed] snapshot_download via {label}")
        try:
            cache = snapshot_download(repo_id=model_id)
            return Path(cache)
        except Exception as e:  # noqa: BLE001 — try next endpoint
            last_err = e
            print(f"[local-embed] failed via {label}: {e}", file=sys.stderr)
    assert last_err is not None
    raise last_err


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-id", default="BAAI/bge-small-zh-v1.5")
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if _already_staged(out):
        print(f"already staged: {out}")
        return 0

    cache_p = _snapshot_download(args.model_id)
    for item in cache_p.iterdir():
        # Skip duplicate weight format to keep packaging lean (~95MB safetensors).
        if item.name == "pytorch_model.bin" and (cache_p / "model.safetensors").is_file():
            continue
        dest = out / item.name
        if item.is_dir():
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)
    if not _already_staged(out):
        print(f"[local-embed] staged incomplete: {out}", file=sys.stderr)
        return 1
    print(f"staged {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
