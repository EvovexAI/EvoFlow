"""Seven-dimension observability report + rule-based recommendations for AI reviewers."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from evoflow.observability import eval_metrics as em
from evoflow.observability import latency_waterfall as wf
from evoflow.observability import queries as q


def build_recommendations(dimensions: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn metrics into prioritized suggestion stubs (agent expands with evidence)."""
    recs: list[dict[str, Any]] = []

    rel = dimensions.get("reliability") if isinstance(dimensions.get("reliability"), dict) else {}
    err_rate = float(rel.get("tool_error_rate") or 0)
    if err_rate >= 0.15:
        recs.append(
            _rec(
                "P0",
                "reliability",
                f"工具错误率 {err_rate:.1%} 偏高",
                "检查 ValidationError（list 参数 JSON 字符串）与 ToolReturnedError（HTTP 403/502）",
                "code",
                "对比 recent_tool_errors 按 error_type 分组；确认 coerce 与 web_fetch Hint 已部署",
            )
        )
    by_type = rel.get("errors_by_type") if isinstance(rel.get("errors_by_type"), list) else []
    for row in by_type:
        if not isinstance(row, dict):
            continue
        et = str(row.get("error_type") or "")
        cnt = int(row.get("count") or 0)
        if et == "ValidationError" and cnt >= 5:
            recs.append(
                _rec(
                    "P0",
                    "reliability",
                    f"ValidationError {cnt} 次",
                    "工具 list 参数被当成 JSON 字符串；检查 middleware coerce 与工具签名",
                    "code",
                    "重启后 errors_by_type 中 ValidationError 应下降",
                )
            )
        if et == "ScenarioNotActivated" and cnt >= 3:
            recs.append(
                _rec(
                    "P2",
                    "product_path",
                    f"ScenarioNotActivated {cnt} 次",
                    "引导先 scenario 激活 plan/file，或调整 plan_guard",
                    "prompt",
                    "抽查 agent-trace summary.plan_guard_events",
                )
            )

    tl = dimensions.get("tool_latency") if isinstance(dimensions.get("tool_latency"), dict) else {}
    for row in tl.get("top_slow_tools") or []:
        if not isinstance(row, dict):
            continue
        name = str(row.get("tool_name") or "")
        mx = float(row.get("max_duration_ms") or 0)
        if name == "search_content" and mx > 60_000:
            recs.append(
                _rec(
                    "P1",
                    "tool_latency",
                    f"search_content 单次最慢 {mx / 1000:.0f}s",
                    "缩小 path/glob、启用 45s 墙钟超时、优先 search_code_index",
                    "code",
                    "slowest_tool_invocations 中 search_content max 应 <45s",
                )
            )
        if name in ("web_search", "web_fetch") and mx > 30_000:
            recs.append(
                _rec(
                    "P1",
                    "tool_latency",
                    f"{name} 单次 {mx / 1000:.0f}s",
                    "AI 资讯用 ai_daily/news_53ai；fetch 遇 403 换源；检查外网超时",
                    "usage",
                    f"{name} max_duration_ms 趋势下降",
                )
            )

    ml = dimensions.get("model_latency") if isinstance(dimensions.get("model_latency"), dict) else {}
    p95 = ml.get("latency_p95_ms")
    if p95 is not None and float(p95) > 60_000:
        recs.append(
            _rec(
                "P1",
                "model_latency",
                f"模型调用 P95 延迟 {float(p95) / 1000:.0f}s",
                "检查 invocation_kind=compress/memory；降低 threshold_ratio、提前压缩",
                "config",
                "model latency_p95 与 highest_token 对照",
            )
        )

    ftl = dimensions.get("first_token_latency") if isinstance(dimensions.get("first_token_latency"), dict) else {}
    ttft_p95 = ftl.get("ttft_p95_ms")
    if ttft_p95 is not None and float(ttft_p95) > 10_000:
        recs.append(
            _rec(
                "P1",
                "first_token_latency",
                f"首token延迟 P95 {float(ttft_p95) / 1000:.1f}s",
                "检查模型 provider 响应速度、prompt 长度（长输入压缩）、vendor API 超时",
                "config",
                "first_token_latency P95 趋势下降至 10s 以下",
            )
        )
    ttft_p99 = ftl.get("ttft_p99_ms")
    if ttft_p99 is not None and float(ttft_p99) > 30_000:
        recs.append(
            _rec(
                "P1",
                "first_token_latency",
                f"首token延迟 P99 {float(ttft_p99) / 1000:.1f}s（尾延迟异常）",
                "排查慢速 provider、思考链过长的模型调用、vendor 端超时重试",
                "code",
                "first_token_latency P99 降至 30s 以下",
            )
        )
    slow_ttft = ftl.get("slowest_ttft_invocations") if isinstance(ftl.get("slowest_ttft_invocations"), list) else []
    for row in slow_ttft[:3]:
        if not isinstance(row, dict):
            continue
        ttft_val = float(row.get("first_token_latency_ms") or 0)
        model_name = str(row.get("model") or "?")
        if ttft_val > 15_000:
            recs.append(
                _rec(
                    "P2",
                    "first_token_latency",
                    f"模型 {model_name} 首token {ttft_val / 1000:.1f}s",
                    "检查该模型 provider 端延迟、是否有长输入压缩瓶颈",
                    "config",
                    "单次 TTFT >15s 的模型调用数减少",
                )
            )

    tok = dimensions.get("tokens") if isinstance(dimensions.get("tokens"), dict) else {}
    for row in tok.get("highest_token_invocations") or []:
        if not isinstance(row, dict):
            continue
        tot = int(row.get("usage_total_tokens") or 0)
        if tot >= 150_000:
            recs.append(
                _rec(
                    "P1",
                    "tokens",
                    f"单次模型 input 约 {tot} tokens",
                    "加强 compaction、工具结果 shaper、减少重复 read_file",
                    "config",
                    "highest_token_model_invocations 峰值下降",
                )
            )
            break

    ch = dimensions.get("channels") if isinstance(dimensions.get("channels"), dict) else {}
    if int(ch.get("im_channel_error_count") or 0) >= 3:
        recs.append(
            _rec(
                "P2",
                "channels",
                f"IM 通道错误 {ch.get('im_channel_error_count')} 条",
                "与工具链分开排查 Feishu/Slack 配置",
                "external",
                "recent_im_channel_errors 减少",
            )
        )

    eval_dim = dimensions.get("eval") if isinstance(dimensions.get("eval"), dict) else {}
    recs.extend(build_eval_recommendations(eval_dim))

    wf_dim = dimensions.get("latency_waterfall") if isinstance(dimensions.get("latency_waterfall"), dict) else {}
    wf_bn = wf_dim.get("bottlenecks") if isinstance(wf_dim.get("bottlenecks"), list) else []

    bn_pre = [b for b in wf_bn if isinstance(b, dict) and b.get("phase") == "pre_model" and b.get("type") == "aggregate"]
    if bn_pre:
        recs.append(
            _rec(
                "P1",
                "latency_waterfall",
                bn_pre[0].get("phenomenon", "pre_model 耗时占比高"),
                "检查中间件链、intent profiling、PlanGuard 处理耗时",
                "code",
                "pre_model 占比降至 30% 以下",
            )
        )

    bn_ttft = [b for b in wf_bn if isinstance(b, dict) and b.get("phase") == "ttft" and b.get("type") == "aggregate"]
    if bn_ttft:
        recs.append(
            _rec(
                "P1",
                "latency_waterfall",
                bn_ttft[0].get("phenomenon", "平均 TTFT 偏高"),
                "检查 provider 响应速度、长输入压缩、vendor API 超时",
                "config",
                "平均 TTFT 下降",
            )
        )

    # Per-cycle bottlenecks: flag threads with >2 bottleneck cycles
    cycle_bns = [b for b in wf_bn if isinstance(b, dict) and b.get("type") == "cycle"]
    if len(cycle_bns) >= 5:
        recs.append(
            _rec(
                "P2",
                "latency_waterfall",
                f"检测到 {len(cycle_bns)} 个周期级瓶颈",
                f"top 示例：{'；'.join(b.get('phenomenon', '') for b in cycle_bns[:3])}",
                "code",
                "周期级瓶颈数量减少",
            )
        )

    order = {"P0": 0, "P1": 1, "P2": 2}
    recs.sort(key=lambda r: order.get(str(r.get("priority")), 9))
    return recs


