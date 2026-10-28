"""Tests for the in-process browser engine stack (contract / tool normalization / engine behavior).

The WebView2 lives in the EvoPanel desktop process, so the engine is tested
against a fake CDP bridge (:class:`FakeBridge`) that mimics the Rust HTTP
server's Runtime.evaluate / Input.* / Page.* responses. A real end-to-end run
against a live desktop app is available behind ``EVOFLOW_DESKTOP_E2E=1``.
"""

from __future__ import annotations

import pytest

from evoflow.tools.builtins.browser_contract import (
    BrowserSnapshot,
    CommandResult,
    ErrorCode,
    PageState,
    SnapshotElement,
    fail,
    snapshot_to_text,
    state_to_text,
)
from evoflow.tools.builtins.browser_tool import _normalize_ref

# ---------------------------------------------------------------------------
# Unit: contract models
# ---------------------------------------------------------------------------


def _sample_element(**overrides) -> SnapshotElement:
    payload = dict(
        ref="e1",
        tag="button",
        role="button",
        name="Submit",
        selector="#submit",
        xpath="//button[@id='submit']",
        rect={"x": 10, "y": 20, "width": 80, "height": 24},
        inViewport=True,
    )
    payload.update(overrides)
    return SnapshotElement.model_validate(payload)


def test_snapshot_to_text_renders_refs_and_roles():
    snap = BrowserSnapshot(url="https://example.com", title="Example", elements=[_sample_element()], truncated=False)
    text = snapshot_to_text(snap)
    assert "URL: https://example.com" in text
    assert "[e1]" in text
    assert "按钮" in text
    assert "Submit" in text


def test_snapshot_to_text_marks_truncation_and_out_of_view():
    snap = BrowserSnapshot(
        url="https://example.com",
        title="Example",
        elements=[
            _sample_element(),
            _sample_element(ref="e2", tag="input", role="textbox", name="Email", inViewport=False, selector="#mail", xpath="//input"),
        ],
        truncated=True,
    )
    text = snapshot_to_text(snap)
    assert "(out of view)" in text
    assert "截断" in text


def test_state_to_text_includes_scroll_and_viewport():
    state = PageState(url="https://x.com", title="X", canGoBack=True, canGoForward=False, scrollX=0.0, scrollY=120.0, viewportWidth=1280.0, viewportHeight=720.0)
    text = state_to_text(state)
    assert "Scroll: x=0 y=120" in text
    assert "Viewport: 1280x720" in text


def test_state_to_text_skips_missing_scroll():
    state = PageState(url="https://x.com", title="X", canGoBack=False, canGoForward=False)
    assert "Scroll" not in state_to_text(state)


def test_fail_result_carries_error_code():
    result = fail(ErrorCode.TIMEOUT, "boom")
    dumped = result.model_dump(mode="json", exclude_none=True)
    assert dumped["ok"] is False
    assert dumped["error"]["code"] == "timeout"


def test_command_result_json_round_trip():
    state = PageState(url="https://x.com", title="X", canGoBack=False, canGoForward=False)
    result = CommandResult(ok=True, state=state)
    dumped = result.model_dump(mode="json", exclude_none=True)
    assert dumped["state"]["url"] == "https://x.com"
    assert "error" not in dumped


# ---------------------------------------------------------------------------
# Unit: tool-layer ref normalization (@e2 legacy CLI style ↔ e2 contract style)
# ---------------------------------------------------------------------------


def test_normalize_ref_strips_at_prefix():
    assert _normalize_ref("@e2") == "e2"
    assert _normalize_ref("e2") == "e2"
    assert _normalize_ref(" @e10 ") == "e10"


def test_normalize_ref_rejects_empty():
    assert _normalize_ref("") is None
    assert _normalize_ref(None) is None
    assert _normalize_ref("@") is None


# ---------------------------------------------------------------------------
# Unit: engine feature flag
# ---------------------------------------------------------------------------


