# -*- coding: utf-8 -*-
"""Dispatch attribution helpers (DB SSOT for who woke whom)."""

from __future__ import annotations

import sys
import types

# Local venv may have broken torch metadata that poisons transformers import.
if "transformers" not in sys.modules:
    _tf = types.ModuleType("transformers")
    _tf.GPT2TokenizerFast = object  # type: ignore[attr-defined]
    sys.modules["transformers"] = _tf

from evoflow.proactive.work_items import (
    dispatch_rationale_zh,
    dispatch_source_line,
    format_raised_by_label,
)


def test_dispatch_rationale_includes_xiaomi() -> None:
    assert dispatch_rationale_zh("xiaomi") == "小V催办派发"
    assert dispatch_rationale_zh("role") == "同事跨岗派发"
    assert dispatch_rationale_zh("employee_page") == "用户从员工页派发"


def test_dispatch_source_line_without_waker() -> None:
    assert dispatch_source_line("role") == "同事跨岗派发"
    assert dispatch_source_line("role", from_agent="") == "同事跨岗派发"
    assert dispatch_source_line("role", from_agent="user") == "同事跨岗派发"


def test_dispatch_source_line_shows_role_name_not_code() -> None:
    assert format_raised_by_label("product-manager") == "产品经理"
    line = dispatch_source_line("role", from_agent="product-manager")
    assert line == "同事跨岗派发 · 产品经理"
    assert "product-manager" not in line
    assert "叫醒" not in line
