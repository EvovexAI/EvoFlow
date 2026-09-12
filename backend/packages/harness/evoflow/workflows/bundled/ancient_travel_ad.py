"""古风穿梭意象短片 — bundled workflow App.

Uses Agent Plan media (Seedream 生图 + Seedance 图生视频) via media crew subagents.
Install: ``python -m evoflow.workflows.bundled.ancient_travel_ad``
Run (CLI): ``evoflow workflow run App_gufeng_travel_ad --file params.json``
"""

from __future__ import annotations

from typing import Any

APP_ID = "App_gufeng_travel_ad"

APP_DEFINITION: dict[str, Any] = {
    "name": "古风穿梭意象短片",
    "description": (
        "创意 AI 广告验证流：水墨古风、主体穿越多场景（如凝露/玉佩/水滴穿越山河云海）。"
        "依赖火山 Agent Plan 全家桶（Seedream 4K 关键帧 + Seedance 4K/1080p 图生视频）；"
        "分镜 → 关键帧 → 图生视频 → 精修拼接成片。"
    ),
    "icon": "🏮",
    "category": "creative",
    "execution_mode": "workflow",
    "status": "published",
    "version": 2,
    "answer_from_ref": "assemble",
    "tags": ["古风", "创意广告", "穿梭镜头", "Agent Plan", "Seedream", "Seedance", "media-crew", "4K"],
    "goal_template": (
        "制作一支约 {{duration_seconds}} 秒的古风穿梭意象短片（画质 {{output_quality}}）。"
        "核心意象：{{hero_object}} 穿越 {{travel_scenes}}。"
        "画幅 {{aspect_ratio}}；风格 {{visual_style}}。"
        "共 {{shot_count}} 镜，每镜约 5 秒；镜头连贯、画面精致、电影级光影，克制不浮夸。"
    ),
    "parameters": [
        {
            "name": "hero_object",
            "label": "穿梭主体",
            "type": "text",
            "default": "一滴晶莹凝露",
            "required": True,
        },
        {
            "name": "travel_scenes",
            "label": "穿越场景（逗号分隔）",
            "type": "textarea",
            "default": "晨雾竹林、水墨江山、云海仙山",
            "required": True,
        },
        {
            "name": "visual_style",
            "label": "视觉风格",
            "type": "text",
            "default": "水墨古风、青绿山水、电影级光影、细腻笔触、克制留白、4K 精致画面",
            "required": True,
        },
        {
            "name": "aspect_ratio",
            "label": "画幅",
            "type": "select",
            "default": "16:9",
            "options": ["16:9", "9:16", "1:1"],
            "required": True,
        },
        {
            "name": "output_quality",
            "label": "输出画质",
            "type": "select",
            "default": "4k",
            "options": ["4k", "1080p", "720p"],
            "required": True,
        },
        {
            "name": "shot_count",
            "label": "镜头数",
            "type": "number",
            "default": "3",
            "required": True,
        },
        {
            "name": "duration_seconds",
            "label": "目标总时长（秒）",
            "type": "number",
            "default": "15",
            "required": True,
        },
        {
            "name": "brand_line",
            "label": "品牌/收束句（可选）",
            "type": "text",
            "default": "",
            "required": False,
        },
    ],
    "steps": [
        {
            "ref": "brief",
            "name": "分镜与口播",
            "assigned_agent": "media-screenwriter",
            "depends_on": [],
            "goal": "撰写 {{shot_count}} 镜连贯古风穿梭广告 brief（精致电影感）",
            "instruction": (
                "用户主题：{{hero_object}} 穿越 {{travel_scenes}}；风格 {{visual_style}}；"
                "画幅 {{aspect_ratio}}；目标画质 {{output_quality}}。\n"
                "写入 outputs/production-brief.md，必须包含：\n"
                "1) User intent（穿梭意象广告，非叙事长片）\n"
                "2) Visual style（全片统一：水墨/古风色调、主光方向、胶片颗粒感、4K 精致细节；"
                "写明 continuity 锚点：主体外观、主色、环境气质）\n"
                "3) Continuity bible（主体在各镜的固定外观 + 每镜如何承接上一镜：动作/运镜/情绪递进，"
                "禁止镜间跳切到无关场景）\n"
                "4) Shot list：恰好 {{shot_count}} 镜。第 1 镜主体登场；后续每镜必须是「从上一镜延续」"
                "的穿越运镜（穿雾、掠水、入画、化云），场景按序对应 {{travel_scenes}}。\n"
                "5) Narration script：每镜 1–2 句古风旁白，口语连贯、声画同步；总时长约 {{duration_seconds}} 秒。\n"
                "若有 {{brand_line}}，收束句使用之。\n"
                "禁止：赛博/现代乱入、浮夸特效、镜间无因果的素材拼盘。"
            ),
        },
        {
            "ref": "prompts",
            "name": "生图分镜 Prompt",
            "assigned_agent": "media-visual-planner",
            "depends_on": ["brief"],
            "goal": "把 brief 转为 {{shot_count}} 条高精致 4K 可生图 prompt",
            "instruction": (
                "读取 outputs/production-brief.md。\n"
                "写入 outputs/shot-prompts.json（JSON 数组，{{shot_count}} 项）。\n"
                "每项含：shot_id、continuity_note（必填，写清与上一镜的衔接）、"
                "image_prompt（单帧静态，140–200 字；写清材质/光影/景深/4K 细节；"
                "禁止 vague 词堆砌）、motion_hint（与 continuity 一致的穿梭运镜）、"
                "aspect_ratio={{aspect_ratio}}。\n"
                "全片同一 continuity bible：色调、主体、环境气质一致；后镜 prompt 显式引用前镜元素。"
            ),
        },
        {
            "ref": "images",
            "name": "生成关键帧",
            "assigned_agent": "media-artist",
            "depends_on": ["prompts"],
            "skills": ["byted-ark-seedream-skill", "media-production"],
            "goal": "Seedream {{output_quality}} 关键帧 PNG",
            "instruction": (
                "读取 outputs/shot-prompts.json，按 shot_id **逐镜各调一次**生图（provider=jimeng）。\n"
                "terminal 示例（每镜替换 prompt）：\n"
                "  python skills/public/media-production/scripts/image_generate.py "
                "--prompt \"<image_prompt>\" --aspect-ratio {{aspect_ratio}} "
                "--quality {{output_quality}} --output-dir outputs\n"
                "第 2 镜起：若前镜已有本地图，优先 --mode image2image "
                "--reference-image-urls \"<前镜 absolute_path 或 url>\" 保持色调连贯。\n"
                "每镜记录 JSON 返回的 url 与 absolute_path。\n"
                "失败禁止换 wan/kling；同参最多重试 1 次（微调 prompt 后）。"
            ),
        },
        {
            "ref": "videos",
            "name": "图生视频",
            "assigned_agent": "media-video-director",
            "depends_on": ["images"],
            "skills": ["media-production"],
            "goal": "Seedance {{output_quality}} 图生视频，每镜约 5 秒带原生配音",
            "instruction": (
                "读取 shot-prompts + 各镜 image_generate 返回的 url。\n"
                "对 **每一镜** 执行 image2video：\n"
                "1) python skills/public/media-production/scripts/video_generate.py "
                "--prompt \"<motion_hint + 本镜口播全文>\" --first-frame-url \"<url>\" "
                "--duration 5 --aspect-ratio {{aspect_ratio}} --quality {{output_quality}} "
                "--generate-audio true --output-dir outputs\n"
                "2) python skills/public/media-production/scripts/task_wait.py "
                "--task-id \"<id>\" --provider jimeng --media-kind video --max-wait-seconds 900 "
                "--output-dir outputs\n"
                "运镜克制连贯：微推/穿雾/掠水，与 continuity_note 一致；口播必须写进 prompt。\n"
                "全部镜 task_wait 成功后再进入下一步。"
            ),
        },
        {
            "ref": "assemble",
            "name": "拼接成片",
            "assigned_agent": "media-post",
            "depends_on": ["videos"],
            "skills": ["media-production"],
            "goal": "精修拼接为 {{output_quality}} 最终 MP4",
            "instruction": (
                "读取 outputs/ 内按镜号顺序的 mp4（每镜 ~5s）。\n"
                "1) **精修成片**（拼接 + 调色 + 升分辨率到 {{output_quality}}）：\n"
                "   python skills/public/media-production/scripts/video_finalize.py "
                "--inputs \"outputs/shot1.mp4,outputs/shot2.mp4,...\" "
                "--output-filename gufeng-travel-final-4k.mp4 "
                "--resolution {{output_quality}} --output-dir outputs\n"
                "   （按实际文件名逗号拼接，保持镜序）\n"
                "2) 可选：用 production-brief 口播跑 subtitle_build.py + subtitle_burn.py "
                "生成 outputs/gufeng-travel-final-4k-subtitled.mp4\n"
                "交付最终绝对路径（@@/path@@），优先 gufeng-travel-final-4k.mp4。"
            ),
        },
    ],
    "flowchart_mermaid": (
        "flowchart LR\n"
        "  brief[分镜口播] --> prompts[生图Prompt]\n"
        "  prompts --> images[Seedream关键帧]\n"
        "  images --> videos[Seedance图生视频]\n"
        "  videos --> assemble[精修拼接4K]\n"
    ),
}


