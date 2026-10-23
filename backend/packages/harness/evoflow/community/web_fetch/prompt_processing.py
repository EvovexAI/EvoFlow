"""Prompt-driven content processing for web fetch (zcode WebFetch alignment).

zcode's WebFetch answers ``prompt`` against the fetched markdown using a small
fast model instead of stuffing the whole page back into the main conversation.
This module provides the same processing step for EvoFlow tools:

- fetch a page → markdown (caller's job)
- ``process_fetched_content_with_prompt(content, prompt, model_name)`` → the
  small model's answer, or ``None`` when the model call fails (caller falls
  back to returning raw markdown).
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Cap of page content fed to the auxiliary model (chars). zcode truncates with
# MAX_MODEL_INPUT_CHARS for the same reason: keep the nested call cheap and
# avoid auxiliary-context pollution.
MAX_MODEL_INPUT_CHARS = 24_000

# Max chars for the auxiliary model's answer.
MAX_ANSWER_CHARS = 8_000

_MODEL_TEMPERATURE = 0.1
_MODEL_TIMEOUT_S = 60
_MODEL_MAX_TOKENS = 2_000


def _suppress_stream_callbacks_for_nested_llm():
    """Prevent nested ``model.invoke`` from leaking tokens into the parent stream.

    Copied from ``title_middleware`` (langchain-core #34382): a nested model call
    inside an agent/tool runnable inherits the parent streaming callbacks and its
    tokens appear as extra assistant output. Clearing callbacks on a child
    RunnableConfig isolates the nested call.
    """
    from contextlib import contextmanager

    @contextmanager
    def _ctx():
        try:
            from langchain_core.runnables.config import ensure_config, var_child_runnable_config
        except ImportError:
            yield
            return

        raw = ensure_config()
        try:
            cfg = dict(raw) if raw is not None else {}
        except Exception:
            cfg = {}
        cfg["callbacks"] = []
        token = var_child_runnable_config.set(cfg)
        try:
            yield
        finally:
            var_child_runnable_config.reset(token)

    return _ctx()


def build_processing_prompt(content: str, prompt: str) -> str:
    """Build the auxiliary-model prompt (mirrors zcode ``buildProcessingPrompt``)."""
    return (
        "以下是抓取到的网页内容（Markdown）：\n\n"
        "```\n"
        f"{content}\n"
        "```\n\n"
        "请仅根据上述网页内容回答下面的问题。要求：\n"
        "- 直接给出答案，不要复述无关内容；\n"
        "- 引用具体事实时保留关键数字、日期与来源表述；\n"
        "- 如果网页内容不足以回答问题，明确说明「网页内容中没有找到相关信息」，"
        "不要编造。\n\n"
        f"问题：{prompt}"
    )


def process_fetched_content_with_prompt(
    content: str,
    prompt: str,
    *,
    model_name: str | None = None,
) -> str | None:
    """Answer ``prompt`` against fetched ``content`` using a small model.

    Args:
        content: Fetched page content (markdown/plain text).
        prompt: The user question to answer from the content.
        model_name: Session model name (resolved by caller from runtime when
            available; ``None`` uses the platform default chat model).

    Returns:
        The model's answer (truncated to ``MAX_ANSWER_CHARS``), or ``None`` when
        the model call fails — the caller should fall back to raw content.
    """
    if not prompt or not prompt.strip():
        return None
    if not content or not content.strip():
        return None

    trimmed = content.strip()
    truncated = False
    if len(trimmed) > MAX_MODEL_INPUT_CHARS:
        trimmed = trimmed[:MAX_MODEL_INPUT_CHARS]
        truncated = True

    aux_prompt = build_processing_prompt(trimmed, prompt.strip())
    if truncated:
        aux_prompt += "\n\n（注意：网页内容已因长度被截断，仅基于可见部分回答。）"

    try:
        from evoflow.models import create_chat_model

        model = create_chat_model(
            name=(model_name or None),
            thinking_enabled=False,
            invocation_kind="webfetch",
            timeout=_MODEL_TIMEOUT_S,
            max_tokens=_MODEL_MAX_TOKENS,
            temperature=_MODEL_TEMPERATURE,
        )
        with _suppress_stream_callbacks_for_nested_llm():
            response = model.invoke(aux_prompt)
        answer = response.content if hasattr(response, "content") else str(response)
        if isinstance(answer, list):
            parts: list[str] = []
            for block in answer:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict):
                    parts.append(str(block.get("text") or ""))
            answer = "".join(parts)
        answer = str(answer).strip()
        if not answer:
            return None
        if len(answer) > MAX_ANSWER_CHARS:
            answer = answer[:MAX_ANSWER_CHARS] + "\n\n(answer truncated)"
        return answer
    except Exception as e:
        logger.warning("webfetch prompt processing failed, falling back to raw content: %s", e)
        return None
