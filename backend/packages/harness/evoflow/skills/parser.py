import logging
from pathlib import Path

import yaml

from evoflow.skills.frontmatter import split_skill_frontmatter

from .types import Skill

logger = logging.getLogger(__name__)


def parse_skill_file(skill_file: Path, category: str, relative_path: Path | None = None) -> Skill | None:
    """
    Parse a SKILL.md file and extract metadata.

    Args:
        skill_file: Path to the SKILL.md file
        category: Category of the skill ('public' or 'custom')

    Returns:
        Skill object if parsing succeeds, None otherwise
    """
    if not skill_file.exists() or skill_file.name != "SKILL.md":
        return None

    try:
        content = skill_file.read_text(encoding="utf-8")

        split = split_skill_frontmatter(content)
        if split is None:
            return None

        front_matter, _body = split
        try:
            metadata = yaml.safe_load(front_matter) or {}
        except yaml.YAMLError:
            return None
        if not isinstance(metadata, dict):
            return None

        name = str(metadata.get("name") or "").strip()
        description = str(metadata.get("description") or "").strip()

        if not name or not description:
            return None

        license_text = metadata.get("license")

        return Skill(
            name=name,
            description=description,
            license=license_text,
            skill_dir=skill_file.parent,
            skill_file=skill_file,
            relative_path=relative_path or Path(skill_file.parent.name),
            category=category,
            enabled=True,  # Default to enabled, actual state comes from config file
        )

    except Exception as e:
        logger.error("Error parsing skill file %s: %s", skill_file, e)
        return None
