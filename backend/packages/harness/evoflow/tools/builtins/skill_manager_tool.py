"""Tool for managing skills at runtime - create, patch, edit, delete, write_file, remove_file, load_skill.

Skills are the agent's procedural memory: they capture *how to do a specific
type of task* based on proven experience. General memory is broad and declarative.
Skills are narrow and actionable.

Trigger conditions:
  Create when: complex task succeeded (5+ tool calls), errors overcome,
  user-corrected approach worked, non-trivial workflow discovered,
  or user asks you to remember a procedure.

  Update when: instructions stale/wrong, OS-specific failures,
  missing steps or pitfalls found during use.
  If you used a skill and hit issues not covered by it, patch it immediately.

  After difficult/iterative tasks, offer to save as a skill.
  Skip for simple one-offs. Confirm with user before creating/deleting.

Good skills: trigger conditions, numbered steps with exact commands,
pitfalls section, verification steps.
"""

import json
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.config.extensions_config import (
    SkillStateConfig,
    reload_extensions_config,
)
from evoflow.skills.frontmatter import split_skill_frontmatter
from evoflow.skills.loader import find_skill_directory, get_skills_root_path
from evoflow.skills.paths import ALLOWED_SKILL_SUBDIRS
from evoflow.skills.security import scan_for_security_issues
from evoflow.skills.validation import _validate_skill_frontmatter

logger = logging.getLogger(__name__)

skill_manager_tool_ui_metadata = {"label": "技能管理器", "icon": "📝", "group": "skill_management", "description": "管理技能（创建、更新、删除）。技能是你的程序记忆——可复用的方法。"}

_MAX_NAME_LENGTH = 64
_MAX_DESCRIPTION_LENGTH = 1024
_MAX_SKILL_CONTENT_CHARS = 100_000
_MAX_SKILL_FILE_BYTES = 1_048_576

_VALID_SKILL_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_VALID_CATEGORY_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

_ALLOWED_SUBDIRS = ALLOWED_SKILL_SUBDIRS


def _scan_for_security_issues(content: str) -> list[str]:
    return scan_for_security_issues(content)


def _validate_skill_name(name: str) -> tuple[bool, str]:
    if not name:
        return False, "技能名称不能为空"
    if len(name) > _MAX_NAME_LENGTH:
        return False, f"技能名称超过 {_MAX_NAME_LENGTH} 字符"
    # Align with skills.validation hyphen-case: [a-z0-9-]+, no leading/trailing
    # hyphen, no consecutive hyphens, no dots/underscores.
    if not _VALID_SKILL_NAME_RE.match(name):
        return False, (
            f"无效的技能名称 '{name}'。"
            "使用 hyphen-case（小写字母、数字和连字符），不能以连字符开头/结尾或包含连续连字符。"
        )
    return True, ""


def _validate_category(category: str | None) -> tuple[bool, str]:
    if category is None:
        return True, ""
    if not isinstance(category, str):
        return False, "类别必须是字符串"
    category = category.strip()
    if not category:
        return True, ""
    if "/" in category or "\\" in category:
        return False, f"无效的类别 '{category}'。类别必须是单个目录名。"
    if len(category) > _MAX_NAME_LENGTH:
        return False, f"类别超过 {_MAX_NAME_LENGTH} 字符"
    if not _VALID_CATEGORY_RE.match(category):
        return False, f"无效的类别 '{category}'。使用小写字母、数字、连字符、点和下划线。"
    return True, ""


def _validate_file_path(file_path: str) -> tuple[bool, str]:
    if not file_path:
        return False, "file_path 是必需的"
    normalized = Path(file_path)
    if ".." in file_path:
        return False, "路径遍历 ('..') 不允许"
    if not normalized.parts or normalized.parts[0] not in _ALLOWED_SUBDIRS:
        allowed = ", ".join(sorted(_ALLOWED_SUBDIRS))
        return False, f"文件必须在以下目录之一: {allowed}。得到: '{file_path}'"
    if len(normalized.parts) < 2:
        return False, f"提供文件路径，而不是目录。示例: '{normalized.parts[0]}/myfile.md'"
    return True, ""


