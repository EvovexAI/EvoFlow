"""``mcp__node_repl__js`` — Browser Use / Computer Use kernel tool.

Registered only when one of the dependent official plugins (browser-use /
computer-use) is installed + enabled and the node-repl-host runtime exists.
The official plugin skills hard-require this exact tool name.

Result plumbing (v3 对齐 ZCode 识别/显示双通道):

- 帧完整性门（对齐 ZCode ``preserveOfficialCuaFrameResult``）：解码每个 image
  block，与宿主帧凭证（``zcode.cua/official-frame-integrity-v1``：sha256 /
  宽高 / media_type）对账，EXIF 方向非规范也拒收；不符的图整张丢弃并在正文
  提示重截，模型和 UI 都看不到被调包的栅格。
- 模型通道：通过完整性门的截图 stage 进 ``viewed_images``（auto 条目，仅
  path，无 base64），``ViewImageMiddleware`` 在下一次模型调用前按 ZCode
  prepareForModel 预算（base64 ≤200KB、≤1600px 边）注入多模态块 —— 模型
  直接"看"到本次截图，视觉闭环与 ZCode 一致。
- UI 通道：原图落 ``browser_screenshot_store`` → 结果文本尾部附一行
  ``{evoflow-cua-display:...}`` JSON 标记，网关剥离后构建 ``cua_display``
  展示字段（media + targetApp）。
- ``_meta``（``zcode/nodeReplCuaApp`` / ``app-associations-v1``，helper 的
  应用身份证据）进 display 标记，UI 才能渲染目标应用徽标。
"""

import base64
import binascii
import hashlib
import json
import logging
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_NODE_REPL_JS_DESCRIPTION = (
    "Browser Use and Computer Use only. Run JavaScript in a fresh Node-backed kernel "
    "with top-level await only as instructed by the corresponding official skill to "
    "control a browser or computer. Owns the Browser Use and Computer Use bridges. "
    "Always provide the required `title` as a short user-facing description in the "
    "user's language that describes the intended action without implementation terms "
    "such as js, JavaScript, or node_repl. "
    "When reading a page, return the full domSnapshot() (text: section first) — "
    "never snapshot.slice(...); if text already answers, stop and reply to the user."
)

_DISPLAY_MARKER_PREFIX = "{evoflow-cua-display:"

# 宿主附着在带图结果上的官方帧凭证（ZCode frame authority 的对账来源）。
_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1"

# ZCode control-browser 要求首轮 dump browser.documentation()；上游全文常 30–40KB。
# EvoFlow 单 WebView，完整 api.json/workflow 对模型是协议税。阈值以上替换为短指南；
# agent.documentation.get("screenshots"|"recording"|…) 小文档不触达此路径。
_BROWSER_DOCS_DUMP_MIN_CHARS = 6000
_EVOFLOW_COMPACT_BROWSER_DOCS = """# Selected Browser
- Name: EvoFlow WebView
- Type: iab
- ID: evoflow-webview

EvoFlow compact API guide (full ZCode dump omitted — this is the complete host guide).

## Fast path (prefer one js cell)
1. Host auto-bootstraps `browser-client.mjs` (also shims `require('browser-use')`). Prefer still writing the bootstrap for clarity when unsure.
2. `const browser = await agent.browsers.getForUrl(url)` or `get("iab")` (or use global `browser`).
3. Navigate: `await agent.browsers.open(url)` **or** `const tab = await browser.tabs.get("tab-0"); await tab.goto(url)`.
4. `await tab.playwright.waitForLoadState({ state: "domcontentloaded" })`.
5. Read with `await tab.playwright.domSnapshot()`; act via getByRole/getByText/… from snapshot facts.
6. Screenshot only when visual evidence is required: `nodeRepl.emitImage(await tab.screenshot())`.
Do **not** invent APIs like `tab.waitForLoadState` / `tab.domSnapshot` — use `tab.playwright.*`.
**Critical:** return the full `domSnapshot()` string (or answer the user from its `text:` section). Never `.slice()` / truncate it — the host already budgets the payload. If `text:` has the answer, stop and reply; do not re-open the same URL.

## Single-tab rules
- One in-app WebView. Do **not** spend a dedicated js call only to `tabs.list()` or re-dump documentation after this guide.
- `tabs.new()` without url is a no-op reclaim (same page). Prefer `open(url)` / `tabs.get("tab-0").goto(url)`.
- Recreate the browser wrapper each js call; tab id is usually `tab-0`.

## Lookups
- Screenshots: `await agent.documentation.get("screenshots")`
- Recording / troubleshooting: `await agent.documentation.get("recording"|"browser-troubleshooting")`

Do not call read on screenshots already staged into chat context.
"""


