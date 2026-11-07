"""Run records must keep the *effective* parameter values, not the raw call.

Regression for the 2026-11-07 run: F2 was started without arguments and rendered
``{{branch_a}}`` → "竞品定价" correctly, but ``run_status.parameters`` came back
``{}`` — post-hoc inspection could not tell what the workers were actually told.
"""

from __future__ import annotations

import importlib

ar = importlib.import_module("evoflow.collab.app_runner")

_APP = {
    "goal_template": "采集 {{branch_a}} 与 {{branch_b}}",
    "steps": [],
    "parameters": [
        {"name": "branch_a", "label": "并行A主题", "type": "text", "default": "竞品定价", "required": True},
        {"name": "branch_b", "label": "并行B主题", "type": "text", "default": "用户差评", "required": True},
    ],
}


def test_defaults_are_recorded_when_nothing_supplied():
    out = ar.run_parameters_payload(_APP, {})
    assert out["parameters"] == {"branch_a": "竞品定价", "branch_b": "用户差评"}
    # the raw call stays distinguishable from defaults filled in
    assert out["parameters_input"] == {}


def test_supplied_value_wins_and_other_default_still_fills():
    out = ar.run_parameters_payload(_APP, {"branch_a": "定价A"})
    assert out["parameters"]["branch_a"] == "定价A"
    assert out["parameters"]["branch_b"] == "用户差评"
    assert out["parameters_input"] == {"branch_a": "定价A"}


def test_blank_value_falls_back_to_default():
    # apply_parameter_defaults treats whitespace as "not supplied"
    out = ar.run_parameters_payload(_APP, {"branch_a": "  "})
    assert out["parameters"]["branch_a"] == "竞品定价"


def test_undeclared_parameter_passes_through():
    out = ar.run_parameters_payload({"parameters": [], "steps": []}, {"x": "1"})
    assert out["parameters"] == {"x": "1"}
    assert out["parameters_input"] == {"x": "1"}


def test_none_parameters_do_not_crash():
    out = ar.run_parameters_payload(_APP, None)
    assert out["parameters"]["branch_a"] == "竞品定价"
    assert out["parameters_input"] == {}


def test_non_string_values_are_stringified():
    out = ar.run_parameters_payload({"parameters": [], "steps": []}, {"n": 7})
    assert out["parameters"] == {"n": "7"}
