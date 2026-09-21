#!/usr/bin/env python3
"""Benchmark list_apps summary vs full, and app-server pipe vs direct HTTP.

Usage (from backend/ with venv):
  python scripts/bench_list_apps_and_pipe.py
  python scripts/bench_list_apps_and_pipe.py --gateway http://127.0.0.1:8012
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path


def _p95(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round(0.95 * (len(s) - 1)))))
    return s[i]


def bench_list_apps_payload(n_apps: int = 20, nodes_per: int = 40) -> dict:
    """In-process: summary vs full list size + wall time (no Gateway)."""
    from evoflow.persistence import app_repositories
    from evoflow.persistence.db import get_db, reset_db_for_tests

    tmp = tempfile.mkdtemp(prefix="evoflow-bench-apps-")
    os.environ["EVOFLOW_HOME"] = tmp
    reset_db_for_tests()
    app_repositories.reset_apps_columns_cache_for_tests()
    get_db()

    fat_canvas = {
        "nodes": [
            {
                "nodeId": str(i),
                "type": "agentStep",
                "position": {"x": float(i * 40), "y": float((i % 5) * 80)},
                "data": {"label": f"step-{i}", "prompt": ("长描述" * 80)},
            }
            for i in range(nodes_per)
        ],
        "edges": [
            {
                "source": str(i),
                "target": str(i + 1),
                "sourceHandle": "out",
                "targetHandle": "in",
            }
            for i in range(nodes_per - 1)
        ],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    }
    fat_steps = [
        {
            "ref": str(i),
            "name": f"步骤 {i}",
            "description": ("详细说明文字" * 40),
            "assigned_agent": f"agent_{(i % 3) + 1}",
            "depends_on": [str(i - 1)] if i else [],
            "tools": "web_search,read_file",
            "skills": ["skill-a", "skill-b"],
        }
        for i in range(nodes_per)
    ]

    for i in range(n_apps):
        app_repositories.save_app(
            f"App_bench_{i:03d}",
            {
                "name": f"Bench App {i}",
                "description": "payload bench",
                "steps": fat_steps,
                "parameters": [{"name": "q", "type": "string", "required": True}],
                "canvas": fat_canvas,
                "status": "published",
                "goal_template": "goal " * 50,
            },
        )

    t0 = time.perf_counter()
    full = app_repositories.list_apps(summary=False)
    t_full = (time.perf_counter() - t0) * 1000
    full_bytes = len(json.dumps(full, ensure_ascii=False).encode("utf-8"))

    t0 = time.perf_counter()
    summary = app_repositories.list_apps(summary=True)
    t_sum = (time.perf_counter() - t0) * 1000
    sum_bytes = len(json.dumps(summary, ensure_ascii=False).encode("utf-8"))

    reset_db_for_tests()
    return {
        "apps": n_apps,
        "nodes_per_app": nodes_per,
        "full_ms": round(t_full, 2),
        "summary_ms": round(t_sum, 2),
        "full_kb": round(full_bytes / 1024, 1),
        "summary_kb": round(sum_bytes / 1024, 1),
        "shrink_x": round(full_bytes / max(1, sum_bytes), 1),
        "summary_has_canvas_nodes": bool((summary[0].get("canvas") or {}).get("nodes")),
        "summary_step_count": summary[0].get("step_count"),
    }


async def _jsonrpc_call(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    *,
    msg_id: int,
    method: str,
    params: dict,
) -> dict:
    payload = json.dumps({"id": msg_id, "method": method, "params": params}, ensure_ascii=False)
    writer.write((payload + "\n").encode("utf-8"))
    await writer.drain()
    line = await asyncio.wait_for(reader.readline(), timeout=60)
    if not line:
        raise RuntimeError("app-server closed connection")
    msg = json.loads(line.decode("utf-8"))
    if "error" in msg:
        raise RuntimeError(msg["error"])
    return msg.get("result") or {}


async def _init_pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, gateway: str, name: str) -> None:
    await _jsonrpc_call(
        reader,
        writer,
        msg_id=1,
        method="initialize",
        params={
            "clientInfo": {"name": name},
            "gatewayBaseUrl": gateway.rstrip("/"),
        },
    )


async def bench_pipe_vs_http(gateway: str, rounds: int = 30) -> dict:
    """Start TCP app-server, compare resources/call vs direct httpx to same Gateway."""
    import httpx

    from evoflow.app_server.stdio_rpc import serve_tcp_server

    host, port = "127.0.0.1", 18991
    path = "/health/liveness"
    url = f"{gateway.rstrip('/')}{path}"

    server = await serve_tcp_server(host, port, gateway_base_url=gateway.rstrip("/"))
    try:
        await asyncio.sleep(0.1)

        async with httpx.AsyncClient(timeout=30.0) as client:
            await client.get(url)  # warm
            http_ms: list[float] = []
            for _ in range(rounds):
                t0 = time.perf_counter()
                r = await client.get(url)
                r.raise_for_status()
                http_ms.append((time.perf_counter() - t0) * 1000)

        reader, writer = await asyncio.open_connection(host, port)
        await _init_pipe(reader, writer, gateway, "bench")
        await _jsonrpc_call(
            reader,
            writer,
            msg_id=2,
            method="resources/call",
            params={"method": "GET", "path": path},
        )

        pipe_ms: list[float] = []
        for i in range(rounds):
            t0 = time.perf_counter()
            result = await _jsonrpc_call(
                reader,
                writer,
                msg_id=100 + i,
                method="resources/call",
                params={"method": "GET", "path": path},
            )
            if not result.get("ok"):
                raise RuntimeError(f"pipe call failed: {result}")
            pipe_ms.append((time.perf_counter() - t0) * 1000)

        # Contention: N HTTP in parallel vs N pipe calls on ONE connection (serial, like stdio)
        n_parallel = 20
        async with httpx.AsyncClient(timeout=30.0) as client:

            async def one_http() -> float:
                t0 = time.perf_counter()
                await client.get(url)
                return (time.perf_counter() - t0) * 1000

            t0 = time.perf_counter()
            http_parallel = await asyncio.gather(*[one_http() for _ in range(n_parallel)])
            http_wall = (time.perf_counter() - t0) * 1000

        seq_ms: list[float] = []
        t0 = time.perf_counter()
        for i in range(n_parallel):
            t1 = time.perf_counter()
            await _jsonrpc_call(
                reader,
                writer,
                msg_id=200 + i,
                method="resources/call",
                params={"method": "GET", "path": path},
            )
            seq_ms.append((time.perf_counter() - t1) * 1000)
        pipe_serial_wall = (time.perf_counter() - t0) * 1000

        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass

        return {
            "gateway": gateway,
            "path": path,
            "rounds": rounds,
            "http_avg_ms": round(statistics.mean(http_ms), 2),
            "http_p95_ms": round(_p95(http_ms), 2),
            "pipe_avg_ms": round(statistics.mean(pipe_ms), 2),
            "pipe_p95_ms": round(_p95(pipe_ms), 2),
            "pipe_overhead_avg_ms": round(statistics.mean(pipe_ms) - statistics.mean(http_ms), 2),
            "parallel": {
                "n": n_parallel,
                "http_wall_ms": round(http_wall, 2),
                "http_avg_each_ms": round(statistics.mean(http_parallel), 2),
                "pipe_one_conn_serial_wall_ms": round(pipe_serial_wall, 2),
                "pipe_one_conn_avg_each_ms": round(statistics.mean(seq_ms), 2),
                "note": "Desktop stdio pipe is one serial connection; HTTP can fan out. Chat streams on the pipe still queue panel APIs unless preferGatewayHttp is set.",
            },
        }
    finally:
        server.close()
        await server.wait_closed()


async def bench_apps_http(gateway: str, rounds: int = 10) -> dict | None:
    """Optional: GET /api/apps if premium allows."""
    import httpx

    url = f"{gateway.rstrip('/')}/api/apps"
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            r = await client.get(url)
        except Exception as exc:
            return {"error": str(exc)}
        if r.status_code == 403:
            return {"skipped": True, "reason": "premium_required", "status": 403}
        if r.status_code >= 400:
            return {"skipped": True, "reason": r.text[:200], "status": r.status_code}
        samples: list[float] = []
        sizes: list[int] = []
        for _ in range(rounds):
            t0 = time.perf_counter()
            rr = await client.get(url)
            rr.raise_for_status()
            body = rr.content
            samples.append((time.perf_counter() - t0) * 1000)
            sizes.append(len(body))
        t0 = time.perf_counter()
        full = await client.get(url, params={"summary": "false"})
        full.raise_for_status()
        full_ms = (time.perf_counter() - t0) * 1000
        count = None
        try:
            count = len(full.json())
        except Exception:
            pass
        return {
            "summary_avg_ms": round(statistics.mean(samples), 2),
            "summary_p95_ms": round(_p95(samples), 2),
            "summary_kb": round(statistics.mean(sizes) / 1024, 1),
            "full_ms": round(full_ms, 2),
            "full_kb": round(len(full.content) / 1024, 1),
            "count": count,
        }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--gateway",
        default=(os.environ.get("EVOFLOW_GATEWAY_URL") or os.environ.get("EVOFLOW_GATEWAY_BASE") or "http://127.0.0.1:8012"),
        help="Gateway base URL",
    )
    ap.add_argument("--rounds", type=int, default=30)
    ap.add_argument("--skip-pipe", action="store_true")
    args = ap.parse_args()

    print("=== 1) list_apps summary vs full (in-process SQLite) ===")
    payload = bench_list_apps_payload()
    print(json.dumps(payload, ensure_ascii=False, indent=2))

    if args.skip_pipe:
        return 0

    print("\n=== 2) app-server pipe vs direct HTTP (/health/liveness) ===")
    try:
        pipe = asyncio.run(bench_pipe_vs_http(args.gateway, rounds=args.rounds))
        print(json.dumps(pipe, ensure_ascii=False, indent=2))
    except Exception as exc:
        print(
            json.dumps(
                {
                    "error": str(exc),
                    "hint": "先启动 Gateway，例如 backend: uv run uvicorn app.gateway.app:app --port 8012",
                },
                ensure_ascii=False,
            )
        )
        return 1

    print("\n=== 3) GET /api/apps (if premium) ===")
    apps = asyncio.run(bench_apps_http(args.gateway))
    print(json.dumps(apps, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "packages" / "harness"))
    raise SystemExit(main())
