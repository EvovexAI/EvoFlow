"""Computer Use (CUA) bridge HTTP surface.

The node-repl-host kernel's ``computer-use-bridge`` global (overridden by
``plugins/node_repl.py`` bridge setup JS) forwards CUA wire methods here.
Each method executes on the REAL Windows desktop via PowerShell
(``plugins/cua_exec.ps1``): screen capture (System.Drawing), mouse/keyboard
injection (user32 SendInput). ZCode's own build ships this closed; this is
EvoFlow's platform implementation.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_org_admin

logger = logging.getLogger(__name__)


def _org_admin_guard(request: Request) -> None:
    require_org_admin(request)


def _bridge_token_guard(request: Request) -> None:
    """CUA 命令面共享令牌校验（同 browser bridge，内核桥为唯一预期调用方）。"""
    from evoflow.plugins.bridge_auth import verify_bridge_token

    if not verify_bridge_token(request):
        raise HTTPException(status_code=403, detail="browser bridge token required")


router = APIRouter(prefix="/api/cua", tags=["cua-bridge"], dependencies=[Depends(_org_admin_guard)])

# Glow status is local desktop UX only — no org-admin gate (poll must stay cheap).
glow_router = APIRouter(prefix="/api/cua", tags=["cua-glow"])


class CuaExecuteRequest(BaseModel):
    method: str = Field(..., description="CUA wire method (get_app_state, left_click, type, key, scroll, list_apps...)")
    input: dict[str, Any] = Field(default_factory=dict, description="Method payload")


_PS_EXEC_PATH = Path(__file__).resolve().parents[3] / "packages" / "harness" / "evoflow" / "plugins" / "cua_exec.ps1"


def _resolve_ps1() -> Path:
    if _PS_EXEC_PATH.is_file():
        return _PS_EXEC_PATH
    # Frozen: PyInstaller datas → evoflow/plugins/cua_exec.ps1 under _MEIPASS.
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        frozen = Path(meipass) / "evoflow" / "plugins" / "cua_exec.ps1"
        if frozen.is_file():
            return frozen
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "plugins" / "cua_exec.ps1"
        if candidate.is_file():
            return candidate
        candidate = parent / "evoflow" / "plugins" / "cua_exec.ps1"
        if candidate.is_file():
            return candidate
    raise RuntimeError("cua_exec.ps1 not found next to the gateway or in the harness package")


def _run_ps_action(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    ps1 = _resolve_ps1()
    payload_json = json.dumps(payload, ensure_ascii=False)
    encoded = base64.b64encode(payload_json.encode("utf-8")).decode("ascii")
    from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs

    cmd = [
        "powershell",
        "-NoProfile",
        "-WindowStyle", "Hidden",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", str(ps1),
        "-Action", action,
        "-EncodedPayload", encoded,
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        **subprocess_hide_window_kwargs(),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"cua_exec.ps1 failed: {(proc.stderr or proc.stdout)[-400:]}")
    return json.loads(proc.stdout)


@router.post(
    "/execute",
    dependencies=[Depends(_bridge_token_guard)],
)
async def execute(payload: CuaExecuteRequest) -> dict[str, Any]:
    """Execute one CUA wire method on the real Windows desktop."""
    from evoflow.tools.builtins.browser_debug_log import browser_debug_log

    method = payload.method
    started = asyncio.get_event_loop().time()
    # CUA MCP full I/O → logs/plugin-control.log ([mcp:cua], same family as kernel tools).
    browser_debug_log(
        "py",
        f"[mcp:cua] CALL start method={method} input="
        + json.dumps(payload.input or {}, ensure_ascii=False)[:1000],
    )
    action_map = {
        # wire method → ps1 Action
        "get_app_state": "get_app_state",
        "list_apps": "list_apps",
        "request_access": "request_access",
        "stop_computer_control": "stop_computer_control",
        "screenshot": "screenshot",
    }
    ps_action = action_map.get(method)
    ps_input = dict(payload.input)
    if ps_action is None:
        # 动作方法（left_click/type/key/scroll/...）直接透传给 ps1 分发
        ps_action = method
    try:
        raw = await asyncio.to_thread(_run_ps_action, ps_action, ps_input)
    except Exception as exc:  # noqa: BLE001 — 统一转 CallToolResult 错误
        logger.warning("CUA execute %s failed: %s", method, exc)
        browser_debug_log(
            "py",
            f"[mcp:cua] CALL FAILED method={method} after {asyncio.get_event_loop().time() - started:.1f}s: {exc}",
        )
        return {
            "content": [{"type": "text", "text": json.dumps({"kind": "cua_error", "message": str(exc)[:300]})}],
            "isError": True,
        }
    result_head = json.dumps(raw, ensure_ascii=False)[:600] if isinstance(raw, dict) else str(raw)[:600]
    browser_debug_log(
        "py",
        f"[mcp:cua] CALL done method={method} ok={bool(raw.get('ok')) if isinstance(raw, dict) else '?'} "
        f"after {asyncio.get_event_loop().time() - started:.1f}s result={result_head}",
    )
    return _to_call_tool_result(method, raw)


def _to_call_tool_result(method: str, raw: dict[str, Any]) -> dict[str, Any]:
    if not raw.get("ok"):
        err = raw.get("error") or {}
        return {
            "content": [{"type": "text", "text": json.dumps(err, ensure_ascii=False)}],
            "isError": True,
        }
    result = raw.get("result") or {}
    # get_app_state / screenshot：图片块 + 状态文本（客户端 getAXState 解析 text + image 块）
    if method in ("get_app_state", "screenshot") and result.get("base64"):
        state_text = json.dumps(
            {"kind": "visual_only", "note": "v1 视觉模式：无辅助功能树，按截图坐标操作", "screen": {"width": result.get("width"), "height": result.get("height")}},
            ensure_ascii=False,
        )
        content: list[dict[str, Any]] = [{"type": "text", "text": state_text}]
        return {"content": content + [{"type": "image", "data": result["base64"], "mimeType": result.get("mime", "image/png")}]}
    return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]}


# ---------------------------------------------------------------------------
# 应用图标解析（target-app-display 徽标）
#
# ZCode 桌面端在 main 进程原生解析 iconLocators；EvoFlow 面板是 Tauri WebView，
# 直接走网关：PowerShell 提取（win32 exe 用 ExtractAssociatedIcon；AUMID 尽力
# 解析 Appx 清单 logo），结果按 locator 值做进程内 LRU 缓存。
# ---------------------------------------------------------------------------

class AppIconLocator(BaseModel):
    kind: str = Field(..., description="darwin-bundle-id | windows-executable-path | windows-aumid")
    value: str = Field(..., min_length=1, max_length=32768)


class AppIconRequestBody(BaseModel):
    locators: list[AppIconLocator] = Field(..., min_length=1, max_length=3)


_ICON_CACHE: dict[str, str | None] = {}
_ICON_CACHE_LIMIT = 256

_APP_ICON_PS = r"""
param([string]$Kind, [string]$Value)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bytes = $null
if ($Kind -eq 'windows-executable-path') {
    $exe = [IO.Path]::GetFullPath($Value)
    $name = [IO.Path]::GetFileName($exe).ToLower()
    if ($name -eq 'applicationframehost.exe') { exit 0 }
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
    if ($icon) {
        $ms = New-Object IO.MemoryStream
        $icon.ToBitmap().Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $ms.ToArray()
    }
} elseif ($Kind -eq 'windows-aumid') {
    $family = ($Value -split '!')[0]
    $pkg = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1
    if ($pkg) {
        $manifest = Join-Path $pkg.InstallLocation 'AppxManifest.xml'
        [xml]$xml = Get-Content -LiteralPath $manifest
        $ve = $xml.Package.Applications.Application.VisualElements | Select-Object -First 1
        if ($ve) {
            $logo = $ve.Square44x44Logo
            if (-not $logo) { $logo = $ve.Square150x150Logo }
            if ($logo) {
                $base = Join-Path $pkg.InstallLocation $logo
                $dir = Split-Path $base -Parent
                $stem = [IO.Path]::GetFileNameWithoutExtension($base)
                $best = Get-ChildItem -LiteralPath $dir -Filter "$stem*" -ErrorAction SilentlyContinue |
                    Where-Object { $_.Extension -match '^\.(png|jpg|jpeg)$' } |
                    Sort-Object Length -Descending | Select-Object -First 1
                if ($best) { $bytes = [IO.File]::ReadAllBytes($best.FullName) }
            }
        }
    }
}
if ($bytes) { [Convert]::ToBase64String($bytes) }
"""


def _read_icon_via_powershell(kind: str, value: str) -> str | None:
    import subprocess
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False, encoding="utf-8-sig") as handle:
        handle.write(_APP_ICON_PS)
        script_path = handle.name
    try:
        from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs

        proc = subprocess.run(
            [
                "powershell", "-NoProfile", "-WindowStyle", "Hidden", "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", script_path, "-Kind", kind, "-Value", value,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            **subprocess_hide_window_kwargs(),
        )
        data = (proc.stdout or "").strip()
        if proc.returncode == 0 and data and len(data) < 400_000:
            return data
        return None
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass


@router.post(
    "/app-icon",
    summary="Resolve an application icon (base64 data URL) for target-app display",
)
async def app_icon(payload: AppIconRequestBody) -> dict[str, Any] | None:
    """按 locator 顺序解析应用图标；全部失败返回 null（面板回退通用图标）。"""
    from fastapi.responses import JSONResponse

    for locator in payload.locators:
        kind = locator.kind.strip()
        value = locator.value.strip()
        if kind not in ("windows-executable-path", "windows-aumid", "darwin-bundle-id"):
            continue
        if kind == "darwin-bundle-id":
            continue  # macOS 图标走平台原生实现（未接线前回退）
        cache_key = f"{kind}:{value.lower()}"
        if cache_key in _ICON_CACHE:
            cached = _ICON_CACHE[cache_key]
        else:
            if kind == "windows-executable-path":
                from pathlib import Path as _Path

                candidate = _Path(value)
                if not candidate.is_absolute() or not candidate.is_file():
                    _ICON_CACHE[cache_key] = None
                    continue
            data = await asyncio.to_thread(_read_icon_via_powershell, kind, value)
            if len(_ICON_CACHE) >= _ICON_CACHE_LIMIT:
                _ICON_CACHE.pop(next(iter(_ICON_CACHE)))
            _ICON_CACHE[cache_key] = data
            cached = data
        if cached:
            return {"iconDataUrl": f"data:image/png;base64,{cached}"}
    return JSONResponse(content=None)


@glow_router.get("/glow-status")
async def glow_status() -> dict[str, Any]:
    """Desktop polls this to show ZCode-style 「正在操作电脑」 top indicator.

    Driven by node_repl CUA cells via ``evoflow.collab.cua_glow_state`` — does not
    require panel-stream / AG-UI (V4-safe). No org-admin dependency.
    """
    from evoflow.collab.cua_glow_state import get_cua_glow_status

    return get_cua_glow_status()


@glow_router.post("/glow-status")
async def glow_status_set(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Manual / test hook to force indicator on/off."""
    from evoflow.collab.cua_glow_state import set_cua_glow

    body = payload or {}
    active = bool(body.get("active"))
    key = str(body.get("key") or body.get("tool_call_id") or "").strip()
    return set_cua_glow(active=active, key=key)
