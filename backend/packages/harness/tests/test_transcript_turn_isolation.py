"""Turn isolation when persisting / loading assistant transcript."""

from evoflow.persistence.transcript_resume_anchor import (
    strip_assistant_message_dict_for_turn_isolation,
    strip_prior_turn_pollutants_from_text,
)


def test_strip_prior_turn_pollutants_from_text_prefix_body() -> None:
    prior = "收到 👍 好的，已了解。"
    mixed = f"{prior}哈哈 😄 这是本轮。"
    out = strip_prior_turn_pollutants_from_text(mixed, body=prior, reasoning="")
    assert out == "哈哈 😄 这是本轮。"


def test_strip_prior_turn_pollutants_reasoning_then_body() -> None:
    reasoning = "The user said hi."
    body = "Hello!"
    mixed = f"{reasoning}{body}New reply"
    out = strip_prior_turn_pollutants_from_text(mixed, body=body, reasoning=reasoning)
    assert out == "New reply"


def test_strip_assistant_message_dict_content_and_reasoning() -> None:
    prior_body = "上一轮完整回复。"
    prior_reason = "上一轮思考。"
    msg = {
        "role": "assistant",
        "content": f"{prior_body}本轮正文。",
        "additional_kwargs": {"reasoning_content": f"{prior_reason}本轮思考"},
    }
    out = strip_assistant_message_dict_for_turn_isolation(
        msg,
        body=prior_body,
        reasoning=prior_reason,
    )
    assert out["content"] == "本轮正文。"
    assert out["additional_kwargs"]["reasoning_content"] == "本轮思考"