def test_engine_disabled_by_env(monkeypatch):
    from evoflow.tools.builtins import browser_engine

    monkeypatch.setenv("EVOFLOW_BROWSER_ENGINE", "cli")
    assert browser_engine.browser_engine_enabled() is False
    monkeypatch.setenv("EVOFLOW_BROWSER_ENGINE", "playwright")
    assert browser_engine.browser_engine_enabled() is True
    monkeypatch.delenv("EVOFLOW_BROWSER_ENGINE", raising=False)
    assert browser_engine.browser_engine_enabled() is True


# ---------------------------------------------------------------------------
# Fake CDP bridge — mimics the Rust WebView2 HTTP bridge
# ---------------------------------------------------------------------------


class FakeBridge:
    """Records CDP calls and answers Runtime.evaluate with a synthetic page.

    The snapshot payload mirrors exactly what ``_SNAPSHOT_JS`` returns, so the
    engine↔contract alignment is pinned by construction.
    """

    def __init__(self, url="https://example.com/", title="Example"):
        self.url = url
        self.title = title
        self.calls: list[tuple[str, dict]] = []
        self.history_index = 0
        self.history_entries = [{"id": "1", "url": "about:blank"}, {"id": "2", "url": url}]
        self.evaluate_value: object = None
        self.evaluate_exception: dict | None = None

    def _record(self, method, params):
        self.calls.append((method, params))
        return {"method": method, "params": params}

    def _element(self, index: int, **overrides) -> dict:
        el = {
            "ref": f"e{index}",
            "tag": "button",
            "role": "button",
            "name": "Submit",
            "text": "Submit",
            "value": "",
            "checked": None,
            "disabled": False,
            "selector": "#submit",
            "xpath": "//body/BUTTON[1]",
            "rect": {"x": 10, "y": 20, "width": 80, "height": 24},
            "inViewport": True,
            "attributes": {"id": "submit"},
        }
        el.update(overrides)
        return el

    def _snapshot_payload(self) -> dict:
        return {
            "url": self.url,
            "title": self.title,
            "elements": [self._element(1), self._element(2, ref="e2", tag="input", role="textbox", name="Email", selector="#mail", xpath="//body/INPUT[1]", text="", value="")],
            "truncated": False,
            "dom": [
                {"tag": "h1", "depth": 1, "inViewport": True, "text": "Hello"},
                {"tag": "div", "depth": 2, "inViewport": True, "text": "22°C 晴"},
            ],
            "domTruncated": False,
        }

    def _state_payload(self) -> dict:
        return {
            "url": self.url,
            "title": self.title,
            "sx": 0,
            "sy": 120,
            "vw": 1280,
            "vh": 720,
            "hl": 2,
            "ready": "complete",
        }

    async def __call__(self, tid: str, method: str, params: dict | None = None):
        self._record(method, params or {})
        if method == "Runtime.evaluate":
            expr = str((params or {}).get("expression") or "")
            if "roleOf" in expr and "interactiveElements" in expr:
                return {"result": {"value": self._snapshot_payload()}}
            if "location.href" in expr:
                payload = self._state_payload()
                payload["ready"] = "complete"
                payload["canBack"] = self.history_index > 0
                payload["canForward"] = False
                return {"result": {"value": payload}}
            if "document.readyState" in expr:
                return {"result": {"value": "complete"}}
            if self.evaluate_exception is not None:
                return {"exceptionDetails": self.evaluate_exception}
            return {"result": {"value": self.evaluate_value}}
        if method == "Page.getNavigationHistory":
            return {"index": self.history_index, "entries": self.history_entries}
        return {}


@pytest.fixture()
def bridge(monkeypatch):
    import evoflow.tools.builtins.browser_engine as engine_mod

    fake = FakeBridge()
    monkeypatch.setattr(engine_mod, "_dispatch_run", fake)
    yield fake


@pytest.fixture()
def engine(bridge):
    """One engine for the whole test so snapshot refs persist across calls."""
    from evoflow.tools.builtins.browser_engine import BrowserEngine

    return BrowserEngine()


