"""Official-ish CNY pricing for prompt-cache savings (Aliyun Bailian + Volcengine Ark)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

Platform = Literal["aliyun", "volcengine"]

# Aliyun Bailian implicit cache: cached input billed at 20% of standard input.
# https://help.aliyun.com/zh/model-studio/context-cache
ALIYUN_IMPLICIT_CACHE_READ_FRACTION = 0.20


@dataclass(frozen=True)
class CachePriceRule:
    pattern: re.Pattern[str]
    input_cny_per_mtok: float
    cache_read_cny_per_mtok: float | None = None
    cache_read_fraction: float | None = None
    label: str = ""


def _rule(pat: str, inp: float, cache: float | None, *, frac: float | None = None, label: str = "") -> CachePriceRule:
    return CachePriceRule(
        pattern=re.compile(pat, re.I),
        input_cny_per_mtok=inp,
        cache_read_cny_per_mtok=cache,
        cache_read_fraction=frac,
        label=label,
    )


# Volcengine Ark — explicit cache-hit prices where published.
# Doubao 2.1 Pro: 输入 6元 / 缓存命中 1.2元 (FORCE 2026)
# DeepSeek on Ark: V3 输入2/命中0.5, R1 输入4/命中1, V4-flash 输入1/命中0.02
VOLCENGINE_RULES: tuple[CachePriceRule, ...] = (
    _rule(r"doubao-seed-2[.\-_]?1[\-_.]pro|doubao.*2\.1.*pro", 6.0, 1.2, label="豆包2.1 Pro"),
    _rule(r"doubao-seed-2[.\-_]?1[\-_.]turbo|doubao.*2\.1.*turbo", 3.0, 0.6, label="豆包2.1 Turbo"),
    _rule(r"doubao-seed-2\.0-pro", 3.2, 0.64, label="豆包2.0 Pro"),  # 官网未单列缓存价，按输入20%估算
    _rule(r"doubao-seed-2\.0-lite", 0.6, 0.12, label="豆包2.0 Lite"),
    _rule(r"doubao-seed-1\.8|doubao-seed-1\.6", 0.8, 0.16, label="豆包1.8/1.6"),
    _rule(r"deepseek-v4-flash", 1.0, 0.02, label="DeepSeek V4 Flash"),
    _rule(r"deepseek-v4-pro", 12.0, 2.4, label="DeepSeek V4 Pro"),  # 缓存价未公开，按输入20%
    _rule(r"deepseek-r1", 4.0, 1.0, label="DeepSeek R1"),
    _rule(r"deepseek-v3\.2", 2.0, 0.5, label="DeepSeek V3.2"),
    _rule(r"deepseek-v3", 2.0, 0.5, label="DeepSeek V3"),
    _rule(r"glm-4\.7", 3.0, 0.6, label="GLM-4.7"),
    _rule(r"glm-4", 3.0, 0.6, label="GLM-4"),
    _rule(r"glm", 3.0, 0.6, label="GLM"),
    _rule(r"doubao", 6.0, 1.2, label="豆包"),
    _rule(r"deepseek", 2.0, 0.5, label="DeepSeek"),
)

# Aliyun Bailian — input list prices + implicit cache 20%.
# https://help.aliyun.com/zh/model-studio/model-pricing
ALIYUN_RULES: tuple[CachePriceRule, ...] = (
    _rule(r"qwen3\.7-max", 12.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="通义3.7 Max"),
    _rule(r"qwen3-max", 2.5, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="通义3 Max"),
    _rule(r"qwen3\.7-plus|qwen-plus", 2.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="通义 Plus"),
    _rule(r"qwen3\.6-flash|qwen3\.5-flash|qwen-flash", 0.2, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="通义 Flash"),
    _rule(r"qwen", 2.5, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="通义"),
    _rule(r"deepseek-v4-flash", 1.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="DeepSeek V4 Flash"),
    _rule(r"deepseek-v4-pro", 12.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="DeepSeek V4 Pro"),
    _rule(r"deepseek-v3\.2|deepseek-v3\.2-exp", 2.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="DeepSeek V3.2"),
    _rule(r"deepseek-r1", 4.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="DeepSeek R1"),
    _rule(r"deepseek-v3", 2.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="DeepSeek V3"),
    _rule(r"deepseek", 2.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="DeepSeek"),
    _rule(r"glm-5", 8.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="GLM-5"),
    _rule(r"glm-4\.7", 3.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="GLM-4.7"),
    _rule(r"glm", 3.0, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="GLM"),
)


def detect_platform(provider: str | None, model: str | None) -> Platform:
    p = str(provider or "").strip().lower()
    m = str(model or "").strip().lower()
    volc_hints = ("volcengine", "volces", "doubao", "火山", "ark", "byte")
    ali_hints = ("aliyun", "dashscope", "百炼", "bailian", "qwen")
    if any(h in p for h in volc_hints):
        return "volcengine"
    if any(h in p for h in ali_hints):
        return "aliyun"
    if m.startswith("doubao") or m.startswith("ep-"):
        return "volcengine"
    if m.startswith("qwen"):
        return "aliyun"
    if "deepseek" in m or m.startswith("glm"):
        # User stack: deepseek/glm on volcano unless provider says aliyun
        if any(h in p for h in ali_hints):
            return "aliyun"
        return "volcengine"
    return "aliyun"


def resolve_cache_price(provider: str | None, model: str | None) -> CachePriceRule:
    platform = detect_platform(provider, model)
    m = str(model or "").strip()
    rules = VOLCENGINE_RULES if platform == "volcengine" else ALIYUN_RULES
    for rule in rules:
        if rule.pattern.search(m):
            return rule
    if platform == "volcengine":
        return _rule(r".*", 2.0, 0.5, label="火山方舟默认")
    return _rule(r".*", 2.5, None, frac=ALIYUN_IMPLICIT_CACHE_READ_FRACTION, label="百炼默认")


def savings_cny_per_mtok(rule: CachePriceRule) -> float:
    inp = float(rule.input_cny_per_mtok)
    if rule.cache_read_cny_per_mtok is not None:
        return max(0.0, inp - float(rule.cache_read_cny_per_mtok))
    frac = rule.cache_read_fraction if rule.cache_read_fraction is not None else ALIYUN_IMPLICIT_CACHE_READ_FRACTION
    return max(0.0, inp * (1.0 - frac))


def estimate_row_cache_savings_cny(cache_read_tokens: int, *, provider: str | None, model: str | None) -> float:
    read = max(0, int(cache_read_tokens or 0))
    if read <= 0:
        return 0.0
    rule = resolve_cache_price(provider, model)
    per_mtok = savings_cny_per_mtok(rule)
    return round((read / 1_000_000) * per_mtok, 6)


# Output tokens are often billed higher than input; use 2× input list price as a conservative default.
_OUTPUT_TOKEN_MULTIPLIER = 2.0


def _cache_read_rate_cny(rule: CachePriceRule) -> float:
    if rule.cache_read_cny_per_mtok is not None:
        return float(rule.cache_read_cny_per_mtok)
    frac = rule.cache_read_fraction if rule.cache_read_fraction is not None else ALIYUN_IMPLICIT_CACHE_READ_FRACTION
    return float(rule.input_cny_per_mtok) * float(frac)


def estimate_row_request_cost_cny(
    prompt_tokens: int,
    completion_tokens: int,
    *,
    cache_read_tokens: int = 0,
    cache_miss_tokens: int = 0,
    cache_creation_tokens: int = 0,
    provider: str | None = None,
    model: str | None = None,
) -> float:
    """Estimate per-request API cost (CNY) from token usage and published list prices."""
    prompt = max(0, int(prompt_tokens or 0))
    completion = max(0, int(completion_tokens or 0))
    if prompt <= 0 and completion <= 0:
        return 0.0

    rule = resolve_cache_price(provider, model)
    inp_rate = float(rule.input_cny_per_mtok)
    cache_rate = _cache_read_rate_cny(rule)

    read = max(0, int(cache_read_tokens or 0))
    miss = max(0, int(cache_miss_tokens or 0))
    create = max(0, int(cache_creation_tokens or 0))
    if read or miss or create:
        billable_miss = miss + create
    else:
        billable_miss = max(0, prompt - read)

    input_cost = (billable_miss / 1_000_000) * inp_rate + (read / 1_000_000) * cache_rate
    output_cost = (completion / 1_000_000) * inp_rate * _OUTPUT_TOKEN_MULTIPLIER
    return round(input_cost + output_cost, 6)


def pricing_platform_label(provider: str | None, model: str | None) -> str:
    platform = detect_platform(provider, model)
    rule = resolve_cache_price(provider, model)
    vendor = "火山方舟" if platform == "volcengine" else "阿里云百炼"
    return f"{vendor} · {rule.label}"
