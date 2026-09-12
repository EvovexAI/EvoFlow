"""Analyze last N tool invocations from observability API — all tools."""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

BASE = "http://localhost:1521/api/observability/tools"

MEDIA_TOOLS = frozenset(
    {
        "media_image_generate",
        "media_video_generate",
        "media_task_wait",
        "media_voiceover_synthesize",
        "media_subtitle_build",
        "media_subtitle_burn",
    }
)

ANTI_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("media_video_text2video", re.compile(r"media_video_generate"), "text2video without first_frame (prefer image2video)"),
    ("media_voiceover_jimeng", re.compile(r"media_voiceover"), "TTS while Seedance pipeline active (use prompt native audio)"),
    ("ffmpeg_terminal", re.compile(r"ffmpeg|process_start|process_wait|\.bat"), "ffmpeg/bat workaround instead of media tools"),
    ("wrong_provider", re.compile(r'"provider"\s*:\s*"(wan|kling)"'), "disabled provider wan/kling"),
    ("long_prompt", re.compile(r"."), "prompt > 400 chars on media_image_generate"),
]


def fetch_all_samples() -> list[dict]:
    """Merge recent, slow, error, and media-specific samples."""
    queries = [
        "page=1&page_size=100",
        "page=1&page_size=100&sort_by=duration_ms",
        "page=1&page_size=80&status=error",
        "page=1&page_size=80&min_duration_ms=10000",
    ]
    for tool in MEDIA_TOOLS | {"subagent", "terminal", "tool_search"}:
        queries.append(f"page=1&page_size=40&tool_name={tool}")

    seen: dict[str, dict] = {}
    for q in queries:
        url = f"{BASE}?{q}"
        try:
            with urllib.request.urlopen(url, timeout=90) as resp:
                data = json.loads(resp.read().decode())
            for item in data.get("items") or []:
                iid = str(item.get("id") or "")
                if iid:
                    seen[iid] = item
        except Exception as e:
            print(f"warn fetch {q}: {e}", file=sys.stderr)
    items = list(seen.values())
    items.sort(key=lambda x: x.get("ended_at") or "", reverse=True)
    return items


def _parse_output(item: dict) -> tuple[bool | None, str]:
    raw = item.get("output_text") or ""
    status = str(item.get("status") or "")
    try:
        obj = json.loads(raw)
        ok = obj.get("ok")
        if ok is False or str(obj.get("status") or "").lower() == "error":
            return False, str(obj.get("message") or raw)[:300]
        if ok is True:
            return True, str(obj.get("message") or "")[:120]
    except json.JSONDecodeError:
        pass
    if status == "error" or raw.strip().startswith("Error:"):
        return False, raw[:300]
    return None, raw[:120]


def analyze(items: list[dict]) -> dict:
    by_tool: Counter[str] = Counter()
    by_status: Counter[str] = Counter()
    durations: dict[str, list[float]] = defaultdict(list)
    errors: list[dict] = []
    slow: list[dict] = []
    issues: Counter[str] = Counter()
    dup_prompts: Counter[str] = Counter()

    for i in items:
        name = str(i.get("tool_name") or "?")
        by_tool[name] += 1
        st = str(i.get("status") or "?")
        by_status[st] += 1
        dur_s = float(i.get("duration_ms") or 0) / 1000
        durations[name].append(dur_s)
        if dur_s >= 15:
            slow.append({"tool": name, "dur_s": dur_s, "ended_at": i.get("ended_at"), "status": st})

        inp = {}
        try:
            inp = json.loads(i.get("input_json") or "{}")
        except json.JSONDecodeError:
            pass

        ok, msg = _parse_output(i)
        if ok is False or st == "error":
            errors.append({"tool": name, "status": st, "msg": msg, "dur_s": dur_s})

        if name == "media_image_generate":
            p = str(inp.get("prompt") or "")
            if len(p) > 400:
                issues["image_prompt_too_long"] += 1
            if p:
                dup_prompts[p[:80]] += 1
            if inp.get("provider") in ("wan", "kling"):
                issues["image_wrong_provider"] += 1

        if name == "media_video_generate":
            mode = inp.get("mode") or "text2video"
            if mode == "text2video" and not inp.get("first_frame_url"):
                issues["video_text2video_no_frame"] += 1
            if len(str(inp.get("prompt") or "")) > 500:
                issues["video_prompt_too_long"] += 1

        if name == "media_voiceover_synthesize":
            issues["voiceover_called"] += 1

        if name in ("terminal", "process_start", "write_to_file"):
            cmd = str(inp.get("command") or inp.get("content") or "")
            if "ffmpeg" in cmd.lower() or ".bat" in cmd.lower():
                issues["ffmpeg_workaround"] += 1

        if name == "media_task_wait" and ok is False:
            issues["task_wait_failed"] += 1

    repeated_images = sum(1 for k, v in dup_prompts.items() if v >= 2)

    return {
        "total": len(items),
        "by_tool": by_tool,
        "by_status": by_status,
        "durations": {k: (sum(v) / len(v), max(v), len(v)) for k, v in durations.items()},
        "errors": errors[:25],
        "slow": sorted(slow, key=lambda x: -x["dur_s"])[:15],
        "issues": issues,
        "repeated_image_prompts": repeated_images,
    }


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if path and path.exists():
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        items = data.get("items") or []
    else:
        items = fetch_all_samples()

    rep = analyze(items)
    print(json.dumps(rep, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