def build_eval_recommendations(eval_dimensions: dict[str, Any]) -> list[dict[str, Any]]:
    """Recommendations from eval-specific aggregates (invalid tools, density, compress ratio)."""
    recs: list[dict[str, Any]] = []
    if not eval_dimensions:
        return recs

    inv = eval_dimensions.get("invalid_tool_calls") if isinstance(eval_dimensions.get("invalid_tool_calls"), dict) else {}
    rate = float(inv.get("invalid_tool_call_rate") or 0)
    total_inv = int(inv.get("total_invalid_tool_calls") or 0)
    if rate >= 0.05 or total_inv >= 10:
        recs.append(
            _rec(
                "P1" if rate < 0.15 else "P0",
                "model",
                f"invalid_tool_calls 占比 {rate:.1%}（合计 {total_inv}）",
                "核对工具 JSON schema、prompt 参数示例；抽查 collab_cycle invalid_tool_calls_count",
                "prompt",
                "eval.invalid_tool_call_rate 与 top_threads_by_invalid 下降",
            )
        )

    density = eval_dimensions.get("thread_tool_density") if isinstance(eval_dimensions.get("thread_tool_density"), dict) else {}
    dense = density.get("dense_threads") if isinstance(density.get("dense_threads"), list) else []
    if len(dense) >= 3:
        recs.append(
            _rec(
                "P2",
                "tool",
                f"{len(dense)} 个会话工具调用密度超过 P95（≥{density.get('tool_calls_p95_threshold')} 次）",
                "减少重复 read_file/search；确认 loop_detection 日志",
                "usage",
                "dense_threads 数量下降",
            )
        )

    compress = eval_dimensions.get("compress_kind") if isinstance(eval_dimensions.get("compress_kind"), dict) else {}
    aux_ratio = float(compress.get("auxiliary_kind_ratio") or 0)
    if aux_ratio >= 0.25:
        recs.append(
            _rec(
                "P1",
                "model",
                f"compress/memory 类调用占比 {aux_ratio:.1%}",
                "降低 summarization.threshold_ratio；减少工具结果体积",
                "config",
                "auxiliary_kind_ratio < 25%",
            )
        )

    return recs