def _validate_frontmatter(content: str) -> tuple[bool, str]:
    if not content.strip():
        return False, "内容不能为空"
    split = split_skill_frontmatter(content)
    if split is None:
        return False, "SKILL.md frontmatter 未关闭。确保有结束的 '---' 行"
    frontmatter_text, body = split
    try:
        import yaml

        parsed = yaml.safe_load(frontmatter_text)
    except Exception as e:
        return False, f"YAML frontmatter 解析错误: {e}"
    if not isinstance(parsed, dict):
        return False, "Frontmatter 必须是 YAML 映射（键值对）"
    if "name" not in parsed:
        return False, "Frontmatter 必须包含 'name' 字段"
    if "description" not in parsed:
        return False, "Frontmatter 必须包含 'description' 字段"
    if len(str(parsed["description"])) > _MAX_DESCRIPTION_LENGTH:
        return False, f"描述超过 {_MAX_DESCRIPTION_LENGTH} 字符"
    if not body.strip():
        return False, "SKILL.md 必须在 frontmatter 后有内容（说明、步骤等）"
    return True, ""


def _validate_content_size(content: str, label: str = "SKILL.md") -> tuple[bool, str]:
    if len(content) > _MAX_SKILL_CONTENT_CHARS:
        return False, f"{label} 内容是 {len(content):,} 字符（限制: {_MAX_SKILL_CONTENT_CHARS:,}）。考虑拆分成更小的 SKILL.md 和支持文件。"
    return True, ""


def _get_skill_dir(skill_name: str, category: str = "custom") -> Path:
    skills_root = get_skills_root_path()
    if category:
        return skills_root / category / skill_name
    return skills_root / skill_name


