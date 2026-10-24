"""Read-only shell command classification (ZCode-style, flag-aware).

Sources:
- ZCode packages/core/src/tool/handlers/bash-readonly-policy*.ts
- ZCode packages/core/src/tool/handlers/bash-command-parser.ts

The classifier answers one question: can this shell command run without user
approval? Read-only commands are auto-allowed so the model can run checks
(``pyright``, ``ruff check``), searches (``rg``) and git inspection in plan /
read-only contexts — exactly ZCode's behavior.

Deliberately conservative: anything not explicitly classified as read-only
falls through to the normal approval flow. Compound commands (``;``, ``&&``,
backticks, command substitution, redirects) are rejected outright; only pure
``|`` pipelines of read-only segments qualify.
"""

from __future__ import annotations

import os
import re
import shlex
from pathlib import PurePath

# Compound / side-effect markers — reject the whole command (mirrors
# tool_approval_config._COMPOUND_CMD_RE, kept local to avoid import cycles).
_COMPOUND_RE = re.compile(r"[;&`]|\|\||&&|\$\(|\$\{|[<>]{1,2}")

# Commands that are read-only with any arguments (still guarded: no compound
# syntax, no redirects — those never reach per-command classification).
_SIMPLE_READONLY = {
    "basename", "cat", "column", "comm", "cut", "date", "df", "diff", "dirname",
    "du", "echo", "env", "false", "file", "head", "hostname", "id", "less",
    "ls", "md5sum", "more", "nl", "paste", "printenv", "printf", "pwd",
    "realpath", "rev", "readlink", "seq", "sha1sum", "sha256sum", "sort",
    "stat", "tac", "tail", "tree", "tty", "true", "type", "uname", "uniq",
    "uptime", "wc", "where", "whereis", "which", "whoami",
}

# Prefix wrappers that only execute the rest of the line.
_WRAPPERS = {"time", "command"}

# Env-assignment prefix (FOO=bar cmd …) — safe to skip before classification.
_ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

# git subcommands that are pure reads with any arguments.
_GIT_READ_ANY = {
    "blame", "cat-file", "describe", "diff", "grep", "ls-files", "ls-remote",
    "log", "merge-base", "reflog", "rev-list", "rev-parse", "shortlog",
    "show", "status",
}

_GIT_BRANCH_UNSAFE_FLAGS = {"-d", "-D", "-m", "-M", "-c", "-C", "--edit-description", "--unset-upstream"}
_GIT_TAG_UNSAFE_FLAGS = {"-d", "-D", "-a", "-s", "-u", "-m", "-F"}

# rg options that execute helper processes or load external config.
_RG_EXEC_FLAGS = {"--pre", "--pre-glob"}

# find options that write or execute.
_FIND_EXEC_FLAGS = {"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprintf", "-fprint", "-fprint0"}


def _split_pipeline(command: str) -> list[str]:
    """Split on ``|`` outside quotes. Callers must have rejected ``||`` already."""
    segments: list[str] = []
    current: list[str] = []
    quote: str | None = None
    for ch in command:
        if quote:
            current.append(ch)
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
            current.append(ch)
        elif ch == "|":
            segments.append("".join(current))
            current = []
        else:
            current.append(ch)
    segments.append("".join(current))
    return segments


def _argv(segment: str) -> list[str] | None:
    try:
        tokens = shlex.split(segment)
    except ValueError:
        return None
    while tokens and tokens[0] in _WRAPPERS:
        tokens.pop(0)
    while tokens and _ENV_ASSIGN_RE.match(tokens[0]):
        tokens.pop(0)
    return tokens or None


def _exe_name(token: str) -> str:
    name = PurePath(token).name.lower()
    return name[:-4] if name.endswith(".exe") else name


def _git_readonly(args: list[str]) -> bool:
    if not args:
        return False
    sub, rest = args[0], args[1:]
    if sub in _GIT_READ_ANY:
        return True
    if sub == "branch":
        # ``git branch foo`` creates a branch — no positional args allowed.
        return all(a.startswith("-") for a in rest) and not (_GIT_BRANCH_UNSAFE_FLAGS & set(rest))
    if sub == "tag":
        return all(a.startswith("-") for a in rest) and not (_GIT_TAG_UNSAFE_FLAGS & set(rest))
    if sub == "stash":
        return rest[:1] in ([], ["list"], ["show"])
    if sub == "config":
        return bool({"--get", "--get-all", "--get-regexp", "--list", "--get-urlmatch"} & set(rest))
    if sub == "remote":
        return rest[:1] in ([], ["-v"], ["--verbose"], ["get-url"], ["show"])
    if sub == "worktree":
        return rest[:1] in ([], ["list"])
    return False


def _classify(exe: str, args: list[str]) -> bool:
    if exe in _SIMPLE_READONLY:
        return True
    if exe == "git":
        return _git_readonly(args)
    if exe in {"rg", "grep", "ugrep"}:
        # rg loads RIPGREP_CONFIG_PATH which may set --pre (command exec).
        if exe == "rg" and os.environ.get("RIPGREP_CONFIG_PATH"):
            return False
        return not (_RG_EXEC_FLAGS & set(args))
    if exe == "find":
        return not (_FIND_EXEC_FLAGS & set(args)) and not any(a.startswith("-fprint") for a in args)
    if exe in {"pyright", "basedpyright"}:
        return not ({"--watch", "-w"} & set(args))
    if exe == "ruff":
        return bool(args) and args[0] == "check" and "--fix" not in args
    if exe == "eslint":
        return "--fix" not in args
    if exe == "tsc":
        return "--noEmit" in args
    if exe in {"pip", "pip3"}:
        return args[:1] in (["list"], ["show"], ["--version"])
    if exe == "npm":
        return args[:1] in (["ls"], ["list"], ["--version"])
    if exe in {"python", "python3", "py", "node"}:
        return args[:1] in (["--version"], ["-V"], ["-v"])
    return False


def is_readonly_shell_command(command: str) -> bool:
    """True when the whole command is a read-only pipeline (safe to auto-run)."""
    raw = str(command or "").strip()
    if not raw or "\n" in raw or "\r" in raw:
        return False
    if _COMPOUND_RE.search(raw):
        return False
    for segment in _split_pipeline(raw):
        tokens = _argv(segment)
        if tokens is None:
            return False
        if not _classify(_exe_name(tokens[0]), tokens[1:]):
            return False
    return True
