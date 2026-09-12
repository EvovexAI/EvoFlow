"""Prompt templates for memory update and injection."""

import math
import re
from typing import Any

try:
    import tiktoken

    TIKTOKEN_AVAILABLE = True
except ImportError:
    TIKTOKEN_AVAILABLE = False

# Prompt template for updating memory based on conversation
MEMORY_UPDATE_PROMPT = """You are a memory management system. Your task is to analyze a conversation and update the user's memory profile.

IMPORTANT: The conversation is in Chinese. You MUST generate all memory content in Chinese.
当前记忆状态和对话都是中文，你必须用中文生成所有记忆内容。

Current Memory State:
<current_memory>
{current_memory}
</current_memory>

New Conversation to Process:
<conversation>
{conversation}
</conversation>

Instructions:
1. Analyze the conversation for important information about the user
2. Extract relevant facts, preferences, and context with specific details (numbers, names, technologies)
3. Update the memory sections as needed following the detailed length guidelines below
4. IMPORTANT: All memory content MUST be in Chinese (中文)

Memory Section Guidelines:

**User Context** (Current state - concise summaries):
- workContext: Professional role, company, key projects, main technologies (2-3 sentences)
  Example: Core contributor, project names with metrics (16k+ stars), technical stack
  示例：核心贡献者，项目名称和指标（16k+ stars），技术栈
- personalContext: Languages, communication preferences, key interests (1-2 sentences)
  Example: Bilingual capabilities, specific interest areas, expertise domains
  示例：双语能力，特定兴趣领域，专业领域
- topOfMind: **Short only** (2–4 sentences): immediate priorities this week. Do NOT dump long smoke-test logs,
  task-by-task narratives, or multi-paragraph status reports here — those belong in **history.recentMonths** or facts.
  仅写短期优先级摘要；长篇过程性叙述、测试流水、任务复盘请写入 history / facts，避免把 topOfMind 变成垃圾堆。

**History** (Temporal context - rich paragraphs):
- recentMonths: Detailed summary of recent activities (4-6 sentences or 1-2 paragraphs)
  Timeline: Last 1-3 months of interactions
  Include: Technologies explored, projects worked on, problems solved, interests demonstrated
- earlierContext: Important historical patterns (3-5 sentences or 1 paragraph)
  Timeline: 3-12 months ago
  Include: Past projects, learning journeys, established patterns
- longTermBackground: Persistent background and foundational context (2-4 sentences)
  Timeline: Overall/foundational information
  Include: Core expertise, longstanding interests, fundamental working style

**Facts Extraction**:
- Extract specific, quantifiable details (e.g., "16k+ GitHub stars", "200+ datasets")
- Include proper nouns (company names, project names, technology names)
- Preserve technical terminology and version numbers
- Categories:
  * preference: Tools, styles, approaches user prefers/dislikes
    偏好：用户喜欢/不喜欢的工具、风格、方法
  * knowledge: Specific expertise, technologies, domain knowledge
    知识：具体专业技能、技术、领域知识
  * context: Background facts (job title, projects, locations, languages)
    背景：背景事实（职位、项目、地点、语言）
  * behavior: Working patterns, communication habits, problem-solving approaches
    行为：工作模式、沟通习惯、解决问题的方法
  * goal: Stated objectives, learning targets, project ambitions
    目标：声明的目标、学习目标、项目抱负
- Confidence levels:
  * 0.9-1.0: Explicitly stated facts ("I work on X", "My role is Y")
    明确声明的事实（"我在做 X"，"我的角色是 Y"）
  * 0.7-0.8: Strongly implied from actions/discussions
    从行为/讨论中强烈暗示
  * 0.5-0.6: Inferred patterns (use sparingly, only for clear patterns)
    推断的模式（谨慎使用，仅用于清晰模式）

**What Goes Where**:
- workContext: Current job, active projects, primary tech stack
  当前工作、活跃项目、主要技术栈
- personalContext: Languages, personality, interests outside direct work tasks
  语言、性格、直接工作任务之外的兴趣
- topOfMind: Short rolling priorities only (2–4 sentences). Long narratives → history.recentMonths.
  仅短期优先级摘要；长叙事写入 history，勿堆在 topOfMind。
- recentMonths: Detailed account of recent technical explorations and work
  最近技术探索和工作的详细记录
- earlierContext: Patterns from slightly older interactions still relevant
  较早但仍相关的互动模式
- longTermBackground: Unchanging foundational facts about the user
  关于用户的不变基础事实

**Multilingual Content**:
- Preserve original language for proper nouns and company names
  保留专有名词和公司名称的原始语言
- Keep technical terms in their original form (DeepSeek, LangGraph, etc.)
  保持技术术语的原始形式（DeepSeek、LangGraph 等）
- Note language capabilities in personalContext
  在 personalContext 中注明语言能力

Output Format (JSON):
{{
  "user": {{
    "workContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "personalContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "topOfMind": {{ "summary": "...", "shouldUpdate": true/false }}
  }},
  "history": {{
    "recentMonths": {{ "summary": "...", "shouldUpdate": true/false }},
    "earlierContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "longTermBackground": {{ "summary": "...", "shouldUpdate": true/false }}
  }},
  "newFacts": [
    {{ "content": "...", "category": "preference|knowledge|context|behavior|goal", "confidence": 0.0-1.0 }}
  ],
  "factsToRemove": ["fact_id_1", "fact_id_2"]
}}

Important Rules:
- Only set shouldUpdate=true if there's meaningful new information
- Follow length guidelines: workContext/personalContext are concise (1-3 sentences), topOfMind and history sections are detailed (paragraphs)
- Include specific metrics, version numbers, and proper nouns in facts
- Only add facts that are clearly stated (0.9+) or strongly implied (0.7+)
- Remove facts that are contradicted by new information
- When updating topOfMind, integrate new focus areas while removing completed/abandoned ones
  Keep 3-5 concurrent focus themes that are still active and relevant
- For history sections, integrate new information chronologically into appropriate time period
- Preserve technical accuracy - keep exact names of technologies, companies, projects
- Focus on information useful for future interactions and personalization
- IMPORTANT: Do NOT record file upload events in memory. Uploaded files are
  session-specific and ephemeral — they will not be accessible in future sessions.
  Recording upload events causes confusion in subsequent conversations.
- CRITICAL: ALL memory content MUST be in Chinese (中文). Only keep proper nouns
  and technical terms in their original form (e.g., DeepSeek, LangGraph, GitHub).
  关键要求：所有记忆内容必须使用中文。只保留专有名词和技术术语的原始形式。

Return ONLY valid JSON, no explanation or markdown."""


