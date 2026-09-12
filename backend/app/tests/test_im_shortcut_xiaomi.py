"""IM shortcut hint should not attach to 小V replies."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

_backend = Path(__file__).resolve().parents[2]
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))
_harness = _backend / "packages" / "harness"
if str(_harness) not in sys.path:
    sys.path.insert(0, str(_harness))


def test_im_agent_is_xiaomi_by_agent_name():
    from app.channels.manager import _im_agent_is_xiaomi

    msg = SimpleNamespace(metadata={})
    assert _im_agent_is_xiaomi({"agent_name": "xiaomi"}, msg) is True
    assert _im_agent_is_xiaomi({"agent_name": "main"}, msg) is False


def test_im_agent_is_xiaomi_by_account_id():
    from app.channels.manager import _im_agent_is_xiaomi

    msg = SimpleNamespace(metadata={"account_id": "xiaomi"})
    assert _im_agent_is_xiaomi({"agent_name": "main"}, msg) is True