def _execute(engine, command: dict, timeout: float = 10.0) -> dict:
    return engine.execute("pytest-tid", command, timeout=timeout)


# ---------------------------------------------------------------------------
# Engine: snapshot contract alignment
# ---------------------------------------------------------------------------


def test_snapshot_returns_contract_valid_shape(bridge, engine):
    result = _execute(engine, {"method": "snapshot"})
    assert result["ok"], result
    snap = result["snapshot"]
    # Round-trips through the pydantic contract without validation errors.
    validated = BrowserSnapshot.model_validate(snap)
    refs = {el["ref"] for el in snap["elements"]}
    assert refs == {"e1", "e2"}
    assert validated.elements[0].role == "button"
    assert validated.dom and validated.dom[0].text == "Hello"
    assert any(n.text == "22°C 晴" for n in (validated.dom or []))


def test_get_state_includes_ready(bridge, engine):
    result = _execute(engine, {"method": "getState"})
    assert result["ok"], result
    state = PageState.model_validate(result["state"])
    assert state.ready == "complete"


def test_snapshot_populates_refs_for_click(bridge, engine):
    result = _execute(engine, {"method": "snapshot"})
    assert result["ok"]
    click = _execute(engine, {"method": "click", "ref": "e1"})
    assert click["ok"], click
    click_calls = [c for c in bridge.calls if c[0] == "Runtime.evaluate" and "el.click()" in str(c[1])]
    assert click_calls, bridge.calls


def test_click_unknown_ref_is_ref_not_found(bridge, engine):
    result = _execute(engine, {"method": "click", "ref": "e99"})
    assert not result["ok"]
    assert result["error"]["code"] == "ref_not_found"
    assert "fresh snapshot" in result["error"]["message"]


# ---------------------------------------------------------------------------
# Engine: evaluate surfaces values and page errors
# ---------------------------------------------------------------------------


def test_evaluate_returns_value(bridge, engine):
    bridge.evaluate_value = "clicked"
    result = _execute(engine, {"method": "evaluate", "expression": "document.getElementById('out').textContent"})
    assert result["ok"], result
    assert result["value"] == "clicked"


def test_evaluate_reports_page_exception(bridge, engine):
    bridge.evaluate_exception = {
        "text": "Uncaught",
        "exception": {"description": "ReferenceError: boom is not defined"},
    }
    result = _execute(engine, {"method": "evaluate", "expression": "boom()"})
    assert not result["ok"]
    assert "boom is not defined" in result["error"]["message"]


# ---------------------------------------------------------------------------
# Engine: history navigation (embed: history.back via Runtime.evaluate)
# ---------------------------------------------------------------------------


def test_back_uses_history_api(bridge, engine):
    result = _execute(engine, {"method": "back"})
    assert result["ok"], result
    evals = [
        params.get("expression", "")
        for method, params in bridge.calls
        if method == "Runtime.evaluate"
    ]
    assert any("history.back()" in expr for expr in evals)
    assert result["state"]["canGoForward"] is True


def test_back_still_ok_when_history_is_empty(bridge, engine):
    # WebView history.back() is a no-op at the first entry; engine still settles.
    bridge.history_index = 0
    result = _execute(engine, {"method": "back"})
    assert result["ok"], result


# ---------------------------------------------------------------------------
# Engine: keyboard events carry real key codes (Chrome needs them for actions)
# ---------------------------------------------------------------------------


def test_press_enter_carries_virtual_key_code_and_text(bridge, engine):
    result = _execute(engine, {"method": "press", "key": "Enter"})
    assert result["ok"], result
    events = [params for method, params in bridge.calls if method == "Input.dispatchKeyEvent"]
    downs = [e for e in events if e.get("type") == "keyDown"]
    enter = next(e for e in downs if e.get("key") == "Enter")
    assert enter["windowsVirtualKeyCode"] == 13
    assert enter["text"] == "\r"
    assert enter["code"] == "Enter"


