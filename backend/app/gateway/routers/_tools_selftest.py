"""Functional self-test for the REST /v1/tools adapter.

Registers throwaway test capabilities (Read/Write/Destructive/Streaming) on the
global registry, then exercises every endpoint with FastAPI's TestClient. The
bearer-token gate is bypassed by overriding ``verify_bearer_token``.

Run: python -m app.gateway.routers._tools_selftest
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any

# Ensure backend root is importable when run as a script.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from evoflow.capability import (
    CallerCtx,
    DangerTier,
    Surface,
    capability,
    get_registry,
)

from app.gateway.routers import tools as tools_mod


# --- Test capability models -------------------------------------------------

class EchoArgs(BaseModel):
    text: str


class WriteArgs(BaseModel):
    path: str
    content: str = ""


class DeleteArgs(BaseModel):
    path: str


class StreamArgs(BaseModel):
    prompt: str


# --- Test capability handlers -----------------------------------------------

@capability(
    name="_test_echo",
    domain="search",
    danger=DangerTier.Read,
    summary="Echo back the input text (test).",
)
def _test_echo(ctx: CallerCtx, p: EchoArgs) -> dict:
    return {"echoed": p.text}


@capability(
    name="_test_write",
    domain="files",
    danger=DangerTier.Write,
    summary="Write a file (test).",
)
def _test_write(ctx: CallerCtx, p: WriteArgs) -> dict:
    return {"written": p.path, "bytes": len(p.content)}


@capability(
    name="_test_delete",
    domain="files",
    danger=DangerTier.Destructive,
    summary="Delete a file (test, destructive).",
)
def _test_delete(ctx: CallerCtx, p: DeleteArgs) -> dict:
    return {"deleted": p.path}


@capability(
    name="_test_stream",
    domain="agent",
    danger=DangerTier.Read,
    summary="Stream a few deltas then finish (test).",
    stream=True,
)
def _test_stream(ctx: CallerCtx, p: StreamArgs, sink) -> dict:
    for i in range(3):
        sink({"type": "delta", "index": i, "text": p.prompt})
    return {"done": True, "prompt": p.prompt}


# --- Build an app with the router, bypassing auth --------------------------

def _build_client() -> TestClient:
    app = FastAPI()
    # Bypass the bearer-token gate: return a fixed identity for every call.
    async def _fake_token():
        return {"identity_type": "agent", "identity_id": "test-user", "token_name": "test", "token_hash": "h"}

    app.dependency_overrides[tools_mod.verify_bearer_token] = _fake_token
    app.include_router(tools_mod.router)
    return TestClient(app)


def main() -> int:
    failures: list[str] = []

    client = _build_client()

    def check(label: str, cond: bool, detail: str = "") -> None:
        status = "PASS" if cond else "FAIL"
        print(f"[{status}] {label}" + (f" :: {detail}" if detail else ""))
        if not cond:
            failures.append(label)

    # 1) GET /v1/tools returns the capability list + schema.
    r = client.get("/v1/tools")
    check("GET /v1/tools status 200", r.status_code == 200, str(r.status_code))
    body = r.json()
    check("response has count+tools", "count" in body and "tools" in body, str(body.keys()))
    names = {t["name"] for t in body["tools"]}
    check("lists _test_echo/_test_write/_test_stream", {"_test_echo", "_test_write", "_test_stream"} <= names, str(names))
    # _test_delete is Destructive on Remote -> Confirm (not Deny) so it IS listed.
    check("lists _test_delete (destructive->confirm, visible)", "_test_delete" in names, str(names))
    echo = next(t for t in body["tools"] if t["name"] == "_test_echo")
    check("tool entry has input_schema with properties", "input_schema" in echo and "properties" in echo["input_schema"], str(echo.get("input_schema", {}).keys()))
    check("count matches tools length", body["count"] == len(body["tools"]), f"{body['count']} vs {len(body['tools'])}")

    # 1b) profile=agent returns curated subset (filter out non-profile domains).
    # Register a tool in a domain outside the agent profile to verify filtering.
    from evoflow.capability import Capability, CapabilityMeta

    class OtherArgs(BaseModel):
        x: int = 0

    def _other_handler(ctx: CallerCtx, p: OtherArgs) -> dict:
        return {"ok": True}

    other_cap = Capability.from_model(
        CapabilityMeta(name="_test_other", domain="otherdomain", summary="out of profile", danger=DangerTier.Read),
        OtherArgs,
        _other_handler,
    )
    get_registry().register(other_cap)

    r_full = client.get("/v1/tools")
    full_names = {t["name"] for t in r_full.json()["tools"]}
    r = client.get("/v1/tools", params={"profile": "agent"})
    agent_names = {t["name"] for t in r.json()["tools"]}
    check("profile=agent filters out non-profile domain", "_test_other" in full_names and "_test_other" not in agent_names, f"full={full_names} agent={agent_names}")
    check("profile=agent keeps agent-domain tool", "_test_stream" in agent_names, str(agent_names))

    # 2) POST /v1/tools/{name} dispatches correctly (Read -> 200).
    r = client.post("/v1/tools/_test_echo", json={"text": "hello"})
    check("POST _test_echo status 200", r.status_code == 200, f"{r.status_code} {r.text}")
    check("echo returns echoed text", r.json().get("echoed") == "hello", r.text)

    # 2b) Write -> 200.
    r = client.post("/v1/tools/_test_write", json={"path": "/tmp/x", "content": "abc"})
    check("POST _test_write status 200", r.status_code == 200, f"{r.status_code} {r.text}")

    # 3) Destructive without confirm -> 409 needs_confirmation.
    r = client.post("/v1/tools/_test_delete", json={"path": "/tmp/x"})
    check("POST _test_delete (no confirm) status 409", r.status_code == 409, f"{r.status_code} {r.text}")
    # FastAPI wraps the registry envelope in HTTPException's ``detail`` field.
    detail = r.json().get("detail", r.json())
    check("409 body has needs_confirmation", "needs_confirmation" in detail, r.text)

    # 3b) Destructive with confirm=true -> 200.
    r = client.post("/v1/tools/_test_delete", json={"path": "/tmp/x", "confirm": True})
    check("POST _test_delete (confirm=true) status 200", r.status_code == 200, f"{r.status_code} {r.text}")

    # 3c) Validation error -> 422.
    r = client.post("/v1/tools/_test_echo", json={})
    check("POST _test_echo (missing arg) status 422", r.status_code == 422, f"{r.status_code} {r.text}")

    # 3d) Unknown tool -> 404.
    r = client.post("/v1/tools/_nope", json={})
    check("POST unknown tool -> 404 or 422", r.status_code in (404, 422), f"{r.status_code} {r.text}")

    # 4) GET /v1/openapi.json generates valid OpenAPI 3.1.
    r = client.get("/v1/openapi.json")
    check("GET /v1/openapi.json status 200", r.status_code == 200, str(r.status_code))
    spec = r.json()
    check("openapi version 3.1.0", spec.get("openapi") == "3.1.0", str(spec.get("openapi")))
    check("has bearerAuth securityScheme", "bearerAuth" in spec.get("components", {}).get("securitySchemes", {}), str(spec.get("components")))
    paths = spec.get("paths", {})
    check("openapi has POST /v1/tools/_test_echo", "/v1/tools/_test_echo" in paths and "post" in paths["/v1/tools/_test_echo"], str(list(paths.keys())[:5]))
    echo_op = paths.get("/v1/tools/_test_echo", {}).get("post", {})
    check("openapi op has bearerAuth security", {"bearerAuth": []} in echo_op.get("security", []), str(echo_op.get("security")))
    check("openapi op has 200/409/422 responses", set(echo_op.get("responses", {}).keys()) >= {"200", "409", "422"}, str(echo_op.get("responses", {}).keys()))

    # 5) SSE stream endpoint exists and streams deltas + terminal __result__.
    with client.stream("POST", "/v1/tools/_test_stream/stream", json={"prompt": "go"}) as resp:
        check("POST /v1/tools/_test_stream status 200", resp.status_code == 200, str(resp.status_code))
        frames: list[dict] = []
        for line in resp.iter_lines():
            if not line:
                continue
            # TestClient yields raw SSE ``data: <json>`` lines.
            payload = line[5:].strip() if line.startswith("data:") else line.strip()
            if not payload:
                continue
            try:
                frames.append(json.loads(payload))
            except json.JSONDecodeError:
                pass
    delta_count = sum(1 for f in frames if f.get("type") == "delta")
    has_result = any(f.get("type") == "__result__" for f in frames)
    check("stream emitted 3 delta frames", delta_count == 3, f"got {delta_count} deltas: {frames}")
    check("stream ended with __result__ frame", has_result, str(frames))
    result_frame = next((f for f in frames if f.get("type") == "__result__"), {})
    check("__result__ data has done=true", result_frame.get("data", {}).get("done") is True, str(result_frame))

    # 6) Auth gate: without dependency override, missing token -> 401.
    bare_app = FastAPI()
    bare_app.include_router(tools_mod.router)
    bare_client = TestClient(bare_app)
    r = bare_client.get("/v1/tools")
    check("no token -> 401", r.status_code == 401, f"{r.status_code} {r.text}")

    print()
    if failures:
        print(f"FAILED: {len(failures)} checks: {failures}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
