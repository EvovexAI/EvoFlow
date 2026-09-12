"""Web search provider credentials + preferred backend (``evoflow_app_settings`` key ``web.search``)."""

from __future__ import annotations

import copy
import os
from typing import Any

from evoflow.persistence import config_repositories as cfg_repo

WEB_SEARCH_SETTINGS_KEY = "web.search"

KNOWN_BACKENDS = frozenset(
    {
        "doubao",
        "bocha",
        "tavily",
        "brave-free",
        "searxng",
        "firecrawl",
        "infoquest",
        "ddgs",
    }
)

# Quality order for test recommendation (ddgs is last-resort only).
RECOMMEND_QUALITY_ORDER: list[str] = [
    "doubao",
    "bocha",
    "tavily",
    "brave-free",
    "searxng",
    "infoquest",
    "firecrawl",
    "ddgs",
]

SECRET_FIELDS = frozenset(
    {
        "doubaoApiKey",
        "bochaApiKey",
        "tavilyApiKey",
        "braveApiKey",
        "firecrawlApiKey",
        "infoquestApiKey",
    }
)

DEFAULT_WEB_SEARCH_SETTINGS: dict[str, Any] = {
    "preferredBackend": "",
    # "" | "agent_plan" | "user" — who last chose preferredBackend
    "preferredBackendSource": "",
    # "" | "agent_plan" | "user" — provenance of doubaoApiKey (UI only; never auto-inject ark-)
    "doubaoKeySource": "",
    "doubaoApiKey": "",
    "doubaoBaseUrl": "",
    "bochaApiKey": "",
    "bochaBaseUrl": "",
    "tavilyApiKey": "",
    "tavilyBaseUrl": "",
    "braveApiKey": "",
    "firecrawlApiKey": "",
    "firecrawlApiUrl": "",
    "infoquestApiKey": "",
    "searxngUrl": "",
}

_SOURCE_VALUES = frozenset({"", "agent_plan", "user"})

# (env_var, credential_field)
_ENV_BINDINGS: list[tuple[str, str]] = [
    ("DOUBAO_SEARCH_API_KEY", "doubaoApiKey"),
    ("VOLCENGINE_SEARCH_API_KEY", "doubaoApiKey"),
    ("DOUBAO_SEARCH_BASE_URL", "doubaoBaseUrl"),
    ("BOCHA_API_KEY", "bochaApiKey"),
    ("BOCHA_SEARCH_API_KEY", "bochaApiKey"),
    ("BOCHAAI_API_KEY", "bochaApiKey"),
    ("BOCHA_SEARCH_BASE_URL", "bochaBaseUrl"),
    ("BOCHAAI_BASE_URL", "bochaBaseUrl"),
    ("TAVILY_API_KEY", "tavilyApiKey"),
    ("TAVILY_BASE_URL", "tavilyBaseUrl"),
    ("BRAVE_SEARCH_API_KEY", "braveApiKey"),
    ("FIRECRAWL_API_KEY", "firecrawlApiKey"),
    ("FIRECRAWL_API_URL", "firecrawlApiUrl"),
    ("INFOQUEST_API_KEY", "infoquestApiKey"),
    ("SEARXNG_URL", "searxngUrl"),
]

# Agent Plan Harness console (claim search quota + SearchInfinity key).
AGENT_PLAN_HARNESS_CONSOLE_URL = (
    "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement"
    "?advancedActiveKey=agentPlan"
)
AGENT_PLAN_DOUBAO_SEARCH_DOCS_URL = "https://www.volcengine.com/docs/82379/2545597?lang=zh"
DOUBAO_SEARCH_CONSOLE_URL = "https://console.volcengine.com/search-infinity/web-search-exp"
DOUBAO_SEARCH_DOCS_URL = "https://docs.volcengine.com/docs/87772/2272951?lang=zh"