def test_press_letter_maps_to_code_and_vk(bridge):
    from evoflow.tools.builtins.browser_engine import _cdp_key_event

    down = _cdp_key_event("a", "keyDown")
    assert down["code"] == "KeyA"
    assert down["windowsVirtualKeyCode"] == 65
    assert down["text"] == "a"


def test_press_with_modifier_sets_modifier_bitmask(bridge, engine):
    result = _execute(engine, {"method": "press", "key": "a", "modifiers": ["Control"]})
    assert result["ok"], result
    events = [params for method, params in bridge.calls if method == "Input.dispatchKeyEvent"]
    assert any(e.get("modifiers") == 2 for e in events), events


# ---------------------------------------------------------------------------
# Engine: fill goes through the keyboard path (React-safe)
# ---------------------------------------------------------------------------


def test_fill_focuses_then_inserts_text(bridge, engine):
    _execute(engine, {"method": "snapshot"})  # populate refs
    result = _execute(engine, {"method": "fill", "ref": "e2", "value": "hello"})
    assert result["ok"], result
    inserts = [params for method, params in bridge.calls if method == "Input.insertText"]
    assert inserts and inserts[0]["text"] == "hello"
    focus_calls = [
        str(params.get("expression") or "")
        for method, params in bridge.calls
        if method == "Runtime.evaluate"
    ]
    assert any("el.select()" in expr for expr in focus_calls), focus_calls


def test_fill_empty_value_skips_insert(bridge, engine):
    _execute(engine, {"method": "snapshot"})  # populate refs
    result = _execute(engine, {"method": "fill", "ref": "e2", "value": ""})
    assert result["ok"], result
    assert not [c for c in bridge.calls if c[0] == "Input.insertText"]


# ---------------------------------------------------------------------------
# Engine: scroll accepts direct wheel deltas (CUA parity)
# ---------------------------------------------------------------------------


def test_scroll_uses_direct_wheel_deltas(bridge, engine):
    result = _execute(engine, {"method": "scroll", "scrollX": 0, "scrollY": -600})
    assert result["ok"], result
    wheels = [params for method, params in bridge.calls if method == "Input.dispatchMouseEvent"]
    assert wheels and wheels[0]["deltaY"] == -600
    assert wheels[0]["type"] == "mouseWheel"


def test_scroll_direction_amount_fallback(bridge, engine):
    result = _execute(engine, {"method": "scroll", "direction": "down", "amount": 800})
    assert result["ok"], result
    wheels = [params for method, params in bridge.calls if method == "Input.dispatchMouseEvent"]
    assert wheels and wheels[0]["deltaY"] == 800


# ---------------------------------------------------------------------------
# Engine: navigate waits for readyState and normalizes the URL
# ---------------------------------------------------------------------------


def test_navigate_adds_scheme_and_reports_state(bridge, engine):
    result = _execute(engine, {"method": "navigate", "url": "example.com/page"})
    assert result["ok"], result
    nav = [c for c in bridge.calls if c[0] == "Page.navigate"]
    assert nav and nav[0][1]["url"] == "https://example.com/page"
    assert result["state"]["url"] == "https://example.com/"


def test_navigate_requires_url(bridge, engine):
    result = _execute(engine, {"method": "navigate", "url": " "})
    assert not result["ok"]


def test_navigate_unwraps_nested_url_dict(bridge, engine):
    result = _execute(
        engine,
        {"method": "navigate", "url": {"url": "https://www.tianqi.com/nanyang/"}},
    )
    assert result["ok"], result
    nav = [c for c in bridge.calls if c[0] == "Page.navigate"]
    assert nav and nav[0][1]["url"] == "https://www.tianqi.com/nanyang/"


def test_navigate_unwraps_python_dict_repr_url(bridge, engine):
    result = _execute(
        engine,
        {"method": "navigate", "url": "{'url': 'https://www.tianqi.com/nanyang/'}"},
    )
    assert result["ok"], result
    nav = [c for c in bridge.calls if c[0] == "Page.navigate"]
    assert nav and nav[0][1]["url"] == "https://www.tianqi.com/nanyang/"


