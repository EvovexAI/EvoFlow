"""Registration begin/poll must work when runtime ports are unset (LangGraph off-process)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import evoflow.runtime.ports as ports
from evoflow.admin.errors import ValidationError
from evoflow.admin import platform_handlers as H


@pytest.fixture(autouse=True)
def _reset_ports():
    ports._impls.clear()
    yield
    ports._impls.clear()


def test_registration_begin_http_fallback_when_port_missing():
    assert ports.get_feishu_registration_client() is None

    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.content = b'{"session_id":"sess1","qr_url":"https://open.feishu.cn/qr","status":"pending"}'
    fake_resp.json.return_value = {
        "session_id": "sess1",
        "qr_url": "https://open.feishu.cn/qr",
        "status": "pending",
    }

    with patch("httpx.Client") as client_cls:
        client_cls.return_value.__enter__.return_value.post.return_value = fake_resp
        session = H._registration_begin("feishu")

    assert session.session_id == "sess1"
    assert session.qr_url == "https://open.feishu.cn/qr"
    assert session.status == "pending"


def test_registration_begin_uses_inprocess_client_when_registered():
    fake_session = SimpleNamespace(
        session_id="local-sess",
        qr_url="https://example.com/local",
        status="pending",
    )

    class _Client:
        async def begin(self):
            return fake_session

    ports.register("channels.feishu_registration_client", _Client())
    session = H._registration_begin("feishu")
    assert session.session_id == "local-sess"
    assert session.qr_url == "https://example.com/local"


def test_registration_begin_http_error_is_validation_error():
    fake_resp = MagicMock()
    fake_resp.status_code = 502
    fake_resp.content = b'{"detail":"upstream boom"}'
    fake_resp.text = '{"detail":"upstream boom"}'
    fake_resp.json.return_value = {"detail": "upstream boom"}

    with patch("httpx.Client") as client_cls:
        client_cls.return_value.__enter__.return_value.post.return_value = fake_resp
        with pytest.raises(ValidationError, match="HTTP 502"):
            H._registration_begin("feishu")


def test_employee_bind_apply_via_gateway_posts_proactive_path():
    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.content = b'{"ok":true,"agent_code":"tutor"}'
    fake_resp.json.return_value = {"ok": True, "agent_code": "tutor"}

    with patch("httpx.Client") as client_cls:
        post = client_cls.return_value.__enter__.return_value.post
        post.return_value = fake_resp
        with patch(
            "evoflow.admin.proactive_http.resolve_proactive_api_base",
            return_value="http://127.0.0.1:8070/api/proactive",
        ):
            out = H._employee_bind_apply_via_gateway("tutor", "feishu", "sess9")

    assert out["ok"] is True
    assert out["agent_code"] == "tutor"
    called_url = post.call_args.args[0]
    assert called_url.endswith("/roles/tutor/feishu/registration/sess9/apply")
