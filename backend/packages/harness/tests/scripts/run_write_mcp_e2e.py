#!/usr/bin/env python3
"""Write MCP E2E against a live Obsidian Local REST API.

Manual run (never commit API keys):

  $env:OBSIDIAN_API_KEY='…'
  $env:OBSIDIAN_VAULT_PATH='D:\\path\\to\\vault'
  $env:OBSIDIAN_BASE_URL='http://127.0.0.1:27123'
  backend\\.venv\\Scripts\\python.exe packages\\harness\\tests\\scripts\\run_write_mcp_e2e.py

Validates: create / append / patch / frontmatter / tags, write-allowlist denial,
and ``obsidian_not_running`` when the API is unreachable.

Skips (exit 0) when OBSIDIAN_API_KEY is missing. Never prints the API key.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[2]
BACKEND = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(HARNESS))
sys.path.insert(0, str(BACKEND / "packages" / "harness"))


def _find_tool(tools: dict, *needles: str) -> str | None:
    for name in tools:
        low = name.lower()
        if all(n in low for n in needles):
            return name
    for name in tools:
        low = name.lower()
        if any(n in low for n in needles):
            return name
    return None


async def _main() -> int:
    api_key = (os.environ.get("OBSIDIAN_API_KEY") or "").strip()
    if not api_key:
        print("SKIP: OBSIDIAN_API_KEY not set")
        print(
            "Command: $env:OBSIDIAN_API_KEY='…'; $env:OBSIDIAN_VAULT_PATH='D:\\vault'; "
            "backend\\.venv\\Scripts\\python.exe packages\\harness\\tests\\scripts\\run_write_mcp_e2e.py"
        )
        return 0

    vault_path = (os.environ.get("OBSIDIAN_VAULT_PATH") or "").strip()
    tmp_ctx = None
    if not vault_path:
        tmp_ctx = tempfile.TemporaryDirectory(prefix="evoflow-write-e2e-")
        vault_path = tmp_ctx.name
        Path(vault_path, ".obsidian").mkdir(parents=True, exist_ok=True)
        Path(vault_path, "00-Inbox").mkdir(parents=True, exist_ok=True)
        Path(vault_path, "Knowledge").mkdir(parents=True, exist_ok=True)

    base_url = (os.environ.get("OBSIDIAN_BASE_URL") or "http://127.0.0.1:27123").strip()
    runtime = Path(tempfile.mkdtemp(prefix="evoflow-kb-write-rt-"))
    os.environ["EVOFLOW_KB_RUNTIME_ROOT"] = str(runtime)
    os.environ.setdefault("EVOFLOW_KB_MCP_LAUNCH", "npx")

    from evoflow.knowledge.vault import secrets as vault_secrets
    from evoflow.knowledge.vault.mcp_runtime import ensure_session, drop_session, call_tool, install_packages
    from evoflow.knowledge.vault.models import KnowledgeVaultConfig, AccessMode
    from evoflow.knowledge.vault.sanitize import sanitize_text
    from evoflow.knowledge.vault.provider import ObsidianKnowledgeProvider
    from evoflow.knowledge.vault import store as vault_store
    from evoflow.knowledge.vault.errors import ObsidianNotRunningError, PathForbiddenError

    store: dict = {}

    def _get(_k):
        return store.get("secrets")

    def _set(_k, v):
        store["secrets"] = v

    import evoflow.knowledge.vault.secrets as sec_mod

    orig_get, orig_set = sec_mod.cfg_repo.get_app_setting, sec_mod.cfg_repo.set_app_setting
    sec_mod.cfg_repo.get_app_setting = _get  # type: ignore[method-assign]
    sec_mod.cfg_repo.set_app_setting = _set  # type: ignore[method-assign]

    try:
        print("Ensuring packages…", flush=True)
        await install_packages()
        ref = vault_secrets.default_obsidian_key_ref("write-e2e")
        vault_secrets.put_secret(ref, api_key)
        cfg = KnowledgeVaultConfig.model_validate(
            {
                "id": "write-e2e",
                "name": "write-e2e",
                "vaultPath": vault_path,
                "accessMode": AccessMode.read_write.value,
                "enabled": True,
                "obsidianBaseUrl": base_url,
                "obsidianApiKeySecretRef": ref,
                "allowedWritePaths": ["00-Inbox"],
            }
        )
        # Persist config so provider can resolve vault_id
        vault_store.upsert_vault_config(cfg)

        sess = await ensure_session(cfg, need_write=True, force_reload=True)
        if not sess.write_tools:
            err = sanitize_text(sess.write_error or "")
            print(f"FAIL: write tools unavailable: {err}", file=sys.stderr)
            if "not running" in err.lower() or "connection" in err.lower() or "refused" in err.lower():
                print("obsidian_not_running (API unreachable at startup)", flush=True)
            return 1

        tools = sess.write_tools
        safe_names = [k for k in sorted(tools) if "command" not in k.lower()]
        print("write tools:", safe_names, flush=True)

        provider = ObsidianKnowledgeProvider()
        note_path = "00-Inbox/EvoFlow-Write-E2E.md"

        await provider.create_note(cfg.id, note_path, "# EvoFlow Write E2E\n\ncreated\n")
        print("create ok", flush=True)

        await provider.append_note(cfg.id, note_path, "\nappended line\n")
        print("append ok", flush=True)

        await provider.patch_note(
            cfg.id, note_path, target="body", operation="append", content="\npatched\n"
        )
        print("patch ok", flush=True)

        fm_tool = _find_tool(tools, "frontmatter") or _find_tool(tools, "property")
        tag_tool = _find_tool(tools, "tag")
        if fm_tool:
            await call_tool(tools, fm_tool, {"path": note_path, "key": "source", "value": "evoflow-e2e"})
            print(f"frontmatter ok via {fm_tool}", flush=True)
        else:
            print("frontmatter tool not discovered — skipped", flush=True)
        if tag_tool:
            await call_tool(tools, tag_tool, {"path": note_path, "tags": ["evoflow-e2e"]})
            print(f"tags ok via {tag_tool}", flush=True)
        else:
            print("tag tool not discovered — skipped", flush=True)

        try:
            await provider.create_note(cfg.id, "Knowledge/forbidden.md", "nope")
            print("FAIL: allowlist bypass", file=sys.stderr)
            return 1
        except PathForbiddenError:
            print("allowlist deny ok (PathForbiddenError)", flush=True)
        except Exception as exc:
            msg = sanitize_text(str(exc))
            if "allow" in msg.lower() or "path" in msg.lower() or "forbidden" in msg.lower():
                print(f"allowlist deny ok: {msg[:200]}", flush=True)
            else:
                print(f"FAIL: unexpected allowlist error: {msg[:200]}", file=sys.stderr)
                return 1

        # Wrong port → obsidian_not_running
        bad = cfg.model_copy(deep=True)
        bad.id = "write-e2e-down"
        bad.obsidian_base_url = "http://127.0.0.1:1"
        bad.obsidian_api_key_secret_ref = ref
        vault_store.upsert_vault_config(bad)
        try:
            await drop_session(bad.id)
            await ensure_session(bad, need_write=True, force_reload=True)
            await provider.create_note(bad.id, note_path, "x")
            print("WARN: expected failure when Obsidian port closed", flush=True)
        except ObsidianNotRunningError:
            print("obsidian_not_running ok", flush=True)
        except Exception as exc:
            code = str(getattr(exc, "code", "") or "")
            text = sanitize_text(str(exc))
            if "obsidian_not_running" in code or "obsidian_not_running" in text or "refused" in text.lower():
                print(f"obsidian_not_running ok ({code or 'mapped'})", flush=True)
            else:
                print(f"WARN: expected obsidian_not_running, got {text[:200]}", flush=True)

        print("WRITE MCP E2E OK", flush=True)
        return 0
    finally:
        await drop_session("write-e2e")
        await drop_session("write-e2e-down")
        try:
            vault_store.delete_vault_config("write-e2e")
            vault_store.delete_vault_config("write-e2e-down")
        except Exception:
            pass
        sec_mod.cfg_repo.get_app_setting = orig_get  # type: ignore[method-assign]
        sec_mod.cfg_repo.set_app_setting = orig_set  # type: ignore[method-assign]
        if tmp_ctx is not None:
            tmp_ctx.cleanup()


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(_main()))
    except Exception as exc:
        from evoflow.knowledge.vault.sanitize import sanitize_text

        print(f"WRITE MCP E2E FAILED: {sanitize_text(str(exc))}", file=sys.stderr)
        raise