def test_unsupported_method_is_capability_error(bridge, engine):
    result = _execute(engine, {"method": "download"})
    assert not result["ok"]
    assert result["error"]["code"] == "capability_unsupported"


# ---------------------------------------------------------------------------
# Regression: navigate / back / forward / reload must surface timeouts
# (auto-insurance-quoter 30 hits/60s storm was caused by the engine
# silently returning ok=True when document.readyState never reached
# "complete" — the proactive worker then retried against an empty page
# until the gateway spike detector tripped on /execution/state.)
# ---------------------------------------------------------------------------


def test_navigate_surfaces_timeout_when_readyState_never_completes(monkeypatch, engine):
    """Soft-decouple: Page.navigate OK + stuck loading → soft-ok (not TIMEOUT), no blank re-nav."""
    import evoflow.tools.builtins.browser_engine as engine_mod

    class StuckLoadingBridge:
        def __init__(self):
            self.calls: list[tuple[str, dict]] = []

        async def __call__(self, tid, method, params=None):
            self.calls.append((method, params or {}))
            if method == "Page.navigate":
                return {"frameId": "fake"}
            if method == "Runtime.evaluate":
                expr = str((params or {}).get("expression") or "")
                if "document.readyState" in expr:
                    # Settle script and legacy readyState polls both stay loading.
                    return {"result": {"value": "loading"}}
                if "location.href" in expr:
                    return {"result": {"value": {
                        "url": "https://pingan.chuangzhan.com/insurance",
                        "title": "", "hl": 0, "sx": 0, "sy": 0, "vw": 1280, "vh": 720,
                    }}}
            return {}

    stuck = StuckLoadingBridge()
    monkeypatch.setattr(engine_mod, "_dispatch_run", stuck)
    # Don't wait 8s — patch the engine's wait to a short deadline for test speed.
    orig_wait = engine._wait_document_ready

    async def fast_wait(tid, timeout_ms=5000):
        return await orig_wait(tid, timeout_ms=200)  # 200ms is enough; stuck bridge returns "loading"

    monkeypatch.setattr(engine, "_wait_document_ready", fast_wait)

    result = _execute(engine, {"method": "navigate", "url": "https://pingan.chuangzhan.com/insurance"})
    # Soft-decouple: successful Page.navigate always soft-oks; settle is best-effort.
    assert result["ok"] is True, result
    assert result["state"]["url"].endswith("/insurance")
    navs = [c for c in stuck.calls if c[0] == "Page.navigate"]
    assert len(navs) == 1, f"slow/loading must not blank-retry, got {len(navs)} navigates"


def test_navigate_surfaces_dispatch_failure_as_execution_error(monkeypatch, engine):
    """Page.navigate itself rejects (CDP broker gone) → EXECUTION_ERROR, not silent swallow."""
    import evoflow.tools.builtins.browser_engine as engine_mod

    class DeadBridge:
        async def __call__(self, tid, method, params=None):
            raise ConnectionError("CDP broker unreachable: WinError 1225")

    monkeypatch.setattr(engine_mod, "_dispatch_run", DeadBridge())
    result = _execute(engine, {"method": "navigate", "url": "https://example.com"})
    assert result["ok"] is False
    assert result["error"]["code"] == "execution_error"
    assert "Page.navigate rejected" in result["error"]["message"]
    assert "CDP broker unreachable" in result["error"]["message"]


def test_navigate_succeeds_when_readyState_completes(bridge, engine):
    """Sanity: the happy path still returns ok=True (regression guard for the new explicit-failure branch)."""
    result = _execute(engine, {"method": "navigate", "url": "https://example.com/page"})
    assert result["ok"] is True, result
    assert result["state"]["url"] == "https://example.com/"


