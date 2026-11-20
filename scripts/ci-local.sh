#!/usr/bin/env bash
# Run the same checks as GitHub Actions (Unit Tests, Lint Check, Docs). Typical use: pre-commit hook or manual run before commit.
# Does NOT run "Sync to Public Repository" (requires secrets / SSH to another clone).
#
# Usage (from repo root):
#   make setup-git-hooks    # once per clone — then `git commit` runs pre-commit (default: ci-local --quick)
#   ./scripts/ci-local.sh
#   ./scripts/ci-local.sh --no-docs     # skip MkDocs + OpenAPI (still runs full tests + evopanel)
#   ./scripts/ci-local.sh --quick       # pre-commit: backend lint + tsc when evopanel deps present
#   make ci-local                        # Windows: uses Git Bash via scripts/run-with-git-bash.cmd
#
# Prerequisites: uv, Node 22 + npm, Python 3.12 with pip (for MkDocs when docs enabled).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_DOCS=false
QUICK=false
for arg in "$@"; do
  case "$arg" in
    --no-docs) SKIP_DOCS=true ;;
    --quick) QUICK=true; SKIP_DOCS=true ;;
    -h|--help)
      echo "Usage: $0 [--no-docs] [--quick]"
      echo "  Mirrors .github/workflows: backend-unit-tests.yml, lint-check.yml, docs.yml"
      echo "  --no-docs  Skip OpenAPI regen + git diff + mkdocs strict build"
      echo "  --quick    Backend uv sync + lint + evopanel tsc --noEmit (skipped if typescript not installed locally)"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
else
  PYTHON=python
fi

# EvoPanel: GitHub uses npm ci. On Windows, npm ci often fails with EPERM unlink on
# node_modules/@esbuild/win32-x64/esbuild.exe (IDE, dev server, or AV holds the file).
_evopanel_npm_ci_or_install() {
  (
    cd "$ROOT/evopanel" || exit 1
    if npm ci; then
      return 0
    fi
    local rc=$?
    local os
    os="$(uname -s 2>/dev/null || true)"
    if [[ "$os" == MINGW* ]] || [[ "$os" == MSYS_NT* ]] || [[ "$os" == CYGWIN_NT* ]]; then
      echo "npm ci failed (exit $rc). On Windows EPERM unlink on esbuild.exe is common." >&2
      echo "Close evopanel dev servers / other terminals using node_modules, then retry." >&2
      echo "Falling back to: npm install (does not fully wipe node_modules first)..." >&2
      npm install
      return $?
    fi
    return "$rc"
  )
}

echo "=========================================="
echo "  CI local: backend (uv sync --group dev)"
echo "=========================================="
(cd backend && uv sync --group dev)

