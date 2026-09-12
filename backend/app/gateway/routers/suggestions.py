import json
import logging
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from evoflow.models import create_chat_model

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["suggestions"])


class SuggestionMessage(BaseModel):
    role: str = Field(..., description="Message role: user|assistant")
    content: str = Field(..., description="Message content as plain text")


class SuggestionsRequest(BaseModel):
    messages: list[SuggestionMessage] = Field(..., description="Recent conversation messages")
    n: int = Field(default=3, ge=1, le=5, description="Number of suggestions to generate")
    model_name: str | None = Field(default=None, description="Optional model override")


class SuggestionsResponse(BaseModel):
    suggestions: list[str] = Field(default_factory=list, description="Suggested follow-up questions")


class PromptEnhanceRequest(BaseModel):
    text: str = Field(..., description="Draft user message to refine")
    model_name: str | None = Field(default=None, description="Optional model override")
    messages: list[SuggestionMessage] | None = Field(
        default=None,
        description="Recent conversation turns; last assistant reply should inform the refinement",
    )


class PromptEnhanceResponse(BaseModel):
    text: str = Field(default="", description="Refined prompt text")


def _strip_markdown_code_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if len(lines) >= 3 and lines[0].startswith("```") and lines[-1].startswith("```"):
        return "\n".join(lines[1:-1]).strip()
    return stripped


def _parse_json_string_list(text: str) -> list[str] | None:
    candidate = _strip_markdown_code_fence(text)
    start = candidate.find("[")
    end = candidate.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return None
    candidate = candidate[start : end + 1]
    try:
        data = json.loads(candidate)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    out: list[str] = []
    for item in data:
        if not isinstance(item, str):
            continue
        s = item.strip()
        if not s:
            continue
        out.append(s)
    return out


def _extract_response_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in {"text", "output_text"}:
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts) if parts else ""
    if content is None:
        return ""
    return str(content)


def _format_conversation(messages: list[SuggestionMessage]) -> str:
    parts: list[str] = []
    for m in messages:
        role = m.role.strip().lower()
        if role in ("user", "human"):
            parts.append(f"User: {m.content.strip()}")
        elif role in ("assistant", "ai"):
            parts.append(f"Assistant: {m.content.strip()}")
        else:
            parts.append(f"{m.role}: {m.content.strip()}")
    return "\n".join(parts).strip()


@router.post(
    "/threads/{thread_id}/suggestions",
    response_model=SuggestionsResponse,
    summary="Generate Follow-up Questions",
    description="Generate short follow-up questions a user might ask next, based on recent conversation context.",
)
async def generate_suggestions(thread_id: str, request: SuggestionsRequest) -> SuggestionsResponse:
    if not request.messages:
        return SuggestionsResponse(suggestions=[])

    n = request.n
    conversation = _format_conversation(request.messages)
    if not conversation:
        return SuggestionsResponse(suggestions=[])

    prompt = (
        "You are generating follow-up questions to help the user continue the conversation.\n"
        f"Based on the conversation below, produce EXACTLY {n} short questions the user might ask next.\n"
        "Requirements:\n"
        "- Questions must be relevant to the conversation.\n"
        "- Questions must be written in the same language as the user.\n"
        "- Keep each question concise (ideally <= 20 words / <= 40 Chinese characters).\n"
        "- Do NOT include numbering, markdown, or any extra text.\n"
        "- Output MUST be a JSON array of strings only.\n\n"
        "Conversation:\n"
        f"{conversation}\n"
    )

    try:
        model = create_chat_model(name=request.model_name, thinking_enabled=False)
        response = await model.ainvoke(prompt)
        raw = _extract_response_text(response.content)
        suggestions = _parse_json_string_list(raw) or []
        cleaned = [s.replace("\n", " ").strip() for s in suggestions if s.strip()]
        cleaned = cleaned[:n]
        return SuggestionsResponse(suggestions=cleaned)
    except Exception as exc:
        logger.exception("Failed to generate suggestions: thread_id=%s err=%s", thread_id, exc)
        return SuggestionsResponse(suggestions=[])


def _clean_enhanced_text(raw: str, original: str) -> str:
    text = _strip_markdown_code_fence(raw).strip()
    text = re.sub(r"^(优化后[：:]|改进后[：:]|输出[：:])\s*", "", text, flags=re.IGNORECASE)
    text = text.strip().strip('"').strip("'")
    if not text:
        return original.strip()
    return text


def _truncate_context_text(text: str, max_len: int) -> str:
    s = (text or "").strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 1].rstrip() + "…"


def _format_conversation_for_enhance(messages: list[SuggestionMessage]) -> str:
    parts: list[str] = []
    last_idx = len(messages) - 1
    for i, m in enumerate(messages):
        role = m.role.strip().lower()
        is_last_assistant = i == last_idx and role in ("assistant", "ai")
        cap = 3200 if is_last_assistant else 1200
        body = _truncate_context_text(m.content, cap)
        if role in ("user", "human"):
            parts.append(f"User: {body}")
        elif role in ("assistant", "ai"):
            parts.append(f"Assistant: {body}")
        else:
            parts.append(f"{m.role}: {body}")
    return "\n".join(parts).strip()


@router.post(
    "/prompt/enhance",
    response_model=PromptEnhanceResponse,
    summary="Enhance user prompt",
    description="Rewrite a draft user message to be clearer and more actionable while preserving intent.",
)
async def enhance_prompt(request: PromptEnhanceRequest) -> PromptEnhanceResponse:
    draft = (request.text or "").strip()
    if not draft:
        raise HTTPException(status_code=422, detail="text is required")
    if len(draft) > 8000:
        raise HTTPException(status_code=422, detail="text is too long")

    conversation = ""
    if request.messages:
        normalized = [
            SuggestionMessage(
                role=("assistant" if m.role.strip().lower() in ("assistant", "ai") else "user"),
                content=(m.content or "").strip(),
            )
            for m in request.messages
            if (m.content or "").strip()
        ]
        if normalized:
            conversation = _format_conversation_for_enhance(normalized[-6:])

    prompt_parts = [
        "You refine user prompts for an AI assistant.",
        "Rewrite the draft below so it is clearer, more specific, and easier to act on.",
        "Rules:",
        "- Preserve the user's intent, constraints, and language (Chinese stays Chinese, English stays English).",
        "- Do not answer the request; only improve how the user writes their next message.",
        "- Do not add markdown headings, bullet labels, or meta commentary.",
        "- Output ONLY the rewritten message text.",
    ]
    if conversation:
        prompt_parts.extend(
            [
                "",
                "The user is continuing an existing chat. Use the conversation below—especially the LAST Assistant message—",
                "to turn the draft into a strong follow-up (reference prior conclusions, files, steps, or open questions when relevant).",
                "Do not copy or summarize the assistant reply into the output.",
                "",
                "Conversation:",
                conversation,
                "",
            ]
        )
    prompt_parts.append(f"Draft message to refine:\n{draft}")
    prompt = "\n".join(prompt_parts) + "\n"

    try:
        model = create_chat_model(name=request.model_name, thinking_enabled=False)
        response = await model.ainvoke(prompt)
        raw = _extract_response_text(response.content)
        enhanced = _clean_enhanced_text(raw, draft)
        return PromptEnhanceResponse(text=enhanced)
    except Exception as exc:
        logger.exception("Failed to enhance prompt: err=%s", exc)
        raise HTTPException(status_code=500, detail="prompt enhance failed") from exc
