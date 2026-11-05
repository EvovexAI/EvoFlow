"""Volc 关思考：空参/minimum 不得落回厂商默认开思考。"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
for p in (str(_BACKEND_ROOT), str(_BACKEND_ROOT / "packages" / "harness")):
    if p not in sys.path:
        sys.path.insert(0, p)

from evoflow.models.vendor_thinking_payload import apply_vendor_thinking_request_payload  # noqa: E402
from evoflow.models.volc_payload import (  # noqa: E402
    _normalize_reasoning_effort,
    normalize_volcengine_modern_chat_request,
)


VOLC_BASE = "https://ark.cn-beijing.volces.com/api/v3"


def test_normalize_aliases_minimum_to_minimal():
    assert _normalize_reasoning_effort("minimum") == "minimal"
    assert _normalize_reasoning_effort("min") == "minimal"
    assert _normalize_reasoning_effort("none") == "none"


def test_modern_request_minimum_effort_disables_thinking():
    # 旧 bug：effort=minimum 未归一 → 当成开思考 + effort
    out = normalize_volcengine_modern_chat_request(
        {"model": "doubao-x", "reasoning_effort": "minimum"},
        base_url=VOLC_BASE,
    )
    assert out["extra_body"]["thinking"] == {"type": "disabled"}
    assert "reasoning" not in out.get("extra_body", {})


def test_force_thinking_off_on_empty_payload():
    out = normalize_volcengine_modern_chat_request(
        {"model": "doubao-x"},
        base_url=VOLC_BASE,
        force_thinking_off=True,
    )
    assert out["extra_body"]["thinking"] == {"type": "disabled"}


def test_vendor_payload_respects_instance_thinking_off():
    class _M:
        _evoflow_thinking_enabled = False
        _evoflow_thinking_type = "disabled"
        _evoflow_reasoning_effort = "minimal"

    out = apply_vendor_thinking_request_payload(
        {"model": "doubao-x"},
        base_url=VOLC_BASE,
        model_instance=_M(),
    )
    assert out["extra_body"]["thinking"] == {"type": "disabled"}
