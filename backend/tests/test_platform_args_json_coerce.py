"""platform args_json: accept object payloads from the model."""

from evoflow.tools.builtins.platform_tool import _coerce_args_json


def test_coerce_args_json_dict() -> None:
    out = _coerce_args_json({"action": "activate", "scenario_key": "agent"})
    assert '"action": "activate"' in out or '"action":"activate"' in out.replace(" ", "")
    assert "agent" in out


def test_coerce_args_json_passthrough_str() -> None:
    assert _coerce_args_json('{"a":1}') == '{"a":1}'
    assert _coerce_args_json(None) == ""
    assert _coerce_args_json("") == ""
