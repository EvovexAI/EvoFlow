"""CUA top-indicator in-process state (ZCode windowsCuaOperationIndicator driver)."""

from evoflow.collab.cua_glow_state import (
    AUTO_HIDE_MS,
    clear_cua_glow,
    get_cua_glow_status,
    pulse_cua_glow_end,
    pulse_cua_glow_start,
    set_cua_glow,
)


def test_cua_glow_start_end_keeps_grace():
    """ZCode: cell end must NOT hard-hide — 30s grace keeps active=True."""
    clear_cua_glow()
    assert get_cua_glow_status()["active"] is False

    a = pulse_cua_glow_start(key="call-1")
    assert a["active"] is True
    assert a["running"] == 1

    b = pulse_cua_glow_start(key="call-2")
    assert b["running"] == 2

    c = pulse_cua_glow_end(key="call-1")
    assert c["active"] is True
    assert c["running"] == 1

    d = pulse_cua_glow_end(key="call-2")
    # Last cell ended → still visible during AUTO_HIDE grace.
    assert d["active"] is True
    assert d["running"] == 0
    assert d["grace_ms_left"] is not None and d["grace_ms_left"] > 0
    assert d["auto_hide_ms"] == int(AUTO_HIDE_MS)


def test_cua_glow_clear_all():
    pulse_cua_glow_start(key="x")
    pulse_cua_glow_start(key="y")
    out = clear_cua_glow()
    assert out["active"] is False
    assert out["running"] == 0


def test_set_cua_glow_compat_empty_key_clears():
    set_cua_glow(active=True, key="x")
    out = set_cua_glow(active=False, key="")
    assert out["active"] is False
