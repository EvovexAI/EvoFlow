"""Expert Pack Installer — 自动化创建智能体流程。

封装「下载技能包 → 解压 → 注册 Agent → 配置头像/SOUL → 注入技能」全链路。

Usage:
    from evoflow.agents.expert_pack_installer import install_expert_pack
    
    # 安装单个技能
    install_expert_pack("cjskill")
    
    # 安装技能并创建 Agent
    install_expert_pack(
        slug="cjskill",
        agent_code="my-video-agent",
        agent_name="短视频助手",
        skills=["short-video-copywriting"],
    )
"""

import json
import logging
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SKILLHUB_API_BASE = "https://api.skillhub.cn"
SKILLS_ROOT = Path.home() / ".evoflow" / "skills"


def download_skill_zip(slug: str, *, timeout: int = 60) -> Path:
    """从 SkillHub 下载技能 ZIP 包到临时目录。
    
    Args:
        slug: SkillHub 技能标识（如 "cjskill"）
        timeout: 下载超时秒数
        
    Returns:
        临时 ZIP 文件路径
        
    Raises:
        RuntimeError: 下载失败
    """
    import httpx
    
    url = f"{SKILLHUB_API_BASE}/api/v1/download?slug={slug}"
    logger.info(f"Downloading skill from {url}")
    
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
    except Exception as e:
        raise RuntimeError(f"下载失败 {slug}: {e}") from e
    
    # 写入临时文件
    tmp_dir = Path(tempfile.mkdtemp(prefix="evoflow_skill_"))
    zip_path = tmp_dir / f"{slug}.zip"
    zip_path.write_bytes(resp.content)
    logger.info(f"Downloaded {len(resp.content)} bytes to {zip_path}")
    
    return zip_path


def extract_skill_to_custom(zip_path: Path, *, target_name: str | None = None) -> Path:
    """解压技能 ZIP 到 custom/ 子目录。
    
    Args:
        zip_path: ZIP 文件路径
        target_name: 目标目录名（默认从 SKILL.md frontmatter 提取）
        
    Returns:
        解压后的技能目录路径
    """
    custom_dir = SKILLS_ROOT / "custom"
    custom_dir.mkdir(parents=True, exist_ok=True)
    
    # 先解压到临时目录，读取 SKILL.md 获取 name
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(tmp_path)
        
        # 读取 SKILL.md frontmatter
        skill_md = tmp_path / "SKILL.md"
        if not skill_md.exists():
            raise ValueError("ZIP 中未找到 SKILL.md")
        
        # 解析 frontmatter 获取 name
        frontmatter = _parse_frontmatter(skill_md.read_text(encoding="utf-8"))
        skill_name = target_name or frontmatter.get("name")
        if not skill_name:
            raise ValueError("无法确定技能名称（SKILL.md 缺少 name 字段）")
        
        # 目标目录
        target_dir = custom_dir / skill_name
        if target_dir.exists():
            logger.warning(f"目标目录已存在，将覆盖: {target_dir}")
            shutil.rmtree(target_dir)
        
        # 移动解压内容
        shutil.copytree(tmp_path, target_dir)
        logger.info(f"Extracted skill to {target_dir}")
    
    return target_dir


def _parse_frontmatter(content: str) -> dict[str, Any]:
    """解析 SKILL.md 的 YAML frontmatter。"""
    if not content.startswith("---"):
        return {}
    
    end = content.find("---", 3)
    if end == -1:
        return {}
    
    frontmatter_text = content[3:end].strip()
    try:
        import yaml
        return yaml.safe_load(frontmatter_text) or {}
    except ImportError:
        # 简单解析 key: value
        result = {}
        for line in frontmatter_text.splitlines():
            if ":" in line:
                key, _, value = line.partition(":")
                result[key.strip()] = value.strip()
        return result


