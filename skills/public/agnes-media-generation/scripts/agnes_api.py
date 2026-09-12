#!/usr/bin/env python3
"""CLI for Agnes AI image and video generation (https://apihub.agnes-ai.com)."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

BASE_URL = "https://apihub.agnes-ai.com"
TEXT_MODEL = "agnes-2.0-flash"
IMAGE_MODEL = "agnes-image-2.1-flash"
VIDEO_MODEL = "agnes-video-v2.0"
SIZE_RE = re.compile(r"^[1-9]\d*x[1-9]\d*$")


def get_api_key() -> str:
    for name in ("AGNES_API_KEY", "AGNES_API_TOKEN", "APIHUB_AGNES_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    raise SystemExit(
        "Missing Agnes API key. Add AGNES_API_KEY in EvoFlow: Settings → Environment variables."
    )


def request_json(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BASE_URL + path,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {get_api_key()}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            text = resp.read().decode("utf-8")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code} from {path}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Request failed for {path}: {exc}") from exc


def print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def needs_english_translation(prompt: str) -> bool:
    return any(ord(ch) > 127 for ch in prompt)


def translate_prompt_to_english(prompt: str) -> str:
    payload = {
        "model": TEXT_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Translate the user's image/video generation prompt into fluent English. "
                    "Preserve visual details, style, camera motion, lighting, and constraints. "
                    "Return only the English prompt."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": 800,
    }
    data = request_json("POST", "/v1/chat/completions", payload)
    try:
        translated = data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise SystemExit(f"Prompt translation failed: {json.dumps(data, ensure_ascii=False)}") from exc
    if not translated:
        raise SystemExit("Prompt translation failed: empty translated prompt")
    return translated


def prepare_generation_prompt(prompt: str, translate: bool) -> tuple[str, str | None]:
    if translate and needs_english_translation(prompt):
        translated = translate_prompt_to_english(prompt)
        return translated, translated
    return prompt, None


def extract_image_urls(data: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for key in ("url", "image_url"):
        val = data.get(key)
        if isinstance(val, str) and val.startswith(("http://", "https://")):
            urls.append(val)
    for item in data.get("data") or []:
        if isinstance(item, dict):
            for key in ("url", "image_url"):
                val = item.get(key)
                if isinstance(val, str) and val.startswith(("http://", "https://")):
                    urls.append(val)
    return list(dict.fromkeys(urls))


def extract_video_urls(data: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for key in ("video_url", "url", "remixed_from_video_id"):
        val = data.get(key)
        if isinstance(val, str) and val.startswith(("http://", "https://")):
            urls.append(val)
    if isinstance(data.get("data"), list):
        for item in data["data"]:
            if isinstance(item, dict):
                urls.extend(extract_video_urls(item))
    return list(dict.fromkeys(urls))


def download_url(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "EvoFlow-Agnes/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        dest.write_bytes(resp.read())


def save_to_outputs(urls: list[str], output_dir: str, prefix: str, ext: str) -> list[str]:
    if not urls:
        return []
    out = Path(output_dir).expanduser()
    if not out.is_absolute():
        out = (Path.cwd() / out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []
    for i, url in enumerate(urls):
        name = f"{prefix}.{ext}" if i == 0 else f"{prefix}_{i}.{ext}"
        dest = out / name
        download_url(url, dest)
        saved.append(str(dest.resolve()).replace("\\", "/"))
    return saved


def validate_size(value: str | None) -> None:
    if value and not SIZE_RE.match(value):
        raise SystemExit(f"Invalid size: {value}. Expected WIDTHxHEIGHT, e.g. 1024x768.")


def validate_video_args(args: argparse.Namespace) -> None:
    if args.num_frames is not None:
        if args.num_frames > 441 or (args.num_frames - 1) % 8 != 0:
            raise SystemExit("Invalid --num-frames: must be <= 441 and satisfy 8n+1 (e.g. 81, 121).")
    if args.frame_rate is not None and not (1 <= args.frame_rate <= 60):
        raise SystemExit("Invalid --frame-rate: supported range is 1-60.")


def cmd_image(args: argparse.Namespace) -> None:
    validate_size(args.size)
    prompt, translated = prepare_generation_prompt(args.prompt, not args.no_translate)
    payload: dict[str, Any] = {"model": IMAGE_MODEL, "prompt": prompt}
    if args.size:
        payload["size"] = args.size
    extra: dict[str, Any] = {"response_format": "url"}
    if args.image:
        extra["image"] = args.image if len(args.image) > 1 else args.image
    payload["extra_body"] = extra
    data = request_json("POST", "/v1/images/generations", payload)
    urls = extract_image_urls(data)
    local_paths: list[str] = []
    if args.output_dir and urls:
        local_paths = save_to_outputs(urls, args.output_dir, "agnes_image", "png")
    result = {
        "ok": True,
        "type": "image2image" if args.image else "text2image",
        "provider": "agnes",
        "model": IMAGE_MODEL,
        "urls": urls,
        "prompt_used": prompt,
        "translated_prompt": translated,
        "absolute_path": local_paths[0] if local_paths else None,
        "local_paths": local_paths,
        "raw": data if args.raw else None,
    }
    print_json({k: v for k, v in result.items() if v is not None})


def build_video_payload(args: argparse.Namespace) -> dict[str, Any]:
    validate_video_args(args)
    prompt, translated = prepare_generation_prompt(args.prompt, not args.no_translate)
    args._prompt_used = prompt  # noqa: SLF001
    args._translated_prompt = translated  # noqa: SLF001
    payload: dict[str, Any] = {"model": VIDEO_MODEL, "prompt": prompt}
    for name in ("height", "width", "num_frames", "frame_rate", "seed", "negative_prompt"):
        value = getattr(args, name, None)
        if value is not None:
            payload[name] = value
    if args.mode:
        payload["mode"] = args.mode
    if args.image:
        if len(args.image) == 1 and args.mode != "keyframes":
            payload["image"] = args.image[0]
        else:
            payload["extra_body"] = {"image": args.image}
            if args.mode:
                payload["extra_body"]["mode"] = args.mode
    return payload


def poll_video(task_id: str, timeout: int, interval: int) -> dict[str, Any]:
    deadline = time.time() + timeout
    last: dict[str, Any] = {}
    while time.time() < deadline:
        last = request_json("GET", f"/v1/videos/{task_id}")
        if last.get("error"):
            raise SystemExit(f"Video task error: {json.dumps(last, ensure_ascii=False)}")
        status = str(last.get("status", "")).lower()
        if status in {"completed", "failed"}:
            return last
        time.sleep(interval)
    raise SystemExit(f"Timed out waiting for video {task_id}. Last: {json.dumps(last)}")


def cmd_video(args: argparse.Namespace) -> None:
    created = request_json("POST", "/v1/videos", build_video_payload(args))
    task_id = created.get("id")
    if not args.poll:
        print_json(
            {
                "ok": True,
                "type": "video-task",
                "provider": "agnes",
                "task_id": task_id,
                "status": created.get("status"),
                "prompt_used": getattr(args, "_prompt_used", None),
                "translated_prompt": getattr(args, "_translated_prompt", None),
                "next_action": f"agnes_api.py video-get {task_id} --poll",
                "raw": created if args.raw else None,
            }
        )
        return
    if not task_id:
        raise SystemExit(f"No task id in response: {json.dumps(created)}")
    data = poll_video(str(task_id), args.timeout, args.interval)
    urls = extract_video_urls(data)
    local_paths: list[str] = []
    if args.output_dir and urls:
        local_paths = save_to_outputs(urls, args.output_dir, f"agnes_video_{task_id}", "mp4")
    status = str(data.get("status", "")).lower()
    print_json(
        {
            "ok": status == "completed" and bool(urls),
            "type": "video-result",
            "provider": "agnes",
            "task_id": task_id,
            "status": data.get("status"),
            "urls": urls,
            "absolute_path": local_paths[0] if local_paths else None,
            "local_paths": local_paths,
            "prompt_used": getattr(args, "_prompt_used", None),
            "translated_prompt": getattr(args, "_translated_prompt", None),
            "raw": data if args.raw else None,
        }
    )
    if status == "failed" or (status == "completed" and not urls):
        raise SystemExit(1)


def cmd_video_get(args: argparse.Namespace) -> None:
    data = request_json("GET", f"/v1/videos/{args.task_id}")
    if args.poll and str(data.get("status", "")).lower() not in {"completed", "failed"}:
        data = poll_video(args.task_id, args.timeout, args.interval)
    urls = extract_video_urls(data)
    local_paths: list[str] = []
    if args.output_dir and urls:
        local_paths = save_to_outputs(urls, args.output_dir, f"agnes_video_{args.task_id}", "mp4")
    status = str(data.get("status", "")).lower()
    print_json(
        {
            "ok": status == "completed" and bool(urls),
            "type": "video-result",
            "provider": "agnes",
            "task_id": args.task_id,
            "status": data.get("status"),
            "urls": urls,
            "absolute_path": local_paths[0] if local_paths else None,
            "local_paths": local_paths,
            "raw": data if args.raw else None,
        }
    )
    if data.get("error") or status == "failed":
        raise SystemExit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agnes AI image/video generation CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    image = sub.add_parser("image", help="Text-to-image or image-to-image")
    image.add_argument("--prompt", required=True)
    image.add_argument("--size", default="1024x768")
    image.add_argument("--image", action="append", help="Reference image URL (repeat for multiple)")
    image.add_argument("--no-translate", action="store_true", help="Skip CN→EN prompt translation")
    image.add_argument("--output-dir", default=None, help="Download to directory (e.g. outputs)")
    image.add_argument("--raw", action="store_true")
    image.set_defaults(func=cmd_image)

    video = sub.add_parser("video", help="Create video task")
    video.add_argument("--prompt", required=True)
    video.add_argument("--image", action="append", help="Input image URL(s)")
    video.add_argument("--mode", choices=("ti2vid", "keyframes"))
    video.add_argument("--height", type=int, default=768)
    video.add_argument("--width", type=int, default=1152)
    video.add_argument("--num-frames", type=int, default=121)
    video.add_argument("--frame-rate", type=int, default=24)
    video.add_argument("--seed", type=int)
    video.add_argument("--negative-prompt")
    video.add_argument("--no-translate", action="store_true")
    video.add_argument("--poll", action="store_true", help="Poll until completed")
    video.add_argument("--timeout", type=int, default=1800)
    video.add_argument("--interval", type=int, default=10)
    video.add_argument("--output-dir", default=None)
    video.add_argument("--raw", action="store_true")
    video.set_defaults(func=cmd_video)

    vget = sub.add_parser("video-get", help="Get video task status")
    vget.add_argument("task_id")
    vget.add_argument("--poll", action="store_true")
    vget.add_argument("--timeout", type=int, default=1800)
    vget.add_argument("--interval", type=int, default=10)
    vget.add_argument("--output-dir", default=None)
    vget.add_argument("--raw", action="store_true")
    vget.set_defaults(func=cmd_video_get)

    return parser


def main() -> int:
    from _bootstrap import ensure_evoflow_importable

    ensure_evoflow_importable()
    args = build_parser().parse_args()
    if hasattr(args, "no_translate"):
        args.no_translate_prompt = args.no_translate
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
