"""Sync Asset Hub user memory to memory graph namespace.

This module bridges the gap between the new Asset Hub file-based memory
and the old memory graph system (mem_atoms / kg_nodes / kg_edges).

The graph system uses LLM-based extraction, but for now we provide a
heuristic sync that creates semantic atoms from asset files.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from evoflow.assets.hub import assets_root
from evoflow.memory import store as mem_store
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Heuristic patterns for categorizing memory content
_CATEGORY_PATTERNS: list[tuple[str, re.Pattern]] = [
    (
        "preference",
        re.compile(r"(偏好|爱好|喜欢|不喜欢|讨厌|习惯|风格|倾向)", re.UNICODE),
    ),
    (
        "fact",
        re.compile(r"(事实|信息|数据|结果|结论|发现|确认|已知)", re.UNICODE),
    ),
    (
        "experience",
        re.compile(r"(经验|教训|心得|总结|回顾|复盘)", re.UNICODE),
    ),
    (
        "process",
        re.compile(r"(过程|步骤|流程|方法|方案|策略|计划)", re.UNICODE),
    ),
    (
        "reflection",
        re.compile(r"(反思|思考|感悟|认识|理解|领悟)", re.UNICODE),
    ),
]


def _classify_content(content: str) -> str:
    """Classify content into a layer category based on keywords."""
    for category, pattern in _CATEGORY_PATTERNS:
        if pattern.search(content):
            return category
    return "semantic"


def _extract_summary(content: str, max_len: int = 100) -> str:
    """Extract a brief summary from content (first non-empty line or first N chars)."""
    lines = [line.strip() for line in content.split("\n") if line.strip()]
    if lines:
        first = lines[0]
        if len(first) <= max_len:
            return first
        return first[: max_len - 3] + "..."
    if len(content) <= max_len:
        return content
    return content[: max_len - 3] + "..."


def sync_user_memory_to_graph(namespace_id: str = "user:default") -> dict[str, Any]:
    """Sync Asset Hub user memory files to the memory graph namespace.

    This is a one-time sync that reads all markdown files under user/memory/
    and creates semantic atoms in the graph system.

    Returns:
        dict with sync statistics: { synced: int, namespaces: list[str] }
    """
    from evoflow.knowledge.owned.db import db

    ns = mem_store.ensure_namespace(namespace_id)
    root = assets_root() / "user" / "memory"

    if not root.is_dir():
        logger.info(f"User memory root not found: {root}")
        return {"synced": 0, "namespace": ns, "reason": "no_root"}

    synced = 0
    files_processed = []

    # Walk through memory subdirectories
    for subdir in ["facts", "episodic", "journal"]:
        subdir_path = root / subdir
        if not subdir_path.is_dir():
            continue

        for md_file in sorted(subdir_path.glob("*.md")):
            try:
                content = md_file.read_text(encoding="utf-8")
                if not content.strip():
                    continue

                # Skip README files
                if md_file.name.lower() == "readme.md":
                    continue

                # Extract frontmatter if present
                summary = _extract_summary(content)
                layer = _classify_content(content)

                # Create atom in the graph system
                with db() as conn:
                    # Check if atom already exists (by content hash)
                    content_hash = hash(content)
                    existing = conn.execute(
                        "SELECT id FROM mem_atoms WHERE namespace_id=? AND content_hash=?",
                        (ns, content_hash),
                    ).fetchone()

                    if existing:
                        logger.debug(f"Atom already exists for {md_file.name}")
                        continue

                    # Insert new atom
                    now = utc_now_iso_z()
                    conn.execute(
                        """
                        INSERT INTO mem_atoms
                        (id, namespace_id, content, summary, layer, kind, content_hash, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            f"{ns}:{md_file.stem}",
                            ns,
                            content,
                            summary,
                            layer,
                            "fact",
                            content_hash,
                            now,
                            now,
                        ),
                    )
                    synced += 1
                    files_processed.append(md_file.name)

            except Exception as exc:
                logger.warning(f"Failed to sync {md_file.name}: {exc}", exc_info=True)

    # Rebuild graph for this namespace
    try:
        from evoflow.memory.graph import rebuild_graph
        rebuild_graph(ns, clear=False)
    except Exception as exc:
        logger.warning(f"Graph rebuild failed: {exc}", exc_info=True)

    return {
        "synced": synced,
        "namespace": ns,
        "files_processed": files_processed,
    }


def sync_workspace_memory_to_graph(workspace_id: str) -> dict[str, Any]:
    """Sync Asset Hub workspace memory files to the memory graph namespace.

    Args:
        workspace_id: The workspace entity ID (e.g., 'ws-abc123')

    Returns:
        dict with sync statistics
    """
    from evoflow.knowledge.owned.db import db

    namespace_id = f"workspace:{workspace_id}"
    ns = mem_store.ensure_namespace(namespace_id)
    root = assets_root() / "workspaces" / workspace_id / "memory"

    if not root.is_dir():
        logger.info(f"Workspace memory root not found: {root}")
        return {"synced": 0, "namespace": ns, "reason": "no_root"}

    synced = 0
    files_processed = []

    for md_file in sorted(root.glob("**/*.md")):
        try:
            content = md_file.read_text(encoding="utf-8")
            if not content.strip():
                continue

            if md_file.name.lower() == "readme.md":
                continue

            summary = _extract_summary(content)
            layer = _classify_content(content)

            with db() as conn:
                content_hash = hash(content)
                existing = conn.execute(
                    "SELECT id FROM mem_atoms WHERE namespace_id=? AND content_hash=?",
                    (ns, content_hash),
                ).fetchone()

                if existing:
                    continue

                now = utc_now_iso_z()
                conn.execute(
                    """
                    INSERT INTO mem_atoms
                    (id, namespace_id, content, summary, layer, kind, content_hash, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"{ns}:{md_file.stem}",
                        ns,
                        content,
                        summary,
                        layer,
                        "fact",
                        content_hash,
                        now,
                        now,
                    ),
                )
                synced += 1
                files_processed.append(str(md_file.relative_to(root)))

        except Exception as exc:
            logger.warning(f"Failed to sync {md_file.name}: {exc}", exc_info=True)

    try:
        from evoflow.memory.graph import rebuild_graph
        rebuild_graph(ns, clear=False)
    except Exception as exc:
        logger.warning(f"Graph rebuild failed: {exc}", exc_info=True)

    return {
        "synced": synced,
        "namespace": ns,
        "files_processed": files_processed,
    }
