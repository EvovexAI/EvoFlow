"""Pooled LSP sessions per (workspace, language server profile)."""

from __future__ import annotations

import logging
import threading
from pathlib import Path

from evoflow.code_index.lsp_client import LspClient
from evoflow.config.code_index_config import get_code_index_config, profile_for_suffix

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_sessions: dict[tuple[str, str], LspClient] = {}
_lsp_build_budget: dict[str, int] = {}


def _session_key(workspace_root: str, profile_name: str) -> tuple[str, str]:
    return (str(Path(workspace_root).resolve()), profile_name)


def get_lsp_client(workspace_root: str, suffix: str) -> LspClient | None:
    cfg = get_code_index_config()
    if not cfg.lsp_enabled:
        return None
    profile = profile_for_suffix(suffix)
    if profile is None:
        return None
    key = _session_key(workspace_root, profile.name)
    with _lock:
        client = _sessions.get(key)
        if client is None:
            try:
                client = LspClient(
                    [str(c) for c in profile.command],
                    workspace_root,
                    timeout_seconds=cfg.lsp_timeout_seconds,
                )
                _sessions[key] = client
                logger.info("LSP started profile=%s root=%s cmd=%s", profile.name, workspace_root, profile.command)
            except Exception as e:
                logger.debug("LSP start failed profile=%s: %s", profile.name, e)
                return None
        return client


def try_lsp_symbols(workspace_root: str, file_path: Path, text: str, *, for_full_build: bool = False) -> list[dict] | None:
    cfg = get_code_index_config()
    if not cfg.lsp_enabled or not cfg.lsp_prefer:
        return None
    profile = profile_for_suffix(file_path.suffix)
    if profile is None:
        return None
    root = str(Path(workspace_root).resolve())
    if for_full_build and cfg.lsp_max_files_per_build > 0:
        with _lock:
            used = _lsp_build_budget.get(root, 0)
            if used >= cfg.lsp_max_files_per_build:
                return None
            _lsp_build_budget[root] = used + 1
    client = get_lsp_client(root, file_path.suffix)
    if client is None:
        return None
    try:
        return client.document_symbols(file_path, text, parser_label=profile.name)
    except Exception as e:
        logger.debug("LSP documentSymbol failed %s: %s", file_path, e)
        return None


def reset_build_budget(workspace_root: str | None = None) -> None:
    with _lock:
        if workspace_root is None:
            _lsp_build_budget.clear()
        else:
            _lsp_build_budget.pop(str(Path(workspace_root).resolve()), None)


def shutdown_lsp_pool(workspace_root: str | None = None) -> None:
    with _lock:
        keys = list(_sessions.keys())
        for key in keys:
            if workspace_root is not None and key[0] != str(Path(workspace_root).resolve()):
                continue
            try:
                _sessions.pop(key).close()
            except Exception:
                pass
        if workspace_root is None:
            _lsp_build_budget.clear()
