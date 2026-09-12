"""Admin helpers for Settings → 联网搜索 (platform tool + Gateway)."""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from typing import Any

from evoflow.admin.errors import ValidationError
from evoflow.persistence.runtime_env import apply_runtime_env_to_environ
from evoflow.persistence.web_search_settings import (
    AGENT_PLAN_DOUBAO_SEARCH_DOCS_URL,
    AGENT_PLAN_HARNESS_CONSOLE_URL,
    DEFAULT_WEB_SEARCH_SETTINGS,
    DOUBAO_SEARCH_CONSOLE_URL,
    KNOWN_BACKENDS,
    PROVIDER_UI,
    RECOMMEND_QUALITY_ORDER,
    get_preferred_backend,
    get_web_search_settings,
    get_web_search_settings_masked,
    patch_web_search_settings,
    pick_recommended_backend,
)

logger = logging.getLogger(__name__)

_TEST_TIMEOUT_S = 8.0

# Fields the assistant may patch (secrets + preferred + URLs).
_PATCHABLE = frozenset(DEFAULT_WEB_SEARCH_SETTINGS.keys())


def _active_backend_info() -> tuple[str | None, str]:
    preferred = get_preferred_backend()
    if preferred:
        source = str(get_web_search_settings().get("preferredBackendSource") or "").strip()
        if source == "agent_plan":
            return preferred, "agent_plan"
        return preferred, "settings"
    try:
        from evoflow.community.web.registry import resolve_search_backend

        name = resolve_search_backend()
        if name:
            return name, "auto"
    except Exception:
        pass
    return None, "none"


def _provider_status_list() -> list[dict[str, Any]]:
    apply_runtime_env_to_environ()
    try:
        from evoflow.community.web.registry import list_providers

        out: list[dict[str, Any]] = []
        for prov in list_providers():
            if not prov.supports_search():
                continue
            available = False
            try:
                available = bool(prov.is_available())
            except Exception:
                available = False
            out.append(
                {
                    "id": prov.name,
                    "label": getattr(prov, "display_name", None) or prov.name,
                    "available": available,
                    "supports_search": True,
                }
            )
        return out
    except Exception as e:
        logger.warning("Failed to list web providers: %s", e)
        return []


def get_agent_plan_web_search_status() -> dict[str, Any] | None:
    """Active Agent Plan binding that includes web_search (for Settings UI)."""
    try:
        from evoflow.plans.bindings import list_bindings
        from evoflow.plans.catalog import get_catalog_entry

        for binding in list_bindings(include_disabled=False, mask_key=True):
            if str(binding.get("status") or "") != "active":
                continue
            if str(binding.get("vendor") or "") != "volcengine":
                continue
            if str(binding.get("plan_family") or "") != "agent_plan":
                continue
            caps = {str(c) for c in (binding.get("bound_capabilities") or [])}
            if "web_search" not in caps:
                continue
            catalog_id = str(binding.get("catalog_id") or "volcengine.agent_plan")
            catalog = get_catalog_entry(catalog_id) or {}
            tier_id = str(binding.get("tier_id") or "").strip()
            raw = get_web_search_settings()
            has_doubao_key = bool(str(raw.get("doubaoApiKey") or "").strip())
            preferred = str(raw.get("preferredBackend") or "").strip().lower()
            return {
                "catalog_id": catalog_id,
                "binding_id": str(binding.get("id") or ""),
                "tier_id": tier_id,
                "label": str(catalog.get("name") or "火山方舟 Agent Plan"),
                "capability": "web_search",
                "engine": "doubao",
                "engine_label": "豆包搜索",
                "doubao_key_configured": has_doubao_key,
                "needs_search_key": not has_doubao_key,
                "preferred_is_doubao": preferred == "doubao",
                "harness_console_url": AGENT_PLAN_HARNESS_CONSOLE_URL,
                "docs_url": AGENT_PLAN_DOUBAO_SEARCH_DOCS_URL,
                "standalone_console_url": DOUBAO_SEARCH_CONSOLE_URL,
                "title": "Agent Plan 含豆包联网搜索",
                "hint": (
                    "套餐赠送的是「豆包搜索 / SearchInfinity」额度，和对话用的 ark- Key 不是同一把。"
                    "请到火山控制台「配置 Harness」领取联网搜索 API Key，填到下方「豆包搜索」。"
                    "绑定时已默认把首选引擎设为豆包；你也可改成其它引擎或自备 Key。"
                ),
                "steps": [
                    "打开火山方舟控制台 → 配置 Harness → 豆包搜索，领取权益并复制联网搜索 API Key",
                    "把该 Key 填到本页「豆包搜索」（不是 ark- 对话 Key）",
                    "点测试确认；也可改首选引擎 / 换 URL / 使用独立开通的 SearchInfinity Key",
                ],
            }
    except Exception as exc:
        logger.debug("agent plan web search status unavailable: %s", exc)
    return None


