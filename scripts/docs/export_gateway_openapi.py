#!/usr/bin/env python3
"""Export FastAPI Gateway OpenAPI schema to docs/generated/openapi-gateway.json.

Run from repository root:

    cd backend && PYTHONPATH=. uv run python ../scripts/docs/export_gateway_openapi.py

When ``EVOFLOW_PRIVATE_DOCS`` points at an optional private docs tree, also
mirrors ``system/reference/generated/openapi-gateway.json`` there.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# OpenAPI path-item HTTP verbs (lowercase). Stable order avoids CI drift across FastAPI/Python builds.
_HTTP_METHODS = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)
_METHOD_ORDER = ("get", "put", "post", "patch", "delete", "options", "head", "trace")


def _normalize_path_item(path_key: str, path_item: dict) -> dict:
    """Reorder verb keys deterministically; fix LangGraph catch-all operationIds."""
    if not isinstance(path_item, dict):
        return path_item
    methods: dict[str, object] = {}
    rest: dict[str, object] = {}
    for key, val in path_item.items():
        lk = key.lower()
        if lk in _HTTP_METHODS:
            methods[lk] = val
        else:
            rest[key] = val

    if path_key == "/api/langgraph/{path}":
        # FastAPI multi-method api_route() emits duplicate/wrong operationIds; normalize for stable docs + CI.
        for verb in list(methods.keys()):
            op = methods[verb]
            if isinstance(op, dict):
                methods[verb] = {
                    **op,
                    "operationId": f"proxy_langgraph_api_langgraph__path__{verb}",
                }

    ordered_methods = {verb: methods[verb] for verb in _METHOD_ORDER if verb in methods}
    for verb in sorted(methods.keys()):
        if verb not in ordered_methods:
            ordered_methods[verb] = methods[verb]
    # Non-method keys first (stable), then verbs — matches common OpenAPI examples.
    out: dict[str, object] = {}
    for rk in sorted(rest.keys()):
        out[rk] = rest[rk]
    out.update(ordered_methods)
    return out


def _normalize_openapi_paths(schema: dict) -> None:
    paths = schema.get("paths")
    if not isinstance(paths, dict):
        return
    schema["paths"] = {
        pk: _normalize_path_item(pk, pi) if isinstance(pi, dict) else pi
        for pk, pi in paths.items()
    }


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _backend_dir() -> Path:
    return _repo_root() / "backend"


def _out_paths() -> list[Path]:
    """Public generated path + optional private-docs mirror via env."""
    root = _repo_root()
    paths = [root / "docs" / "generated" / "openapi-gateway.json"]
    private_root = (os.environ.get("EVOFLOW_PRIVATE_DOCS") or "").strip()
    if private_root:
        private = (
            Path(private_root)
            / "system"
            / "reference"
            / "generated"
            / "openapi-gateway.json"
        )
        paths.append(private)
    return paths


def main() -> int:
    backend = _backend_dir()
    if not backend.is_dir():
        print("backend/ not found next to scripts/", file=sys.stderr)
        return 1

    os.chdir(backend)
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))

    # Import after chdir so logging resolves paths consistently
    from app.gateway.app import create_app  # noqa: PLC0415

    app = create_app()
    schema = app.openapi()
    _normalize_openapi_paths(schema)
    payload = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"
    n_paths = len(schema.get("paths", {}))

    for out in _out_paths():
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, encoding="utf-8")
        try:
            rel = out.relative_to(_repo_root())
        except ValueError:
            rel = out
        print(f"Wrote {rel} ({n_paths} paths)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
