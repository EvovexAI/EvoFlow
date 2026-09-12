from app.gateway.speech.volcengine_speech import (
    TTS_URL_AGENT_PLAN,
    TTS_URL_STANDARD,
    _format_tts_business_error,
    _resolve_tts_resource_id,
    _tts_urls_to_try,
)


def test_resolve_tts_resource_id_uranus_2_0():
    assert _resolve_tts_resource_id("zh_female_vv_uranus_bigtts", "seed-tts-1.0") == "seed-tts-2.0"
    assert _resolve_tts_resource_id("zh_male_sunwukong_uranus_bigtts", "seed-tts-1.0") == "seed-tts-2.0"


def test_resolve_tts_resource_id_icl_uranus_2_0():
    assert (
        _resolve_tts_resource_id("ICL_uranus_zh_female_aojiaonvyou_tob", "seed-tts-1.0")
        == "seed-tts-2.0"
    )


def test_resolve_tts_resource_id_icl_legacy():
    assert _resolve_tts_resource_id("ICL_uranus_en_female_charlie_tob", "seed-tts-1.0") == "seed-tts-2.0"
    assert _resolve_tts_resource_id("ICL_some_old_tob", "seed-tts-2.0") == "seed-tts-1.0"


def test_resolve_tts_resource_id_clone():
    assert _resolve_tts_resource_id("S_abc123", "seed-tts-2.0") == "seed-icl-2.0"


def test_tts_urls_agent_plan_only_uses_plan_endpoint():
    # Agent Plan 文档：只走 /api/v3/plan/tts/unidirectional，不回退标准口
    assert _tts_urls_to_try(
        agent_plan=True,
        explicit_speaker=True,
        preview=True,
        resource_id="seed-tts-2.0",
    ) == [TTS_URL_AGENT_PLAN]


def test_tts_urls_standard_only_without_agent_plan():
    assert _tts_urls_to_try(
        agent_plan=False,
        explicit_speaker=True,
        preview=False,
        resource_id="seed-tts-2.0",
    ) == [TTS_URL_STANDARD]


def test_format_agent_plan_deduct_error():
    msg = _format_tts_business_error(
        45000030,
        "acquire failed err:call ark get status code:403 code:Forbidden.AgentPlanDeductNotEnabled",
    )
    assert "AgentPlanDeductNotEnabled" in msg
    assert "seed-tts-2.0" in msg
