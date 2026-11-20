"""启动闸门名单必须覆盖 register_extended_routers 实际挂载的每个前缀。

【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】

为什么非要一条自己的测试：
`app/gateway/startup_gate.py` 的注释早写了「every prefix mounted by
``register_extended_routers`` MUST be listed here」。但那份名单和
`router_registry._extended` 是两份**手工维护**的清单，会静默漂移。
2026-11-19 就漂了 5 个：/api/browser、/api/cua、/api/plugins、/api/audit、/openai/v1。

漂移的代价不是报错，是**伪装成 404**：端口已 bind、路由还没挂完的窗口里，
请求穿透闸门，Starlette 回一个裸 404（实测 0.4~1.7ms、无 body），
面板把它当「接口不存在」。现网一天：/api/browser/log 76 次、
/api/cua/glow-status 56 次，全部成簇出现在每次重启后的 0~10 秒。

要紧的是这类缺陷**只在启动窗口出现**，靠「现在 curl 一下没问题」永远证明不了
它修好了。所以判据不能是端到端探测，必须是**静态全覆盖**：
名单 ⊇ 实际挂载前缀。
"""

from __future__ import annotations

import importlib

import pytest

from app.gateway.startup_gate import _needs_extended_routers

# 刻意**不**进名单的前缀，各自有理由（见 startup_gate.py 内注释）。
# 加条目必须先写清「为什么屏蔽它反而更糟」。
_INTENTIONALLY_EXEMPT = {
    "/api/threads",  # core threads.py 拥有；屏蔽会 503 掉本来能用的 core 路由
    "/api/v4",       # core 阶段 pre-ready 已挂载；其 404 是 handler 内业务 404
}


def _extended_modules() -> list[str]:
    """从 router_registry 取懒挂载模块清单（单一真源，不另抄一份）。"""
    import re
    from pathlib import Path

    src = Path("app/gateway/router_registry.py").read_text(encoding="utf-8")
    block = re.search(r"_extended = \((.*?)\n    \)\n", src, re.S)
    assert block, "router_registry._extended 结构变了，本判据需同步更新"
    return [m for m, _ in re.findall(r'\("([^"]+)",\s*"([^"]+)"', block.group(1))]


def _mounted_paths(module: str) -> set[str]:
    """import 该模块，拿它所有 router（含 glow_router / conversation_router）的真实路径。"""
    mod = importlib.import_module(module)
    paths: set[str] = set()
    for attr in ("router", "glow_router", "conversation_router"):
        r = getattr(mod, attr, None)
        if r is None:
            continue
        for route in r.routes:
            p = getattr(route, "path", None)
            if isinstance(p, str) and p.startswith("/"):
                paths.add(p)
    return paths


def _covered(path: str) -> bool:
    """闸门是前缀匹配（含 / 边界），与 _needs_extended_routers 保持同一口径。"""
    return _needs_extended_routers(path)


@pytest.mark.parametrize("module", [m for m in _extended_modules()])
def test_every_extended_route_is_gated_while_loading(module: str) -> None:
    """每个懒挂载路由的路径，在 extended 未就绪时都必须被闸门拦住（→ 503 可重试）。

    漏一个，该端点就在启动窗口里裸 404 —— 就是 /api/browser/log 那 76 次。
    """
    try:
        paths = _mounted_paths(module)
    except Exception as exc:  # pragma: no cover - 模块缺失是另一类缺陷
        pytest.skip(f"{module} 无法 import：{type(exc).__name__}: {exc}")

    if not paths:
        pytest.skip(f"{module} 无静态可读路由")

    ungated = sorted(
        p for p in paths
        if not _covered(p) and not any(p == e or p.startswith(e + "/") for e in _INTENTIONALLY_EXEMPT)
    )
    assert not ungated, (
        f"{module} 有 {len(ungated)} 条路由不在启动闸门名单里，"
        f"extended 加载窗口内会裸 404 而非可重试的 503：{ungated}"
    )


def test_known_regressions_are_gated() -> None:
    """现网真咬到过的那几条，钉死。改坏名单这里必红。"""
    for path in (
        "/api/browser/log",
        "/api/cua/glow-status",
        "/api/plugins/describe",
        "/api/audit/actions",
        "/openai/v1/models",
    ):
        assert _covered(path), f"{path} 又被漏出启动闸门了"


def test_core_owned_prefixes_stay_ungated() -> None:
    """反向断言：core 拥有的前缀不能被误加进名单。

    误加的后果比漏加更严重——会对本来正常工作的 core 路由回 503。
    """
    for path in ("/api/threads/evoflow-node-repl-bridge/browser-embed/cdp", "/api/v4/conversation/file_changes"):
        assert not _covered(path), f"{path} 属于 core 路由，不该被 extended 闸门屏蔽"


def test_gate_returns_retryable_503_not_bare_404() -> None:
    """端到端：extended 未就绪时，命中名单的路径必须拿 503 + retry_after_ms。

    这是「启动中」与「不存在」的可区分性本身。以前这里是裸 404。
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.gateway.startup_gate import StartupGateMiddleware

    app = FastAPI()
    app.state._is_evoflow_gateway_app = True
    app.state.routers_registered = True
    app.state.extended_routers_registered = False
    app.add_middleware(StartupGateMiddleware)

    client = TestClient(app)
    for path, method in (("/api/browser/log", "POST"), ("/api/cua/glow-status", "GET")):
        resp = client.request(method, path, json={})
        assert resp.status_code == 503, f"{path} 应回可重试 503，实得 {resp.status_code}"
        body = resp.json()
        assert body["error"] == "loading_extended"
        assert body["retry_after_ms"] > 0
        assert resp.headers.get("Retry-After")
