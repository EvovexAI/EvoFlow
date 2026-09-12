"""Patched ChatOpenAI that preserves thought_signature for Gemini thinking models.

When using Gemini with thinking enabled via an OpenAI-compatible gateway (e.g.
Vertex AI, Google AI Studio, or any proxy), the API requires that the
``thought_signature`` field on tool-call objects is echoed back verbatim in
every subsequent request.

The OpenAI-compatible gateway stores the raw tool-call dicts (including
``thought_signature``) in ``additional_kwargs["tool_calls"]``, but standard
``langchain_openai.ChatOpenAI`` only serialises the standard fields (``id``,
``type``, ``function``) into the outgoing payload, silently dropping the
signature.  That causes an HTTP 400 ``INVALID_ARGUMENT`` error:

    Unable to submit request because function call `<tool>` in the N. content
    block is missing a `thought_signature`.

This module fixes the problem by overriding ``_get_request_payload`` to
re-inject tool-call signatures back into the outgoing payload for any assistant
message that originally carried them.
"""

from __future__ import annotations

from typing import Any

from langchain_core.language_models import LanguageModelInput
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langchain_openai import ChatOpenAI

from evoflow.models.request_payload_logger import log_model_request_payload
from evoflow.models.vendor_roundtrip import VendorRoundtripChatMixin
from evoflow.models.vendor_thinking_payload import apply_vendor_thinking_request_payload


def _coerce_openai_chat_completion_response(response: Any) -> Any:
    """Normalize chat-completion bodies before LangChain ``_create_chat_result``.

    Stock ``ChatOpenAI`` does ``response if dict else response.model_dump()``.
    Plain-text / HTML bodies from OpenAI-compatible gateways are ``str`` and raise
    ``AttributeError: 'str' object has no attribute 'model_dump'`` — the toast seen
    when probing models such as ``gpt-5.6-sol`` on OpenAI / third-party proxies.
    """
    if isinstance(response, dict):
        return response
    if isinstance(response, (str, bytes, bytearray)):
        text = (
            response.decode("utf-8", errors="replace")
            if isinstance(response, (bytes, bytearray))
            else response
        )
        preview = text.strip().replace("\n", " ")
        if len(preview) > 240:
            preview = preview[:240] + "…"
        raise ValueError(
            "OpenAI-compatible chat completion returned non-JSON text "
            f"({len(text)} chars): {preview!r}"
        )
    return response


class PatchedChatOpenAI(VendorRoundtripChatMixin, ChatOpenAI):
    """ChatOpenAI with ``thought_signature`` preservation for Gemini thinking via OpenAI gateway.

    When using Gemini with thinking enabled via an OpenAI-compatible gateway,
    the API expects ``thought_signature`` to be present on tool-call objects in
    multi-turn conversations.  This patched version restores those signatures
    from ``AIMessage.additional_kwargs["tool_calls"]`` into the serialised
    request payload before it is sent to the API.

    Usage in ``config.yaml``::

        - name: gemini-2.5-pro-thinking
          display_name: Gemini 2.5 Pro (Thinking)
          use: evoflow.models.patched_openai:PatchedChatOpenAI
          model: google/gemini-2.5-pro-preview
          api_key: $GEMINI_API_KEY
          base_url: https://<your-openai-compat-gateway>/v1
          max_tokens: 16384
          supports_thinking: true
          supports_vision: true
          when_thinking_enabled:
            extra_body:
              thinking:
                type: enabled
    """

    def _create_chat_result(
        self,
        response: dict | Any,
        generation_info: dict | None = None,
    ) -> ChatResult:
        return super()._create_chat_result(
            _coerce_openai_chat_completion_response(response),
            generation_info,
        )

    def _get_request_payload(
        self,
        input_: LanguageModelInput,
        *,
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> dict:
        """Get request payload with ``thought_signature`` preserved on tool-call objects.

        Overrides the parent method to re-inject ``thought_signature`` fields
        on tool-call objects that were stored in
        ``additional_kwargs["tool_calls"]`` by LangChain but dropped during
        serialisation.
        """
        # Capture the original LangChain messages *before* conversion so we can
        # access fields that the serialiser might drop.
        original_messages = self._convert_input(input_).to_messages()

        # Obtain the base payload from the parent implementation.
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)

        payload_messages = payload.get("messages", [])

        if len(payload_messages) == len(original_messages):
            for payload_msg, orig_msg in zip(payload_messages, original_messages):
                if payload_msg.get("role") == "assistant" and isinstance(orig_msg, AIMessage):
                    _restore_tool_call_signatures(payload_msg, orig_msg)
        else:
            # Fallback: match assistant-role entries positionally against AIMessages.
            ai_messages = [m for m in original_messages if isinstance(m, AIMessage)]
            assistant_payloads = [(i, m) for i, m in enumerate(payload_messages) if m.get("role") == "assistant"]
            for (_, payload_msg), ai_msg in zip(assistant_payloads, ai_messages):
                _restore_tool_call_signatures(payload_msg, ai_msg)

        _ensure_user_query_message(payload, original_messages)

        base_url = getattr(self, "openai_api_base", None) or getattr(self, "base_url", None)
        apply_vendor_thinking_request_payload(
            payload,
            base_url=str(base_url or ""),
            model_instance=self,
        )

        log_model_request_payload(
            provider="patched_openai",
            model=getattr(self, "model_name", None) or getattr(self, "model", None),
            payload=payload,
            invocation_kind=getattr(self, "_evoflow_invocation_kind", None),
            model_instance=self,
        )
        return payload

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> ChatGenerationChunk | None:
        """Preserve provider-specific reasoning fields into additional_kwargs.reasoning_content.

        DashScope (OpenAI-compatible) emits streamed thinking in `delta.reasoning_content`.
        EvoFlow frontend expects `additional_kwargs.reasoning_content`, so we map it here.
        """
        # Delegate to upstream implementation for standard parsing.
        gen = super()._convert_chunk_to_generation_chunk(chunk, default_chunk_class, base_generation_info)
        if gen is None:
            return None

        try:
            choices = chunk.get("choices") or []
            if not choices:
                return gen
            delta = choices[0].get("delta") or {}
            reasoning_delta = delta.get("reasoning_content")
            if not (isinstance(reasoning_delta, str) and reasoning_delta):
                return gen
            msg = gen.message
            if not isinstance(msg, AIMessageChunk):
                return gen
            ak = dict(msg.additional_kwargs or {})
            existing = ak.get("reasoning_content")
            if isinstance(existing, str) and existing:
                ak["reasoning_content"] = f"{existing}{reasoning_delta}"
            else:
                ak["reasoning_content"] = reasoning_delta
            gen.message = msg.model_copy(update={"additional_kwargs": ak})
            return gen
        except Exception:
            # best-effort only
            return gen


