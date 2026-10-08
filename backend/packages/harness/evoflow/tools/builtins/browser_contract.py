"""Typed browser command contracts, ported from ZCode ``@zcode/shared/browser-use``.

Data model parity with ZCode's zod schemas (commands.ts / result.ts / snapshot.ts /
command-metadata.ts), expressed as pydantic v2 models. The engine
(:mod:`evoflow.tools.builtins.browser_engine`) consumes/produces these shapes so the
EvoPanel browser UI can later adopt the same wire contract.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Viewport constants (ZCode: command-metadata.ts)
# ---------------------------------------------------------------------------

BROWSER_VIEWPORT_LIMITS = {
    "minWidth": 320,
    "maxWidth": 3840,
    "minHeight": 320,
    "maxHeight": 2160,
}
DEFAULT_AGENT_BROWSER_VIEWPORT = {"width": 1280, "height": 720}
DEFAULT_EMBEDDED_BROWSER_VIEWPORT = {"width": 393, "height": 852}


class ErrorCode(StrEnum):
    """Structured error codes — never silently swallowed (ZCode parity)."""

    BACKEND_UNAVAILABLE = "backend_unavailable"
    CAPABILITY_UNSUPPORTED = "capability_unsupported"
    REF_NOT_FOUND = "ref_not_found"
    NAVIGATION_BLOCKED = "navigation_blocked"
    TIMEOUT = "timeout"
    RENDERER_UNREACHABLE = "renderer_unreachable"
    CANCELLED = "cancelled"
    EXECUTION_ERROR = "execution_error"


MouseButton = Literal["left", "right", "middle"]
KeyModifier = Literal["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float
    y: float


class ClipRect(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float
    y: float
    width: float = Field(gt=0)
    height: float = Field(gt=0)


# ---------------------------------------------------------------------------
# Snapshot model (ZCode: snapshot.ts)
# ---------------------------------------------------------------------------


class ElementRect(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float
    y: float
    width: float
    height: float


class SnapshotElement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ref: str = Field(min_length=1)
    tag: str
    role: str | None = None
    name: str | None = None
    text: str | None = None
    value: str | None = None
    disabled: bool | None = None
    checked: bool | None = None
    selector: str
    xpath: str
    rect: ElementRect
    inViewport: bool
    parentRef: str | None = None
    framePath: str | None = None
    attributes: dict[str, str] | None = None


class SnapshotDomNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tag: str
    depth: int = Field(ge=0)
    inViewport: bool
    ref: str | None = None
    role: str | None = None
    name: str | None = None
    text: str | None = None
    attributes: dict[str, str] | None = None


class BrowserSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str
    title: str
    dom: list[SnapshotDomNode] | None = None
    domTruncated: bool | None = None
    elements: list[SnapshotElement]
    truncated: bool


class PageState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str
    title: str
    canGoBack: bool
    canGoForward: bool
    scrollX: float | None = None
    scrollY: float | None = None
    viewportWidth: float | None = None
    viewportHeight: float | None = None


class DialogInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["alert", "confirm", "prompt", "beforeunload"]
    message: str
    defaultPrompt: str | None = None


class TabSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tabId: str
    url: str
    title: str
    viewport: dict[str, int]
    active: bool | None = None
    lifecycle: Literal["active", "deliverable", "handoff"] | None = None


# ---------------------------------------------------------------------------
# Command union (ZCode: commands.ts) — subset the engine implements
# ---------------------------------------------------------------------------

BrowserCommandMethod = Literal[
    "navigate",
    "back",
    "forward",
    "reload",
    "snapshot",
    "click",
    "fill",
    "type",
    "press",
    "scroll",
    "hover",
    "select",
    "check",
    "drag",
    "screenshot",
    "getState",
    "elementInfo",
    "evaluate",
    "waitFor",
    "close",
    "list",
    "viewportSet",
]


class BrowserCommand(BaseModel):
    """Discriminated-ish command envelope; ``method`` picks the payload fields.

    Kept permissive (extra ignored) so the panel/agent can adopt ZCode command
    fields incrementally without breaking the engine.
    """

    model_config = ConfigDict(extra="ignore")

    method: BrowserCommandMethod
    # navigate
    url: str | None = None
    # click/type/scroll/hover/select/check/drag/screenshot/elementInfo
    ref: str | None = None
    x: float | None = None
    y: float | None = None
    button: MouseButton | None = None
    doubleClick: bool | None = None
    modifiers: list[KeyModifier] | None = None
    # fill/type
    value: str | None = None
    text: str | None = None
    # press
    key: str | None = None
    keys: list[str] | None = None
    # scroll / drag
    scrollX: float | None = None
    scrollY: float | None = None
    direction: str | None = None
    amount: int | None = None
    fromRef: str | None = None
    toRef: str | None = None
    from_: Point | None = Field(default=None, alias="from")
    to: Point | None = None
    # select / check
    values: list[str] | None = None
    checked: bool | None = None
    # screenshot
    fullPage: bool | None = None
    clip: ClipRect | None = None
    # snapshot
    maxElements: int | None = Field(default=None, gt=0)
    includeHidden: bool | None = None
    # evaluate / waitFor
    expression: str | None = None
    selector: str | None = None
    textGone: str | None = None
    timeoutMs: int | None = Field(default=None, gt=0)
    # viewportSet
    width: int | None = None
    height: int | None = None
    # generic
    tabId: str | None = None


# ---------------------------------------------------------------------------
# Command result (ZCode: result.ts)
# ---------------------------------------------------------------------------


class BrowserError(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: ErrorCode
    message: str
    sideEffect: Literal["none", "uncertain"] | None = None


class CommandResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    state: PageState | None = None
    snapshot: BrowserSnapshot | None = None
    image: dict[str, str] | None = None  # {"base64": ..., "mimeType": "image/png"}
    value: Any = None
    element: SnapshotElement | None = None
    dialog: DialogInfo | None = None
    tabs: list[TabSummary] | None = None
    error: BrowserError | None = None
    elapsedMs: float = 0


def fail(code: ErrorCode, message: str, *, side_effect: str | None = None) -> CommandResult:
    return CommandResult(
        ok=False,
        error=BrowserError(
            code=code, message=message, sideEffect=side_effect  # type: ignore[arg-type]
        ),
    )


# ---------------------------------------------------------------------------
# Agent-facing text rendering (engine snapshot → tool string output)
# ---------------------------------------------------------------------------

_ROLE_LABELS_ZH = {
    "textbox": "输入框",
    "button": "按钮",
    "link": "链接",
    "checkbox": "复选框",
    "radio": "单选",
    "combobox": "下拉框",
    "listbox": "列表",
    "menuitem": "菜单项",
    "tab": "标签页",
    "switch": "开关",
    "slider": "滑块",
    "img": "图片",
    "heading": "标题",
}


def snapshot_to_text(snapshot: BrowserSnapshot, *, max_dom_lines: int = 60) -> str:
    """Render a snapshot as compact ref-addressed text for the model."""
    lines: list[str] = [f"URL: {snapshot.url}", f"Title: {snapshot.title}", ""]
    for el in snapshot.elements:
        role = el.role or el.tag or "generic"
        label = _ROLE_LABELS_ZH.get(role, role)
        desc = f"- [{el.ref}] {label}"
        name = (el.name or "").strip()
        if name:
            desc += f' "{name}"'
        text = (el.text or "").strip()
        if text and text != name:
            desc += f" text={text[:80]!r}"
        value = (el.value or "").strip()
        if value:
            desc += f" value={value[:80]!r}"
        if el.checked is not None:
            desc += " [x]" if el.checked else " [ ]"
        if el.disabled:
            desc += " [disabled]"
        if not el.inViewport:
            desc += " (out of view)"
        lines.append(desc)
    if snapshot.truncated:
        lines.append(f"...（元素超过预算，已截断；共返回 {len(snapshot.elements)} 个）")
    dom_nodes = snapshot.dom or []
    if dom_nodes:
        lines.append("")
        shown = 0
        for node in dom_nodes:
            if shown >= max_dom_lines:
                lines.append("...（正文大纲已截断）")
                break
            text = (node.text or "").strip()
            name = (node.name or "").strip()
            body = text or name
            if not body:
                continue
            indent = "  " * min(node.depth, 6)
            role = node.role or node.tag
            lines.append(f"{indent}{role}: {body[:120]}")
            shown += 1
        if snapshot.domTruncated:
            lines.append("...（正文大纲超预算，已截断）")
    return "\n".join(lines)


def state_to_text(state: PageState) -> str:
    parts = [f"URL: {state.url}", f"Title: {state.title}"]
    if state.scrollY is not None or state.scrollX is not None:
        parts.append(f"Scroll: x={state.scrollX or 0:.0f} y={state.scrollY or 0:.0f}")
    if state.viewportWidth and state.viewportHeight:
        parts.append(f"Viewport: {state.viewportWidth:.0f}x{state.viewportHeight:.0f}")
    return "\n".join(parts)
