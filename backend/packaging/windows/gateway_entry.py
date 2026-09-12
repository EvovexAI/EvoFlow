"""Windows executable entrypoint for EvoFlow Gateway (dual-mode: gateway / langgraph)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import threading
from pathlib import Path

from app.gateway.startup_trace import startup_mark, startup_reset, startup_set_meta

startup_reset()
startup_mark("gateway_entry.begin", phase="entry")

if sys.platform == "win32":
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ["NO_COLOR"] = "1"
    os.environ["FORCE_COLOR"] = "0"

# PyInstaller --noconsole 会关闭控制台句柄。colorama.init() 在 import 阶段
# 将已关闭句柄包进 AnsiToWin32，后续 logging 经过 colorama 写入时崩溃：
#   ValueError: I/O operation on closed file.
# prepare_frozen_process_stdio() must run before ``import uvicorn`` (see pyi_rth hook too).
if getattr(sys, "frozen", False):
    os.environ["COLORAMA_DISABLE"] = "1"
    try:
        import colorama.initialise  # noqa: F401

        colorama.initialise.atexit_done = True
    except Exception:
        pass
    from evoflow.desktop_stdio import prepare_frozen_process_stdio

    prepare_frozen_process_stdio()
    startup_mark("entry.frozen_stdio", phase="entry")

# HF mirror before any import that may load huggingface_hub (bge embedding warmup).
try:
    from evoflow.knowledge.embedding.hf_env import ensure_hf_hub_env

    ensure_hf_hub_env()
except Exception:
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
startup_mark("entry.hf_env", phase="entry")

# Windows asyncio policy must land before uvicorn creates the event loop.
try:
    from evoflow.platform.asyncio_windows import apply_windows_langgraph_runtime_fixes

    apply_windows_langgraph_runtime_fixes()
except Exception:
    pass
startup_mark("entry.asyncio_fixes", phase="entry")

import uvicorn

startup_mark("entry.uvicorn_imported", phase="entry")


def _default_config_path() -> str:
    if env := os.environ.get("EVOFLOW_CONFIG_PATH"):
        return env
    return str(Path.home() / ".evoflow" / "config.yaml")


def _default_extensions_path() -> str:
    if env := os.environ.get("EVOFLOW_EXTENSIONS_CONFIG_PATH"):
        return env
    return str(Path.home() / ".evoflow" / "extensions_config.json")


def _ensure_runtime_files() -> None:
    cfg = Path(_default_config_path())
    cfg.parent.mkdir(parents=True, exist_ok=True)
    if not cfg.exists():
        # Minimal valid config for desktop first-run bootstrap.
        cfg.write_text(
            "\n".join(
                [
                    "config_version: 5",
                    "log_level: info",
                    "models: []",
                    # Host-direct tools (search_code_index, terminal, read/write) for local workspace.
                    "tools_mode: host_direct",
                    "tool_search:",
                    "  enabled: true",
                    "sandbox:",
                    "  use: evoflow.sandbox.noop:NoopSandboxProvider",
                    "guardrails:",
                    "  enabled: true",
                    "  fail_closed: true",
                    "  provider:",
                    "    use: evoflow.guardrails.builtin:AllowlistProvider",
                    "    config:",
                    "      denied_tools: []",
                    "checkpointer:",
                    "  type: sqlite",
                    "  connection_string: checkpoints.db",
                    "storage:",
                    "  backend: sqlite",
                    "  sqlite_path: evoflow.db",
                    "",
                ]
            ),
            encoding="utf-8",
        )

    ext = Path(_default_extensions_path())
    if not ext.exists():
        ext.parent.mkdir(parents=True, exist_ok=True)
        ext.write_text('{"mcpServers":{},"skills":{}}', encoding="utf-8")


def _apply_bundled_certifi() -> None:
    """PyInstaller one-folder builds must ship cacert.pem for Weixin iLink HTTPS."""
    if not getattr(sys, "frozen", False):
        return
    try:
        import certifi
    except ImportError:
        return
    ca = Path(certifi.where())
    if ca.is_file():
        os.environ.setdefault("SSL_CERT_FILE", str(ca))
        return
    meipass = getattr(sys, "_MEIPASS", None)
    if not meipass:
        return
    bundled = Path(meipass) / "certifi" / "cacert.pem"
    if bundled.is_file():
        os.environ.setdefault("SSL_CERT_FILE", str(bundled))
        os.environ.setdefault("REQUESTS_CA_BUNDLE", str(bundled))


def _find_bundled_chrome_executable(ab_root: Path) -> str | None:
    browsers = ab_root / "browsers"
    if not browsers.is_dir():
        return None
    for ver_dir in sorted(browsers.glob("chrome-*"), reverse=True):
        for name in ("chrome.exe", "chrome"):
            candidate = ver_dir / name
            if candidate.is_file():
                return str(candidate)
    return None


def _apply_bundled_ripgrep() -> None:
    """Prepend bundled ripgrep for frozen desktop builds."""
    if not getattr(sys, "frozen", False):
        return
    exe_dir = Path(sys.executable).resolve().parent
    rg_dir = exe_dir / "tools" / "ripgrep"
    if not rg_dir.is_dir():
        return
    if any((rg_dir / name).is_file() for name in ("rg.exe", "rg")):
        os.environ["PATH"] = str(rg_dir) + os.pathsep + os.environ.get("PATH", "")


def _apply_bundled_agent_browser() -> None:
    """Prepend bundled agent-browser CLI + Chromium for frozen desktop builds."""
    if not getattr(sys, "frozen", False):
        return
    exe_dir = Path(sys.executable).resolve().parent
    ab_root = exe_dir / "tools" / "agent-browser"
    if not ab_root.is_dir():
        return
    bin_dirs = [
        ab_root / "node_modules" / ".bin",
        ab_root / "bin",
    ]
    chrome_exe = _find_bundled_chrome_executable(ab_root)
    if chrome_exe:
        os.environ.setdefault("AGENT_BROWSER_EXECUTABLE_PATH", chrome_exe)
    prefix = os.pathsep.join(str(p) for p in bin_dirs if p.is_dir())
    if prefix:
        os.environ["PATH"] = prefix + os.pathsep + os.environ.get("PATH", "")


def _apply_bundled_evoflow_cli() -> None:
    """Prepend bundled or dev venv ``evoflow`` CLI to PATH for agent terminal sessions."""
    try:
        from evoflow.utils.bundled_tools import apply_evoflow_cli_to_path

        apply_evoflow_cli_to_path()
    except Exception:
        pass


def _is_cli_mode(argv: list[str]) -> bool:
    _entry_dir = str(Path(__file__).resolve().parent)
    if _entry_dir not in sys.path:
        sys.path.insert(0, _entry_dir)
    from cli_argv import is_cli_mode

    return is_cli_mode(argv)


def _cli_argv_without_mode(argv: list[str]) -> list[str]:
    _entry_dir = str(Path(__file__).resolve().parent)
    if _entry_dir not in sys.path:
        sys.path.insert(0, _entry_dir)
    from cli_argv import cli_argv_without_mode

    return cli_argv_without_mode(argv)


def _run_cli_mode() -> None:
    from evoflow.cli.main import main as cli_main

    raise SystemExit(cli_main(_cli_argv_without_mode(list(sys.argv[1:]))))


def _prepare_stdio_for_frozen() -> None:
    """Re-run frozen stdio fix (idempotent). Keeps Tauri log redirection when fds are valid."""
    if not getattr(sys, "frozen", False):
        return
    from evoflow.desktop_stdio import prepare_frozen_process_stdio

    prepare_frozen_process_stdio()


def _reset_logging_before_server() -> None:
    """Drop handlers without logging.shutdown().

      Uvicorn/LangGraph reconfigure logging via dictConfig, which calls shutdown() on
    existing handlers. In frozen builds some StreamHandlers lack ``lock`` and crash with:
      AttributeError: 'StreamHandler' object has no attribute 'lock'
    """
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
        if not hasattr(handler, "lock"):
            handler.lock = threading.RLock()
        try:
            handler.close()
        except Exception:
            pass
    try:
        logging._handlers.clear()  # noqa: SLF001
    except Exception:
        pass
    try:
        if hasattr(logging, "_handlerList"):
            logging._handlerList.clear()  # noqa: SLF001
    except Exception:
        pass


def _ensure_runtime_env() -> None:
    from evoflow.desktop_stdio import apply_windows_stdio_fixes

    apply_windows_stdio_fixes()
    _apply_bundled_certifi()
    _apply_bundled_ripgrep()
    _apply_bundled_agent_browser()
    _apply_bundled_evoflow_cli()
    _prepare_stdio_for_frozen()
    # Keep runtime config in user home so desktop app upgrades do not wipe settings.
    _ensure_runtime_files()
    os.environ.setdefault("EVOFLOW_CONFIG_PATH", _default_config_path())
    os.environ.setdefault("EVOFLOW_EXTENSIONS_CONFIG_PATH", _default_extensions_path())


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="EvoFlow Gateway executable (dual-mode)")
    parser.add_argument(
        "--mode",
        default="gateway",
        choices=["gateway", "langgraph", "cli", "app-server"],
        help="Operating mode",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Gateway bind host")
    parser.add_argument("--port", default=8012, type=int, help="Gateway bind port")
    parser.add_argument("--langgraph-port", default=2024, type=int, help="LangGraph bind port (langgraph mode)")
    parser.add_argument(
        "--listen",
        default="",
        help="app-server mode: empty/stdio = JSONL on stdio (runtime default); HOST:PORT = TCP JSONL",
    )
    parser.add_argument(
        "--gateway-url",
        default="",
        help="app-server mode: Gateway base URL to proxy turn/start",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        help="Uvicorn log level",
    )
    return parser.parse_args()


def _run_langgraph(port: int) -> None:
    """Run standalone LangGraph server on the given port."""
    from langgraph_api.cli import run_server

    from evoflow.langgraph_runtime_env import run_server_kwargs

    kwargs = run_server_kwargs()
    kwargs["port"] = port
    logging.info("Starting EvoFlow LangGraph server on port %s", port)
    run_server(**kwargs)


def _create_gateway_app():
    """Factory wrapper with cold-start timing (import app.gateway.app is the main cost)."""
    from app.gateway.startup_trace import startup_mark

    startup_mark("factory.import_begin", phase="factory")
    from app.gateway.app import create_app as _create_app

    startup_mark("factory.app_imported", phase="factory")
    app = _create_app(defer_routers=True)
    startup_mark("factory.create_app_done", phase="factory", extra={"routes": len(app.routes)})
    return app


def main() -> None:
    startup_mark("entry.main_enter", phase="entry")
    # CLI subcommands (automation list, agents list, …) must NOT go through the
    # gateway ArgumentParser — it only knows --mode/--host/--port and would
    # reject them as "unrecognized arguments" before _run_cli_mode runs.
    if _is_cli_mode(sys.argv[1:]):
        _ensure_runtime_env()
        _run_cli_mode()
        return

    args = _parse_args()
    _ensure_runtime_env()

    if args.mode == "langgraph":
        _reset_logging_before_server()
        _run_langgraph(args.langgraph_port)
        return

    if args.mode == "app-server":
        from evoflow.app_server.stdio_rpc import main_argv

        listen = (args.listen or "").strip()
        gateway_url = (args.gateway_url or "").strip()
        if not gateway_url:
            gateway_url = f"http://127.0.0.1:{int(args.port)}"
        argv: list[str] = ["--gateway-url", gateway_url]
        listen_l = listen.lower()
        # runtime default: stdio. Only pass --listen for real TCP endpoints.
        if listen and listen_l not in ("stdio", "stdio://", "off", "-"):
            argv.extend(["--listen", listen])
        raise SystemExit(main_argv(argv))

    # Gateway mode: run FastAPI gateway (LangGraph in-process by default)
    os.environ.setdefault("EVOFLOW_GATEWAY_PORT", str(args.port))
    os.environ.setdefault("EVOFLOW_APP_SERVER_PORT", str(int(args.port) + 1))
    if not os.environ.get("EVOFLOW_LANGGRAPH_URL"):
        os.environ["EVOFLOW_LANGGRAPH_URL"] = f"http://127.0.0.1:{args.port}/api/langgraph"
        logging.info(
            "Auto-set EVOFLOW_LANGGRAPH_URL=http://127.0.0.1:%s/api/langgraph (in-process mode)",
            args.port,
        )
    else:
        from evoflow.langgraph_deployment import is_external_langgraph_mode

        if is_external_langgraph_mode():
            logging.info(
                "LangGraph external mode: EVOFLOW_LANGGRAPH_URL=%s (Gateway %s:%s)",
                os.environ.get("EVOFLOW_LANGGRAPH_URL"),
                args.host,
                args.port,
            )

    bind_host = args.host
    if bind_host in ("127.0.0.1", "localhost", "::1"):
        # Never block listen on SQLite: under lock contention `_load_webui_enabled`
        # previously stalled ~60–90s before uvicorn bound → Vite ECONNREFUSED :8070.
        # Desktop stdio keeps loopback; WebUI 0.0.0.0 bind can be forced via env.
        force_all = (os.environ.get("EVOFLOW_GATEWAY_BIND") or "").strip()
        if force_all in ("0.0.0.0", "::", "*"):
            bind_host = "0.0.0.0"
            logging.info("EVOFLOW_GATEWAY_BIND=%s — binding Gateway to 0.0.0.0", force_all)
        elif (os.environ.get("EVOFLOW_APP_SERVER_STDIO") or "").strip().lower() in (
            "1",
            "true",
            "yes",
            "on",
        ):
            logging.debug("desktop stdio mode — keep Gateway bind %s (skip WebUI DB bind rewrite)", bind_host)
        else:
            try:
                import threading

                from evoflow.webui.auth import _load_webui_enabled, is_webui_enabled

                box: list[bool] = [False]

                def _probe() -> None:
                    try:
                        _load_webui_enabled()
                        box[0] = bool(is_webui_enabled())
                    except Exception:
                        pass

                th = threading.Thread(target=_probe, name="webui-bind-probe", daemon=True)
                th.start()
                th.join(0.75)
                if th.is_alive():
                    logging.warning(
                        "WebUI bind-host DB probe timed out (SQLite busy?) — keeping %s",
                        bind_host,
                    )
                elif box[0]:
                    bind_host = "0.0.0.0"
                    logging.info("WebUI remote access enabled — binding Gateway to 0.0.0.0")
            except Exception:
                logging.debug("WebUI bind-host check skipped", exc_info=True)

    from app.gateway.logging_setup import configure_gateway_file_logging

    configure_gateway_file_logging(log_name="gateway.log", force=True)

    logging.info("Starting EvoFlow Gateway on %s:%s (LangGraph in-process)", bind_host, args.port)

    _reset_logging_before_server()
    configure_gateway_file_logging(log_name="gateway.log", force=True)
    startup_set_meta(
        mode=args.mode,
        host=bind_host,
        port=args.port,
        log_level=args.log_level,
    )
    startup_mark("entry.uvicorn_run", phase="entry")
    from evoflow.platform.asyncio_windows import run_uvicorn_with_windows_shutdown_guard, serve_uvicorn_config

    # CRITICAL: schema + fat router imports hold the CPython GIL. Doing them after
    # the event loop is live starves HTTP (port listens, probes die, CLOSE_WAIT).
    try:
        from app.gateway.cold_start_prewarm import prewarm_gateway_before_event_loop

        prewarm_gateway_before_event_loop()
    except Exception:
        logging.exception("Gateway cold-start prewarm failed (continuing to bind)")

    config = uvicorn.Config(
        _create_gateway_app,
        factory=True,
        host=bind_host,
        port=args.port,
        log_level=args.log_level,
        access_log=True,
    )

    import atexit

    from app.gateway.startup_trace import note_gateway_exit

    atexit.register(lambda: note_gateway_exit("atexit", detail="process atexit handlers running"))

    _prev_excepthook = sys.excepthook

    def _gateway_excepthook(exc_type, exc, tb):  # type: ignore[no-untyped-def]
        try:
            note_gateway_exit(
                "excepthook",
                detail=f"{getattr(exc_type, '__name__', exc_type)}: {exc}",
            )
        except Exception:
            pass
        _prev_excepthook(exc_type, exc, tb)

    sys.excepthook = _gateway_excepthook

    try:
        stdio_mode = str(os.environ.get("EVOFLOW_APP_SERVER_STDIO") or "").strip().lower() in (
            "1",
            "true",
            "yes",
            "on",
        )
        gateway_url = f"http://127.0.0.1:{int(args.port)}"
        os.environ.setdefault("EVOFLOW_GATEWAY_URL", gateway_url)

        if stdio_mode:
            logging.info(
                "Desktop asset-hub memory mode: Gateway HTTP + app-server JSON-RPC on stdio (%s)",
                gateway_url,
            )

            async def _serve_http_and_stdio() -> None:
                from app.gateway.cold_start_prewarm import wait_core_routers_ready
                from evoflow.app_server.stdio_rpc import serve_stdio_async

                http_task = asyncio.create_task(serve_uvicorn_config(config))

                # Don't pump stdio RPC until core routes exist — early Tauri traffic
                # otherwise competes with lifespan on the same loop.
                async def _stdio_after_core() -> int:
                    ready = await asyncio.to_thread(wait_core_routers_ready, 180.0)
                    if not ready:
                        logging.warning(
                            "stdio: core routers not ready within 180s — starting anyway"
                        )
                    return await serve_stdio_async(gateway_base_url=gateway_url)

                stdio_task = asyncio.create_task(_stdio_after_core())
                done, pending = await asyncio.wait(
                    {http_task, stdio_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                for task in done:
                    exc = task.exception() if not task.cancelled() else None
                    if exc is not None:
                        raise exc

            def _run_server() -> None:
                asyncio.run(_serve_http_and_stdio())
        else:

            def _run_server() -> None:
                asyncio.run(serve_uvicorn_config(config))

        run_uvicorn_with_windows_shutdown_guard(_run_server)
        note_gateway_exit("uvicorn_returned", detail="server serve() returned normally")
    except KeyboardInterrupt:
        note_gateway_exit("keyboard_interrupt", detail="Ctrl+C / KeyboardInterrupt")
        raise
    except SystemExit as exc:
        note_gateway_exit("system_exit", detail=f"code={exc.code}")
        raise
    except BaseException as exc:
        note_gateway_exit("uncaught_exception", detail=f"{type(exc).__name__}: {exc}")
        raise


if __name__ == "__main__":
    main()