def _maybe_compact_browser_docs_dump(text: str) -> str:
    """Replace oversized ``browser.documentation()`` dumps with the EvoFlow compact guide."""
    if len(text) < _BROWSER_DOCS_DUMP_MIN_CHARS:
        return text
    if "# Selected Browser" not in text:
        return text
    if "# Built-in Browser Automation API" not in text and "API manifest" not in text:
        return text
    # Keep a trailing expression result if the cell both wrote docs and returned a value.
    tail = ""
    for sep in ("\n==> ", "\n=> "):
        idx = text.rfind(sep)
        if idx > len(text) // 2:
            tail = "\n\n" + text[idx:].lstrip()
            break
    logger.info(
        "compacted browser.documentation dump chars=%s -> %s",
        len(text),
        len(_EVOFLOW_COMPACT_BROWSER_DOCS) + len(tail),
    )
    return _EVOFLOW_COMPACT_BROWSER_DOCS + tail


class NodeReplJsInput(BaseModel):
    # 显示契约（对齐 ZCode node-repl-host 的 JS_TOOL_DESCRIPTION）：面板折叠条
    # 的主标题直接取该字段渲染。前端对含实现术语的标题有过滤兜底，但约束
    # 首先在这里生效——模型每次调用都必须自述一句用户视角的操作意图。
    title: str = Field(
        description=(
            "Required short user-facing description in the user's language that "
            "describes the intended action without implementation terms such as "
            "js, JavaScript, or node_repl."
        ),
        min_length=1,
    )
    code: str = Field(description="JavaScript code to execute in the Node REPL session")
    timeout_ms: int | None = Field(
        default=None,
        ge=1,
        le=120_000,
        description="Per-call timeout in milliseconds (max 120000).",
    )
    # 必须写进 args_schema：自定义 schema 时 LangChain 只从这里注入 tool_call_id。
    # 缺了截图无法 Command 回填 viewed_images，模型只能再调 view_image。
    tool_call_id: Annotated[str, InjectedToolCallId] = Field(default="", description="injected")


def _get_thread_id(runtime: ToolRuntime[Any, Any]) -> str:
    ctx = getattr(runtime, "context", None)
    tid = None
    if isinstance(ctx, dict):
        tid = ctx.get("thread_id")
    elif ctx is not None:
        tid = getattr(ctx, "thread_id", None)
    if not tid:
        config = getattr(runtime, "config", None)
        configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
        if isinstance(configurable, dict):
            tid = configurable.get("thread_id")
    return str(tid or "evoflow")


def _decode_image(image_b64: str) -> tuple[bytes, Any] | None:
    """Strict decode + full Pillow load; returns (raw_bytes, img) or None."""
    try:
        raw = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError):
        return None
    if not raw:
        return None
    try:
        from io import BytesIO

        from PIL import Image

        img = Image.open(BytesIO(raw))
        img.load()
    except Exception:
        return None
    return raw, img


def _exif_orientation(img: Any) -> int:
    try:
        return int(img.getexif().get(274, 1) or 1)
    except Exception:
        return 1