def install(*, publish: bool = True, overwrite: bool = True) -> dict[str, Any]:
    """Save (and optionally publish) the bundled App into the local EvoFlow DB."""
    from evoflow.admin import apps as apps_admin
    from evoflow.collab.app_schema import normalize_app_document
    from evoflow.collab.workflow_validator import validate_app_definition
    from evoflow.persistence import app_repositories

    doc = normalize_app_document(dict(APP_DEFINITION))
    validation = validate_app_definition(doc)
    if not validation.get("valid"):
        errors = validation.get("errors") or []
        raise RuntimeError("Workflow validation failed: " + "; ".join(str(e) for e in errors[:8]))

    existing = app_repositories.load_app(APP_ID)
    if existing and not overwrite:
        return {"appId": APP_ID, "skipped": True, "reason": "already exists"}

    app_repositories.save_app(APP_ID, doc)
    out: dict[str, Any] = {
        "appId": APP_ID,
        "name": doc.get("name"),
        "status": doc.get("status"),
        "steps_count": len(doc.get("steps") or []),
        "validation": {"valid": True, "warnings": validation.get("warnings") or []},
    }
    if publish and str(doc.get("status") or "") != "published":
        pub = apps_admin.publish_app(APP_ID)
        out["status"] = pub.get("status") or "published"
    return out


def main() -> None:
    import json
    import sys

    result = install(publish=True, overwrite=True)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