def test_navigate_retries_settle_while_webview_mounts(monkeypatch, engine):
    """Cold panel: first Runtime.evaluate fails with webview-not-ready; must retry, not abort in <1s."""
    import evoflow.tools.builtins.browser_engine as engine_mod

    class MountingBridge:
        def __init__(self) -> None:
            self.evals = 0

        async def __call__(self, tid, method, params=None):
            if method == "Page.navigate":
                return {"frameId": "fake"}
            if method == "Runtime.evaluate":
                self.evals += 1
                if self.evals < 3:
                    raise RuntimeError(
                        "embedded webview not ready for Runtime.evaluate "
                        "(label=browser-embed-primary); Page.navigate first"
                    )
                return {
                    "result": {
                        "value": {
                            "ready": "interactive",
                            "url": "https://www.baidu.com/",
                            "title": "百度",
                            "sx": 0,
                            "sy": 0,
                            "vw": 1280,
                            "vh": 720,
                            "hl": 1,
                            "canBack": False,
                            "canForward": False,
                        }
                    }
                }
            return {}

    monkeypatch.setattr(engine_mod, "_dispatch_run", MountingBridge())
    result = _execute(engine, {"method": "navigate", "url": "https://www.baidu.com"})
    assert result["ok"] is True, result
    assert "baidu.com" in result["state"]["url"]


def test_navigate_blank_while_want_http_redispatches_once(monkeypatch, engine):
    """Cold open: first settle stuck on about:blank → one Page.navigate retry, then ready."""
    import evoflow.tools.builtins.browser_engine as engine_mod

    class BlankThenReadyBridge:
        def __init__(self) -> None:
            self.navs = 0
            self.evals = 0

        async def __call__(self, tid, method, params=None):
            if method == "Page.navigate":
                self.navs += 1
                return {"frameId": "fake"}
            if method == "Runtime.evaluate":
                self.evals += 1
                # Until second navigate, document is "complete" on boot blank.
                if self.navs < 2:
                    return {
                        "result": {
                            "value": {
                                "ready": "complete",
                                "url": "about:blank",
                                "title": "",
                                "sx": 0,
                                "sy": 0,
                                "vw": 1280,
                                "vh": 720,
                                "hl": 1,
                                "canBack": False,
                                "canForward": False,
                            }
                        }
                    }
                return {
                    "result": {
                        "value": {
                            "ready": "complete",
                            "url": "https://www.bing.com/search?q=shanghai",
                            "title": "shanghai - Search",
                            "sx": 0,
                            "sy": 0,
                            "vw": 1280,
                            "vh": 720,
                            "hl": 1,
                            "canBack": False,
                            "canForward": False,
                        }
                    }
                }
            return {}

    bridge = BlankThenReadyBridge()
    monkeypatch.setattr(engine_mod, "_dispatch_run", bridge)
    result = _execute(
        engine, {"method": "navigate", "url": "https://www.bing.com/search?q=shanghai"}
    )
    assert result["ok"] is True, result
    assert bridge.navs == 2, f"expected blank re-nav once, got navs={bridge.navs}"
    assert "bing.com" in result["state"]["url"]


def test_navigate_slow_site_does_not_redispatch(monkeypatch, engine):
    """Non-blank settle failure (loading on real URL) must not second-navigate."""
    import evoflow.tools.builtins.browser_engine as engine_mod

    class SlowSiteBridge:
        def __init__(self) -> None:
            self.navs = 0

        async def __call__(self, tid, method, params=None):
            if method == "Page.navigate":
                self.navs += 1
                return {"frameId": "fake"}
            if method == "Runtime.evaluate":
                return {
                    "result": {
                        "value": {
                            "ready": "loading",
                            "url": "https://slow.example.com/",
                            "title": "",
                            "sx": 0,
                            "sy": 0,
                            "vw": 1280,
                            "vh": 720,
                            "hl": 1,
                            "canBack": False,
                            "canForward": False,
                        }
                    }
                }
            return {}

    async def short_settle(session, tid, timeout_ms):
        return await engine_mod.BrowserEngine._settle(engine, session, tid, 200)

    bridge = SlowSiteBridge()
    monkeypatch.setattr(engine_mod, "_dispatch_run", bridge)
    monkeypatch.setattr(engine, "_settle", short_settle)
    result = _execute(engine, {"method": "navigate", "url": "https://slow.example.com/"})
    assert result["ok"] is True, result
    assert bridge.navs == 1, f"slow site must not blank-retry, got navs={bridge.navs}"


