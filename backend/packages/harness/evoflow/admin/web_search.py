"""Admin helpers for Settings → 联网搜索 (platform tool + Gateway)."""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
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
    """Active Agent Plan binding that includes web_search (for Settings UI + system status)."""
    try:
        from evoflow.plans.bindings import list_bindings
        from evoflow.plans.catalog import get_catalog_entry
        from evoflow.persistence.web_search_settings import resolve_agent_plan_doubao_search_api_key

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
            key_source = str(raw.get("doubaoKeySource") or "").strip()
            preferred = str(raw.get("preferredBackend") or "").strip().lower()
            preferred_source = str(raw.get("preferredBackendSource") or "").strip()
            plan_binding_has_key = bool(binding.get("api_key_configured"))
            # Runtime can still resolve Plan ark- even if settings field is empty.
            runtime_plan_key = bool(resolve_agent_plan_doubao_search_api_key())
            key_ready = has_doubao_key or runtime_plan_key or plan_binding_has_key
            wired_from_plan = key_source == "agent_plan" and has_doubao_key
            preferred_is_doubao = preferred == "doubao" or (
                not preferred and preferred_source == "agent_plan"
            )
            ready = bool(key_ready and (preferred_is_doubao or not preferred or preferred == "doubao"))
            return {
                "catalog_id": catalog_id,
                "binding_id": str(binding.get("id") or ""),
                "tier_id": tier_id,
                "label": str(catalog.get("name") or "火山方舟 Agent Plan"),
                "capability": "web_search",
                "engine": "doubao",
                "engine_label": "豆包搜索",
                "doubao_key_configured": has_doubao_key,
                "doubao_key_source": key_source or ("agent_plan" if runtime_plan_key else ""),
                "plan_binding_has_key": plan_binding_has_key,
                "wired_from_plan": wired_from_plan or (runtime_plan_key and not has_doubao_key),
                "needs_search_key": not key_ready,
                "preferred_is_doubao": preferred == "doubao",
                "ready": ready,
                "harness_required": True,
                "harness_console_url": AGENT_PLAN_HARNESS_CONSOLE_URL,
                "docs_url": AGENT_PLAN_DOUBAO_SEARCH_DOCS_URL,
                "standalone_console_url": DOUBAO_SEARCH_CONSOLE_URL,
                "title": "Agent Plan · 豆包联网搜索",
                "hint": (
                    "官方：Agent Plan 专属 Key 即可调用豆包搜索（与对话同一把）。"
                    "绑定套餐后会自动写入首选引擎=豆包，并带上套餐 Key。"
                    "请到火山控制台 Harness 开启「豆包搜索」抵扣，否则可能无法按套餐额度扣费。"
                    "也可改成其它引擎或手填独立 SearchInfinity Key。"
                ),
                "steps": [
                    "确认火山控制台 → Harness → 已开启「豆包搜索」抵扣",
                    "本页应显示「套餐 Key 已自动接通」；若未接通可重新保存/绑定 Agent Plan",
                    "点「测试」确认；也可改首选引擎或手填独立搜索 Key",
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

    plan_ready = bool(plan and (plan.get("ready") or (not plan.get("needs_search_key") and has_doubao)))
    plan_key_ready = bool(
        plan
        and (
            has_doubao
            or plan.get("wired_from_plan")
            or plan.get("plan_binding_has_key")
            or not plan.get("needs_search_key")
        )
    )

    if plan and plan.get("needs_search_key"):
        status = "agent_plan_needs_doubao_key"
        summary = "已绑定 Agent Plan（含豆包联网搜索），但套餐 Key 尚未接通到豆包搜索。"
        say = (
            "你已开通 Agent Plan。官方可用套餐专属 Key 调豆包搜索（与对话同一把）。"
            "请重新保存/绑定一次套餐以自动写入，或把 Key 发给我写入「豆包搜索」；"
            "并确认火山控制台 Harness 已开启「豆包搜索」抵扣。也可改用博查 / Tavily。"
        )
        next_steps = list(plan.get("steps") or []) + [
            "重新 materialize / 更新套餐 Key 后会自动写入 doubaoApiKey（doubaoKeySource=agent_plan）",
            "或 settings.patch_web_search（preferredBackend=doubao, doubaoApiKey=套餐 Key）",
            '再 settings.test_web_search（engines=["doubao"], adopt_recommended=true）',
        ]
        links = {
            "harness_console": plan.get("harness_console_url") or AGENT_PLAN_HARNESS_CONSOLE_URL,
            "docs": plan.get("docs_url") or AGENT_PLAN_DOUBAO_SEARCH_DOCS_URL,
            "standalone_doubao": plan.get("standalone_console_url") or DOUBAO_SEARCH_CONSOLE_URL,
        }
    elif plan and plan_key_ready:
        status = "agent_plan_ready"
        summary = (
            "Agent Plan 豆包联网搜索已接通（套餐 Key）；web_search 优先走豆包。"
            if plan.get("wired_from_plan") or has_doubao
            else "Agent Plan 已绑定且套餐 Key 可用；web_search 可走豆包。"
        )
        say = (
            "联网搜索已按 Agent Plan 自动接好豆包（套餐 Key）。"
            "请确认控制台 Harness「豆包搜索」抵扣已开。若要换引擎或改用独立搜索 Key，直接说即可。"
        )
        next_steps = [
            "可选：settings.test_web_search 确认通不通",
            "换引擎：settings.patch_web_search（preferredBackend=…）",
            "提醒用户：Harness 未开抵扣时可能无法按套餐额度扣费",
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
        say = f"当前联网搜索生效引擎是「{active or '自动探测'}」。要改首选、换 Key 或测通，直接说需求即可；不必让用户自己翻设置页。"
        next_steps = [
            "改首选：settings.patch_web_search（preferredBackend=…）",
            "测通：settings.test_web_search",
        ]
        links = {"standalone_doubao": DOUBAO_SEARCH_CONSOLE_URL}
    else:
        status = "not_configured"
        summary = "尚未配置任何联网搜索引擎密钥。"
        say = (
            "还没配联网搜索。常见做法：① 绑定火山 Agent Plan（官方用套餐 Key 调豆包搜索，Harness 开抵扣）；"
            "② 或独立开通豆包 / 博查 / Tavily，把 Key 发我写入并测通。"
        )
        next_steps = [
            "先问用户用哪条路径（Agent Plan / 独立豆包 / 博查 / Tavily…）",
            "Agent Plan：保存绑定后自动接通；其它：settings.patch_web_search + settings.test_web_search",
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
        "agent_plan_ready": plan_ready,
        "doubao_key_configured": has_doubao,
        "doubao_key_source": (plan or {}).get("doubao_key_source") if plan else (str(settings.get("doubaoKeySource") or "").strip() or None),
        "wired_from_plan": bool(plan and plan.get("wired_from_plan")),
        "harness_required": bool(plan and plan.get("harness_required")),
        "configured": status in {"agent_plan_ready", "configured"},
        "online_capable": status in {"agent_plan_ready", "configured"} and bool(active),
        "patch_fields_hint": (
            "preferredBackend, doubaoApiKey, doubaoBaseUrl, bochaApiKey, tavilyApiKey, "
            "braveApiKey, searxngUrl, firecrawlApiKey, infoquestApiKey"
        ),
        "note": (
            "帮用户配联网搜索时走 platform settings.* / diagnostics.status。"
            "Agent Plan 官方：套餐专属 Key = 豆包搜索鉴权 Key（需 Harness 开启抵扣）。"
        ),
    }


def resolve_web_search_setup_gate() -> dict[str, Any]:
    """Tell ``web_search`` whether to fail-fast and ask the user for a Key.

    When Agent Plan / paid engines need a Key but none is configured, hanging on
    free ``ddgs`` (often 45s timeout) is worse than prompting via platform tools.
    Explicit ``preferredBackend=ddgs`` still allows the free path.
    """
    try:
        snap = get_web_search()
        guide = snap.get("assistant_guide") if isinstance(snap.get("assistant_guide"), dict) else build_web_search_assistant_guide(snap)
    except Exception as e:
        logger.debug("resolve_web_search_setup_gate failed: %s", e)
        return {
            "needs_configuration": False,
            "skip_slow_ddgs": False,
            "assistant_guide": None,
            "reason": f"gate_error:{e}",
        }

    status = str(guide.get("status") or "").strip()
    preferred = str(guide.get("preferred_backend") or "").strip().lower()
    needs = status in {"agent_plan_needs_doubao_key", "not_configured"}
    # Always skip slow free ddgs when Keys are missing — prompting via platform is faster
    # and more reliable than a 45s DuckDuckGo hang (common on restricted networks).
    # After the user configures a Key (or SearXNG URL), needs=False and normal failover resumes.
    skip_ddgs = bool(needs)
    return {
        "needs_configuration": needs,
        "skip_slow_ddgs": skip_ddgs,
        "assistant_guide": guide,
        "reason": status or "ok",
        "preferred_backend": preferred or None,
        "platform_hint": (
            "先向用户复述 assistant_guide.say_to_user；用户贴出 Key 后用 "
            "platform(action='settings.patch_web_search', …, confirm=true) 写入，再 "
            "settings.test_web_search 测通。不要让用户自己翻复杂设置页。"
        ),
    }


def _soft_heal_agent_plan_web_search() -> None:
    """For bindings created before auto-wire: inject Plan Key + preferred doubao once."""
    try:
        from evoflow.persistence.web_search_settings import (
            apply_agent_plan_web_search_defaults,
            get_web_search_settings,
        )
        from evoflow.plans.bindings import find_active_binding

        binding = find_active_binding(
            vendor="volcengine",
            plan_family="agent_plan",
            capability="web_search",
            mask_key=True,
        )
        if not binding or not binding.get("api_key_configured"):
            return
        raw = get_web_search_settings()
        key_source = str(raw.get("doubaoKeySource") or "").strip()
        pref_source = str(raw.get("preferredBackendSource") or "").strip()
        has_key = bool(str(raw.get("doubaoApiKey") or "").strip())
        pref = str(raw.get("preferredBackend") or "").strip().lower()
        needs_key = not has_key and key_source != "user"
        needs_pref = (not pref or pref == "doubao") and pref_source != "user"
        if needs_key or needs_pref:
            apply_agent_plan_web_search_defaults()
    except Exception as exc:
        logger.debug("soft heal agent plan web_search skipped: %s", exc)


def get_web_search() -> dict[str, Any]:
    """Masked settings + provider status for assistant / Gateway GET."""
    apply_runtime_env_to_environ()
    _soft_heal_agent_plan_web_search()
    active, source = _active_backend_info()
    plan_ws = get_agent_plan_web_search_status()
    providers = _provider_status_list()
    if plan_ws:
        needs_key = bool(plan_ws.get("needs_search_key"))
        wired = bool(plan_ws.get("wired_from_plan"))
        for prov in providers:
            if prov.get("id") == "doubao":
                prov["plan_sourced"] = True
                prov["plan_needs_key"] = needs_key
                prov["plan_key_wired"] = wired
                prov["plan_ready"] = bool(plan_ws.get("ready"))
                # Plan entitled + key missing → mark unavailable so UI shows 待接通.
                if needs_key:
                    prov["available"] = False
                elif not prov.get("available") and (
                    plan_ws.get("plan_binding_has_key") or plan_ws.get("doubao_key_configured")
                ):
                    # Settings may be empty while runtime Plan key fallback works.
                    prov["available"] = True
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
            raise ValidationError(f"preferredBackend must be one of {sorted(KNOWN_BACKENDS)} (or empty for auto)")
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