# Prompt template for extracting facts from a single message
FACT_EXTRACTION_PROMPT = """Extract factual information about the user from this message.

Message:
{message}

Extract facts in this JSON format:
{{
  "facts": [
    {{ "content": "...", "category": "preference|knowledge|context|behavior|goal", "confidence": 0.0-1.0 }}
  ]
}}

Categories:
- preference: User preferences (likes/dislikes, styles, tools)
- knowledge: User's expertise or knowledge areas
- context: Background context (location, job, projects)
- behavior: Behavioral patterns
- goal: User's goals or objectives

Rules:
- Only extract clear, specific facts
- Confidence should reflect certainty (explicit statement = 0.9+, implied = 0.6-0.8)
- Skip vague or temporary information

Return ONLY valid JSON."""


def _count_tokens(text: str, encoding_name: str = "cl100k_base") -> int:
    """Count tokens in text using tiktoken.

    Args:
        text: The text to count tokens for.
        encoding_name: The encoding to use (default: cl100k_base for GPT-4/3.5).

    Returns:
        The number of tokens in the text.
    """
    if not TIKTOKEN_AVAILABLE:
        # Fallback to character-based estimation if tiktoken is not available
        return len(text) // 4

    try:
        encoding = tiktoken.get_encoding(encoding_name)
        return len(encoding.encode(text))
    except Exception:
        # Fallback to character-based estimation on error
        return len(text) // 4