def test_navigate_timeout_mentions_webview_not_ready(monkeypatch, engine):
    """Embed never mounts: soft-ok after Page.navigate; must not blank-retry on not-ready."""
    import evoflow.tools.builtins.browser_engine as engine_mod

    class NeverReadyBridge:
        def __init__(self) -> None:
            self.navs = 0

        async def __call__(self, tid, method, params=None):
            if method == "Page.navigate":
                self.navs += 1
                return {"frameId": "fake"}
            raise RuntimeError("embedded webview not ready for Runtime.evaluate")

    async def fast_settle(session, tid, timeout_ms):
        # Exercise real settle with a short deadline.
        return await engine_mod.BrowserEngine._settle(engine, session, tid, 250)

    bridge = NeverReadyBridge()
    monkeypatch.setattr(engine_mod, "_dispatch_run", bridge)
    monkeypatch.setattr(engine, "_settle", fast_settle)
    result = _execute(engine, {"method": "navigate", "url": "https://www.baidu.com"})
    # Soft-decouple: navigate committed → soft-ok even if settle cannot probe.
    assert result["ok"] is True, result
    assert bridge.navs == 1, f"not-ready must not blank-retry, got navs={bridge.navs}"
    assert "baidu.com" in result["state"]["url"]


def test_back_surfaces_timeout_when_readyState_never_completes(monkeypatch, engine):
    """back navigation stuck → explicit TIMEOUT (regression for the same silent-ok bug)."""
    import evoflow.tools.builtins.browser_engine as engine_mod

    class StuckHistoryBridge:
        def __init__(self):
            self.calls: list[tuple[str, dict]] = []
            self.history_index = 1
            self.history_entries = [
                {"id": "1", "url": "about:blank"},
                {"id": "2", "url": "https://example.com/"},
            ]

        async def __call__(self, tid, method, params=None):
            self.calls.append((method, params or {}))
            if method == "Page.getNavigationHistory":
                return {"index": self.history_index, "entries": self.history_entries}
            if method == "Page.navigateToHistoryEntry":
                return {"frameId": "fake"}
            if method == "Runtime.evaluate":
                expr = str((params or {}).get("expression") or "")
                if "document.readyState" in expr:
                    return {"result": {"value": "loading"}}
                if "location.href" in expr:
                    return {"result": {"value": {
                        "url": "https://example.com/", "title": "", "hl": 2,
                        "sx": 0, "sy": 0, "vw": 1280, "vh": 720,
                    }}}
            return {}

    stuck = StuckHistoryBridge()
    monkeypatch.setattr(engine_mod, "_dispatch_run", stuck)
    orig_wait = engine._wait_document_ready

    async def fast_wait(tid, timeout_ms=5000):
        return await orig_wait(tid, timeout_ms=200)

    monkeypatch.setattr(engine, "_wait_document_ready", fast_wait)

    result = _execute(engine, {"method": "back"})
    assert result["ok"] is False
    assert result["error"]["code"] == "timeout"
    assert "back" in result["error"]["message"]


def test_wait_document_ready_returns_bool_not_none():
    """API contract: _wait_document_ready must return bool (False on timeout), not None."""
    import asyncio
    import evoflow.tools.builtins.browser_engine as engine_mod
    from evoflow.tools.builtins.browser_engine import BrowserEngine

    class AlwaysLoadingBridge:
        async def __call__(self, tid, method, params=None):
            if method == "Runtime.evaluate":
                return {"result": {"value": "loading"}}
            return {}

    eng = BrowserEngine()
    orig = engine_mod._dispatch_run
    engine_mod._dispatch_run = AlwaysLoadingBridge()
    try:
        result = asyncio.run(eng._wait_document_ready("any", timeout_ms=100))
    finally:
        engine_mod._dispatch_run = orig
    assert result is False, f"expected False, got {result!r}"


