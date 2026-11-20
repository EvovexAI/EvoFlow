"""Long-lived local embedding subprocess (JSONL over stdin/stdout).

Gateway on Windows must not import sentence_transformers in-process (GIL /
event-loop stall). Owned KB indexing and probes call this worker instead.

Protocol (one JSON object per line):
  → {"op":"embed","model":"BAAI/bge-small-zh-v1.5","device":"cpu","texts":["…"]}
  ← {"ok":true,"vectors":[[…],…]}
  → {"op":"ping"}
  ← {"ok":true,"pong":true}
  → {"op":"shutdown"}
  ← {"ok":true} then exit
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from typing import Any

logger = logging.getLogger("evoflow.embed_worker")


def main(argv: list[str] | None = None) -> int:
    # Allow ST load in this throwaway / sidecar process only.
    os.environ["EVOFLOW_LOCAL_EMBED_WORKER"] = "1"
    os.environ.setdefault("EVOFLOW_CODE_INDEX_BUILD_WORKER", "1")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [embed-worker] %(message)s",
        stream=sys.stderr,
    )
    parser = argparse.ArgumentParser(description="EvoFlow local embedding worker")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Read one request from stdin and exit (tests)",
    )
    args = parser.parse_args(argv)

    from evoflow.knowledge.embedding.base import DEFAULT_LOCAL_MODEL
    from evoflow.knowledge.embedding.local_provider import (
        _load_model_sync,
        _model_cache,
        clear_local_model_cache,
    )

    loaded_key: str | None = None

    def _ensure_model(model_id: str, device: str) -> Any:
        nonlocal loaded_key
        key = f"{model_id}|{device}"
        if loaded_key != key:
            clear_local_model_cache()
            _load_model_sync(model_id, device)
            loaded_key = key
        return _model_cache[model_id]

    def _handle(msg: dict[str, Any]) -> dict[str, Any]:
        op = str(msg.get("op") or "embed").strip().lower()
        if op == "ping":
            return {"ok": True, "pong": True}
        if op == "shutdown":
            return {"ok": True, "shutdown": True}
        if op != "embed":
            return {"ok": False, "error": f"unknown op: {op}"}
        texts = msg.get("texts")
        if not isinstance(texts, list) or not texts:
            return {"ok": False, "error": "texts must be a non-empty list"}
        model_id = str(msg.get("model") or "").strip() or DEFAULT_LOCAL_MODEL
        device = str(msg.get("device") or "cpu").strip() or "cpu"
        model = _ensure_model(model_id, device)
        embs = model.encode(
            [str(t) for t in texts],
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
        vectors = [list(map(float, row)) for row in embs]
        return {"ok": True, "vectors": vectors, "dim": len(vectors[0]) if vectors else 0}

    def _loop() -> int:
        while True:
            line = sys.stdin.buffer.readline()
            if not line:
                return 0
            try:
                msg = json.loads(line.decode("utf-8"))
            except Exception as exc:
                sys.stdout.buffer.write(
                    (
                        json.dumps({"ok": False, "error": f"bad json: {exc}"}, ensure_ascii=False) + "\n"
                    ).encode("utf-8")
                )
                sys.stdout.buffer.flush()
                continue
            try:
                out = _handle(msg if isinstance(msg, dict) else {})
            except Exception as exc:
                logger.exception("embed failed")
                out = {"ok": False, "error": str(exc)}
            sys.stdout.buffer.write((json.dumps(out, ensure_ascii=False) + "\n").encode("utf-8"))
            sys.stdout.buffer.flush()
            if out.get("shutdown"):
                return 0
            if args.once:
                return 0 if out.get("ok") else 1

    return _loop()


if __name__ == "__main__":
    raise SystemExit(main())
