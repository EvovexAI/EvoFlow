"""Plugin runtime integration — exposes installed plugins to the agent runtime.

This module is the bridge between the plugin management domain (storage +
service) and the conversation runtime:

- ``plugin_skill_roots`` feeds plugin ``skills/`` directories into the skills
  discovery pipeline (``skills/loader.py`` extra roots), so enabled plugin
  skills behave exactly like native skills: ``<available_skills>`` directory,
  ``$skill-name`` mentions, ``skill:<name>`` URIs in read/terminal tools.
- ``build_plugin_injection_block`` renders the per-turn ``<plugin_injection>``
  message for plugins picked in the chat composer (``preferred_plugins``).
  It ships metadata only — command names/descriptions and skill
  name/description/location — plus the markdown body of a command **only when
  the user actually invokes it via ``/name`` in the current message**
  (ZCode-style on-demand loading). SKILL.md bodies are never injected here:
  they stay on disk and are reached through ``skill:<name>`` URIs.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any
from xml.sax import saxutils

from evoflow.assets.injection_budget import cap_text_chars
from evoflow.plugins.components import enumerate_plugin_components
from evoflow.plugins.manifest import PluginManifestError, read_plugin_manifest_from_root
from evoflow.plugins.storage import (
    InstalledPluginsState,
    load_installed_plugins_state,
    resolve_installed_plugin_root,
    resolve_storage_root,
)

logger = logging.getLogger(__name__)


def _ulog(message: str) -> None:
    """统一浏览器/插件调试日志（logs/plugin-control.log，三端汇聚）。"""
    try:
        from evoflow.tools.builtins.browser_debug_log import browser_debug_log

        browser_debug_log("py", f"[plugin-runtime] {message}")
    except Exception:
        pass

# Whole-block budget. Metadata entries are tiny; the only heavy payload is an
# actually-invoked command body, capped per command. Overflow degrades to
# metadata lines instead of shipping half-cut prose.
_PLUGIN_INJECTION_MAX_CHARS = 8_000
_INVOKED_COMMAND_BODY_MAX_CHARS = 4_000
_PLUGIN_METADATA_DESC_CHARS = 200

# ``/command-name`` token in the user message — same shape as the ``$skill``
# mention regex in skills/selection.py.
_COMMAND_INVOCATION_RE = re.compile(r"(?<![\w/\\-])/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})")


def _iter_enabled_plugins(storage_root: Path | None = None):
    root = Path(storage_root) if storage_root else resolve_storage_root()
    try:
        state = load_installed_plugins_state(root)
    except Exception:
        return root, []
    enabled: list[tuple[str, Path]] = []
    for record in state.plugins:
        if not state.is_enabled(record.id):
            continue
        plugin_root = resolve_installed_plugin_root(root, record)
        if plugin_root.is_dir():
            enabled.append((record.id, plugin_root))
    return root, enabled


def enabled_plugin_roots(storage_root: Path | None = None) -> list[tuple[str, Path]]:
    """``(plugin_id, plugin_root)`` for every installed + enabled plugin."""
    return _iter_enabled_plugins(storage_root)[1]


def plugin_skill_roots(storage_root: Path | None = None) -> list[Path]:
    """``<plugin_root>/skills`` directories for the skills discovery pipeline."""
    roots: list[Path] = []
    for _plugin_id, plugin_root in enabled_plugin_roots(storage_root):
        skills_dir = plugin_root / "skills"
        if skills_dir.is_dir():
            roots.append(skills_dir)
    return roots


def plugin_state_signature(storage_root: Path | None = None) -> str:
    """Cheap fingerprint of installed plugin ids + enable states (cache invalidation)."""
    try:
        root = Path(storage_root) if storage_root else resolve_storage_root()
        state = load_installed_plugins_state(root)
    except Exception:
        return ""
    return "|".join(f"{record.id}:{'1' if state.is_enabled(record.id) else '0'}" for record in state.plugins)


def _read_text(path: Path, limit: int = 20_000) -> str:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    if len(text) > limit:
        text = text[:limit] + "\n… (truncated)"
    return text


def _frontmatter_body(text: str) -> str:
    """Strip the leading YAML frontmatter from a markdown body, keeping the prompt body."""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end >= 0:
            return text[end + 4 :].strip()
    return text


def _plugin_summary(plugin_root: Path) -> dict[str, Any]:
    manifest = None
    try:
        manifest = read_plugin_manifest_from_root(plugin_root)
    except PluginManifestError:
        manifest = None
    components = enumerate_plugin_components(plugin_root, manifest)
    return {
        "name": manifest.name if manifest else plugin_root.name,
        "description": manifest.description if manifest else None,
        "version": manifest.version if manifest else None,
        "components": components,
    }


def resolve_plugin_id(plugin_ref: str, state: InstalledPluginsState) -> str | None:
    """Accept ``name@marketplace`` ids or bare plugin names."""
    ref = str(plugin_ref or "").strip()
    if not ref:
        return None
    if any(record.id == ref for record in state.plugins):
        return ref
    lowered = ref.lower()
    for record in state.plugins:
        if record.name.lower() == lowered or record.id.lower() == lowered:
            return record.id
    return None


def _extract_invoked_commands(user_message: str) -> set[str]:
    """``/name`` tokens from the current user message, lowercased."""
    if not user_message:
        return set()
    return {match.group(1).lower() for match in _COMMAND_INVOCATION_RE.finditer(user_message)}


def build_plugin_injection_block(
    plugin_refs: list[str] | None,
    storage_root: Path | None = None,
    *,
    user_message: str = "",
) -> str:
    """Render the ``<plugin_injection>`` block for composer-selected plugins.

    Metadata-only by default: command names/descriptions and skill
    name/description/location lines. A command's markdown body is inlined only
    when the user invokes it via ``/name`` in the current message. SKILL.md
    bodies are never injected — enabled plugin skills are already listed in
    ``<available_skills>`` and reachable via ``skill:<name>`` URIs.
    """
    refs = [str(ref or "").strip() for ref in (plugin_refs or []) if str(ref or "").strip()]
    if not refs:
        return ""
    root = Path(storage_root) if storage_root else resolve_storage_root()
    try:
        state = load_installed_plugins_state(root)
    except Exception as exc:
        _ulog(f"injection aborted: load state failed: {exc}")
        return ""

    resolved: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for ref in refs:
        plugin_id = resolve_plugin_id(ref, state)
        if plugin_id is None or plugin_id in seen or not state.is_enabled(plugin_id):
            _ulog(f"ref skipped: ref={ref!r} resolved={plugin_id!r} enabled={state.is_enabled(plugin_id) if plugin_id else False}")
            continue
        seen.add(plugin_id)
        record = next((item for item in state.plugins if item.id == plugin_id), None)
        if record is None:
            continue
        plugin_root = resolve_installed_plugin_root(root, record)
        if plugin_root.is_dir():
            resolved.append((plugin_id, plugin_root))
    if not resolved:
        _ulog(f"injection empty: refs={refs}")
        return ""

    invoked = _extract_invoked_commands(user_message)
    used = 0
    sections: list[str] = []
    truncated = False
    for plugin_id, plugin_root in resolved:
        section, section_used = _render_plugin_section(plugin_id, plugin_root, invoked)
        if not section:
            continue
        if section_used > _PLUGIN_INJECTION_MAX_CHARS - used:
            truncated = True
            break
        sections.append(section)
        used += section_used

    if not sections:
        return ""
    intro = (
        "<plugin_injection>\n"
        "The following EvoFlow plugins are activated by the user. Only their component\n"
        "metadata is listed here: read a skill via \"skill:<name>\" (read/terminal) when its\n"
        "steps are needed; command markdown bodies are inlined only for commands the user\n"
        "invokes via \"/name\" in this turn's message.\n"
        "用户启用了以下 EvoFlow 插件，此处仅列出组件元数据：需要技能步骤时用 "
        "\"skill:<名称>\" 读取 SKILL.md；仅当用户本轮消息以 \"/命令名\" 调用某命令时，"
        "该命令的正文才会内联给出。\n"
    )
    browser_hint = ""
    if any(pid.startswith("browser-use") or "browser-use" in pid for pid, _ in resolved):
        browser_hint = (
            "\n<evoflow_browser_runtime>\n"
            "EvoFlow ships a single in-app WebView (one tab). Prefer ONE first js cell: "
            "bootstrap + getForUrl/get(iab) + open(url) or tabs.get(\"tab-0\").goto(url) + "
            "waitForLoadState + domSnapshot — do not burn a dedicated round only for "
            "browser.documentation() (host returns a compact guide if you still dump it). "
            "After that, do NOT spend extra js calls only to list tabs or re-dump docs; "
            "reuse tab-0 / last tab id. Screenshots are already on the tool card and staged: "
            "do NOT call view_image again, and do not mention screenshot file paths, "
            "filenames, or @@...png@@ in your reply.\n"
            "EvoFlow 只有一个内置浏览器页。优先第一枪就把 bootstrap、选浏览器、打开 URL、"
            "wait、domSnapshot 写进同一个 js；不要单独一轮只为 documentation（宿主会返回短指南）。"
            "之后不要再为 tabs.list / 重复 dump 文档另开 js；用 tab-0。"
            "截图已在工具卡上并 staged，勿再 view_image，也不要在回复里写截图文件名或 @@…png@@。\n"
            "</evoflow_browser_runtime>\n"
        )
    cua_hint = ""
    if any(pid.startswith("computer-use") or "computer-use" in pid for pid, _ in resolved):
        cua_hint = (
            "\n<evoflow_computer_runtime>\n"
            "Computer Use screenshots returned by mcp__node_repl__js are staged into "
            "the next model context and already shown on the tool card. Do NOT call "
            "view_image again, and do not mention screenshot file paths, filenames, "
            "or @@...png@@ in your reply. Click/type coordinates are pixels of that "
            "delivered screenshot (the WxH in the tool result), not the OS window "
            "bounds, and not a size parsed from the file header. Put one gesture — "
            "click, type, and key — in a single js cell and screenshot once at the end.\n"
            "电脑控制截图会自动进入下一轮视觉上下文，并已经画在工具卡上。"
            "不要再对同一张图调 view_image，也不要在回复里写截图文件名或 @@…png@@。"
            "点击坐标用结果里给出的截图像素宽高，不要读文件头，也不要用窗口 bounds。"
            "同一次手势（点击、输入、按键）写在同一个 js 里，最后再截一次图。\n"
            "</evoflow_computer_runtime>\n"
        )
    body = intro + browser_hint + cua_hint + "\n".join(sections)
    if truncated:
        body += "\n<!-- plugin_injection truncated: remaining plugins/components exceed the budget; use skill:/commands metadata above -->"
    _ulog(
        f"injection built: plugins={[pid for pid, _ in resolved]} chars={len(body)} truncated={truncated}"
    )
    return body + "\n</plugin_injection>"


def _render_plugin_section(
    plugin_id: str,
    plugin_root: Path,
    invoked: set[str],
) -> tuple[str, int]:
    """Render one plugin's metadata section; returns ``(section, chars_used)``.

    ``chars_used`` may exceed the caller's remaining budget when the section
    alone cannot fit — the caller drops such sections entirely instead of
    shipping half-cut ones.
    """
    summary = _plugin_summary(plugin_root)
    lines: list[str] = [f'<plugin id="{saxutils.escape(plugin_id, {chr(34): "&quot;"})}">']
    if summary["description"]:
        lines.append(
            f"  <description>{saxutils.escape(_cap(summary['description']))}</description>"
        )
    commands: list[str] = []
    skills: list[str] = []
    for group in summary["components"]:
        if group["kind"] == "command":
            commands_dir = plugin_root / "commands"
            for item in group["items"]:
                name = str(item["name"])
                if name.lower() in invoked:
                    body = _frontmatter_body(_read_text(commands_dir / f"{name}.md", _INVOKED_COMMAND_BODY_MAX_CHARS))
                    if body:
                        commands.append(
                            f'    <command name="{saxutils.escape(name)}" invoked="true">\n'
                            f"{_indent(body, 6)}\n"
                            f"    </command>"
                        )
                        continue
                commands.append(_metadata_line("command", name, item.get("description")))
        elif group["kind"] == "skill":
            for item in group["items"]:
                name = str(item["name"])
                skills.append(
                    f'    <skill name="{saxutils.escape(name)}" location="skill:{saxutils.escape(name)}"'
                    + (f' description="{saxutils.escape(_cap(item["description"]))}"' if item.get("description") else "")
                    + " />"
                )
    if commands:
        lines.append("  <plugin_commands>")
        lines.extend(commands)
        lines.append("  </plugin_commands>")
    if skills:
        lines.append("  <plugin_skills>")
        lines.extend(skills)
        lines.append("  </plugin_skills>")
    lines.append("</plugin>")
    section = "\n".join(lines)
    return section, len(section)


def _metadata_line(kind: str, name: str, description: str | None) -> str:
    desc = f' description="{saxutils.escape(_cap(description or ""))}"' if (description or "").strip() else ""
    return f'    <{kind} name="{saxutils.escape(name)}"{desc} />'


def _cap(text: str) -> str:
    return cap_text_chars(text, _PLUGIN_METADATA_DESC_CHARS)


def _indent(text: str, spaces: int) -> str:
    pad = " " * spaces
    return "\n".join(f"{pad}{line}" if line.strip() else line for line in text.splitlines())
