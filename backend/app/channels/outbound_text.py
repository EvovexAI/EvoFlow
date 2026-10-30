"""Shared outbound text cleanup for all IM channels (Feishu / WeCom / …)."""

from __future__ import annotations


def sanitize_channel_outbound_text(text: str) -> str:
    """Strip agent-internal markup that must not reach IM surfaces.

    Today: ``<evo-asset-citation>`` blocks and loose ``citation_entries:`` leaks
    (same rules as Panel V4 / ``evoflow.assets.citation``).
    """
    raw = text or ""
    try:
        from evoflow.assets.citation import strip_evo_asset_citations

        return strip_evo_asset_citations(raw)
    except Exception:
        return raw