def _atomic_write_text(file_path: Path, content: str, encoding: str = "utf-8") -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(
        dir=str(file_path.parent),
        prefix=f".{file_path.name}.tmp.",
        suffix="",
    )
    try:
        with os.fdopen(fd, "w", encoding=encoding) as f:
            f.write(content)
        os.replace(temp_path, file_path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            logger.error("Failed to remove temporary file %s", temp_path, exc_info=True)
        raise


def _clear_skills_cache():
    try:
        from evoflow.skills.loader import clear_skills_cache

        clear_skills_cache()
    except Exception:
        pass


def _enable_skill_after_create(skill_name: str) -> None:
    """Persist 'enabled=true' for a newly created custom skill.

    Note: custom skills default to enabled even without config, but we still
    persist the flag so the state is explicit and manageable via UI/API.
    """
    skill_name = str(skill_name or "").strip().lower()
    if not skill_name:
        return
    # If env path is provided but file doesn't exist yet, create it (do not call
    # resolve_config_path() which enforces existence for the env override).
    from evoflow.persistence import config_repositories as cfg_repo

    cfg_repo.set_skill_enabled(skill_name, True)
    extensions_config = reload_extensions_config()
    extensions_config.skills[skill_name] = SkillStateConfig(enabled=True)


def _load_skill(name: str) -> dict[str, Any]:
    """Return SKILL.md body for an installed skill (by directory name under skills/)."""
    if not name:
        return {"success": False, "error": "load_skill 需要 name 或 skill_name（技能目录名）。"}
    existing = find_skill_directory(name, require_enabled=False)
    if not existing:
        return {"success": False, "error": f"技能 '{name}' 未找到。"}
    skill_md = existing / "SKILL.md"
    if not skill_md.exists():
        return {"success": False, "error": f"未找到 SKILL.md: {skill_md}"}
    content = skill_md.read_text(encoding="utf-8")
    is_valid, error = _validate_content_size(content, label="SKILL.md")
    if not is_valid:
        return {"success": False, "error": error}
    return {
        "success": True,
        "message": f"已加载技能 '{name}' 的 SKILL.md。",
        "path": str(skill_md),
        "content": content,
    }


@tool("skill_manager")
async def skill_manager_tool(
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    action: str,
    name: str = "",
    skill_name: str | None = None,
    content: str | None = None,
    category: str | None = None,
    old_string: str | None = None,
    new_string: str | None = None,
    replace_all: bool = False,
    file_path: str | None = None,
    file_content: str | None = None,
) -> str:
    """管理技能（创建、更新、删除）。技能是你的程序记忆——可复用的方法。

    新技能存放在 skills/custom/；现有技能可以修改。

    操作: create（完整 SKILL.md + 可选类别）,
    patch（old_string/new_string——修复首选）,
    edit（完整 SKILL.md 重写——仅用于大改）,
    delete, write_file, remove_file, load_skill（只读返回 SKILL.md 全文）.

    创建时机: 复杂任务成功（5+ 工具调用）、克服错误、用户纠正的方法有效、
    发现非平凡工作流、或用户要求记住某个流程。

    更新时机: 说明过时/错误、OS 特定失败、使用中发现缺失步骤或陷阱。
    如果使用技能时遇到未覆盖的问题，立即 patch。

    完成困难/迭代任务后，提议保存为技能。
    简单一次性任务跳过。创建/删除前与用户确认。

    好的技能: 触发条件、带精确命令的编号步骤、陷阱部分、验证步骤。

    Args:
        action: 操作类型 (create/patch/edit/delete/write_file/remove_file/load_skill)
        name: 技能目录名（小写、连字符/下划线、最大 64 字符）。与 skill_name 二选一即可（同时传时以 name 为准）。
        skill_name: 同 name，兼容部分调用方使用的参数名。
        content: 完整 SKILL.md 内容（YAML frontmatter + markdown 正文）。create 和 edit 必需
        category: 可选类别/领域用于组织技能（如 'devops', 'data-science'）。仅用于 create
        old_string: 要查找的文本（patch 必需）。必须唯一，除非 replace_all=true
        new_string: 替换文本（patch 必需）。可以是空字符串删除匹配文本
        replace_all: 对于 patch: 替换所有出现而不是要求唯一匹配（默认 false）
        file_path: 技能目录内的支持文件路径。write_file/remove_file 必需，必须在 references/、templates/、scripts/ 或 assets/ 下。patch 可选，默认 SKILL.md
        file_content: 文件内容。write_file 必需

    Returns:
        操作结果的 JSON 字符串
    """
    action = action.lower().strip()
    raw = (name or skill_name or "").strip()
    name = raw.lower() if raw else ""

    logger.info(f"skill_manager_tool: action={action}, name={name!r}")

    valid_actions = ["create", "patch", "edit", "delete", "write_file", "remove_file", "load_skill"]
    if action not in valid_actions:
        return json.dumps({"success": False, "error": f"未知操作 '{action}'。使用: {', '.join(valid_actions)}"}, ensure_ascii=False)

    if action == "load_skill":
        try:
            result = _load_skill(name)
            return json.dumps(result, ensure_ascii=False)
        except Exception as e:
            logger.error(f"技能操作失败: {str(e)}", exc_info=True)
            return json.dumps({"success": False, "error": f"操作失败: {str(e)}"}, ensure_ascii=False)

    is_valid, error_msg = _validate_skill_name(name)
    if not is_valid:
        return json.dumps({"success": False, "error": error_msg}, ensure_ascii=False)

    is_valid, error_msg = _validate_category(category)
    if not is_valid:
        return json.dumps({"success": False, "error": error_msg}, ensure_ascii=False)

    try:
        if action == "create":
            if not content:
                return json.dumps({"success": False, "error": "create 需要 content。提供完整 SKILL.md 文本（frontmatter + 正文）。"}, ensure_ascii=False)
            result = _create_skill(name, content, category)
        elif action == "edit":
            if not content:
                return json.dumps({"success": False, "error": "edit 需要 content。提供完整更新的 SKILL.md 文本。"}, ensure_ascii=False)
            result = _edit_skill(name, content)
        elif action == "patch":
            if not old_string:
                return json.dumps({"success": False, "error": "patch 需要 old_string。提供要查找的文本。"}, ensure_ascii=False)
            if new_string is None:
                return json.dumps({"success": False, "error": "patch 需要 new_string。使用空字符串删除匹配文本。"}, ensure_ascii=False)
            result = _patch_skill(name, old_string, new_string, file_path, replace_all)
        elif action == "delete":
            result = _delete_skill(name)
        elif action == "write_file":
            if not file_path:
                return json.dumps({"success": False, "error": "write_file 需要 file_path。示例: 'references/api-guide.md'"}, ensure_ascii=False)
            if file_content is None:
                return json.dumps({"success": False, "error": "write_file 需要 file_content。"}, ensure_ascii=False)
            result = _write_file(name, file_path, file_content)
        elif action == "remove_file":
            if not file_path:
                return json.dumps({"success": False, "error": "remove_file 需要 file_path。"}, ensure_ascii=False)
            result = _remove_file(name, file_path)

        if result.get("success"):
            _clear_skills_cache()

        return json.dumps(result, ensure_ascii=False)

    except Exception as e:
        logger.error(f"技能操作失败: {str(e)}", exc_info=True)
        return json.dumps({"success": False, "error": f"操作失败: {str(e)}"}, ensure_ascii=False)


def _create_skill(name: str, content: str, category: str | None) -> dict[str, Any]:
    is_valid, error = _validate_frontmatter(content)
    if not is_valid:
        return {"success": False, "error": error}

    is_valid, error = _validate_content_size(content)
    if not is_valid:
        return {"success": False, "error": error}

    existing = find_skill_directory(name, require_enabled=False)
    if existing:
        return {"success": False, "error": f"名为 '{name}' 的技能已存在于 {existing}。"}

    skill_dir = _get_skill_dir(name, category or "custom")
    skill_dir.mkdir(parents=True, exist_ok=True)

    skill_md = skill_dir / "SKILL.md"
    _atomic_write_text(skill_md, content)

    security_issues = _scan_for_security_issues(content)
    if security_issues:
        shutil.rmtree(skill_dir, ignore_errors=True)
        return {"success": False, "error": "内容包含潜在安全问题", "issues": security_issues}

    is_valid, message, parsed_name = _validate_skill_frontmatter(skill_dir)
    if not is_valid:
        shutil.rmtree(skill_dir, ignore_errors=True)
        return {"success": False, "error": f"SKILL.md frontmatter 验证失败: {message}"}

    try:
        _enable_skill_after_create(name)
    except Exception as e:
        logger.warning("技能已创建，但写入启用状态失败: %s", e, exc_info=True)

    result = {
        "success": True,
        "message": f"技能 '{name}' 创建成功。",
        "path": str(skill_dir),
        "skill_md": str(skill_md),
    }
    if category:
        result["category"] = category
    result["hint"] = f"要添加参考文件、模板或脚本，使用 skill_manager(action='write_file', name='{name}', file_path='references/example.md', file_content='...')"
    return result


def _edit_skill(name: str, content: str) -> dict[str, Any]:
    is_valid, error = _validate_frontmatter(content)
    if not is_valid:
        return {"success": False, "error": error}

    is_valid, error = _validate_content_size(content)
    if not is_valid:
        return {"success": False, "error": error}

    existing = find_skill_directory(name, require_enabled=False)
    if not existing:
        return {"success": False, "error": f"技能 '{name}' 未找到。"}

    skill_md = existing / "SKILL.md"
    original_content = skill_md.read_text(encoding="utf-8") if skill_md.exists() else None
    _atomic_write_text(skill_md, content)

    security_issues = _scan_for_security_issues(content)
    if security_issues:
        if original_content is not None:
            _atomic_write_text(skill_md, original_content)
        return {"success": False, "error": "内容包含潜在安全问题", "issues": security_issues}

    return {"success": True, "message": f"技能 '{name}' 更新成功。", "path": str(existing)}


def _patch_skill(
    name: str,
    old_string: str,
    new_string: str,
    file_path: str | None = None,
    replace_all: bool = False,
) -> dict[str, Any]:
    existing = find_skill_directory(name, require_enabled=False)
    if not existing:
        return {"success": False, "error": f"技能 '{name}' 未找到。"}

    skill_dir = existing

    if file_path:
        is_valid, error = _validate_file_path(file_path)
        if not is_valid:
            return {"success": False, "error": error}
        target = skill_dir / file_path
        if ".." in file_path:
            return {"success": False, "error": "路径遍历不允许"}
    else:
        target = skill_dir / "SKILL.md"

    if not target.exists():
        return {"success": False, "error": f"文件未找到: {target.relative_to(skill_dir)}"}

    content = target.read_text(encoding="utf-8")

    if replace_all:
        count = content.count(old_string)
        if count == 0:
            preview = content[:500] + ("..." if len(content) > 500 else "")
            return {"success": False, "error": "未找到匹配文本", "file_preview": preview}
        new_content = content.replace(old_string, new_string)
    else:
        count = content.count(old_string)
        if count == 0:
            preview = content[:500] + ("..." if len(content) > 500 else "")
            return {"success": False, "error": "未找到匹配文本", "file_preview": preview}
        if count > 1:
            preview = content[:500] + ("..." if len(content) > 500 else "")
            return {"success": False, "error": f"找到 {count} 处匹配。提供更多上下文确保唯一，或使用 replace_all=true", "file_preview": preview}
        new_content = content.replace(old_string, new_string, 1)

    target_label = "SKILL.md" if not file_path else file_path
    is_valid, error = _validate_content_size(new_content, label=target_label)
    if not is_valid:
        return {"success": False, "error": error}

    if not file_path:
        is_valid, error = _validate_frontmatter(new_content)
        if not is_valid:
            return {"success": False, "error": f"Patch 会破坏 SKILL.md 结构: {error}"}

    original_content = content
    _atomic_write_text(target, new_content)

    security_issues = _scan_for_security_issues(new_content)
    if security_issues:
        _atomic_write_text(target, original_content)
        return {"success": False, "error": "补丁内容包含潜在安全问题", "issues": security_issues}

    return {
        "success": True,
        "message": f"已 patch {'SKILL.md' if not file_path else file_path} 在技能 '{name}'（{count} 处替换）。",
    }


def _delete_skill(name: str) -> dict[str, Any]:
    existing = find_skill_directory(name, require_enabled=False)
    if not existing:
        return {"success": False, "error": f"技能 '{name}' 未找到。"}

    skill_dir = existing

    if skill_dir.parent.name == "public":
        return {"success": False, "error": "不允许删除 public 技能。只能删除 custom 技能。"}

    shutil.rmtree(skill_dir)

    parent = skill_dir.parent
    skills_root = get_skills_root_path()
    if parent != skills_root and parent.exists() and not any(parent.iterdir()):
        parent.rmdir()

    # Keep SQLite registry + extensions_config in sync with admin.delete_skill.
    try:
        from evoflow.config.extensions_config import (
            get_extensions_config,
            reload_extensions_config,
            save_extensions_to_db,
        )
        from evoflow.persistence import config_repositories as cfg_repo
        from evoflow.skills.loader import clear_skills_cache

        cfg_repo.delete_skill_registry(name)
        extensions_config = get_extensions_config()
        if name in extensions_config.skills:
            del extensions_config.skills[name]
            save_extensions_to_db(extensions_config)
        reload_extensions_config()
        clear_skills_cache()
    except Exception as exc:
        logger.warning("skill delete registry cleanup failed for %s: %s", name, exc)

    return {"success": True, "message": f"技能 '{name}' 已删除。", "path": str(skill_dir)}


def _write_file(name: str, file_path: str, file_content: str) -> dict[str, Any]:
    is_valid, error = _validate_file_path(file_path)
    if not is_valid:
        return {"success": False, "error": error}

    if not file_content and file_content != "":
        return {"success": False, "error": "file_content 是必需的。"}

    content_bytes = len(file_content.encode("utf-8"))
    if content_bytes > _MAX_SKILL_FILE_BYTES:
        return {"success": False, "error": f"文件内容是 {content_bytes:,} 字节（限制: {_MAX_SKILL_FILE_BYTES:,} 字节 / 1 MiB）。"}

    is_valid, error = _validate_content_size(file_content, label=file_path)
    if not is_valid:
        return {"success": False, "error": error}

    existing = find_skill_directory(name, require_enabled=False)
    if not existing:
        return {"success": False, "error": f"技能 '{name}' 未找到。先用 action='create' 创建。"}

    target = existing / file_path
    if ".." in file_path:
        return {"success": False, "error": "路径遍历不允许"}

    target.parent.mkdir(parents=True, exist_ok=True)
    original_content = target.read_text(encoding="utf-8") if target.exists() else None
    _atomic_write_text(target, file_content)

    security_issues = _scan_for_security_issues(file_content)
    if security_issues:
        if original_content is not None:
            _atomic_write_text(target, original_content)
        else:
            target.unlink(missing_ok=True)
        return {"success": False, "error": "文件内容包含潜在安全问题", "issues": security_issues}

    return {
        "success": True,
        "message": f"文件 '{file_path}' 写入技能 '{name}'。",
        "path": str(target),
    }


def _remove_file(name: str, file_path: str) -> dict[str, Any]:
    is_valid, error = _validate_file_path(file_path)
    if not is_valid:
        return {"success": False, "error": error}

    existing = find_skill_directory(name, require_enabled=False)
    if not existing:
        return {"success": False, "error": f"技能 '{name}' 未找到。"}
    skill_dir = existing

    target = skill_dir / file_path
    if ".." in file_path:
        return {"success": False, "error": "路径遍历不允许"}

    if not target.exists():
        available = []
        for subdir in _ALLOWED_SUBDIRS:
            d = skill_dir / subdir
            if d.exists():
                for f in d.rglob("*"):
                    if f.is_file():
                        available.append(str(f.relative_to(skill_dir)))
        return {
            "success": False,
            "error": f"文件 '{file_path}' 在技能 '{name}' 中未找到。",
            "available_files": available if available else None,
        }

    target.unlink()

    parent = target.parent
    if parent != skill_dir and parent.exists() and not any(parent.iterdir()):
        parent.rmdir()

    return {"success": True, "message": f"文件 '{file_path}' 从技能 '{name}' 中删除。"}
