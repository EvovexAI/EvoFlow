"""Analyze recent media tool invocations from observability API."""
from __future__ import annotations

import json
import urllib.request
from collections import Counter, defaultdict

BASE = "http://localhost:1521/api/observability/tools"
MEDIA_TOOLS = {
    "media_image_generate",
    "media_video_generate",
    "media_task_wait",
    "media_voiceover_synthesize",
    "media_subtitle_build",
    "media_subtitle_burn",
}


def fetch(tool_name: str | None, page_size: int = 40) -> list[dict]:
    params = f"page=1&page_size={page_size}"
    if tool_name:
        params += f"&tool_name={tool_name}"
    url = f"{BASE}?{params}"
    with urllib.request.urlopen(url, timeout=60) as resp:
        data = json.loads(resp.read().decode())
    items = data.get("items") or []
    if tool_name:
        return items
    return [i for i in items if i.get("tool_name") in MEDIA_TOOLS]


def main() -> None:
    all_items: list[dict] = []
    for name in sorted(MEDIA_TOOLS):
        all_items.extend(fetch(name, 40))
    all_items.sort(key=lambda x: x.get("ended_at") or "", reverse=True)
    all_items = all_items[:40]

    print(f"=== Recent {len(all_items)} media-related tool calls ===\n")
    stats = Counter()
    errors: list[tuple[str, str, str]] = []
    durations: dict[str, list[float]] = defaultdict(list)
    prompt_lens: dict[str, list[int]] = defaultdict(list)
    modes: Counter[str] = Counter()

    for i in all_items:
        name = i["tool_name"]
        status = i.get("status") or "?"
        dur = float(i.get("duration_ms") or 0) / 1000
        stats[f"{name}:{status}"] += 1
        durations[name].append(dur)
        inp = json.loads(i.get("input_json") or "{}")
        prompt = str(inp.get("prompt") or inp.get("text") or "")
        if prompt:
            prompt_lens[name].append(len(prompt))
        mode = inp.get("mode")
        if mode:
            modes[f"{name}:{mode}"] += 1
        try:
            out = json.loads(i.get("output_text") or "{}")
            ok = out.get("ok")
            msg = str(out.get("message") or "")[:200]
        except Exception:
            ok = None
            msg = (i.get("output_text") or "")[:200]
        if status == "error" or ok is False:
            errors.append((name, status, msg))
        print(f"[{i.get('ended_at','')[:19]}] {name} {status} {dur:.1f}s")
        print(f"  IN: {json.dumps(inp, ensure_ascii=False)[:350]}")
        print(f"  OUT: ok={ok} | {msg}")
        print()

    print("=== Summary ===")
    for k, v in sorted(stats.items()):
        print(f"  {k}: {v}")
    print("\n=== Avg duration (s) ===")
    for name, ds in sorted(durations.items()):
        print(f"  {name}: {sum(ds)/len(ds):.1f}s (n={len(ds)})")
    print("\n=== Avg prompt length ===")
    for name, ls in sorted(prompt_lens.items()):
        print(f"  {name}: {sum(ls)/len(ls):.0f} chars (n={len(ls)})")
    print("\n=== Modes ===")
    for k, v in modes.most_common():
        print(f"  {k}: {v}")
    if errors:
        print(f"\n=== Errors ({len(errors)}) ===")
        for name, status, msg in errors[:15]:
            print(f"  {name} [{status}]: {msg}")


if __name__ == "__main__":
    main()
