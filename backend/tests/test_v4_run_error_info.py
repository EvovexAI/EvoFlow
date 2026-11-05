"""V4 RUN_ERROR → lastError must expose copyable detail for user feedback."""

from __future__ import annotations

from app.gateway.agui_stream_normalizer import AgUiEncoderState, RUN_ERROR, evf_payload_to_agui_events
from app.gateway.v4.agui_mirror import _run_error_info


def test_run_error_info_schema_failure() -> None:
    info = _run_error_info(
        {
            "code": "PydanticInvalidForJsonSchema",
            "message": (
                "Failed to generate JSON schema for 'knowledge': "
                "Cannot generate a JsonSchema for core_schema.CallableSchema"
            ),
        },
        now_ms=1,
    )
    assert info["code"] == "PydanticInvalidForJsonSchema"
    assert "knowledge" in info["message"]
    assert "复制" in info["message"]
    assert "CallableSchema" in info["detail"]
    assert info["source"] == "runtime"


def test_agui_error_dict_extracts_message() -> None:
    state = AgUiEncoderState(thread_id="t1", run_id="r1")
    events = evf_payload_to_agui_events(
        {
            "type": "error",
            "error": {
                "error": "PydanticInvalidForJsonSchema",
                "message": "Failed to generate JSON schema for 'knowledge'",
            },
        },
        state=state,
    )
    err = next(e for e in events if e.get("type") == RUN_ERROR)
    assert err["code"] == "PydanticInvalidForJsonSchema"
    assert err["message"] == "Failed to generate JSON schema for 'knowledge'"
    assert "{" not in err["message"]
