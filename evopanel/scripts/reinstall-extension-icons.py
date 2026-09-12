"""Reinstall extension icons into linked install paths and rebuild registry UTF-8."""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

ext_root = Path(r"d:\dev\github\EvoFlow\extensions")
pairs = [
    (ext_root / "contentos-trending", Path(r"D:\dev\github\ContentOS\evoflow-extensions\trending"), "contentos-trending"),
    (ext_root / "contentos-decompose", Path(r"D:\dev\github\ContentOS\evoflow-extensions\decompose"), "contentos-decompose"),
    (
        ext_root / "contentos-account-insights",
        Path(r"D:\dev\github\ContentOS\evoflow-extensions\account-insights"),
        "contentos-account-insights",
    ),
    (ext_root / "contentos-materials", Path(r"D:\dev\github\ContentOS\evoflow-extensions\materials"), "contentos-materials"),
    (ext_root / "contentos", Path(r"D:\dev\github\ContentOS\evoflow-extensions\ops"), "contentos"),
    (ext_root / "ai-canvas", Path(r"D:\dev\github\_refs\ai-canvas\Infinite-Canvas"), "ai-canvas"),
]

now = datetime.now(timezone.utc).isoformat()
rows: list[dict] = []

for src, dest, eid in pairs:
    src_manifest = src / "evoflow.extension.json"
    src_icon = src / "icon.png"
    if not src_manifest.is_file():
        raise SystemExit(f"missing {src_manifest}")
    if not src_icon.is_file():
        raise SystemExit(f"missing {src_icon}")
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_manifest, dest / "evoflow.extension.json")
    shutil.copy2(src_icon, dest / "icon.png")
    # also keep members copy for ai-canvas
    if eid == "ai-canvas":
        members = ext_root / "content-creator" / "members" / "ai-canvas"
        if members.is_dir():
            shutil.copy2(src_icon, members / "icon.png")
            shutil.copy2(src_manifest, members / "evoflow.extension.json")
    manifest = json.loads(src_manifest.read_text(encoding="utf-8"))
    if manifest.get("icon") != "./icon.png":
        manifest["icon"] = "./icon.png"
        src_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        shutil.copy2(src_manifest, dest / "evoflow.extension.json")
    rows.append(
        {
            "enabled": True,
            "id": eid,
            "install_path": str(dest),
            "installed_at": now,
            "manifest": manifest,
            "source": "suite:content-creator",
        }
    )
    print(f"OK {eid}: {manifest.get('name')} -> {dest}")

suite_dir = ext_root / "content-creator"
suite_json = suite_dir / "evoflow.suite.json"
if suite_json.is_file():
    suite = json.loads(suite_json.read_text(encoding="utf-8"))
    rows.append(
        {
            "enabled": True,
            "id": "content-creator",
            "install_path": str(suite_dir),
            "installed_at": now,
            "kind": "suite",
            "manifest": {
                "schema": 1,
                "id": "content-creator",
                "kind": "suite",
                "name": suite.get("name", "内容创作"),
                "version": suite.get("version", "1.1.0"),
                "description": suite.get("description", ""),
                "nav": {"title": suite.get("name", "内容创作"), "group": "extensions", "order": 1},
                "ui": {"kind": "webview", "entry": "about:blank"},
                "permissions": ["embed"],
                "service": {"mode": "none"},
                "bridge": {"origin_allowlist": []},
            },
            "member_ids": [r["id"] for r in rows],
            "source": "suite",
            "suite": suite,
        }
    )

reg_path = Path.home() / ".evoflow" / "ui-extensions" / "registry.json"
reg_path.parent.mkdir(parents=True, exist_ok=True)
if reg_path.exists():
    bak = reg_path.with_suffix(".json.bak-iconv")
    shutil.copy2(reg_path, bak)
    print("backup", bak)

reg_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("wrote", reg_path)

data = json.loads(reg_path.read_text(encoding="utf-8"))
for x in data:
    print(x["id"], x.get("manifest", {}).get("name"), x.get("manifest", {}).get("icon"))