def _validate_kernel_images(images: list[dict[str, Any]], meta: dict[str, Any] | None) -> tuple[list[dict[str, Any]], list[str]]:
    """帧完整性门：解码对账，返回 (通过校验的 images, 拒收说明列表)。

    凭证只覆盖"本次最终栅格"，所以仅在结果恰好一张图时做 sha256/宽高/media_type
    严格对账（与 ZCode "official CUA allows exactly one final raster per result"
    的绑定语义一致）；多图结果退化为解码 + 方向规范检查。
    """
    frame: dict[str, Any] | None = None
    if isinstance(meta, dict):
        candidate = meta.get(_FRAME_INTEGRITY_META_KEY)
        if isinstance(candidate, dict):
            frame = candidate
    strict = frame is not None and len(images) == 1

    valid: list[dict[str, Any]] = []
    notes: list[str] = []
    for idx, image in enumerate(images):
        data = str(image.get("data") or "")
        mime = str(image.get("mime_type") or "")
        decoded = _decode_image(data)
        if decoded is None:
            notes.append(f"image {idx + 1}: undecodable or non-canonical base64")
            continue
        raw, img = decoded
        width, height = img.size
        orientation = _exif_orientation(img)
        if orientation != 1:
            notes.append(f"image {idx + 1}: non-canonical EXIF orientation {orientation}")
            continue
        if strict and frame is not None:
            expected_sha = str(frame.get("sha256") or "")
            if expected_sha and hashlib.sha256(raw).hexdigest() != expected_sha:
                notes.append("image 1: sha256 does not match the host frame receipt")
                continue
            expected_w, expected_h = frame.get("width"), frame.get("height")
            if isinstance(expected_w, int) and isinstance(expected_h, int) and (width, height) != (expected_w, expected_h):
                notes.append(f"image 1: raster {width}x{height} does not match frame receipt {expected_w}x{expected_h}")
                continue
            expected_mime = str(frame.get("media_type") or "")
            if expected_mime and mime and expected_mime != mime:
                notes.append(f"image 1: media type {mime} does not match frame receipt {expected_mime}")
                continue
        valid.append(image)
    return valid, notes


def _raster_png_and_size(image_bytes: bytes) -> tuple[bytes, int, int] | None:
    """Return PNG bytes plus pixel size.

    CUA frames are often JPEG stored under a ``.png`` name. Reading IHDR at
    offset 16 then yields garbage coordinates (the 32768, 3519884875 miss).
    """
    import io

    from PIL import Image

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            width, height = img.size
            if width <= 0 or height <= 0:
                return None
            if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
                return image_bytes, width, height
            out = io.BytesIO()
            img.convert("RGB").save(out, format="PNG")
            png = out.getvalue()
    except Exception:
        return None
    if not png:
        return None
    return png, width, height


def _save_kernel_image(thread_id: str, image_b64: str, mime_type: str) -> dict[str, Any] | None:
    # helper 回传的栅格是 JPEG（默认编码）或 PNG；统一转成真正的 PNG 再落盘，
    # 文件名与内容一致，模型按 PNG 头读宽高才不会点出画面。
    mime = (mime_type or "").lower()
    if mime and mime not in ("image/png", "image/jpeg"):
        return None
    try:
        image_bytes = base64.b64decode(image_b64, validate=False)
    except (binascii.Error, ValueError):
        return None
    if not image_bytes:
        return None
    raster = _raster_png_and_size(image_bytes)
    if raster is None:
        return None
    png_bytes, width, height = raster
    from evoflow.tools.builtins.browser_screenshot_store import resolve_screenshot_file, save_screenshot_png

    meta = save_screenshot_png(thread_id, png_bytes, width=width, height=height)
    path = resolve_screenshot_file(thread_id, str(meta["screenshot_id"]))
    return {
        "url": str(meta["image_url"]),
        "kb": int(meta["size_kb"]),
        "width": width,
        "height": height,
        **({"path": str(path)} if path is not None else {}),
    }