PROVIDER_UI: list[dict[str, str]] = [
    {
        "id": "doubao",
        "label": "豆包搜索",
        "secretField": "doubaoApiKey",
        "urlField": "doubaoBaseUrl",
        "defaultBaseUrl": "https://open.feedcoopapi.com/search_api/web_search",
        "docsUrl": DOUBAO_SEARCH_DOCS_URL,
        "signupUrl": DOUBAO_SEARCH_CONSOLE_URL,
        "hint": (
            "火山「豆包搜索 / SearchInfinity」API。"
            "须用联网搜索专用 Key（不是对话用的 ark- Key）。"
            "独立开通有每月免费额度；若已订 Agent Plan，可在控制台「配置 Harness」领取套餐赠送额度 Key。"
        ),
    },
    {
        "id": "bocha",
        "label": "博查搜索",
        "secretField": "bochaApiKey",
        "urlField": "bochaBaseUrl",
        "defaultBaseUrl": "https://api.bochaai.com/v1/web-search",
        "docsUrl": "https://open.bochaai.com/",
        "signupUrl": "https://open.bochaai.com/",
        "hint": "国内 AI 搜索 API（自然语言 + 长摘要），适合 Agent / RAG。",
    },
    {
        "id": "tavily",
        "label": "Tavily",
        "secretField": "tavilyApiKey",
        "urlField": "tavilyBaseUrl",
        "defaultBaseUrl": "https://api.tavily.com",
        "docsUrl": "https://docs.tavily.com/documentation/api-credits",
        "signupUrl": "https://app.tavily.com/home",
        "hint": "专为 Agent 设计的搜索 API。",
    },
    {
        "id": "brave-free",
        "label": "Brave Search",
        "secretField": "braveApiKey",
        "urlField": "",
        "defaultBaseUrl": "",
        "docsUrl": "https://brave.com/search/api/",
        "signupUrl": "https://api-dashboard.search.brave.com/app/keys",
        "hint": "需 BRAVE_SEARCH_API_KEY。",
    },
    {
        "id": "searxng",
        "label": "SearXNG",
        "secretField": "",
        "urlField": "searxngUrl",
        "defaultBaseUrl": "",
        "docsUrl": "https://docs.searxng.org/",
        "signupUrl": "https://docs.searxng.org/admin/installation.html",
        "hint": "自建实例；填写实例 URL。公开实例可参考 searx.space。",
    },
    {
        "id": "firecrawl",
        "label": "Firecrawl",
        "secretField": "firecrawlApiKey",
        "urlField": "firecrawlApiUrl",
        "defaultBaseUrl": "https://api.firecrawl.dev",
        "docsUrl": "https://docs.firecrawl.dev/",
        "signupUrl": "https://www.firecrawl.dev/app/api-keys",
        "hint": "搜索 + 页面抽取。",
    },
    {
        "id": "infoquest",
        "label": "InfoQuest",
        "secretField": "infoquestApiKey",
        "urlField": "",
        "defaultBaseUrl": "",
        "docsUrl": "https://docs.byteplus.com/en/docs/InfoQuest/What_is_Info_Quest",
        "signupUrl": "https://console.byteplus.com/infoquest",
        "hint": "BytePlus InfoQuest，需 INFOQUEST_API_KEY。",
    },
    {
        "id": "ddgs",
        "label": "DDGS（免费兜底）",
        "secretField": "",
        "urlField": "",
        "defaultBaseUrl": "",
        "docsUrl": "https://pypi.org/project/ddgs/",
        "signupUrl": "https://pypi.org/project/ddgs/",
        "hint": "无需密钥，安装 ddgs 包即可；不稳定时请换其它引擎。",
    },
]


