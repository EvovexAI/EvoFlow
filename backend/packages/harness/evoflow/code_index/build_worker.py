"""Child-process entry for full code-index builds.

Gateway must NOT load ``sentence_transformers`` / sklearn / scipy inside its
own process during index rebuild: Python's import lock + GIL can stall the
asyncio event loop for minutes (2026-11-17 hang: ``execution/state`` waited
200s+ while ``code-index-build-*`` imported ``scipy.linalg._fblas``).

``schedule_build_index`` launches this module via ``python -m
evoflow.code_index.build_worker`` so heavy ML imports stay in a throwaway
process. Threads alone do not isolate GIL.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Any


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [code-index-worker] %(message)s",
        stream=sys.stderr,
    )
    parser = argparse.ArgumentParser(description="EvoFlow code-index build worker")
    parser.add_argument("--workspace-root", default=None)
    parser.add_argument("--thread-id", default=None)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)

    from evoflow.code_index.store import build_index

    try:
        result: dict[str, Any] = build_index(
            workspace_root=args.workspace_root,
            thread_id=args.thread_id,
            force=bool(args.force),
        )
    except Exception as exc:
        logging.exception("code-index build worker failed")
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result if isinstance(result, dict) else {"ok": True, "result": result}, ensure_ascii=False))
    return 0 if isinstance(result, dict) and result.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