def _coerce_confidence(value: Any, default: float = 0.0) -> float:
    """Coerce a confidence-like value to a bounded float in [0, 1].

    Non-finite values (NaN, inf, -inf) are treated as invalid and fall back
    to the default before clamping, preventing them from dominating ranking.
    The ``default`` parameter is assumed to be a finite value.
    """
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return max(0.0, min(1.0, default))
    if not math.isfinite(confidence):
        return max(0.0, min(1.0, default))
    return max(0.0, min(1.0, confidence))


def _truncate_summary(text: str, max_chars: int) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    if len(t) <= max_chars:
        return t
    return t[: max_chars - 1].rstrip() + "…"


def _standing_fact_allowed(fact: dict[str, Any], *, chat_compact: bool) -> bool:
    """Standing injection: preferences/habits only — not migrated encyclopedia."""
    cat = str(fact.get("category") or fact.get("kind") or "context").strip().lower() or "context"
    src = str(fact.get("source") or "").strip().lower()
    content = str(fact.get("content") or "").strip()
    if not content:
        return False
    if cat.startswith("section:"):
        return False
    if cat in {"knowledge", "module", "api", "config", "flow", "dependency", "file"}:
        return False
    if cat == "goal" and src in {"migrate", "bootstrap", "bootstrap-scan"}:
        return False
    if src in {"goal_complete", "task_complete"}:
        return False
    if "已完成" in content and ("Goal「" in content or "任务「" in content):
        return False
    if cat in {"preference", "behavior"}:
        return True
    if cat == "context":
        conf = _coerce_confidence(fact.get("confidence"), default=0.0)
        if len(content) <= 160 and conf >= 0.8:
            return True
        return False
    if chat_compact:
        return False
    # full profile: still block knowledge; allow other short high-conf facts
    return cat not in {"knowledge"} and len(content) <= 200 and _coerce_confidence(fact.get("confidence"), default=0.0) >= 0.85