def test_wait_document_ready_returns_true_when_complete():
    """API contract: True when readyState reaches 'complete' or 'interactive'."""
    import asyncio
    import evoflow.tools.builtins.browser_engine as engine_mod
    from evoflow.tools.builtins.browser_engine import BrowserEngine

    class ImmediateCompleteBridge:
        async def __call__(self, tid, method, params=None):
            return {"result": {"value": "complete"}}

    eng = BrowserEngine()
    orig = engine_mod._dispatch_run
    engine_mod._dispatch_run = ImmediateCompleteBridge()
    try:
        result = asyncio.run(eng._wait_document_ready("any", timeout_ms=2000))
    finally:
        engine_mod._dispatch_run = orig
    assert result is True, f"expected True, got {result!r}"


# ---------------------------------------------------------------------------
# Engine: screenshot passes fullPage through to CDP
# ---------------------------------------------------------------------------


def test_screenshot_fullpage_sets_capture_beyond_viewport(bridge, monkeypatch, engine):
    async def fake_dispatch(tid, method, params=None):
        bridge._record(method, params or {})
        if method == "Page.captureScreenshot":
            return {"data": "aGVsbG8="}
        if method == "Runtime.evaluate":
            expr = str((params or {}).get("expression") or "")
            if "location.href" in expr:
                return {"result": {"value": bridge._state_payload()}}
            if "document.readyState" in expr:
                return {"result": {"value": "complete"}}
        return {}

    import evoflow.tools.builtins.browser_engine as engine_mod

    monkeypatch.setattr(engine_mod, "_dispatch_run", fake_dispatch)
    result = _execute(engine, {"method": "screenshot", "fullPage": True})
    assert result["ok"], result
    shot = [c for c in bridge.calls if c[0] == "Page.captureScreenshot"]
    assert shot and shot[0][1].get("captureBeyondViewport") is True
    assert result["image"]["mimeType"] == "image/png"


# ---------------------------------------------------------------------------
# E2E: real desktop bridge (opt-in — requires the EvoFlow desktop app running)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not __import__("os").getenv("EVOFLOW_DESKTOP_E2E"),
    reason="Requires the EvoFlow desktop app (set EVOFLOW_DESKTOP_E2E=1)",
)
def test_engine_end_to_end_navigate_snapshot_click():
    from evoflow.tools.builtins.browser_engine import get_browser_engine

    engine = get_browser_engine()
    tid = "pytest-engine-e2e"
    page = (
        "data:text/html,<h1>Hello EvoFlow</h1>"
        '<button id="btn" onclick="document.getElementById(\'out\').textContent=\'clicked\'">Click me</button>'
        '<input id="in" placeholder="type here"/>'
        '<div id="out"></div>'
    )
    try:
        nav = engine.execute(tid, {"method": "navigate", "url": page}, timeout=30)
        assert nav["ok"], nav

        snap = engine.execute(tid, {"method": "snapshot"}, timeout=30)
        assert snap["ok"], snap
        elements = snap["snapshot"]["elements"]
        btn = next((el for el in elements if "btn" in el["selector"]), None)
        assert btn is not None, elements

        click = engine.execute(tid, {"method": "click", "ref": btn["ref"]}, timeout=30)
        assert click["ok"], click

        value = engine.execute(
            tid,
            {"method": "evaluate", "expression": "document.getElementById('out').textContent"},
            timeout=30,
        )
        assert value["ok"] and value["value"] == "clicked", value

        shot = engine.execute(tid, {"method": "screenshot"}, timeout=30)
        assert shot["ok"] and shot["image"]["base64"], shot

        fill = engine.execute(tid, {"method": "fill", "ref": btn["ref"], "value": "x"}, timeout=30)
        assert fill["ok"], fill
    finally:
        engine.close_session(tid)
