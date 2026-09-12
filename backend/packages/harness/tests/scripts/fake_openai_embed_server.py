"""Minimal OpenAI-compatible embeddings server for OHS offline E2E."""

from __future__ import annotations

import hashlib
import json
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


DIM = 384


def _embed(text: str) -> list[float]:
    # Deterministic pseudo-embedding from text hash (good enough for index + hybrid smoke)
    h = hashlib.sha256(text.encode("utf-8")).digest()
    vals = []
    seed = h
    while len(vals) < DIM:
        seed = hashlib.sha256(seed).digest()
        for b in seed:
            vals.append(((b / 255.0) * 2.0) - 1.0)
            if len(vals) >= DIM:
                break
    # L2 normalize
    norm = math.sqrt(sum(v * v for v in vals)) or 1.0
    return [v / norm for v in vals]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/v1/models"):
            body = json.dumps(
                {
                    "data": [
                        {
                            "id": "text-embedding-3-small",
                            "object": "model",
                            "context_length": 512,
                        }
                    ]
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            payload = {}
        if self.path.rstrip("/").endswith("/embeddings") or "/embeddings" in self.path:
            inp = payload.get("input")
            texts = inp if isinstance(inp, list) else [str(inp or "")]
            data = [
                {"object": "embedding", "index": i, "embedding": _embed(str(t))}
                for i, t in enumerate(texts)
            ]
            body = json.dumps({"object": "list", "data": data, "model": payload.get("model") or "text-embedding-3-small"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    host, port = "127.0.0.1", 8765
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"fake-embed http://{host}:{port}/v1", flush=True)
    httpd.serve_forever()