def _message_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str) and item.strip():
                parts.append(item.strip())
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        return "\n".join(parts).strip()
    return ""


def _ensure_user_query_message(payload: dict, original_messages: list) -> None:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return
    if any(isinstance(m, dict) and m.get("role") == "user" and _message_content_text(m.get("content")) for m in messages):
        return
    from evoflow.agents.message_analysis_utils import resolve_user_question_for_model_payload

    tid = sk = None
    try:
        from langgraph.config import get_config

        cfg = get_config().get("configurable") or {}
        if isinstance(cfg, dict):
            tid = str(cfg.get("thread_id") or "").strip() or None
            sk = str(cfg.get("session_key") or "").strip() or None
    except Exception:
        pass
    fallback = resolve_user_question_for_model_payload(
        original_messages,
        thread_id=tid,
        session_key=sk,
    )
    insert_at = 0
    while insert_at < len(messages) and isinstance(messages[insert_at], dict) and messages[insert_at].get("role") == "system":
        insert_at += 1
    messages.insert(insert_at, {"role": "user", "content": fallback})


def _restore_tool_call_signatures(payload_msg: dict, orig_msg: AIMessage) -> None:
    """Re-inject ``thought_signature`` onto tool-call objects in *payload_msg*.

    When the Gemini OpenAI-compatible gateway returns a response with function
    calls, each tool-call object may carry a ``thought_signature``.  LangChain
    stores the raw tool-call dicts in ``additional_kwargs["tool_calls"]`` but
    only serialises the standard fields (``id``, ``type``, ``function``) into
    the outgoing payload, silently dropping the signature.

    This function matches raw tool-call entries (by ``id``, falling back to
    positional order) and copies the signature back onto the serialised
    payload entries.
    """
    raw_tool_calls: list[dict] = orig_msg.additional_kwargs.get("tool_calls") or []
    payload_tool_calls: list[dict] = payload_msg.get("tool_calls") or []

    if not raw_tool_calls or not payload_tool_calls:
        return

    # Build an id → raw_tc lookup for efficient matching.
    raw_by_id: dict[str, dict] = {}
    for raw_tc in raw_tool_calls:
        tc_id = raw_tc.get("id")
        if tc_id:
            raw_by_id[tc_id] = raw_tc

    for idx, payload_tc in enumerate(payload_tool_calls):
        # Try matching by id first, then fall back to positional.
        raw_tc = raw_by_id.get(payload_tc.get("id", ""))
        if raw_tc is None and idx < len(raw_tool_calls):
            raw_tc = raw_tool_calls[idx]

        if raw_tc is None:
            continue

        # The gateway may use either snake_case or camelCase.
        sig = raw_tc.get("thought_signature") or raw_tc.get("thoughtSignature")
        if sig:
            payload_tc["thought_signature"] = sig
