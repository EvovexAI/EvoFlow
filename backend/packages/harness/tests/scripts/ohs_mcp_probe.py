"""Probe real OHS MCP tools/list and a few tool calls (stdio JSON-RPC)."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

VAULT = Path(os.environ["EVOFLOW_KB_E2E_VAULT"])
PREFIX = Path(os.environ["EVOFLOW_KB_E2E_PREFIX"])
SERVER_JS = PREFIX / "node_modules" / "obsidian-hybrid-search" / "dist" / "src" / "server.js"
NODE = os.environ.get("EVOFLOW_KB_NODE") or "node"


async def mcp_session():
    env = {
        **os.environ,
        "OBSIDIAN_VAULT_PATH": str(VAULT),
        "OBSIDIAN_PREFIX": "evo_kb_",
        "OBSIDIAN_RESPECT_GITIGNORE": "true",
        "OBSIDIAN_IGNORE_PATTERNS": ".obsidian/**,templates/**,*.canvas",
    }
    # Strip secrets from child if any
    proc = await asyncio.create_subprocess_exec(
        NODE,
        str(SERVER_JS),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    assert proc.stdin and proc.stdout

    async def rpc(method: str, params: dict | None = None, *, msg_id: int = 1) -> dict:
        payload = {"jsonrpc": "2.0", "id": msg_id, "method": method}
        if params is not None:
            payload["params"] = params
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        proc.stdin.write(line.encode("utf-8"))
        await proc.stdin.drain()
        # Read until we get a response with matching id (skip notifications)
        while True:
            raw = await asyncio.wait_for(proc.stdout.readline(), timeout=120.0)
            if not raw:
                err = await proc.stderr.read()
                raise RuntimeError(f"EOF from MCP: {err[-2000:]}")
            text = raw.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == msg_id:
                return msg

    init = await rpc(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "evoflow-e2e", "version": "0.1"},
        },
        msg_id=1,
    )
    # initialized notification
    proc.stdin.write(
        (json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n").encode()
    )
    await proc.stdin.drain()

    tools = await rpc("tools/list", {}, msg_id=2)
    tool_list = (tools.get("result") or {}).get("tools") or []

    async def call(name: str, arguments: dict, msg_id: int) -> dict:
        return await rpc("tools/call", {"name": name, "arguments": arguments}, msg_id=msg_id)

    results = {
        "initialize": init.get("result"),
        "tools": [
            {
                "name": t.get("name"),
                "description": (t.get("description") or "")[:200],
                "inputSchema": t.get("inputSchema") or t.get("input_schema"),
            }
            for t in tool_list
        ],
    }

    # Prefer prefixed names if present
    names = {t["name"] for t in results["tools"]}
    status_name = "evo_kb_status" if "evo_kb_status" in names else ("status" if "status" in names else None)
    search_name = "evo_kb_search" if "evo_kb_search" in names else ("search" if "search" in names else None)
    read_name = "evo_kb_read" if "evo_kb_read" in names else ("read" if "read" in names else None)
    reindex_name = "evo_kb_reindex" if "evo_kb_reindex" in names else ("reindex" if "reindex" in names else None)

    mid = 10
    if status_name:
        mid += 1
        results["status_before"] = await call(status_name, {}, mid)
    if reindex_name:
        mid += 1
        results["reindex"] = await call(reindex_name, {}, mid)
    if status_name:
        mid += 1
        results["status_after"] = await call(status_name, {}, mid)
    if search_name:
        for label, args in [
            ("fulltext_zh", {"query": "智能体长期记忆", "mode": "fulltext", "limit": 5}),
            ("semantic_zh", {"query": "怎么让 AI 记住以前项目？", "mode": "semantic", "limit": 5}),
            ("hybrid_zh", {"query": "怎么让 AI 记住以前项目？", "mode": "hybrid", "limit": 5}),
            ("title", {"query": "Agent Memory", "mode": "title", "limit": 5}),
            ("tag", {"query": "memory", "mode": "hybrid", "tags": ["agent"], "limit": 5}),
            ("scope", {"query": "EvoFlow", "mode": "fulltext", "scopes": ["Knowledge"], "limit": 5}),
        ]:
            mid += 1
            try:
                results[f"search_{label}"] = await call(search_name, args, mid)
            except Exception as exc:
                results[f"search_{label}"] = {"error": str(exc)}
    if read_name:
        mid += 1
        results["read"] = await call(
            read_name,
            {"paths": ["Knowledge/EvoFlow.md"]},
            mid,
        )

    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except Exception:
        proc.kill()

    out_path = Path(os.environ.get("EVOFLOW_KB_E2E_OUT", "ohs_e2e_result.json"))
    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print("WROTE", out_path)
    print("TOOL_NAMES", sorted(names))
    return results


if __name__ == "__main__":
    asyncio.run(mcp_session())
