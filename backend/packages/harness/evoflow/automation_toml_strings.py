"""TOML basic-string escaping for flat ``*.toml`` automation files.

Paths and Markdown often contain ``\\`` (Windows); unescaped backslashes break
``tomllib`` (``Unescaped '\\' in a string``).
"""


def escape_toml_basic_string(s: str) -> str:
    """Escape for TOML double-quoted (basic) strings."""
    if not s:
        return ""
    return str(s).replace("\\", "\\\\").replace("\r", "\\r").replace("\n", "\\n").replace("\t", "\\t").replace('"', '\\"')
