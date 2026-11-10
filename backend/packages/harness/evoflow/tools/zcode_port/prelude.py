"""Shell prelude that wraps find/grep/rg the way ZCode embedded search does.

Source: ZCode/apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts
ugrep -z/-Z differs from GNU grep null-data; those flags must fall through to system grep.
Windows does not ship bfs; Git Bash must keep system find.
"""

from __future__ import annotations

GREP_BYPASS_CASE_PATTERN = (
    "-*-filter*|-*-pager*|-*-view*|-*-format-open*|-*-config*|---*|-@*|-*-save-config*|-[Zz]*|-[!-]*[Zz]*|--null|--null-data"
)

BFS_DEFAULT_ARGS = "-S dfs -regextype findutils-default"
UGREP_DEFAULT_ARGS = "-G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl"

BASH_DESCRIPTION = """Executes a bash command and returns its output.

- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist across calls (each command runs in a fresh subshell; the host may reuse a warm bash process).
- IMPORTANT: Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.
- `timeout` is in milliseconds: default 120000, max 600000. Short read-only probes (`git status`/`log`, `ls`, …) soft-cap at 30000 when timeout is omitted.
- On Windows the shell is Git Bash (POSIX) when available — use `&&`, pipes, and `2>/dev/null`. Prefer `git -C 'path' …` over `cd && …`.
- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.
- Do **not** wait with `sleep N`, `sleep N; tail …`, or `sleep N && gh run view`. Long jobs: `run_in_background=true`, then rely on the completion notification / output file (or non-blocking `taskoutput`). For CI use `gh run watch`. Single `sleep` over ~20s is rejected.

# Git
- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.
- Use the `gh` CLI for GitHub operations (PRs, issues, API).
- Commit or push only when the user asks. If on the default branch, branch first."""

BASH_DESCRIPTION_DIRECT = BASH_DESCRIPTION.replace(
    "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`",
    "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`",
)

GLOB_DESCRIPTION = 'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.'

GREP_DESCRIPTION = """Content search built on ripgrep. Prefer this over `grep`/`rg` via Bash — results integrate with the permission UI and file links.

- Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Ripgrep, not grep — escape literal braces (`interface\\{\\}`).
- Filter with `glob` (e.g. "**/*.tsx") or `type` (e.g. "js", "py", "rust").
- `output_mode`: "content" (matching lines), "files_with_matches" (paths only, default), or "count".
- `multiline: true` for patterns that span lines."""

TASK_OUTPUT_DESCRIPTION = """DEPRECATED: Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes.
- For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr.
- For local_agent tasks: use the Agent tool result directly. Do NOT Read the .output file — it is a symlink to the full subagent conversation transcript (JSONL) and will overflow your context window.
- For remote_agent tasks: prefer using the Read tool on the output file path — it contains the streamed remote session output (same as bash).

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions"""

TASK_STOP_DESCRIPTION = """
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task
"""


def build_embedded_search_prelude(*, find_command: str = "bfs", grep_command: str = "ugrep", rg_command: str = "rg", wrap_find: bool = True) -> str:
    """POSIX function prelude. Skipped for cmd/PowerShell (ZCode: no function injection)."""
    lines: list[str] = []
    if wrap_find:
        lines.append("unalias find 2>/dev/null || true")
    lines.append("unalias grep 2>/dev/null || true")
    if wrap_find:
        lines.append(
            "\n".join(
                [
                    "find() {",
                    f"  command -v {find_command} >/dev/null 2>&1 || {{ command find \"$@\"; return; }}",
                    f"  command {find_command} {BFS_DEFAULT_ARGS} \"$@\"",
                    "}",
                ]
            )
        )
    lines.append(
        "\n".join(
            [
                "grep() {",
                "  local _zcode_grep_arg",
                '  for _zcode_grep_arg in "$@"; do',
                f'    case "$_zcode_grep_arg" in {GREP_BYPASS_CASE_PATTERN}) command grep "$@"; return ;; esac',
                "  done",
                f"  command -v {grep_command} >/dev/null 2>&1 || {{ command grep \"$@\"; return; }}",
                f"  command {grep_command} {UGREP_DEFAULT_ARGS} \"$@\"",
                "}",
            ]
        )
    )
    if rg_command != "rg":
        lines.append(
            "\n".join(
                [
                    "if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then",
                    "  unalias rg 2>/dev/null || true",
                    "  rg() {",
                    f"    command {rg_command} \"$@\"",
                    "  }",
                    "fi",
                ]
            )
        )
    return "\n".join(lines) + "\n"