def format_memory_for_injection(
    memory_data: dict[str, Any],
    max_tokens: int = 2000,
    *,
    injection_profile: str = "full",
) -> str:
    """Format memory data for injection into system prompt.

    Args:
        memory_data: The memory data dictionary.
        max_tokens: Maximum tokens to use (counted via tiktoken for accuracy).
        injection_profile: ``full`` = all sections (user topOfMind + history + facts).
            ``chat_compact`` = stable user summaries only (work + personal, truncated),
            no topOfMind/history (avoid narrative junk on casual turns), facts above a confidence floor.

    Returns:
        Formatted memory string for system prompt injection.
    """
    if not memory_data:
        return ""

    chat_compact = injection_profile == "chat_compact"
    user_summary_cap = 360 if chat_compact else None
    chat_min_fact_confidence = 0.72 if chat_compact else 0.0
    chat_max_fact_lines = 5 if chat_compact else 10

    sections = []

    # Format user context
    user_data = memory_data.get("user", {})
    if user_data:
        user_sections = []

        work_ctx = user_data.get("workContext", {})
        if work_ctx.get("summary"):
            ws = work_ctx["summary"]
            if user_summary_cap is not None:
                ws = _truncate_summary(str(ws), user_summary_cap)
            if ws:
                # Demote role/job narratives — preferences only, not standing duty orders.
                user_sections.append(f"Work (参考偏好，非站立任务): {ws}")

        personal_ctx = user_data.get("personalContext", {})
        if personal_ctx.get("summary"):
            ps = personal_ctx["summary"]
            if user_summary_cap is not None:
                ps = _truncate_summary(str(ps), user_summary_cap)
            if ps:
                user_sections.append(f"Personal: {ps}")

        if not chat_compact:
            top_of_mind = user_data.get("topOfMind", {})
            if top_of_mind.get("summary"):
                user_sections.append(f"Current Focus: {top_of_mind['summary']}")

        if user_sections:
            header = "User Context (稳定偏好):\n" if chat_compact else "User Context:\n"
            sections.append(header + "\n".join(f"- {s}" for s in user_sections))

    # Format history (omit for chat_compact — often stale narrative; full scenarios load it again)
    history_data = memory_data.get("history", {})
    if not chat_compact and history_data:
        history_sections = []

        recent = history_data.get("recentMonths", {})
        if recent.get("summary"):
            history_sections.append(f"Recent: {recent['summary']}")

        earlier = history_data.get("earlierContext", {})
        if earlier.get("summary"):
            history_sections.append(f"Earlier: {earlier['summary']}")

        if history_sections:
            sections.append("History:\n" + "\n".join(f"- {s}" for s in history_sections))

    # Format facts (standing: preference/behavior/short context only)
    facts_data = memory_data.get("facts", [])
    if isinstance(facts_data, list) and facts_data:
        ranked_facts = sorted(
            (
                f
                for f in facts_data
                if isinstance(f, dict)
                and isinstance(f.get("content"), str)
                and f.get("content").strip()
                and _standing_fact_allowed(f, chat_compact=chat_compact)
            ),
            key=lambda fact: _coerce_confidence(fact.get("confidence"), default=0.0),
            reverse=True,
        )
        if chat_compact:
            ranked_facts = [f for f in ranked_facts if _coerce_confidence(f.get("confidence"), default=0.0) >= chat_min_fact_confidence]

        base_text = "\n\n".join(sections)
        base_tokens = _count_tokens(base_text) if base_text else 0
        facts_header = "Facts (偏好/习惯):\n" if chat_compact else "Facts (偏好/习惯):\n"
        separator_tokens = _count_tokens("\n\n" + facts_header) if base_text else _count_tokens(facts_header)
        running_tokens = base_tokens + separator_tokens

        fact_lines: list[str] = []
        for fact in ranked_facts:
            if len(fact_lines) >= chat_max_fact_lines:
                break
            content_value = fact.get("content")
            if not isinstance(content_value, str):
                continue
            content = content_value.strip()
            if not content:
                continue
            category = str(fact.get("category", "context")).strip() or "context"
            confidence = _coerce_confidence(fact.get("confidence"), default=0.0)
            line = f"- [{category} | {confidence:.2f}] {content}"

            line_text = ("\n" + line) if fact_lines else line
            line_tokens = _count_tokens(line_text)

            if running_tokens + line_tokens <= max_tokens:
                fact_lines.append(line)
                running_tokens += line_tokens
            else:
                break

        if fact_lines:
            sections.append(facts_header + "\n".join(fact_lines))

    if not sections:
        return ""

    result = "\n\n".join(sections)

    # Use accurate token counting with tiktoken
    token_count = _count_tokens(result)
    if token_count > max_tokens:
        # Truncate to fit within token limit
        # Estimate characters to remove based on token ratio
        char_per_token = len(result) / token_count
        target_chars = int(max_tokens * char_per_token * 0.95)  # 95% to leave margin
        result = result[:target_chars] + "\n..."

    return result


def format_conversation_for_update(messages: list[Any]) -> str:
    """Format conversation messages for memory update prompt.

    Args:
        messages: List of conversation messages.

    Returns:
        Formatted conversation string.
    """
    lines = []
    for msg in messages:
        role = getattr(msg, "type", "unknown")
        content = getattr(msg, "content", str(msg))

        # Handle content that might be a list (multimodal)
        if isinstance(content, list):
            text_parts = []
            for p in content:
                if isinstance(p, str):
                    text_parts.append(p)
                elif isinstance(p, dict):
                    text_val = p.get("text")
                    if isinstance(text_val, str):
                        text_parts.append(text_val)
            content = " ".join(text_parts) if text_parts else str(content)

        # Strip uploaded_files tags from human messages to avoid persisting
        # ephemeral file path info into long-term memory.  Skip the turn entirely
        # when nothing remains after stripping (upload-only message).
        if role == "human":
            content = re.sub(r"<uploaded_files>[\s\S]*?</uploaded_files>\n*", "", str(content)).strip()
            if not content:
                continue

        # Truncate very long messages
        if len(str(content)) > 1000:
            content = str(content)[:1000] + "..."

        if role == "human":
            lines.append(f"User: {content}")
        elif role == "ai":
            lines.append(f"Assistant: {content}")

    return "\n\n".join(lines)
