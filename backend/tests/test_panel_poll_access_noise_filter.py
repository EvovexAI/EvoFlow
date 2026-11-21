"""PanelPollAccessNoiseFilter：只丢「高频轮询的 2xx 成功行」。

【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
为什么单独立一份测试：这个过滤器的缺陷两次都是「路径对了但方法错了」——
第一版只盖 4 条路径，第二版把 `live-run` 写进表里但方法组只认 GET|POST，
而 live-run 心跳真实走 PUT，于是重启后每天仍有 2964 行落盘。语法门禁对这类缺陷零分辨力，
所以判据必须是「真实 access 行字符串 → 裁决」的矩阵，且必须含**反证**：
不该丢的行（4xx/5xx、危险写操作、非轮询业务请求）必须返回 True。
"""

import logging

import pytest

from app.gateway.logging_setup import PanelPollAccessNoiseFilter

SK = "proactive%3Aself-evolution-bot%3Achat%3A2026-11-19T16-15-39.290Z"


def acc(method: str, path: str, status: int = 200) -> logging.LogRecord:
    msg = f'127.0.0.1:12345 - "{method} {path} HTTP/1.1" {status}'
    return logging.LogRecord(
        name="uvicorn.access", level=logging.INFO, pathname=__file__, lineno=1,
        msg=msg, args=None, exc_info=None,
    )


@pytest.fixture(autouse=True)
def _show_polls_off(monkeypatch):
    monkeypatch.delenv("EVOFLOW_SHOW_PANEL_POLL_LOGS", raising=False)


@pytest.mark.parametrize("method", ["GET", "POST", "PUT", "PATCH", "DELETE"])
@pytest.mark.parametrize(
    "path",
    [
        f"/api/chat/sessions/{SK}/execution/state",
        f"/api/chat/sessions/{SK}/live-run",
        "/health/ready",
        "/health/liveness",
        "/api/cua/glow-status",
        "/api/speech/log",
        "/api/proactive/approvals",
        "/api/session-notifications",
    ],
)
def test_poll_2xx_dropped_for_every_method(method, path):
    """轮询路径 × 任意方法 × 2xx → 丢。方法维度是历史缺陷所在，必须全方法覆盖。"""
    assert PanelPollAccessNoiseFilter().filter(acc(method, path)) is False


@pytest.mark.parametrize("status", [400, 401, 404, 429, 500, 502, 503])
def test_poll_failures_kept(status):
    """轮询失败才是信号：非 2xx 一律保留。"""
    assert PanelPollAccessNoiseFilter().filter(acc("GET", f"/api/chat/sessions/{SK}/live-run", status)) is True


@pytest.mark.parametrize(
    "method,path",
    [
        ("DELETE", f"/api/chat/sessions/{SK}"),          # 删会话：不可逆，必须可见
        ("PATCH", f"/api/chat/sessions/{SK}/title"),     # 改标题：低频业务写
        ("POST", f"/api/chat/sessions/{SK}/messages"),   # 用户消息投递：必须可见
        ("POST", "/api/langgraph/threads/t-1/runs/stream"),
        ("GET", "/api/chat/sessions"),                   # 会话列表：低频
        ("GET", "/api/tasks"),
    ],
)
def test_non_poll_paths_kept(method, path):
    """反证：路径白名单之外的一律保留，否则会静默丢掉事故现场。"""
    assert PanelPollAccessNoiseFilter().filter(acc(method, path)) is True


def test_env_switch_keeps_everything(monkeypatch):
    monkeypatch.setenv("EVOFLOW_SHOW_PANEL_POLL_LOGS", "1")
    assert PanelPollAccessNoiseFilter().filter(acc("PUT", f"/api/chat/sessions/{SK}/live-run")) is True


def test_warning_level_never_dropped():
    r = acc("PUT", f"/api/chat/sessions/{SK}/live-run")
    r.levelno = logging.WARNING
    assert PanelPollAccessNoiseFilter().filter(r) is True


def test_non_access_lines_untouched():
    """非 access 行（没有 "METHOD path HTTP/x" 形状）不能被误伤。"""
    r = logging.LogRecord(
        name="app.gateway.x", level=logging.INFO, pathname=__file__, lineno=1,
        msg="loaded 12 skills from disk", args=None, exc_info=None,
    )
    assert PanelPollAccessNoiseFilter().filter(r) is True


def test_real_world_samples_from_prod_log():
    """现网原文（2026-11-21 日志逐字拷贝）：这几行曾经漏网，必须被丢。"""
    samples = [
        '127.0.0.1:64623 - "PUT /api/chat/sessions/proactive%3Aself-evolution-bot%3Achat%3A2026-11-19T16-15-39.290Z/live-run HTTP/1.1" 200',
        '127.0.0.1:60673 - "DELETE /api/chat/sessions/proactive%3Aself-evolution-bot%3Achat%3A2026-11-19T16-15-39.290Z/live-run HTTP/1.1" 200',
        '127.0.0.1:62920 - "GET /api/chat/sessions/proactive%3Aself-evolution-bot%3Achat%3A2026-11-19T05-07-10.588Z/execution/state HTTP/1.1" 200',
    ]
    f = PanelPollAccessNoiseFilter()
    for s in samples:
        r = logging.LogRecord(
            name="uvicorn.access", level=logging.INFO, pathname=__file__, lineno=1,
            msg=s, args=None, exc_info=None,
        )
        assert f.filter(r) is False, f"未过滤：{s}"