def _rec(
    priority: str,
    dimension: str,
    phenomenon: str,
    action: str,
    root_cause: str,
    verification: str,
) -> dict[str, Any]:
    return {
        "priority": priority,
        "dimension": dimension,
        "phenomenon": phenomenon,
        "suggested_action": action,
        "root_cause_category": root_cause,
        "verification": verification,
    }


def fetch_report(*, since_hours: float = 168, limit: int = 10) -> dict[str, Any]:
    """Single JSON bundle for AI periodic review (7 dimensions + recommendations)."""
    if q._store() is None:
        return {"enabled": False}

    since = q._since_iso(since_hours)
    overview = q.fetch_overview(since_hours=since_hours)
    insights = q.fetch_insights(limit=limit, since_hours=since_hours)
    errors_summary = q.fetch_errors_summary(since_hours=since_hours)
    trends = q.fetch_trends(days=min(14, max(1, int(since_hours / 24) if since_hours else 7)), since_hours=since_hours)
    eval_dimensions = {
        "invalid_tool_calls": em.fetch_invalid_tool_calls_summary(since_hours=since_hours),
        "thread_tool_density": em.fetch_thread_tool_density(since_hours=since_hours),
        "compress_kind": em.fetch_compress_kind_stats(since_hours=since_hours),
    }
    waterfall_summary = wf.build_waterfall_summary(since_hours=since_hours, sample_limit=20)

    dimensions: dict[str, Any] = {
        "reliability": {
            "tool_invocations": overview.get("tool_invocations"),
            "tool_errors": overview.get("tool_errors"),
            "tool_error_rate": overview.get("tool_error_rate"),
            "errors_by_type": errors_summary.get("by_error_type"),
            "errors_by_tool": errors_summary.get("by_tool_name"),
            "recent_tool_errors": insights.get("recent_tool_errors"),
        },
        "tool_latency": {
            "avg_duration_ms": overview.get("tool_avg_duration_ms"),
            "duration_p95_ms": overview.get("tool_duration_p95_ms"),
            "top_slow_tools": overview.get("top_slow_tools"),
            "slowest_invocations": insights.get("slowest_tool_invocations"),
        },
        "model_latency": {
            "model_invocations": overview.get("model_invocations"),
            "avg_latency_ms": overview.get("model_avg_latency_ms"),
            "latency_p95_ms": overview.get("model_latency_p95_ms"),
            "trace_model_avg_latency_ms": overview.get("trace_model_avg_latency_ms"),
            "slowest_invocations": insights.get("slowest_model_invocations"),
            "by_invocation_kind": errors_summary.get("model_by_kind"),
        },
        "first_token_latency": {
            "ttft_count": overview.get("model_ttft_count"),
            "ttft_p50_ms": overview.get("model_ttft_p50_ms"),
            "ttft_p95_ms": overview.get("model_ttft_p95_ms"),
            "ttft_p99_ms": overview.get("model_ttft_p99_ms"),
            "slowest_ttft_invocations": insights.get("slowest_ttft_model_invocations"),
        },
        "tokens": {
            "total_tokens": overview.get("total_tokens"),
            "model_token_stats": overview.get("model_token_stats"),
            "highest_token_invocations": insights.get("highest_token_model_invocations"),
        },
        "thread_health": {
            "thread_count": overview.get("thread_count"),
            "top_slow_threads": overview.get("top_slow_threads"),
        },
        "channels": {
            "im_channel_error_count": len(insights.get("recent_im_channel_errors") or []),
            "recent_im_channel_errors": insights.get("recent_im_channel_errors"),
        },
        "product_path": {
            "note_zh": "需结合 /api/debug/agent-trace/export 查看 plan_guard、ai_daily/news_53ai 用法",
            "debug_endpoints": {
                "export": "/api/debug/agent-trace/export?thread_id=<uuid>&omit_model_payloads=1",
                "analysis": "/api/debug/agent-trace/analysis?thread_id=<uuid>&turn=<n>",
            },
        },
        "eval": eval_dimensions,
        "latency_waterfall": {
            "sampled_threads": waterfall_summary.get("sampled_threads"),
            "aggregate": waterfall_summary.get("aggregate"),
            "bottlenecks": waterfall_summary.get("bottlenecks"),
        },
    }

    recommendations = build_recommendations(dimensions)
    eval_findings = em.build_eval_findings(dimensions)

    return {
        "enabled": True,
        "schema": "evoflow.observability.report.v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "window": {"since_hours": since_hours, "since_iso": since},
        "limit": limit,
        "overview": overview,
        "trends": trends,
        "dimensions": dimensions,
        "recommendations": recommendations,
        "eval_findings": eval_findings,
        "endpoints": {
            "report": f"/api/observability/report?since_hours={since_hours}&limit={limit}",
            "eval_snapshot": f"/api/observability/eval-snapshot?since_hours={since_hours}&sample_k=5",
            "insights": f"/api/observability/insights?since_hours={since_hours}",
            "errors_summary": f"/api/observability/errors/summary?since_hours={since_hours}",
            "trends": f"/api/observability/trends?days=7&since_hours={since_hours}",
            "waterfall": "/api/observability/waterfall/<thread_id>",
            "waterfall_summary": f"/api/observability/waterfall-summary?since_hours={since_hours}&sample_limit=20",
            "playbook": "internal design docs (not published in this repository)",
            "eval_skill": "skills/custom/evoflow-eval-analysis/SKILL.md",
        },
    }
