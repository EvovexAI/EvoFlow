"""Stage BAAI/bge-small-zh-v1.5 into packaging/windows/local-embed-models/."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-id", default="BAAI/bge-small-zh-v1.5")
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if (out / "config.json").is_file() and (
        (out / "model.safetensors").is_file()
        or (out / "pytorch_model.bin").is_file()
        or (out / "modules.json").is_file()
    ):
        print(f"already staged: {out}")
        return 0

    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    from huggingface_hub import snapshot_download

    cache = snapshot_download(repo_id=args.model_id)
    cache_p = Path(cache)
    for item in cache_p.iterdir():
        dest = out / item.name
        if item.is_dir():
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)
    print(f"staged {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