def _stage_model_image(runtime: ToolRuntime[Any, Any] | None, saved: dict[str, Any]) -> dict[str, Any] | None:
    """把已落盘的截图 stage 成 ``viewed_images`` auto 条目（path-only）。

    注入前的预算压缩（base64 ≤200KB）由 ViewImageMiddleware 统一执行；
    这里只要求模型走 native 像素路由。
    """
    from evoflow.agents.image_routing import decide_view_image_route
    from evoflow.agents.image_staging import stage_image_entry
    from evoflow.tools.builtins.vision_analysis_core import (
        main_model_supports_vision,
        resolve_model_name_from_runtime,
    )

    path = str(saved.get("path") or "")
    mime = "image/png" if path.lower().endswith(".png") else "image/jpeg"
    model_name = resolve_model_name_from_runtime(runtime) if runtime is not None else None
    supports = main_model_supports_vision(runtime) if runtime is not None else False
    try:
        route = decide_view_image_route(runtime=runtime)
    except Exception as exc:
        route = f"error:{exc}"
    staged = stage_image_entry(
        runtime=runtime,
        path=path,
        mime_type=mime,
        label="screen capture",
    )
    _mcp_log(
        f"stage_image path={path!r} model={model_name!r} supports_vision={supports} "
        f"route={route!r} staged={'yes' if staged else 'no'}"
    )
    return staged


def _display_marker(payload: dict[str, Any]) -> str:
    return _DISPLAY_MARKER_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "}"


def _mcp_log(message: str) -> None:
    """MCP tool I/O → logs/plugin-control.log (shared with browser / CUA)."""
    try:
        from evoflow.tools.builtins.browser_debug_log import browser_debug_log

        browser_debug_log("py", f"[mcp:node_repl] {message}")
    except Exception:
        pass


def _code_touches_computer_use(code: str) -> bool:
    """对齐 ZCode：CUA cell 必带 ``setupComputerUseRuntime`` 引导句。"""
    raw = str(code or "")
    if not raw:
        return False
    return (
        "setupComputerUseRuntime" in raw
        or "computer-use-client" in raw
        or "agent.computerUse" in raw
        or "ZCODE_CUA_PLUGIN_ROOT" in raw
        or "computer-use-bridge" in raw
    )


def _emit_cua_glow(thread_id: str, *, active: bool, tool_call_id: str = "") -> None:
    """Drive Windows CUA top indicator (ZCode-aligned).

    Start = CUA cell begins. End of a cell only starts 30s grace (does not hard-hide).
    1) In-process status for ``GET /api/cua/glow-status`` (frontend poll — reliable)
    2) Best-effort ``panel:cua_glow`` SSE (may no-op if broadcaster absent)
    """
    tid = str(thread_id or "").strip()
    call_id = str(tool_call_id or "").strip()
    key = call_id or (f"thread:{tid}" if tid else "default")
    status: dict[str, Any] = {}
    try:
        from evoflow.collab.cua_glow_state import set_cua_glow

        # active=False + key → pulse_end (30s grace). Empty key → clear_all.
        status = set_cua_glow(active=bool(active), key=key if active or call_id else "")
    except Exception:
        logger.warning("cua glow state update failed", exc_info=True)
    # Broadcast the *resolved* visibility (grace may still be active after cell end).
    resolved_active = bool(status.get("active")) if status else bool(active)
    try:
        from evoflow.tools.builtins.browser_debug_log import browser_debug_log

        browser_debug_log(
            "py",
            f"[cua-glow] emit request_active={bool(active)} resolved_active={resolved_active} "
            f"thread={tid or '-'} tool_call_id={call_id or '-'} status={status}",
        )
    except Exception:
        pass
    if not tid:
        return
    try:
        import asyncio

        from evoflow.runtime.ports import broadcaster

        data: dict[str, Any] = {
            "active": resolved_active,
            "tool_call_id": call_id,
            "phase": "start" if active else "end",
        }
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(broadcaster.broadcast(tid, "panel:cua_glow", data))
        except RuntimeError:
            asyncio.run(broadcaster.broadcast(tid, "panel:cua_glow", data))
    except Exception:
        logger.debug("cua glow broadcast failed thread=%s active=%s", tid, active, exc_info=True)


