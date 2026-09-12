from pathlib import Path

from pydantic import BaseModel, Field


class ExtraSkillRoot(BaseModel):
    """Additional skill discovery root (user-bound folder)."""

    path: str = Field(description="Absolute or ~-relative path to a skills tree or skill folder")
    readonly: bool = Field(default=True, description="When true, agent write tools should not modify skills here")


class SkillsConfig(BaseModel):
    """Configuration for skills system"""

    path: str | None = Field(
        default=None,
        description="Path to skills directory. If not specified, defaults to ../skills relative to backend directory",
    )
    extra_roots: list[ExtraSkillRoot] = Field(
        default_factory=list,
        description="Additional skill discovery roots; higher precedence than primary public/",
    )
    repo_skills_dir: str = Field(
        default=".evoflow/skills",
        description="Relative to workspace root; scanned when a workspace is bound",
    )
    container_path: str = Field(
        default="/mnt/skills",
        description="Path where skills are mounted in the sandbox container",
    )

    def get_skills_path(self) -> Path:
        """
        Get the resolved skills directory path.

        Returns:
            Path to the skills directory
        """
        if self.path:
            # Use configured path (can be absolute or relative)
            path = Path(self.path)
            if not path.is_absolute():
                # If relative, resolve from current working directory
                path = Path.cwd() / path
            return path.resolve()
        else:
            # Default: ../skills relative to backend directory
            from evoflow.skills.loader import get_skills_root_path

            return get_skills_root_path()

    def get_extra_root_paths(self) -> list[Path]:
        out: list[Path] = []
        for entry in self.extra_roots or []:
            raw = str(entry.path or "").strip()
            if not raw:
                continue
            p = Path(raw).expanduser()
            if not p.is_absolute():
                p = Path.cwd() / p
            try:
                out.append(p.resolve())
            except OSError:
                continue
        return out

    def get_skill_container_path(self, skill_name: str, category: str = "public") -> str:
        """
        Get the full container path for a specific skill.

        Args:
            skill_name: Name of the skill (directory name)
            category: Category of the skill (public or custom)

        Returns:
            Full path to the skill in the container
        """
        return f"{self.container_path}/{category}/{skill_name}"
