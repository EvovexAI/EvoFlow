"""Minimal LSP JSON-RPC client over stdio (documentSymbol)."""

from __future__ import annotations

import json
import logging
import subprocess
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_LSP_KIND_MAP: dict[int, str] = {
    1: "file",
    2: "module",
    3: "namespace",
    4: "package",
    5: "class",
    6: "method",
    7: "property",
    8: "field",
    9: "constructor",
    10: "enum",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    15: "string",
    16: "number",
    17: "boolean",
    18: "array",
    19: "object",
    20: "key",
    21: "null",
    22: "enum_member",
    23: "struct",
    24: "event",
    25: "operator",
    26: "type_parameter",
}


def _kind_name(kind: int | None) -> str:
    if kind is None:
        return "symbol"
    return _LSP_KIND_MAP.get(int(kind), "symbol")


def flatten_document_symbols(items: list[dict] | None, *, parser: str) -> list[dict]:
    """Flatten hierarchical ``textDocument/documentSymbol`` response."""
    out: list[dict] = []

    def walk(nodes: list[dict] | None) -> None:
        if not nodes:
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            name = str(node.get("name") or "").strip()
            if name and not name.startswith("_"):
                rng = node.get("range") or node.get("selectionRange") or {}
                start = rng.get("start") if isinstance(rng, dict) else {}
                line = int((start or {}).get("line", 0)) + 1
                out.append(
                    {
                        "name": name,
                        "kind": _kind_name(node.get("kind")),
                        "line": max(1, line),
                        "parser": parser,
                    }
                )
            children = node.get("children")
            if isinstance(children, list):
                walk(children)

    walk(items if isinstance(items, list) else None)
    return out[:200]


class LspClient:
    """One language-server subprocess for a workspace root."""

    def __init__(self, command: list[str], workspace_root: str, *, timeout_seconds: float = 30.0) -> None:
        self._root = Path(workspace_root).resolve()
        self._timeout = timeout_seconds
        self._lock = threading.Lock()
        self._next_id = 1
        self._proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        if self._proc.stdin is None or self._proc.stdout is None:
            raise RuntimeError("LSP process missing stdio pipes")
        self._initialize()

    def close(self) -> None:
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
        except OSError:
            pass
        try:
            self._proc.terminate()
            self._proc.wait(timeout=3)
        except Exception:
            try:
                self._proc.kill()
            except Exception:
                pass

    def _read_message(self) -> dict[str, Any]:
        stdout = self._proc.stdout
        assert stdout is not None
        headers: dict[str, str] = {}
        while True:
            line = stdout.readline()
            if not line:
                raise RuntimeError("LSP server closed stdout")
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                break
            if ":" in text:
                k, v = text.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        length = int(headers.get("content-length", "0"))
        if length <= 0:
            return {}
        body = stdout.read(length)
        if not body:
            return {}
        return json.loads(body.decode("utf-8"))

    def _send(self, payload: dict[str, Any]) -> None:
        stdin = self._proc.stdin
        assert stdin is not None
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        header = f"Content-Length: {len(data)}\r\n\r\n".encode("ascii")
        stdin.write(header)
        stdin.write(data)
        stdin.flush()

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            req_id = self._next_id
            self._next_id += 1
            self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
            while True:
                msg = self._read_message()
                if msg.get("id") == req_id:
                    if "error" in msg:
                        err = msg["error"]
                        raise RuntimeError(f"LSP error {method}: {err}")
                    result = msg.get("result")
                    return result if isinstance(result, dict) else {"items": result}
                if msg.get("method") == "window/logMessage":
                    continue

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        with self._lock:
            self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _initialize(self) -> None:
        root_uri = self._root.as_uri()
        self._request(
            "initialize",
            {
                "processId": None,
                "rootUri": root_uri,
                "capabilities": {},
                "workspaceFolders": [{"uri": root_uri, "name": self._root.name or "workspace"}],
            },
        )
        self._notify("initialized", {})

    def document_symbols(self, file_path: Path, text: str, *, parser_label: str) -> list[dict]:
        uri = file_path.resolve().as_uri()
        language_id = _language_id(file_path.suffix)
        self._notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id,
                    "version": 1,
                    "text": text,
                }
            },
        )
        result = self._request(
            "textDocument/documentSymbol",
            {"textDocument": {"uri": uri}, "partialResultToken": None},
        )
        items = result if isinstance(result, list) else result.get("items") if isinstance(result, dict) else []
        if not isinstance(items, list):
            items = []
        return flatten_document_symbols(items, parser=f"lsp_{parser_label}")


def _language_id(suffix: str) -> str:
    s = str(suffix or "").lower()
    return {
        ".py": "python",
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".java": "java",
        ".go": "go",
        ".rs": "rust",
    }.get(s, "plaintext")