if [[ "$QUICK" == true ]]; then
  echo ""
  echo "=========================================="
  echo "  CI local: --quick (backend lint + optional evopanel tsc)"
  echo "=========================================="
  export RUFF_CACHE_DIR="${TMPDIR:-${TEMP:-/tmp}}/ruff-cache-evoflow"
  mkdir -p "$RUFF_CACHE_DIR" 2>/dev/null || true
  # Fatal-only gate first: F821 (name used before any binding) is always a crash,
  # unlike the 388-item style backlog that `make lint` reports. See backend/Makefile.
  # Runner must never be allowed to seed a build that dies on an UnboundLocalError.
  # Gate invoked directly through uv: `make` is not installed on every dev box
  # (Windows/Git Bash → exit 127), and a gate nobody can run is a gate everybody
  # --no-verify's past — which is exactly how the lint backlog grew.
  (cd backend && uv run ruff check --select F821 .)
  # 【fullstack-dev · 2026-11-15 · 第10轮】改：advisory 档只报条数，不再全量刷屏。
  # 为什么：实测本行每次提交打印 ~1500 行（Found 413 errors. 及全部明细），把真正致命的那 1 条淹在滚屏里；
  # 而 quick 线是 pre-commit 每次提交都跑，噪音 = 没人看 = 等于没报。口径与下面全量线一致：条数进日志，明细要看自己跑。
  (cd backend && { uv run ruff check --output-format=concise . 2>&1 | grep -E "Found [0-9]+ error|All checks passed" | tail -2; } || true)
  # 【fullstack-dev · 2026-11-14 · 第2轮】改：缺 tsc 时不再静默经绿 —— 碰了 evopanel/ 就 exit 1，没碰则打 NOTE。
  # 【fullstack-dev · 2026-11-14 · 第3轮】改：quick 线两处 make lint-fatal/make lint → uv run ruff（本机无 make，exit 127 曾逼人人 --no-verify）。
  # Prefer direct node+tsc (reliable on Git Bash / Windows).
  # A missing compiler used to print one line to stderr and pass — so every
  # commit from a tree without `npm ci` in evopanel/ shipped untypechecked and
  # looked green. Now: fail if this commit touches evopanel/, loud skip otherwise.
  _tsc_js="evopanel/node_modules/typescript/bin/tsc"
  _touches_evopanel=false
  if [[ -n "$(git diff --cached --name-only -- diff-filter=d -- evopanel/ 2>/dev/null)" ]] ||
     [[ -n "$(git diff --name-only -- evopanel/ 2>/dev/null)" ]] ||
     [[ -n "$(git ls-files --others --exclude-standard -- evopanel/ 2>/dev/null)" ]]; then
    _touches_evopanel=true
  fi
  if [[ -f "$_tsc_js" ]]; then
    (cd evopanel && node ./node_modules/typescript/bin/tsc --noEmit)
  elif [[ "$_touches_evopanel" == true ]]; then
    echo "ci-local --quick: FAIL — evopanel/ has changes but the TypeScript compiler is missing ($_tsc_js)." >&2
    echo "  Typechecking was NOT run, so a green result here would be meaningless." >&2
    echo "  Fix: cd evopanel && npm ci    (or bypass knowingly: SKIP_TYPECHECK=1 git commit …)" >&2
    if [[ "${SKIP_TYPECHECK:-}" != "1" ]]; then
      exit 1
    fi
    echo "  SKIP_TYPECHECK=1 set — continuing WITHOUT typecheck (logged, not silent)." >&2
  else
    echo "ci-local --quick: NOTE — no changes under evopanel/, frontend typecheck skipped (compiler not installed)." >&2
  fi
  # 【self-evolution-bot · 2026-11-20 · 第86轮 · 模型:deepseek-v4.1-flash-1017】
  # 改了什么：quick 门禁新增「本轮署名必须带模型名」检查，只扫**本次 diff 新增行**。
  # 为什么：第86轮我把 10 个文件 23 处署名写成上一轮的模型名（qwen3.8-flash），
  #   而自查命令在 craft/代码改动署名注释格式.md 里写得很清楚——我没跑。
  #   缺的不是配方，是强制：靠"我记得要自查"的规则，必然在第 4 次复发时失效。
  # 边界：全仓 278 处历史署名缺模型名（实测 grep 计数），所以**只查新增行**；
  #   若扫全仓，一上线就被历史债刷红 = 没人看 = 等于没报（与第10轮 ruff 同一教训）。
  # 判据：新增行含 `self-evolution-bot · YYYY-MM-DD · 第N轮】` 却无 `模型:` → 失败。
  _sig_files=(backend evopanel/src scripts)
  _sig_diff="$(
    { git diff -U0 -- "${_sig_files[@]}" 2>/dev/null || true
      git diff --cached -U0 -- "${_sig_files[@]}" 2>/dev/null || true
    } | grep -E '^\+' | grep -vE '^\+\+\+' || true
  )"
  # 未跟踪新文件也要查（新建文件里的署名同样是本轮产出）
  _sig_new=""
  while IFS= read -r _f; do
    [[ -z "$_f" ]] && continue
    _sig_new+="$(cat "$_f" 2>/dev/null || true)"$'\n'
  done < <(git ls-files --others --exclude-standard -- "${_sig_files[@]}" 2>/dev/null || true)

  _sig_bad="$(
    { printf '%s\n' "$_sig_diff"; printf '%s\n' "$_sig_new"; } \
      | grep -E 'self-evolution-bot · [0-9]{4}-[0-9]{2}-[0-9]{2} · 第[0-9]+轮】' \
      | grep -vE '模型:' || true
  )"
  if [[ -n "$_sig_bad" ]]; then
    echo "ci-local --quick: FAIL — 本轮署名缺模型名（必须逐字取自本轮 <session> 的「模型:」行）。" >&2
    _sig_n="$(printf '%s\n' "$_sig_bad" | grep -c . || true)"
    echo "  不合格行（共 ${_sig_n} 处）:" >&2
    printf '%s\n' "$_sig_bad" | sed -n '1,5p' | sed 's/^/    /' >&2
    echo "  正确格式：# 【self-evolution-bot · YYYY-MM-DD · 第N轮 · 模型:<本轮模型名>】改了什么 / 为什么" >&2
    echo "  明知要跳过：SKIP_SIGNATURE=1 git commit …（会记录在案，不静默）" >&2
    if [[ "${SKIP_SIGNATURE:-}" != "1" ]]; then
      exit 1
    fi
    echo "  SKIP_SIGNATURE=1 set — continuing WITHOUT signature check (logged, not silent)." >&2
  else
    echo "  ci-local: 署名检查通过（本轮新增行均带模型名）"
  fi
  # 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
  # 改了什么：quick 门禁接入 scripts/maintainer/windows/ps1-gate.ps1（BOM + 语法 + 接线断言）。
  # 为什么：第87轮我要用 dev-self-verify.ps1 跑「构建→重启→自唤醒」，它一跑就 ParserError。
  #   根因是 dev-self-verify.ps1 与 selfverify-watchdog.ps1 的 UTF-8 BOM 丢了（HEAD 里也没有）：
  #   两个文件分别有 2656 / 3330 个非 ASCII 字符，PS 5.1 按 GBK 解码 → 中文注释吞掉闭合引号 →
  #   「表达式或语句中包含意外的标记」。而 ps1-gate.ps1 **早就存在、早就报了 FAIL、GATE_PASS=0**，
  #   只是没人调用它——判据在仓库里，闸门没接上，等于没有（第16轮接线教训的同一类）。
  #   收益：这类「脚本自己载入不了」只有语法门禁能照出来，py_compile/tsc/ruff 全都看不见。
  # 边界：本机无 powershell 时跳过并留痕，不做静默通过。
  if command -v powershell >/dev/null 2>&1; then
    _ps1_gate="scripts/maintainer/windows/ps1-gate.ps1"
    if [[ -f "$_ps1_gate" ]]; then
      _ps1_out="$(powershell -NoProfile -ExecutionPolicy Bypass -File "$_ps1_gate" 2>&1 || true)"
      if printf '%s' "$_ps1_out" | grep -q 'GATE_PASS=1'; then
        echo "  ci-local: ps1 门禁通过（BOM/语法/接线断言）"
      else
        echo "ci-local --quick: FAIL — ps1 门禁未通过（GATE_PASS != 1）。" >&2
        printf '%s\n' "$_ps1_out" | grep -E '\[FAIL\]' | sed -n '1,8p' | sed 's/^/    /' >&2
        echo "  修法：含中文的 .ps1 必须 UTF-8 with BOM；本地复跑：" >&2
        echo "    powershell -NoProfile -ExecutionPolicy Bypass -File $_ps1_gate" >&2
        if [[ "${SKIP_PS1_GATE:-}" != "1" ]]; then
          exit 1
        fi
        echo "  SKIP_PS1_GATE=1 set — continuing WITHOUT ps1 gate (logged, not silent)." >&2
      fi
    else
      echo "  ci-local: NOTE — 未找到 $_ps1_gate，跳过 ps1 门禁" >&2
    fi
  else
    echo "  ci-local: NOTE — 无 powershell，跳过 ps1 门禁（BOM/语法未校验）" >&2
  fi

  echo ""
  echo "=========================================="
  echo "  CI local: --quick checks passed."
  echo "  Full CI: ./scripts/ci-local.sh   or   make ci-local"
  echo "=========================================="
  exit 0