def _normalize_backend(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    if not s or s in {"auto", "none", "null"}:
        return ""
    if s not in KNOWN_BACKENDS:
        return ""
    return s


def _normalize_source(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    return s if s in _SOURCE_VALUES else ""


def _deep_merge_defaults(raw: Any) -> dict[str, Any]:
    base = copy.deepcopy(DEFAULT_WEB_SEARCH_SETTINGS)
    if not isinstance(raw, dict):
        return base
    for k, v in raw.items():
        if k == "preferredBackend":
            base[k] = _normalize_backend(v)
            continue
        if k in {"preferredBackendSource", "doubaoKeySource"}:
            base[k] = _normalize_source(v)
            continue
        if k in base:
            base[k] = "" if v is None else str(v)
    return base


def get_web_search_settings() -> dict[str, Any]:
    raw = cfg_repo.get_app_setting(WEB_SEARCH_SETTINGS_KEY)
    return _deep_merge_defaults(raw)


def get_preferred_backend() -> str | None:
    """Return configured preferred backend, or None for auto-detect."""
    pref = _normalize_backend(get_web_search_settings().get("preferredBackend"))
    return pref or None


def _mask_secret(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if len(s) <= 4:
        return "****"
    return "*" * min(len(s) - 4, 12) + s[-4:]


def get_web_search_settings_masked() -> dict[str, Any]:
    settings = get_web_search_settings()
    out: dict[str, Any] = {}
    configured: dict[str, bool] = {}
    for k, v in settings.items():
        if k in SECRET_FIELDS:
            masked = _mask_secret(v)
            out[k] = masked
            configured[k] = bool(str(v or "").strip())
        else:
            out[k] = v
            if k in {"searxngUrl", "tavilyBaseUrl", "firecrawlApiUrl", "doubaoBaseUrl", "bochaBaseUrl"}:
                configured[k] = bool(str(v or "").strip())
    out["_configured"] = configured
    return out


def patch_web_search_settings(patch: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(patch, dict) or not patch:
        return get_web_search_settings()
    current = get_web_search_settings()
    for k, v in patch.items():
        if k.startswith("_"):
            continue
        if k == "preferredBackend":
            current[k] = _normalize_backend(v)
            continue
        if k in {"preferredBackendSource", "doubaoKeySource"}:
            current[k] = _normalize_source(v)
            continue
        if k not in current and k not in SECRET_FIELDS:
            continue
        if k in SECRET_FIELDS:
            if v is None:
                current[k] = ""
            elif isinstance(v, str) and not v.strip():
                continue  # empty = leave unchanged
            else:
                current[k] = str(v).strip()
        else:
            current[k] = "" if v is None else str(v).strip()
    cfg_repo.set_app_setting(WEB_SEARCH_SETTINGS_KEY, current)
    return current


def apply_agent_plan_web_search_defaults() -> dict[str, Any]:
    """Prefer Doubao when Agent Plan includes web_search, without clobbering user choices.

    Official Agent Plan Harness grants SearchInfinity quota + a **separate** search API Key
    (not the chat ``ark-`` key). We only set preferred backend to ``doubao`` when the user
    has not explicitly chosen another engine.
    """
    current = get_web_search_settings()
    source = _normalize_source(current.get("preferredBackendSource"))
    if source == "user":
        return current
    pref = _normalize_backend(current.get("preferredBackend"))
    # Empty (auto) or previously Plan-applied → lock preferred to doubao.
    if pref and pref != "doubao" and source != "agent_plan":
        return current
    return patch_web_search_settings(
        {
            "preferredBackend": "doubao",
            "preferredBackendSource": "agent_plan",
        }
    )


def apply_web_search_credentials_to_mapping(env: dict[str, str]) -> None:
    """Overlay stored web-search credentials onto *env* (non-empty values only)."""
    settings = get_web_search_settings()
    for env_key, cred_key in _ENV_BINDINGS:
        s = str(settings.get(cred_key) or "").strip()
        if s:
            env[env_key] = s


def apply_web_search_credentials_to_environ() -> None:
    apply_web_search_credentials_to_mapping(os.environ)


def pick_recommended_backend(results: list[dict[str, Any]]) -> str | None:
    """Pick preferred backend from test results.

    Prefer successful paid/self-hosted engines ordered by quality, then latency.
    ``ddgs`` only when nothing else succeeds.
    """
    ok_rows = [
        r
        for r in results
        if isinstance(r, dict)
        and r.get("ok")
        and int(r.get("result_count") or 0) >= 1
        and str(r.get("name") or "").strip()
    ]
    if not ok_rows:
        return None

    quality_index = {name: i for i, name in enumerate(RECOMMEND_QUALITY_ORDER)}

    def sort_key(row: dict[str, Any]) -> tuple[int, int, float]:
        name = str(row.get("name") or "").strip().lower()
        is_ddgs = 1 if name == "ddgs" else 0
        qi = quality_index.get(name, 100)
        latency = float(row.get("latency_ms") or 1e9)
        return (is_ddgs, qi, latency)

    best = sorted(ok_rows, key=sort_key)[0]
    name = str(best.get("name") or "").strip().lower()
    return name if name in KNOWN_BACKENDS else None