def register_agent(
    agent_code: str,
    *,
    agent_name: str | None = None,
    description: str = "",
    skills: list[str] | None = None,
    avatar: str = "image",
    system_prompt: str | None = None,
    agent_type: str = "custom",
    **extra_fields: Any,
) -> None:
    """注册或更新 Agent 配置。
    
    Args:
        agent_code: Agent 唯一标识
        agent_name: 显示名称
        description: Agent 描述
        skills: 关联的技能列表
        avatar: 头像类型（"image" | "emoji:🔧" | null）
        system_prompt: 系统提示词（subagent 类型使用）
        agent_type: Agent 类型（"custom" | "subagent" | "acp"）
        **extra_fields: 其他 AgentConfig 字段
    """
    from evoflow.config.agents_config import save_agent_config, load_agent_config
    
    # 尝试加载现有配置
    try:
        existing = load_agent_config(agent_code)
        config_data = existing.model_dump(mode="python", exclude={"name"})
    except FileNotFoundError:
        config_data = {}
    
    # 更新字段
    config_data["agent_code"] = agent_code
    if agent_name:
        config_data["agent_name"] = agent_name
    if description:
        config_data["description"] = description
    if skills is not None:
        config_data["skills"] = list(skills)
    if avatar is not None:
        config_data["avatar"] = avatar
    if system_prompt:
        config_data["system_prompt"] = system_prompt
    config_data["agent_type"] = agent_type
    
    # 合并额外字段
    config_data.update(extra_fields)
    
    save_agent_config(agent_code, config_data)
    logger.info(f"Registered agent: {agent_code}")


def refresh_skills_registry() -> None:
    """刷新技能注册表，使新安装的技能生效。"""
    from evoflow.skills.loader import clear_skills_cache
    from evoflow.persistence.bootstrap import sync_skills_from_filesystem
    
    clear_skills_cache()
    try:
        sync_skills_from_filesystem()
        logger.info("Skills registry refreshed")
    except Exception as e:
        logger.warning(f"Failed to sync skills from filesystem: {e}")


def install_expert_pack(
    slug: str,
    *,
    agent_code: str | None = None,
    agent_name: str | None = None,
    description: str = "",
    skills: list[str] | None = None,
    avatar: str = "image",
    system_prompt: str | None = None,
    target_name: str | None = None,
) -> dict[str, Any]:
    """安装专家包（技能 + Agent 配置）。
    
    全链路：下载 → 解压 → 注册 Agent → 刷新注册表
    
    Args:
        slug: SkillHub 技能标识
        agent_code: Agent 唯一标识（默认使用 slug）
        agent_name: Agent 显示名称
        description: Agent 描述
        skills: 关联的技能列表（默认从 SKILL.md 提取）
        avatar: 头像类型
        system_prompt: 系统提示词
        target_name: 技能目录名（默认从 SKILL.md 提取）
        
    Returns:
        安装结果字典
        
    Example:
        >>> result = install_expert_pack(
        ...     slug="cjskill",
        ...     agent_code="video-copywriter",
        ...     agent_name="短视频文案助手",
        ...     skills=["short-video-copywriting"],
        ... )
        >>> print(result["skill_dir"])
        C:\\Users\\...\\.evoflow\\skills\\custom\\cjskill
    """
    result = {
        "slug": slug,
        "skill_dir": None,
        "agent_code": agent_code or slug,
        "success": False,
        "error": None,
    }
    
    try:
        # 1. 下载
        zip_path = download_skill_zip(slug)
        
        # 2. 解压
        skill_dir = extract_skill_to_custom(zip_path, target_name=target_name)
        result["skill_dir"] = str(skill_dir)
        
        # 3. 读取 SKILL.md 获取技能名称
        skill_md = skill_dir / "SKILL.md"
        frontmatter = _parse_frontmatter(skill_md.read_text(encoding="utf-8"))
        skill_name = frontmatter.get("name", slug)
        
        # 4. 注册 Agent（如果指定了 agent_code）
        if agent_code or agent_name:
            register_agent(
                agent_code=agent_code or slug,
                agent_name=agent_name or slug,
                description=description,
                skills=skills or [skill_name],
                avatar=avatar,
                system_prompt=system_prompt,
            )
            result["agent_code"] = agent_code or slug
        
        # 5. 刷新注册表
        refresh_skills_registry()
        
        # 6. 清理临时文件
        try:
            shutil.rmtree(zip_path.parent)
        except Exception:
            pass
        
        result["success"] = True
        logger.info(f"Expert pack installed: {slug} -> {skill_dir}")
        
    except Exception as e:
        result["error"] = str(e)
        logger.error(f"Failed to install expert pack {slug}: {e}")
    
    return result


def install_skill_only(slug: str, *, target_name: str | None = None) -> dict[str, Any]:
    """仅安装技能（不创建 Agent）。
    
    Args:
        slug: SkillHub 技能标识
        target_name: 技能目录名
        
    Returns:
        安装结果字典
    """
    return install_expert_pack(slug, target_name=target_name, agent_code=None)
