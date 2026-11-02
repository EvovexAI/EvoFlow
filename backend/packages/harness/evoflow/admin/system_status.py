"""Live system status snapshot for ``platform diagnostics.status``.

Collects ports, data/install dirs, and Gateway service health so agents can
answer 「系统现在跑在哪、状态如何」 without hopping obs/debug UIs.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


def _parse_port(raw: Any) -> int | None:
    try:
        port = int(raw)
    except (TypeError, ValueError):
        return None
    if 1 < port < 65536:
        return port
    return None


def _env_port(*keys: str) -> int | None:
    for key in keys:
        port = _parse_port((os.getenv(key) or "").strip())
        if port is not None:
            return port
    return None


def _runtime_state_candidates() -> list[Path]:
    """Profile-scoped runtime files Tauri writes for the active Gateway."""
    out: list[Path] = []
    home = (os.getenv("EVOFLOW_HOME") or "").strip()
    if home:
        out.append(Path(home) / "backend-runtime.json")
    config = (os.getenv("EVOFLOW_CONFIG_DIR") or "").strip()
    profile = (os.getenv("EVOFLOW_PROFILE") or "").strip()
    if config and profile:
        out.append(Path(config) / "profiles" / profile / "backend-runtime.json")
    if config:
        out.append(Path(config) / "backend-runtime.json")
    # Dev / doctor fallbacks
    for base in (Path.home() / ".evoflow", Path.home() / ".evoflow-dev"):
        profiles = base / "profiles"
        if profiles.is_dir():
            try:
                out.extend(p / "backend-runtime.json" for p in sorted(profiles.iterdir()) if p.is_dir())
            except OSError:
                pass
        out.append(base / "evopanel" / "backend-runtime.json")
    return out


def _read_backend_runtime() -> dict[str, Any]:
    """Best-effort read of Tauri ``backend-runtime.json``."""
    for path in _runtime_state_candidates():
        try:
            if not path.is_file():
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            continue
        if isinstance(data, dict):
            out = dict(data)
            out["_path"] = str(path)
            return out
    return {}


def resolve_install_dir() -> dict[str, Any]:
    """Locate the application / repo install root.

    Priority:
    1. ``EVOFLOW_INSTALL_DIR``
    2. Frozen EXE parent (PyInstaller sidecar)
    3. ``EVOFLOW_BACKEND_DIR`` → parent when named ``backend``, else itself
    4. Walk up from this package looking for ``evopanel`` + ``backend`` siblings
    5. ``sys.executable`` parent
    """
    explicit = (os.getenv("EVOFLOW_INSTALL_DIR") or "").strip()
    if explicit:
        p = Path(explicit).expanduser().resolve()
        return {"path": str(p), "source": "EVOFLOW_INSTALL_DIR", "exists": p.exists()}

    if getattr(sys, "frozen", False) or getattr(sys, "_MEIPASS", None):
        exe = Path(getattr(sys, "executable", "") or "").resolve()
        if exe.is_file():
            # …/binaries/evoflow-gateway/evoflow-gateway.exe → prefer app root when obvious
            parent = exe.parent
            for candidate in (parent, parent.parent, parent.parent.parent):
                if (candidate / "evopanel").is_dir() or (candidate / "EvoFlow.exe").is_file():
                    return {
                        "path": str(candidate.resolve()),
                        "source": "frozen_exe_tree",
                        "exists": True,
                    }
            return {"path": str(parent), "source": "frozen_exe_parent", "exists": True}

    backend_env = (os.getenv("EVOFLOW_BACKEND_DIR") or "").strip()
    if backend_env:
        backend = Path(backend_env).expanduser().resolve()
        root = backend.parent if backend.name.lower() == "backend" else backend
        return {
            "path": str(root),
            "source": "EVOFLOW_BACKEND_DIR",
            "exists": root.exists(),
            "backend_dir": str(backend),
        }

    here = Path(__file__).resolve()
    for ancestor in here.parents:
        if (ancestor / "evopanel").is_dir() and (ancestor / "backend").is_dir():
            return {"path": str(ancestor), "source": "repo_layout", "exists": True}
        if ancestor.name.lower() in {"site-packages", "dist-packages"}:
            break

    exe = Path(getattr(sys, "executable", "") or "").resolve()
    if exe.is_file():
        return {"path": str(exe.parent), "source": "sys.executable", "exists": True}

    return {"path": None, "source": "unresolved", "exists": False}


def resolve_data_paths() -> dict[str, Any]:
    from evoflow.config.data_paths import resolve_data_base_dir, resolve_data_root

    try:
        base_dir = resolve_data_base_dir()
    except Exception:
        base_dir = Path.home() / ".evoflow"
    try:
        data_dir = resolve_data_root()
    except Exception:
        data_dir = Path(base_dir) / "data"

    home_env = (os.getenv("EVOFLOW_HOME") or "").strip()
    return {
        "data_dir": str(Path(data_dir).resolve()),
        "base_dir": str(Path(base_dir).resolve()),
        "evoflow_home": home_env or None,
        "logs_dir": (os.getenv("EVOFLOW_LOGS_DIR") or "").strip() or None,
    }


def resolve_ports() -> dict[str, Any]:
    """Frontend / backend / related listen ports."""
    from evoflow.gateway_http import gateway_port_from_base, resolve_gateway_base_url

    runtime = _read_backend_runtime()
    gateway_base = resolve_gateway_base_url(allow_legacy_default=False)
    gateway_port = (
        gateway_port_from_base(gateway_base)
        or _parse_port(runtime.get("port"))
        or _env_port("EVOFLOW_GATEWAY_PORT", "EVOFLOW_GATEWAY_BIND_PORT", "PORT")
    )

    frontend_port: int | None = None
    frontend_source = ""
    try:
        from evoflow.webui.auth import get_webui_access_port, get_webui_http_port, gateway_serves_evopanel_webui

        if gateway_port and gateway_serves_evopanel_webui():
            frontend_port = get_webui_access_port(gateway_port)
            frontend_source = "gateway_serves_spa"
        else:
            frontend_port = get_webui_http_port()
            frontend_source = "webui_http_port"
    except Exception:
        frontend_port = _env_port("EVOFLOW_WEBUI_HTTP_PORT", "EVOFLOW_VITE_PORT")
        frontend_source = "env_fallback" if frontend_port else "unresolved"

    langgraph_port = (
        _parse_port(runtime.get("langgraphPort"))
        or _env_port("EVOFLOW_LANGGRAPH_PORT")
    )
    # Only surface app-server when explicitly configured / embedded (stdio desktop may omit TCP).
    app_server_port = _env_port("EVOFLOW_APP_SERVER_PORT")
    if app_server_port is None and (os.getenv("EVOFLOW_EMBED_APP_SERVER") or "").strip() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        try:
            from evoflow.app_server.embed import resolve_app_server_listen_port

            app_server_port = resolve_app_server_listen_port()
        except Exception:
            app_server_port = None

    ports: dict[str, Any] = {
        "backend": gateway_port,
        "frontend": frontend_port,
        "gateway": gateway_port,
        "langgraph": langgraph_port,
        "app_server": app_server_port,
        "frontend_source": frontend_source or None,
        "gateway_base_url": gateway_base or (f"http://127.0.0.1:{gateway_port}" if gateway_port else None),
        "runtime_status": runtime.get("status"),
        "runtime_pid": runtime.get("pid"),
        "runtime_file": runtime.get("_path"),
    }

    system: list[dict[str, Any]] = []
    for role, port in (
        ("backend", gateway_port),
        ("frontend", frontend_port),
        ("langgraph", langgraph_port),
        ("app_server", app_server_port),
    ):
        if port is None:
            continue
        # Deduplicate when frontend shares gateway port (packaged SPA).
        if any(row.get("port") == port and row.get("role") != role for row in system):
            # Keep both roles listed but mark shared
            system.append({"role": role, "port": port, "shared": True})
        else:
            system.append({"role": role, "port": port})
    ports["system"] = system
    return ports


def _probe_service_health() -> dict[str, Any]:
    """In-process health (no HTTP round-trip)."""
    body: dict[str, Any] = {
        "status": "unknown",
        "service": "evo-flow-gateway",
        "pid": os.getpid(),
    }
    try:
        from evoflow.runtime import ports as runtime_ports

        # Off-process (CLI / harness tests): adapters are absent — same as the
        # legacy soft-import miss, report process identity without pretending healthy.
        if not runtime_ports.is_registered("diagnostics.event_loop_lag_seconds"):
            body["status"] = "running"
            body["note"] = "hang_diagnostics unavailable: adapter not registered"
            return body

        if runtime_ports.is_listen_socket_broken():
            body.update(
                {
                    "status": "unhealthy",
                    "reason": "listen_socket_broken",
                    "detail": runtime_ports.listen_socket_broken_detail(),
                }
            )
            return body
        lag = runtime_ports.get_event_loop_lag_seconds()
        body["event_loop_lag_seconds"] = round(lag, 3)
        if runtime_ports.is_event_loop_overloaded():
            body.update({"status": "degraded", "reason": "event_loop_overloaded"})
            return body
        body["status"] = "healthy"
    except Exception as exc:
        # Outside Gateway process (CLI / tests): still report process identity.
        body["status"] = "running"
        body["note"] = f"hang_diagnostics unavailable: {exc}"[:160]
    return body


def _probe_ready_state() -> dict[str, Any]:
    """Best-effort startup readiness from live Gateway app state (if present)."""
    from evoflow.runtime.ports import probe_gateway_ready_state

    return probe_gateway_ready_state()


def _probe_runtime_summary() -> dict[str, Any]:
    """Reuse observability runtime-status summary when Gateway adapters are registered."""
    try:
        from evoflow.runtime.ports import build_runtime_status_payload

        payload = build_runtime_status_payload()
        if not isinstance(payload, dict):
            return {"error": "runtime status adapter not registered"}
        summary = payload.get("summary") if isinstance(payload, dict) else None
        if not isinstance(summary, dict):
            summary = {}
        return {
            "summary": summary,
            "task_queue": {
                k: (payload.get("task_queue") or {}).get(k)
                for k in (
                    "backend_loop_running",
                    "active_unattended",
                    "in_progress",
                    "queued_candidates",
                    "max_concurrent",
                )
            }
            if isinstance(payload.get("task_queue"), dict)
            else None,
            "automation_scheduler": {
                k: (payload.get("automation_scheduler") or {}).get(k)
                for k in ("backend_loop_running", "last_tick_at", "error")
            }
            if isinstance(payload.get("automation_scheduler"), dict)
            else None,
            "timestamp": payload.get("timestamp"),
        }
    except Exception as exc:
        return {"error": str(exc)[:200]}


def _derive_overall(
    service: dict[str, Any],
    ready: dict[str, Any],
    runtime: dict[str, Any],
) -> str:
    status = str(service.get("status") or "").lower()
    if status == "unhealthy":
        return "unhealthy"
    if ready.get("error"):
        return "unhealthy"
    if ready and ready.get("ready") is False:
        return "degraded"
    if status == "degraded":
        return "degraded"
    summary = runtime.get("summary") if isinstance(runtime, dict) else None
    if isinstance(summary, dict):
        # Loops off is degraded only when we successfully read them as False.
        auto = summary.get("automation_running")
        queue = summary.get("task_queue_running")
        if auto is False and queue is False:
            return "degraded"
    if status in {"healthy", "running"}:
        return "healthy"
    return "unknown"


def format_system_status_markdown(snap: dict[str, Any]) -> str:
    ports = snap.get("ports") or {}
    paths = snap.get("paths") or {}
    service = snap.get("service") or {}
    ready = snap.get("ready") or {}
    runtime = snap.get("runtime") or {}
    summary = runtime.get("summary") if isinstance(runtime, dict) else {}
    if not isinstance(summary, dict):
        summary = {}

    overall = snap.get("overall") or "unknown"
    overall_zh = {
        "healthy": "正常",
        "degraded": "降级",
        "unhealthy": "异常",
        "unknown": "未知",
    }.get(str(overall), str(overall))

    def _port_line(label: str, port: Any) -> str:
        return f"- {label}：`{port}`" if port is not None else f"- {label}：未解析"

    system_ports = ports.get("system") or []
    if system_ports:
        bits = []
        for row in system_ports:
            role = row.get("role")
            port = row.get("port")
            shared = "（与其它角色共用）" if row.get("shared") else ""
            bits.append(f"{role} `{port}`{shared}")
        system_line = "、".join(bits)
    else:
        system_line = "未解析"

    lines = [
        "## EvoFlow 系统运行状态",
        f"- 总览：**{overall_zh}**（`{overall}`）",
        f"- 生成时间：{snap.get('generated_at') or datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "### 端口",
        _port_line("后端（Gateway）", ports.get("backend") or ports.get("gateway")),
        _port_line("前端（WebUI / Vite）", ports.get("frontend")),
        f"- 系统端口：{system_line}",
    ]
    if ports.get("langgraph") is not None:
        lines.append(_port_line("LangGraph", ports.get("langgraph")))
    if ports.get("app_server") is not None:
        lines.append(_port_line("App Server", ports.get("app_server")))
    if ports.get("gateway_base_url"):
        lines.append(f"- Gateway URL：`{ports.get('gateway_base_url')}`")

    lines.extend(
        [
            "",
            "### 目录",
            f"- 数据目录：`{paths.get('data_dir') or '未解析'}`",
            f"- 安装目录：`{(snap.get('install') or {}).get('path') or '未解析'}`",
        ]
    )
    if paths.get("base_dir"):
        lines.append(f"- 工作区根：`{paths.get('base_dir')}`")

    svc_status = service.get("status") or "unknown"
    lines.extend(
        [
            "",
            "### 服务状态",
            f"- Gateway：`{svc_status}`（pid `{service.get('pid')}`）",
        ]
    )
    if service.get("event_loop_lag_seconds") is not None:
        lines.append(f"- 事件循环延迟：`{service.get('event_loop_lag_seconds')}s`")
    if service.get("reason"):
        lines.append(f"- 原因：{service.get('reason')}")
    if ready:
        ready_flag = ready.get("ready")
        phase = ready.get("phase") or "—"
        lines.append(f"- 就绪：`{ready_flag}` · phase `{phase}`")
        if ready.get("langgraph") is not None:
            lines.append(f"- LangGraph ready：`{ready.get('langgraph')}`")

    if summary:
        lines.extend(
            [
                "",
                "### 运行负载",
                f"- 自动化调度：{'ON' if summary.get('automation_running') else 'OFF'}",
                f"- 任务队列：{'ON' if summary.get('task_queue_running') else 'OFF'}",
                f"- 活跃会话：`{summary.get('active_sessions_count', 0)}` · 流：`{summary.get('active_streams_count', 0)}`",
                f"- 后台 worker：`{summary.get('active_workers_count', 0)}` · Agent：`{summary.get('active_agents_count', 0)}`",
            ]
        )
        tq = runtime.get("task_queue") if isinstance(runtime, dict) else None
        if isinstance(tq, dict) and tq.get("in_progress") is not None:
            lines.append(
                f"- 队列执行中：`{tq.get('in_progress')}` · 排队：`{tq.get('queued_candidates')}`"
                + (f" · 并发上限：`{tq.get('max_concurrent')}`" if tq.get("max_concurrent") is not None else "")
            )

    web = snap.get("web_search") if isinstance(snap.get("web_search"), dict) else {}
    if web:
        online = "是" if web.get("online_capable") else "否"
        configured = "是" if web.get("configured") else "否"
        lines.extend(
            [
                "",
                "### 联网搜索",
                f"- 已配置：{configured} · 可联网：{online}",
                f"- 状态：`{web.get('status') or 'unknown'}`",
                f"- 生效引擎：`{web.get('active_backend') or '—'}`（来源 `{web.get('active_source') or '—'}`）",
            ]
        )
        if web.get("summary"):
            lines.append(f"- 说明：{web.get('summary')}")
        if web.get("agent_plan_bound"):
            plan_ready = "已就绪" if web.get("agent_plan_ready") else "待接通"
            wired = "套餐 Key 已自动写入" if web.get("wired_from_plan") else "未标记套餐写入"
            lines.append(f"- Agent Plan：{plan_ready} · {wired}")
            if web.get("harness_required"):
                lines.append("- 提醒：需在火山控制台 Harness 开启「豆包搜索」抵扣")
            if web.get("needs_search_key"):
                lines.append("- 待办：套餐 Key 尚未接通到豆包搜索")

    return "\n".join(lines)


def _probe_web_search_status() -> dict[str, Any]:
    """Compact联网搜索 readiness for diagnostics / assistants (no secrets)."""
    try:
        from evoflow.admin.web_search import get_web_search

        snap = get_web_search()
        guide = snap.get("assistant_guide") if isinstance(snap.get("assistant_guide"), dict) else {}
        plan = snap.get("agent_plan_web_search") if isinstance(snap.get("agent_plan_web_search"), dict) else None
        return {
            "configured": bool(guide.get("configured")),
            "online_capable": bool(guide.get("online_capable")),
            "status": guide.get("status") or "unknown",
            "summary": guide.get("summary") or "",
            "active_backend": snap.get("active_backend"),
            "active_source": snap.get("active_source"),
            "preferred_backend": guide.get("preferred_backend"),
            "agent_plan_bound": bool(guide.get("agent_plan_bound") or plan),
            "agent_plan_ready": bool(guide.get("agent_plan_ready") or (plan and plan.get("ready"))),
            "wired_from_plan": bool(guide.get("wired_from_plan") or (plan and plan.get("wired_from_plan"))),
            "doubao_key_configured": bool(guide.get("doubao_key_configured")),
            "doubao_key_source": guide.get("doubao_key_source") or (plan or {}).get("doubao_key_source"),
            "harness_required": bool(guide.get("harness_required") or (plan and plan.get("harness_required"))),
            "needs_search_key": bool(plan and plan.get("needs_search_key")),
        }
    except Exception as exc:
        return {
            "configured": False,
            "online_capable": False,
            "status": "unavailable",
            "summary": f"web_search status unavailable: {exc}"[:160],
        }


def build_system_status_snapshot() -> dict[str, Any]:
    """Assemble a structured live status payload + markdown summary."""
    ports = resolve_ports()
    paths = resolve_data_paths()
    install = resolve_install_dir()
    service = _probe_service_health()
    ready = _probe_ready_state()
    runtime = _probe_runtime_summary()
    web_search = _probe_web_search_status()

    # Prefer live app-server port from Gateway state when present.
    if ready.get("app_server_port") and not ports.get("app_server"):
        ports["app_server"] = ready["app_server_port"]
        ports["system"] = [
            row
            for row in (ports.get("system") or [])
            if row.get("role") != "app_server"
        ] + [{"role": "app_server", "port": ready["app_server_port"]}]

    overall = _derive_overall(service, ready, runtime)
    snap: dict[str, Any] = {
        "ok": True,
        "overall": overall,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "ports": ports,
        "paths": paths,
        "install": install,
        "service": service,
        "ready": ready,
        "runtime": runtime,
        "web_search": web_search,
    }
    snap["markdown"] = format_system_status_markdown(snap)
    return snap
