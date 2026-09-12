"""Skill content security scanning."""

from __future__ import annotations

import re
from pathlib import Path

# Patterns dangerous in any file type — injection, path traversal, network exfiltration.
# These are flagged regardless of whether the file is code or documentation.
# Note: bare ``curl``/``wget`` mentions in documentation are *not* listed here —
# they only apply to executable code files (see ``_CODE_PATTERNS``) so install
# tutorials in SKILL.md are not false-positive blocked.
_UNIVERSAL_PATTERNS = [
    r"<script[^>]*>",
    r"javascript:",
    r"\bon\w+\s*=",  # HTML event handlers (onclick=, onerror=); \b avoids matching sessionKey=
    r'fetch\s*\(\s*["\']https?://',
    r"XMLHttpRequest",
    r"\.\./\.\.",
    r"/etc/passwd",
    r"/etc/shadow",
    r"\\windows\\system32",
]

# Patterns that represent code execution — only dangerous in actual code files,
# not in documentation that merely mentions exec() or eval() / curl in prose.
_CODE_PATTERNS = [
    r"os\.system\s*\(",
    r"subprocess\.(?:run|call|Popen|check_output|check_call|getoutput)\s*\(",
    r"(?<![\w.-])\bexec\s*\(",
    r"(?<![\w.-])\beval\s*\(",
    r"curl\s+https?://",
    r"wget\s+https?://",
]

# File suffixes that contain executable code — code patterns are scanned here.
_CODE_SUFFIXES = {".py", ".js", ".ts", ".sh", ".bash"}

# All text file suffixes that get scanned (code + documentation/config).
_TEXT_SUFFIXES = {
    ".md",
    ".txt",
    ".yaml",
    ".yml",
    ".json",
    ".py",
    ".sh",
    ".bash",
    ".toml",
    ".csv",
    ".ts",
    ".js",
}


def scan_for_security_issues(content: str, *, is_code: bool = True) -> list[str]:
    """Scan text content for dangerous patterns.

    Args:
        content: The text content to scan.
        is_code: If True, also scan for code execution patterns (exec, eval,
            os.system, subprocess). Set to False for documentation files that
            may mention these functions in prose without being dangerous.
    """
    issues: list[str] = []
    patterns = _UNIVERSAL_PATTERNS + (_CODE_PATTERNS if is_code else [])
    for pattern in patterns:
        if re.search(pattern, content, re.IGNORECASE):
            issues.append(f"Potential security risk: {pattern}")
    return issues


def scan_skill_directory(skill_dir: Path) -> list[str]:
    """Scan text files under a skill directory for dangerous patterns.

    Code execution patterns (exec, eval, os.system, subprocess) are only
    scanned in code files (.py, .js, .ts, .sh, .bash). Documentation files
    (.md, .txt, etc.) are only scanned for universal patterns (injection,
    path traversal, network exfiltration).
    """
    issues: list[str] = []
    for path in skill_dir.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in _TEXT_SUFFIXES and path.name != "SKILL.md":
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        is_code = path.suffix.lower() in _CODE_SUFFIXES
        for issue in scan_for_security_issues(content, is_code=is_code):
            rel = path.relative_to(skill_dir).as_posix()
            issues.append(f"{rel}: {issue}")
    return issues