fi

echo ""
echo "=========================================="
echo "  CI local: Unit Tests (backend-unit-tests.yml)"
echo "=========================================="
# 【fullstack-dev · 2026-11-15 · 第10轮】改：make test → uv run python -m pytest（用例集与 backend/Makefile:10-11 一致）。
# 为什么：① 本机没装 make（command -v make 空），全量线跑到这里 exit 127 —— quick 线第3轮已修过同类问题但全量线漏了，
# 跑不动的 gate = 人人 --no-verify 的 gate；② 但 **不能**直接写 `uv run pytest`：本机实测报
# `error: uv trampoline failed to canonicalize script path`（pytest 的 console shim 在 Windows 上规范化失败），
# 换成 `uv run python -m pytest` 才通（已实测收 3 passed 级别的 collect 正常）。
(cd backend && PYTHONPATH=. uv run python -m pytest app/tests packages/harness/tests tests/ -v)

echo ""
echo "=========================================="
echo "  CI local: Lint backend (lint-check.yml)"
echo "=========================================="
# 【fullstack-dev · 2026-11-15 · 第10轮】改：make lint → 两档，口径与 lint-check.yml 对齐。
# 为什么：① 同样因为本机无 make；② `ruff check .` 实测 413 条（F*/E9* 131 条，多为 tests/ 里 F401/I001/UP017 风格债），
# 而 CI 里全量 lint job 是 `if: workflow_dispatch`（不阻断），真正必须绿的只有 fatal-names job 的 F821。
# 所以本地照抄 CI：F821 不过就 exit 1（新加的 NameError/未赋值先用了 → 挡住），其余档位只报条数不挡提交。
# `ruff format --check`（make lint 的第二条）CI 并未 gate，这里同样只报不挡。
echo "-- gate: F821 use-before-assignment (must stay green) --"
(cd backend && uv run ruff check --select F821 .)
echo "-- report only: full ruff + format (CI gates these on manual dispatch) --"
# 同 quick 线：必须按行匹配 "Found N errors"，`tail -1` 会只抓到 "333 fixable…" 那行、把总数切掉。
(cd backend && { uv run ruff check --output-format=concise . 2>&1 | grep -E "Found [0-9]+ error|All checks passed" | tail -2; } || true)
(cd backend && { uv run ruff format --check . 2>&1 | grep -E "Would reformat|formatted" | tail -1; } || true)

echo ""
echo "=========================================="
echo "  CI local: Lint EvoPanel (lint-check.yml)"
echo "=========================================="
(
  cd "$ROOT/evopanel" || exit 1
  _evopanel_npm_ci_or_install || exit $?
  npm run typecheck && npm run test && npm run build
)

if [[ "$SKIP_DOCS" == true ]]; then
  echo ""
  echo "Skipping Docs workflow (--no-docs)."
else
  echo ""
  echo "=========================================="
  echo "  CI local: Docs (docs.yml)"
  echo "=========================================="
  (cd backend && PYTHONPATH=. uv run python ../scripts/docs/export_gateway_openapi.py)
  echo "Installing MkDocs dependencies..."
  "$PYTHON" -m pip install -q -r requirements-docs.txt
  echo "MkDocs strict build..."
  "$PYTHON" -m mkdocs build --strict
fi

echo ""
echo "=========================================="
echo "  CI local: all checks passed."
echo "=========================================="
