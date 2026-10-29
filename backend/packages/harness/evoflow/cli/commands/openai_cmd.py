"""evoflow openai — OpenAI-compatible single-shot chat / vision over configured models."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
from pathlib import Path
from typing import Any

from evoflow.admin.errors import ValidationError
from evoflow.cli.common import add_json_input_flags, add_output_flags, load_json_payload


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "openai",
        help="OpenAI-compatible chat / vision against configured models",
        description=(
            "Call platform models with an OpenAI-shaped contract.\n"
            "In-process by default; use --gateway to hit GET/POST /openai/v1/* on the local Gateway."
        ),
    )
    sub = parser.add_subparsers(dest="openai_cmd", required=True)

    models_p = sub.add_parser("models", help="List configured models (OpenAI /v1/models shape)")
    models_p.add_argument("--gateway", action="store_true", help="Call Gateway /openai/v1/models")
    models_p.add_argument("--gateway-url", metavar="URL", help="Gateway base URL (implies --gateway)")
    add_output_flags(models_p)
    models_p.set_defaults(handler=_models)

    chat_p = sub.add_parser("chat", help="Single chat completion")
    chat_p.add_argument("--model", "-M", default=None, help="Configured model name")
    chat_p.add_argument("-m", "--message", default=None, help="User message (single turn)")
    chat_p.add_argument("--system", default=None, help="Optional system prompt")
    chat_p.add_argument("--temperature", type=float, default=None)
    chat_p.add_argument("--json", dest="as_json", action="store_true", help="Print full OpenAI response JSON")
    chat_p.add_argument("--gateway", action="store_true", help="Call Gateway /openai/v1/chat/completions")
    chat_p.add_argument("--gateway-url", metavar="URL", help="Gateway base URL (implies --gateway)")
    chat_p.add_argument("--token", default=None, help="Bearer token when using --gateway")
    add_json_input_flags(chat_p)
    add_output_flags(chat_p)
    chat_p.set_defaults(handler=_chat)

    vision_p = sub.add_parser("vision", help="Describe / ask about one image")
    vision_p.add_argument("--image", "-i", required=True, help="Image path, https URL, or data: URL")
    vision_p.add_argument("-m", "--message", required=True, help="Question / instruction about the image")
    vision_p.add_argument("--model", "-M", default=None, help="Vision-capable configured model")
    vision_p.add_argument("--system", default=None, help="Optional system prompt")
    vision_p.add_argument("--temperature", type=float, default=None)
    vision_p.add_argument("--json", dest="as_json", action="store_true", help="Print full OpenAI response JSON")
    vision_p.add_argument("--gateway", action="store_true", help="Call Gateway /openai/v1/chat/completions")
    vision_p.add_argument("--gateway-url", metavar="URL", help="Gateway base URL (implies --gateway)")
    vision_p.add_argument("--token", default=None, help="Bearer token when using --gateway")
    add_output_flags(vision_p)
    vision_p.set_defaults(handler=_vision)


def _gateway_base(args: argparse.Namespace) -> str | None:
    url = str(getattr(args, "gateway_url", None) or "").strip()
    if url:
        return url.rstrip("/")
    if not getattr(args, "gateway", False):
        return None
    env = os.environ.get("EVOFLOW_GATEWAY_URL", "").strip()
    if env:
        return env.rstrip("/")
    runtime = _find_gateway_runtime()
    base = str(runtime.get("baseUrl") or "").strip()
    if base:
        return base.rstrip("/")
    port = runtime.get("port")
    if port:
        return f"http://127.0.0.1:{port}"
    raise ValidationError(
        "Gateway URL not found; pass --gateway-url or set EVOFLOW_GATEWAY_URL / EVOFLOW_HOME"
    )


def _find_gateway_runtime() -> dict[str, Any]:
    candidates: list[Path] = []
    home = os.getenv("EVOFLOW_HOME", "").strip()
    if home:
        candidates.append(Path(home) / "backend-runtime.json")
    for base in (Path.home() / ".evoflow", Path.home() / ".evoflow-dev"):
        profiles = base / "profiles"
        if profiles.is_dir():
            try:
                candidates.extend(
                    p / "backend-runtime.json" for p in sorted(profiles.iterdir()) if p.is_dir()
                )
            except OSError:
                pass
        candidates.append(base / "backend-runtime.json")
    for candidate in candidates:
        try:
            if candidate.is_file():
                data = json.loads(candidate.read_text(encoding="utf-8"))
                return {
                    "path": str(candidate),
                    "baseUrl": data.get("baseUrl"),
                    "port": data.get("port"),
                }
        except Exception:
            continue
    return {}


def _bearer(args: argparse.Namespace) -> str | None:
    tok = str(getattr(args, "token", None) or "").strip()
    if tok:
        return tok
    return (
        os.environ.get("EVOFLOW_GATEWAY_TOKEN", "").strip()
        or os.environ.get("EVOFLOW_API_TOKEN", "").strip()
        or None
    )


def _http_json(method: str, url: str, *, token: str | None, body: dict | None = None) -> Any:
    import httpx

    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with httpx.Client(timeout=300.0) as client:
        if method.upper() == "GET":
            r = client.get(url, headers=headers)
        else:
            r = client.post(url, headers=headers, json=body or {})
        if r.status_code >= 400:
            detail = r.text
            try:
                detail = r.json().get("detail") or r.json().get("error") or detail
            except Exception:
                pass
            raise ValidationError(f"Gateway {r.status_code}: {detail}")
        return r.json()


def _models(args: argparse.Namespace) -> Any:
    base = _gateway_base(args)
    if base:
        return _http_json("GET", f"{base}/openai/v1/models", token=_bearer(args))
    from evoflow.models.openai_compat_invoke import list_configured_models_openai

    return list_configured_models_openai()


def _emit_completion(result: dict[str, Any], *, as_json: bool, compact: bool) -> Any:
    if as_json:
        return result
    text = ""
    try:
        text = str((((result.get("choices") or [{}])[0].get("message") or {}).get("content")) or "")
    except Exception:
        text = ""
    # Plain text to stdout (not JSON wrapper)
    sys.stdout.write(text)
    if text and not text.endswith("\n"):
        sys.stdout.write("\n")
    return None


def _chat(args: argparse.Namespace) -> Any:
    payload = load_json_payload(args)
    messages: list[dict[str, Any]]
    model = getattr(args, "model", None)
    temperature = getattr(args, "temperature", None)

    if isinstance(payload, dict) and isinstance(payload.get("messages"), list):
        messages = list(payload["messages"])
        model = payload.get("model") or model
        if temperature is None and payload.get("temperature") is not None:
            temperature = float(payload["temperature"])
    elif isinstance(payload, list):
        messages = list(payload)
    else:
        msg = str(getattr(args, "message", None) or "").strip()
        if not msg:
            raise ValidationError("Provide -m/--message or --file with messages JSON")
        messages = []
        system = str(getattr(args, "system", None) or "").strip()
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": msg})

    base = _gateway_base(args)
    if base:
        body: dict[str, Any] = {"messages": messages, "stream": False}
        if model:
            body["model"] = model
        if temperature is not None:
            body["temperature"] = temperature
        result = _http_json(
            "POST",
            f"{base}/openai/v1/chat/completions",
            token=_bearer(args),
            body=body,
        )
    else:
        from evoflow.models.openai_compat_invoke import OpenAICompatError, invoke_chat_completion

        try:
            result = invoke_chat_completion(
                model=model,
                messages=messages,
                temperature=temperature,
                record_usage=True,
            )
        except OpenAICompatError as e:
            raise ValidationError(e.message) from e

    return _emit_completion(
        result,
        as_json=bool(getattr(args, "as_json", False)),
        compact=bool(getattr(args, "compact", False)),
    )


def _local_image_to_data_url(path: str) -> str:
    p = Path(path).expanduser()
    if not p.is_file():
        raise ValidationError(f"image not found: {path}")
    mime, _ = mimetypes.guess_type(str(p))
    if not mime or not mime.startswith("image/"):
        mime = "image/png"
    b64 = base64.standard_b64encode(p.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _vision(args: argparse.Namespace) -> Any:
    from evoflow.models.openai_compat_invoke import (
        OpenAICompatError,
        invoke_chat_completion,
        vision_messages,
    )

    image = str(args.image).strip()
    prompt = str(args.message).strip()
    if not prompt:
        raise ValidationError("-m/--message is required")

    # Prefer data URL for local files before gateway/in-process
    low = image.lower()
    if not (low.startswith("http://") or low.startswith("https://") or low.startswith("data:")):
        image = _local_image_to_data_url(image)

    messages = vision_messages(
        prompt=prompt,
        image=image,
        system=str(getattr(args, "system", None) or "").strip() or None,
    )
    model = getattr(args, "model", None)
    temperature = getattr(args, "temperature", None)

    base = _gateway_base(args)
    if base:
        body: dict[str, Any] = {"messages": messages, "stream": False}
        if model:
            body["model"] = model
        if temperature is not None:
            body["temperature"] = temperature
        result = _http_json(
            "POST",
            f"{base}/openai/v1/chat/completions",
            token=_bearer(args),
            body=body,
        )
    else:
        try:
            result = invoke_chat_completion(
                model=model,
                messages=messages,
                temperature=temperature,
                record_usage=True,
            )
        except OpenAICompatError as e:
            raise ValidationError(e.message) from e

    return _emit_completion(
        result,
        as_json=bool(getattr(args, "as_json", False)),
        compact=bool(getattr(args, "compact", False)),
    )
