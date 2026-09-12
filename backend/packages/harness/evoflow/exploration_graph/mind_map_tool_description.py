"""Canonical policy for the standalone ``mind_map`` tool description."""

from __future__ import annotations

MIND_MAP_TOOL_DESCRIPTION = """\
Update or query the session mind map (call-chain graph). Not auto-injected — use \
``query=true`` to read; updates return a compact ``<session_mind_map>`` snapshot.

Hard rules: (1) every ``upsert_node`` pairs with ``upsert_edge`` in the same batch; \
(2) omit edge ``id``; (3) empty session → first batch includes ``set_goal``; \
(4) close done flow/gap → ``patch_node`` status resolved|verified|refuted|blocked + \
``claim:`` child (overwrite ``body``, not ``append_body``).

Shape: goal:session → flow: → file:/gap:/claim:/diagram: (prefix ids). Body = concrete \
facts (path + symbol + line), not diaries.

``ops`` op values: set_goal, upsert_node, patch_node, delete_node, upsert_edge, delete_edge.
"""