def build_web_search_assistant_guide(snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compact diagnosis for the platform assistant (settings.get_web_search).

    Keeps the model from dumping raw provider tables; tells it what to say and
    which follow-up platform actions to take.
    """
    snap = snapshot if isinstance(snapshot, dict) else get_web_search()
    settings = snap.get("settings") if isinstance(snap.get("settings"), dict) else {}
    configured = settings.get("_configured") if isinstance(settings.get("_configured"), dict) else {}
    plan = snap.get("agent_plan_web_search") if isinstance(snap.get("agent_plan_web_search"), dict) else None
    active = str(snap.get("active_backend") or "").strip() or None
    source = str(snap.get("active_source") or "").strip() or "none"
    has_doubao = bool(configured.get("doubaoApiKey"))
    preferred = str(settings.get("preferredBackend") or "").strip().lower()

    if plan and plan.get("needs_search_key"):
        status = "agent_plan_needs_doubao_key"
        summary = (
            "已绑定 Agent Plan（含豆包联网搜索额度），但还没填「豆包搜索」联网 Key；"
            "对话里的 web_search 暂时走不了豆包。"
        )
        say = (
            "你已开通 Agent Plan，套餐里的联网搜索是「豆包搜索」额度，"
            "和对话用的 ark- Key 不是同一把。"
            "请到火山控制台「配置 Harness → 豆包搜索」领取联网搜索 API Key，把 Key 发给我，"
            "我帮你写入设置并测通。也可以改用博查 / Tavily 等其它引擎。"
        )
        next_steps = list(plan.get("steps") or []) + [
            "用户贴出联网 Key 后：settings.patch_web_search（preferredBackend=doubao, doubaoApiKey=…）",
            "再 settings.test_web_search（engines=[\"doubao\"], adopt_recommended=true）",
        ]
        links = {
            "harness_console": plan.get("harness_console_url") or AGENT_PLAN_HARNESS_CONSOLE_URL,
            "docs": plan.get("docs_url") or AGENT_PLAN_DOUBAO_SEARCH_DOCS_URL,
            "standalone_doubao": plan.get("standalone_console_url") or DOUBAO_SEARCH_CONSOLE_URL,
        }
    elif plan and has_doubao:
        status = "agent_plan_ready"
        summary = "Agent Plan + 豆包联网 Key 已就绪；web_search 可优先走豆包。"
        say = (
            "联网搜索已按 Agent Plan 默认走豆包。若要换引擎或更新 Key，直接说目标引擎或把新 Key 发给我即可。"
        )
        next_steps = [
            "可选：settings.test_web_search 再确认通不通",
            "换引擎：settings.patch_web_search（preferredBackend=…）",
        ]
        links = {
            "harness_console": plan.get("harness_console_url") or AGENT_PLAN_HARNESS_CONSOLE_URL,
            "docs": plan.get("docs_url") or AGENT_PLAN_DOUBAO_SEARCH_DOCS_URL,
        }
    elif has_doubao or any(
        configured.get(k)
        for k in (
            "bochaApiKey",
            "tavilyApiKey",
            "braveApiKey",
            "firecrawlApiKey",
            "infoquestApiKey",
            "searxngUrl",
        )
    ):
        status = "configured"
        summary = f"已有搜索凭据；当前生效引擎={active or '自动'}（来源={source}）。"
        say = (
            f"当前联网搜索生效引擎是「{active or '自动探测'}」。"
            "要改首选、换 Key 或测通，直接说需求即可；不必让用户自己翻设置页。"
        )
        next_steps = [
            "改首选：settings.patch_web_search（preferredBackend=…）",
            "测通：settings.test_web_search",
        ]
        links = {"standalone_doubao": DOUBAO_SEARCH_CONSOLE_URL}
    else:
        status = "not_configured"
        summary = "尚未配置任何联网搜索引擎密钥。"
        say = (
            "还没配联网搜索。常见做法："
            "① 若有火山 Agent Plan：控制台「配置 Harness」领豆包联网 Key 发我；"
            "② 或独立开通豆包搜索 / 博查 / Tavily，把 Key 发我，我写入并测通。"
            "不要用对话 ark- Key 填豆包搜索。"
        )
        next_steps = [
            "先问用户用哪条路径（Agent Plan / 独立豆包 / 博查 / Tavily…）",
            "拿到 Key 后 settings.patch_web_search + settings.test_web_search",
        ]
        links = {
            "harness_console": AGENT_PLAN_HARNESS_CONSOLE_URL,
            "standalone_doubao": DOUBAO_SEARCH_CONSOLE_URL,
            "docs": AGENT_PLAN_DOUBAO_SEARCH_DOCS_URL,
        }

    return {
        "status": status,
        "summary": summary,
        "say_to_user": say,
        "next_steps": next_steps,
        "links": links,
        "active_backend": active,
        "active_source": source,
        "preferred_backend": preferred or None,
        "agent_plan_bound": bool(plan),
        "doubao_key_configured": has_doubao,
        "patch_fields_hint": (
            "preferredBackend, doubaoApiKey, doubaoBaseUrl, bochaApiKey, tavilyApiKey, "
            "braveApiKey, searxngUrl, firecrawlApiKey, infoquestApiKey"
        ),
        "note": (
            "帮用户配联网搜索时走 platform settings.*，不要让用户自己在复杂设置页里找。"
            "豆包联网 Key ≠ ark- 对话 Key。"
        ),
    }


def get_web_search() -> dict[str, Any]:
    """Masked settings + provider status for assistant / Gateway GET."""
    apply_runtime_env_to_environ()
    active, source = _active_backend_info()
    plan_ws = get_agent_plan_web_search_status()
    providers = _provider_status_list()
    if plan_ws:
        needs_key = bool(plan_ws.get("needs_search_key"))
        for prov in providers:
            if prov.get("id") == "doubao":
                prov["plan_sourced"] = True
                prov["plan_needs_key"] = needs_key
                # Entitled via Plan; still need SearchInfinity key to call.
                if needs_key:
                    prov["available"] = False
        # Plan entitled but nothing resolved yet → surface intended engine.
        if not active:
            active = "doubao"
            source = "agent_plan"
    snap = {
        "settings": get_web_search_settings_masked(),
        "defaults": dict(DEFAULT_WEB_SEARCH_SETTINGS),
        "providers": providers,
        "active_backend": active,
        "active_source": source,
        "agent_plan_web_search": plan_ws,
        "provider_ui": list(PROVIDER_UI),
        "known_backends": sorted(KNOWN_BACKENDS),
    }
    snap["assistant_guide"] = build_web_search_assistant_guide(snap)
    return snap


def normalize_web_search_patch(raw: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(raw, dict) or not raw:
        return {}
    # Allow either {settings: {...}} or flat fields.
    nested = raw.get("settings")
    src = nested if isinstance(nested, dict) else raw
    out: dict[str, Any] = {}
    for k, v in src.items():
        if str(k).startswith("_"):
            continue
        key = str(k).strip()
        # camelCase aliases from common snake_case
        aliases = {
            "preferred_backend": "preferredBackend",
            "preferred_backend_source": "preferredBackendSource",
            "doubao_key_source": "doubaoKeySource",
            "doubao_api_key": "doubaoApiKey",
            "doubao_base_url": "doubaoBaseUrl",
            "bocha_api_key": "bochaApiKey",
            "bocha_base_url": "bochaBaseUrl",
            "tavily_api_key": "tavilyApiKey",
            "tavily_base_url": "tavilyBaseUrl",
            "brave_api_key": "braveApiKey",
            "firecrawl_api_key": "firecrawlApiKey",
            "firecrawl_api_url": "firecrawlApiUrl",
            "infoquest_api_key": "infoquestApiKey",
            "searxng_url": "searxngUrl",
        }
        key = aliases.get(key, key)
        if key not in _PATCHABLE:
            continue
        out[key] = v
    # User-facing patches mark provenance so Plan rematerialize won't clobber.
    if "preferredBackend" in out and "preferredBackendSource" not in out:
        out["preferredBackendSource"] = "user"
    if "doubaoApiKey" in out and str(out.get("doubaoApiKey") or "").strip():
        if "doubaoKeySource" not in out:
            out["doubaoKeySource"] = "user"
    return out


def patch_web_search(patch: dict[str, Any] | None) -> dict[str, Any]:
    """Persist credentials / preferred backend; return refreshed get_web_search().

    Empty patch is a no-op (Gateway may PATCH with ``{}``).
    """
    normalized = normalize_web_search_patch(patch)
    if not normalized:
        return get_web_search()
    pref = normalized.get("preferredBackend")
    if pref is not None:
        raw = str(pref).strip().lower()
        if raw and raw not in KNOWN_BACKENDS and raw not in {"auto", "none", "null"}:
            raise ValidationError(
                f"preferredBackend must be one of {sorted(KNOWN_BACKENDS)} (or empty for auto)"
            )
    patch_web_search_settings(normalized)
    apply_runtime_env_to_environ()
    return get_web_search()


def run_one_search(name: str, query: str, limit: int) -> dict[str, Any]:
    """Probe one provider via the same ``run_provider_search`` path as ``web_search`` tool."""
    from evoflow.community.web.registry import get_provider, run_provider_search

    base: dict[str, Any] = {
        "name": name,
        "ok": False,
        "latency_ms": 0,
        "result_count": 0,
        "sample_titles": [],
        "error": "",
        "available": False,
        "skipped": False,
    }
    prov = get_provider(name)
    if prov is None:
        base["error"] = "unknown provider"
        return base
    try:
        available = bool(prov.is_available())
    except Exception as e:
        base["error"] = f"availability check failed: {e}"
        return base
    base["available"] = available
    if not available:
        base["skipped"] = True
        base["error"] = "not configured / unavailable"
        return base
    if not prov.supports_search():
        base["skipped"] = True
        base["error"] = "does not support search"
        return base

    t0 = time.perf_counter()
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            fut = pool.submit(run_provider_search, name, query, limit=limit)
            try:
                raw = fut.result(timeout=_TEST_TIMEOUT_S)
            except FuturesTimeout:
                base["latency_ms"] = round((time.perf_counter() - t0) * 1000, 1)
                base["error"] = f"timeout after {_TEST_TIMEOUT_S:.0f}s"
                return base
    except Exception as e:
        base["latency_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        base["error"] = str(e)[:300]
        return base

    latency = round((time.perf_counter() - t0) * 1000, 1)
    base["latency_ms"] = latency
    if not isinstance(raw, dict) or not raw.get("success"):
        err = ""
        if isinstance(raw, dict):
            err = str(raw.get("error") or "search failed")
        else:
            err = "invalid response"
        base["error"] = err[:300]
        return base

    web = ((raw.get("data") or {}) if isinstance(raw.get("data"), dict) else {}).get("web") or []
    if not isinstance(web, list):
        web = []
    titles = [str(item.get("title") or "").strip() for item in web[:3] if isinstance(item, dict)]
    titles = [t for t in titles if t]
    count = len(web)
    base["result_count"] = count
    base["sample_titles"] = titles
    base["ok"] = count >= 1
    if count < 1:
        base["error"] = "empty results"
    return base


def test_web_search(
    *,
    query: str | None = None,
    engines: list[str] | None = None,
    max_results: int = 5,
    adopt_recommended: bool = False,
) -> dict[str, Any]:
    """Connectivity test across providers; optionally adopt recommended as preferred."""
    apply_runtime_env_to_environ()
    q = (query or "").strip() or "今天 AI 新闻"
    limit = max(1, min(int(max_results or 5), 20))

    if engines:
        names = [str(x).strip().lower() for x in engines if str(x).strip()]
    else:
        try:
            from evoflow.community.web.registry import list_providers

            names = [p.name for p in list_providers() if p.supports_search()]
        except Exception:
            names = list(KNOWN_BACKENDS)

    order = {n: i for i, n in enumerate(RECOMMEND_QUALITY_ORDER)}
    names = sorted(dict.fromkeys(names), key=lambda n: order.get(n, 100))

    results = [run_one_search(name, q, limit) for name in names]
    recommended = pick_recommended_backend(results)
    adopted = None
    if adopt_recommended and recommended:
        patch_web_search_settings({"preferredBackend": recommended})
        apply_runtime_env_to_environ()
        adopted = recommended

    return {
        "query": q,
        "results": results,
        "recommended": recommended,
        "adopted_preferred": adopted,
        "active_backend": get_preferred_backend() or recommended,
    }
