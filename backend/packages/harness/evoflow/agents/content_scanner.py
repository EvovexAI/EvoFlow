"""Content security scanner — detects prompt injection in user-provided content.

Scans context files, uploaded documents, memory content, custom system prompts
for known prompt injection patterns before they enter the LLM context.
"""

import logging
import re

logger = logging.getLogger(__name__)

# Threat patterns: (regex, threat_id, description)
_THREAT_PATTERNS: list[tuple[str, str, str]] = [
    (r"ignore\s+(previous|all|above|prior)\s+instructions", "prompt_injection", "Attempt to ignore previous instructions"),
    (r"you\s+are\s+now\s+", "role_hijack", "Attempt to hijack agent role definition"),
    (r"do\s+not\s+tell\s+the\s+user", "deception_hide", "Attempt to hide information from user"),
    (r"system\s+prompt\s+override", "sys_prompt_override", "Attempt to override system prompt"),
    (r"disregard\s+(your|all|any)\s+(instructions|rules|guidelines)", "disregard_rules", "Attempt to disregard established rules"),
    (r"act\s+as\s+(if|though)\s+you\s+(have\s+no|don\'t\s+have)\s+(restrictions|limits|rules|constraints)", "bypass_restrictions", "Attempt to bypass restrictions"),
    (r"<!--[^>]*(?:ignore|override|system|secret|hidden|prompt)[^>]*-->", "html_comment_injection", "HTML comment-based injection attempt"),
    (r'<\s*div\s+style\s*=\s*["\'][\s\S]*?display\s*:\s*none', "hidden_div", "Hidden div injection attempt"),
    (r"translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval|follow)", "translate_execute", "Translate-and-execute attack pattern"),
    (r"curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)", "exfil_curl", "Credential exfiltration via curl"),
    (r"cat\s+[^\n]*(\.env|\$HOME|credentials|\.netrc|\.pgpass|id_rsa)", "read_secrets", "Attempt to read secret files"),
    (r"OvErRide|DiSrEgArd|IgNoRe\s+AlL", "case_bypass", "Case-mixing attempt to bypass filters"),
]

# Invisible Unicode characters commonly used in prompt injection
_INVISIBLE_CHARS = frozenset(
    {
        "\u200b",  # zero-width space
        "\u200c",  # zero-width non-joiner
        "\u200d",  # zero-width joiner
        "\u2060",  # word joiner
        "\ufeff",  # BOM / zero-width no-break space
        "\u202a",  # left-to-right embedding
        "\u202b",  # right-to-left embedding
        "\u202c",  # pop directional formatting
        "\u202d",  # left-to-right override
        "\u202e",  # right-to-left override
    }
)


def scan_content(content: str, source: str = "unknown") -> str:
    """Scan content for prompt injection patterns.

    Returns the original content if clean, or a blocked message if threats
    are detected.

    Args:
        content: The text content to scan.
        source: A human-readable source label for logging (e.g. file name).

    Returns:
        Original content if safe, or a ``[BLOCKED]`` message if threats found.
    """
    if not content:
        return content

    findings: list[str] = []

    # Check invisible unicode characters
    for char in _INVISIBLE_CHARS:
        if char in content:
            findings.append(f"invisible unicode U+{ord(char):04X}")

    # Check threat patterns
    for pattern, threat_id, description in _THREAT_PATTERNS:
        if re.search(pattern, content):
            findings.append(f"{threat_id} ({description})")

    if findings:
        logger.warning("Content blocked from '%s': %s", source, "; ".join(findings))
        return f"[BLOCKED: {source} contained potential prompt injection ({'; '.join(findings)}). Content was not loaded for security reasons.]"

    return content


def scan_memory_entries(entries: list[str], source: str = "memory") -> list[str]:
    """Scan each memory entry and replace dangerous ones with blocked markers."""
    result = []
    for entry in entries:
        scanned = scan_content(entry, source=source)
        if scanned != entry:
            result.append("[BLOCKED MEMORY ENTRY — contains prompt injection patterns]")
        else:
            result.append(entry)
    return result
