"""ASR error classification helpers (no heavy deps)."""

from __future__ import annotations

# 鉴权失败再狂重建只会刷 401，把日志打爆且 UI 永远「聆听中」。
_AUTH_ERROR_MARKERS = (
    "AuthenticationError",
    "401",
    "Unauthorized",
    "invalid api key",
    "api key or ak/sk",
    "missing or invalid",
)


def is_asr_auth_error(msg: str) -> bool:
    text = str(msg or "").lower()
    if not text:
        return False
    return any(m.lower() in text for m in _AUTH_ERROR_MARKERS)


def asr_auth_error_user_message() -> str:
    return (
        "语音识别鉴权失败（火山 ASR 401）。请到「设置 → 模型 → 创意媒体」"
        "检查火山语音 API Key（ark- 方舟 Key 需开通 Agent Plan 语音抵扣）。"
    )
