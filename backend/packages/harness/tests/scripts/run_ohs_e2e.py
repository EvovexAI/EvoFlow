#!/usr/bin/env python3
"""Real OHS E2E: private npm install + fake OpenAI embed server + full capability matrix.

Usage (from backend/):
  .venv/Scripts/python.exe packages/harness/tests/scripts/run_ohs_e2e.py

Requires network on first install. Skips cleanly if Node/npm missing.
Writes evidence JSON next to this script: ohs_e2e_live_result.json
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[2]  # packages/harness
BACKEND = Path(__file__).resolve().parents[3]  # backend
SCRIPTS = Path(__file__).resolve().parent
OUT_JSON = SCRIPTS / "ohs_e2e_live_result.json"

sys.path.insert(0, str(HARNESS))
sys.path.insert(0, str(BACKEND / "packages" / "harness"))
sys.path.insert(0, str(SCRIPTS))
from fake_openai_embed_server import Handler  # noqa: E402


def _have_npm() -> bool:
    return bool(shutil.which("npm") or shutil.which("npm.cmd"))


def _have_node() -> bool:
    return bool(shutil.which("node") or shutil.which("node.exe"))


def _write_vault(vault: Path) -> None:
    (vault / ".obsidian").mkdir(parents=True, exist_ok=True)
    knowledge = vault / "Knowledge"
    knowledge.mkdir(parents=True, exist_ok=True)
    (vault / "00-Inbox").mkdir(parents=True, exist_ok=True)
    (knowledge / "Agent Memory.md").write_text(
        "---\ntags: [memory, agent]\naliases: [智能体记忆]\n---\n"
        "# Agent Memory\n\n智能体长期记忆用于保存跨任务可复用的信息。\n\n"
        "See also [[RAG]] and [[EvoFlow]].\n",
        encoding="utf-8",
    )
    (knowledge / "RAG.md").write_text(
        "---\ntags: [rag, retrieval]\n---\n"
        "# RAG\n\nRetrieval Augmented Generation 与中文检索。\n\n"
        "Back to [[Agent Memory]].\n",
        encoding="utf-8",
    )
    (knowledge / "EvoFlow.md").write_text(
        "---\ntags: [product]\naliases: [进化流]\n---\n"
        "# EvoFlow\n\nEvoFlow 桌面 Agent 工作台。关联 [[Agent Memory]]。\n",
        encoding="utf-8",
    )


async def _main() -> int:
    evidence: dict = {"steps": {}, "tools": [], "ok": False}
    if not _have_node() or not _have_npm():
        print("SKIP: Node.js / npm not available")
        evidence["skip"] = "no_node"
        OUT_JSON.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0

    with tempfile.TemporaryDirectory(prefix="evoflow-ohs-e2e-") as tmp:
        tmp_path = Path(tmp)
        runtime = tmp_path / "kb-mcp"
        vault = tmp_path / "vault"
        vault.mkdir()
        _write_vault(vault)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        embed_base = f"http://127.0.0.1:{port}/v1"
        print(f"fake-embed {embed_base}", flush=True)
        evidence["fakeEmbed"] = embed_base

        os.environ["EVOFLOW_KB_RUNTIME_ROOT"] = str(runtime)
        os.environ.pop("EVOFLOW_PACKAGED", None)

        from evoflow.knowledge.vault.mcp_runtime import (
            call_tool,
            drop_session,
            ensure_session,
            install_packages,
            get_session,
        )
        from evoflow.knowledge.vault.models import KnowledgeVaultConfig, EmbeddingMode
        from evoflow.knowledge.vault.capability import (
            build_search_arguments,
            build_related_graph_arguments,
            build_read_arguments,
        )
        from evoflow.knowledge.vault.normalize import (
            normalize_search_results,
            normalize_notes,
            build_graph_from_related_search,
        )
        from evoflow.knowledge.vault.runtime_resolve import build_search_launch_plan

        print("Installing private packages…", flush=True)
        os.environ["EVOFLOW_KB_MCP_LAUNCH"] = "npx"
        result = await install_packages()
        assert result.get("ok"), result
        evidence["install"] = {"runtimeRoot": result.get("runtimeRoot"), "ok": True}
        print("install ok", flush=True)

        os.environ["EVOFLOW_KB_MCP_LAUNCH"] = "private"
        plan = build_search_launch_plan()
        evidence["launchPlan"] = {
            "kind": plan.kind,
            "command": plan.command,
            "args": plan.args,
            "message": plan.message,
        }
        assert plan.kind == "private", plan

        cfg = KnowledgeVaultConfig.model_validate(
            {
                "id": "e2e",
                "name": "e2e-vault",
                "vaultPath": str(vault),
                "accessMode": "read_only",
                "enabled": True,
                "embeddingMode": EmbeddingMode.openai_compatible.value,
                "embeddingBaseUrl": embed_base,
                "embeddingModel": "text-embedding-3-small",
            }
        )

        try:
            sess = await ensure_session(cfg, force_reload=True)
            assert sess.search_tools, sess.search_error
            assert sess.search_capabilities and sess.search_capabilities.search_tool
            caps = sess.search_capabilities
            tool_names = sorted(sess.search_tools.keys())
            evidence["tools"] = tool_names
            evidence["discovered"] = {
                "search": caps.search_tool,
                "read": caps.read_tool,
                "reindex": caps.reindex_tool,
                "status": caps.status_tool,
            }
            evidence["schemas"] = {
                name: (caps.schemas.get(name) if caps.schemas else None)
                for name in (caps.search_tool, caps.read_tool, caps.reindex_tool, caps.status_tool)
                if name
            }
            print("tools/list:", tool_names, flush=True)
            evidence["steps"]["initialize"] = True
            evidence["steps"]["tools_list"] = tool_names

            search_tool = caps.search_tool
            search_schema = caps.schemas.get(search_tool) if caps.schemas else None

            # status
            if caps.status_tool:
                status_raw = await call_tool(sess.search_tools, caps.status_tool, {})
                evidence["steps"]["status"] = str(status_raw)[:800]
                print("status ok", flush=True)

            # reindex
            if caps.reindex_tool:
                reindex_raw = await call_tool(sess.search_tools, caps.reindex_tool, {})
                evidence["steps"]["reindex"] = str(reindex_raw)[:800]
                print("reindex done", flush=True)

            async def _search(label: str, session, tool_name: str, schema, **kwargs):
                args = build_search_arguments(schema=schema, **kwargs)
                raw = await call_tool(session.search_tools, tool_name, args)
                hits = normalize_search_results("e2e", raw)
                evidence["steps"][label] = {
                    "args": args,
                    "hitCount": len(hits),
                    "paths": [h.path for h in hits[:5]],
                }
                print(f"{label} hits={len(hits)} paths={evidence['steps'][label]['paths']}", flush=True)
                return hits

            hits_ft = await _search(
                "fulltext_zh", sess, search_tool, search_schema, query="智能体长期记忆", mode="fulltext", top_k=5
            )
            assert hits_ft, "fulltext Chinese search returned no hits"

            hits_sem = await _search(
                "semantic_zh", sess, search_tool, search_schema, query="跨任务可复用信息", mode="semantic", top_k=5
            )
            evidence["steps"]["semantic_zh"]["note"] = "fake embeddings; non-empty preferred"

            hits_hyb = await _search(
                "hybrid_zh", sess, search_tool, search_schema, query="智能体记忆", mode="hybrid", top_k=5
            )
            assert hits_hyb, "hybrid Chinese search returned no hits"

            hits_title = await _search(
                "title_match", sess, search_tool, search_schema, query="EvoFlow", mode="title", top_k=5
            )
            assert any("EvoFlow" in (h.path or "") for h in hits_title), hits_title

            await _search(
                "tag_filter", sess, search_tool, search_schema, query="", mode="fulltext", top_k=5, tags=["memory"]
            )
            await _search(
                "folder_scope",
                sess,
                search_tool,
                search_schema,
                query="记忆",
                mode="hybrid",
                top_k=5,
                scopes=["Knowledge"],
            )
            # read
            assert caps.read_tool
            read_args = build_read_arguments(
                paths=["Knowledge/Agent Memory.md"],
                schema=caps.schemas.get(caps.read_tool) if caps.schemas else None,
            )
            read_raw = await call_tool(sess.search_tools, caps.read_tool, read_args)
            notes = normalize_notes("e2e", read_raw)
            evidence["steps"]["read"] = {
                "args": read_args,
                "noteCount": len(notes),
                "paths": [n.path for n in notes],
            }
            assert notes, "read returned empty"
            print("read ok", flush=True)

            # links / backlinks / graph via related
            gargs = build_related_graph_arguments(
                path="Knowledge/Agent Memory.md",
                depth=1,
                direction="both",
                schema=search_schema,
            )
            grow = await call_tool(sess.search_tools, search_tool, gargs)
            graph = build_graph_from_related_search("e2e", "Knowledge/Agent Memory.md", grow, depth=1)
            evidence["steps"]["graph_depth1"] = {
                "args": gargs,
                "nodes": len(graph.nodes),
                "edges": len(graph.edges),
                "edgeTypes": sorted({e.type for e in graph.edges}),
            }
            print(
                f"graph nodes={len(graph.nodes)} edges={len(graph.edges)} types={evidence['steps']['graph_depth1']['edgeTypes']}",
                flush=True,
            )
            assert graph.edges, "expected wikilink edges from related search"

            # incremental: update one file then reindex
            target = vault / "Knowledge" / "EvoFlow.md"
            target.write_text(
                target.read_text(encoding="utf-8") + "\n\n增量更新：中文索引验证段落。\n",
                encoding="utf-8",
            )
            if caps.reindex_tool:
                await call_tool(sess.search_tools, caps.reindex_tool, {})
            hits_inc = await _search(
                "incremental_after_update",
                sess,
                search_tool,
                search_schema,
                query="增量更新",
                mode="fulltext",
                top_k=5,
            )
            assert hits_inc, "incremental index did not pick up file update"

            # restart MCP and verify index recovery
            pids_before = list(sess.managed_pids)
            await drop_session("e2e")
            sess2 = await ensure_session(cfg, force_reload=True)
            assert sess2.search_tools and sess2.search_capabilities
            search_tool2 = sess2.search_capabilities.search_tool
            search_schema2 = (
                sess2.search_capabilities.schemas.get(search_tool2) if sess2.search_capabilities.schemas else None
            )
            hits_after = await _search(
                "after_restart",
                sess2,
                search_tool2,
                search_schema2,
                query="智能体记忆",
                mode="hybrid",
                top_k=5,
            )
            assert hits_after, "search failed after MCP restart"
            evidence["steps"]["restart"] = {
                "pidsBefore": pids_before,
                "pidsAfter": list(sess2.managed_pids),
                "hits": len(hits_after),
            }
            print("restart ok", flush=True)

            # singleton: 10 searches should not spawn 10 sessions
            sess_again = get_session("e2e")
            assert sess_again is sess2
            for i in range(10):
                await _search(f"reuse_{i}", sess2, search_tool2, search_schema2, query="EvoFlow", mode="title", top_k=3)
            sess_final = get_session("e2e")
            evidence["steps"]["singleton"] = {
                "sameObject": sess_final is sess2,
                "pids": list(sess_final.managed_pids) if sess_final else [],
            }
            assert sess_final is sess2
            assert len(sess_final.managed_pids) <= 3  # search (+ maybe helper), not 10

            evidence["ok"] = True
            print("OHS E2E OK", flush=True)
            return 0
        finally:
            await drop_session("e2e")
            httpd.shutdown()
            OUT_JSON.write_text(json.dumps(evidence, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
            print(f"wrote {OUT_JSON}", flush=True)

if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(_main()))
    except Exception as exc:
        print(f"OHS E2E FAILED: {exc}", file=sys.stderr)
        raise