def _run(code: str, timeout_ms: int | None, title: str, runtime: ToolRuntime[Any, Any] | None, tool_call_id: str) -> str | Command:
    # `title` 仅用于面板显示，不转发给 node-repl-host。
    import time as _time

    from evoflow.plugins.node_repl import call_node_repl_js_structured

    started = _time.monotonic()
    kwargs: dict[str, Any] = {"code": code}
    if timeout_ms:
        kwargs["timeout_ms"] = timeout_ms
    thread_id = _get_thread_id(runtime) if runtime is not None else "evoflow"
    # 真实会话 id → 宿主 broker 按会话隔离状态并仲裁桌面控制器租约
    # （两个对话同时开电脑控制时，后到的拿到 CONTROLLER_BUSY 而不是互相打断）。
    kwargs["session_id"] = f"evoflow-thread:{thread_id}"
    cua_cell = _code_touches_computer_use(code)
    if cua_cell:
        # 权威触发：工具真正开跑时亮顶部提示（不依赖前端 AG-UI / V4 识别）。
        _emit_cua_glow(thread_id, active=True, tool_call_id=tool_call_id)
    # MCP 调用日志：完整输入（代码全文截断 3000 字符）+ 标题 + 会话。
    _mcp_log(
        f"CALL start title={title!r} thread={thread_id} code({len(code)} chars)="
        + code.replace("\n", "\\n")[:3000]
    )
    try:
        result = call_node_repl_js_structured(**kwargs)
    except Exception as exc:
        if cua_cell:
            _emit_cua_glow(thread_id, active=False, tool_call_id=tool_call_id)
        _mcp_log(f"CALL raised dur={_time.monotonic() - started:.1f}s error={str(exc)[:600]}")
        raise
    text = str(result.get("text") or "")
    if result.get("is_error"):
        # 报错也走同一通道：把已有文本 + 标记交给上层（Projector 仍可渲染失败态），
        # 模型侧则看到带错误说明的正文，而不是裸 RuntimeError。
        text = text or str(result.get("error") or "node_repl js failed")
        text = f"{text}\n\n[node_repl] call failed."[:4000]
    else:
        text = _maybe_compact_browser_docs_dump(text)

    raw_images = [
        {"data": str(image.get("data") or ""), "mime_type": str(image.get("mime_type") or "")}
        for image in (result.get("images") or [])[:2]
        if isinstance(image, dict) and str(image.get("data") or "")
    ]
    # 帧完整性门：不符的图整张拒收，模型与 UI 都不可见。
    kernel_images, integrity_notes = _validate_kernel_images(raw_images, result.get("meta"))
    for note in integrity_notes:
        text = f"{text}\n[screenshot rejected by frame integrity gate: {note} — capture a new image and retry]"[:8000]

    display: dict[str, Any] = {"status": "failed" if result.get("is_error") else "success"}
    image_entries: list[dict[str, Any]] = []
    staged_entries: dict[str, dict[str, Any]] = {}
    for image in kernel_images:
        saved = _save_kernel_image(thread_id, str(image.get("data") or ""), str(image.get("mime_type") or ""))
        if not saved:
            continue
        image_entries.append(saved)
        # ToolMessage 需要真实 call id 才能随 Command 回填图状态；
        # 直连调用（无注入 id）时退化为纯文本结果。
        staged = _stage_model_image(runtime, saved) if tool_call_id else None
        if staged:
            # ref = 落盘文件绝对路径，注入时由中间件读回并按预算压缩。
            staged_entries[staged["path"]] = staged
    if image_entries:
        display["images"] = [
            {"url": entry["url"], "kb": entry["kb"]} for entry in image_entries
        ]
        # Banner first so documentation dumps (screenshots.md) cannot bury it.
        size = image_entries[0]
        pixel = ""
        if size.get("width") and size.get("height"):
            pixel = (
                f" Click inside {size['width']}x{size['height']} screenshot pixels. "
                f"Do not parse the image file for size. "
                f"Batch the next click, type, and key in one js cell, then screenshot once."
            )
        # 只给模型 API 地址。图已经在工具卡上并 staged。
        banner = (
            f"[Screenshot captured: {image_entries[0]['url']} "
            f"({image_entries[0]['kb']}KB) — already shown on the tool card"
            f"{' and staged for your next context' if staged_entries else ''}. "
            f"Do not mention the file path or filename in your reply. "
            f"Do NOT call read on these images."
            f"{pixel}]"
        )
        text = f"{banner}\n\n{text}".strip() if text.strip() else banner
        if not tool_call_id:
            _mcp_log("stage_image skipped: empty tool_call_id (InjectedToolCallId missing)")
        elif not staged_entries:
            _mcp_log(
                "stage_image skipped: route not native or path missing "
                f"(entries={len(image_entries)} tool_call_id={tool_call_id!r})"
            )

    meta = result.get("meta") or {}
    # 宿主 broker 把目标应用身份记在 result._meta["zcode/nodeReplCuaApp"]
    # （appKey: "windows-exe:…" / "windows-aumid:…" / "darwin:…"）；
    # ZCode 的 app-associations-v1（带内联图标）作为兼容通道一并读取。
    app_identity: dict[str, Any] | None = None
    candidate = meta.get("zcode/nodeReplCuaApp")
    if isinstance(candidate, dict) and candidate.get("appKey"):
        app_identity = {
            "app_key": str(candidate["appKey"]),
            **(
                {"display_name": str(candidate["displayName"])}
                if isinstance(candidate.get("displayName"), str) and candidate["displayName"].strip()
                else {}
            ),
        }
    if app_identity is None:
        associations = meta.get("zcode.cua/app-associations-v1")
        if isinstance(associations, dict):
            primary = associations.get("primary")
            if isinstance(primary, dict) and primary.get("appKey"):
                app_identity = {
                    "app_key": str(primary["appKey"]),
                    **(
                        {"display_name": str(primary["displayName"])}
                        if isinstance(primary.get("displayName"), str) and primary["displayName"].strip()
                        else {}
                    ),
                }
    if app_identity:
        display["target_app"] = app_identity

    # MCP 调用日志：完整输出（正文截断 800 字符）+ 状态 + 耗时 + 附带信息。
    _mcp_log(
        f"CALL done status={'error' if result.get('is_error') else 'ok'} "
        f"dur={_time.monotonic() - started:.1f}s text({len(text)} chars)="
        + text.replace("\r", " ").replace("\n", " | ")[:800]
        + (f" images={len(image_entries)}" if image_entries else "")
        + (f" staged_model={len(staged_entries)}" if staged_entries else "")
        + (f" integrity_rejected={len(integrity_notes)}" if integrity_notes else "")
        + (f" target_app={app_identity.get('app_key')}" if app_identity else "")
        + (f" tool_call_id={tool_call_id!r}" if tool_call_id else " tool_call_id=''")
    )
    if cua_cell:
        _emit_cua_glow(thread_id, active=False, tool_call_id=tool_call_id)

    payload = f"{text}\n\n{_display_marker(display)}"
    if staged_entries and tool_call_id:
        message = ToolMessage(content=payload, tool_call_id=tool_call_id)
        return Command(update={"messages": [message], "viewed_images": staged_entries})
    return payload


def build_node_repl_js_tool() -> Any | None:
    """Build the ``mcp__node_repl__js`` tool, or None when unavailable."""
    if not _is_available():
        return None

    @tool("mcp__node_repl__js", description=_NODE_REPL_JS_DESCRIPTION, args_schema=NodeReplJsInput)
    def node_repl_js(
        title: str,
        code: str,
        timeout_ms: int | None = None,
        runtime: ToolRuntime[Any, Any] = None,  # type: ignore[assignment]
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
    ) -> str | Command:
        # InjectedToolCallId 偶发空串时，尝试从 runtime 补回，否则截图无法 Command 回填 viewed_images。
        call_id = str(tool_call_id or "").strip()
        if not call_id and runtime is not None:
            call_id = str(getattr(runtime, "tool_call_id", "") or "").strip()
        return _run(code, timeout_ms, title, runtime, call_id)

    logger.info("node_repl kernel tool registered (mcp__node_repl__js)")
    return node_repl_js


def _is_available() -> bool:
    from evoflow.plugins.node_repl import is_node_repl_available

    return is_node_repl_available()
