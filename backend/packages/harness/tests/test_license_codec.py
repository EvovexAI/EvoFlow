"""Unit tests for Ed25519 license codec + entitlements."""

from __future__ import annotations

import gc
import re
import tempfile
import time
from pathlib import Path

import pytest

from evoflow.config.app_config import reset_app_config
from evoflow.license.codec import (
    LicenseCodecError,
    issue_activation_code,
    resolve_bind_machine_id,
    verify_activation_code,
)
from evoflow.license.entitlements import (
    build_activated_state,
    get_license_status,
    is_premium_active,
    premium_denial_code,
)
from evoflow.license.keys import (
    BUILTIN_LICENSE_PUBLIC_KEY_B64,
    clear_key_cache,
    generate_keypair,
)
from evoflow.license.machine import clear_machine_id_cache, get_machine_id
from evoflow.license.store import clear_license_state, set_license_state
from evoflow.persistence.db import get_db, reset_db_for_tests

@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        db_path = root / "data" / "app" / "evoflow.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        priv, pub, mac = generate_keypair()
        monkeypatch.setenv("EVOFLOW_HOME", str(root))
        monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
        monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
        monkeypatch.setenv("EVOFLOW_LICENSE_PRIVATE_KEY", priv)
        monkeypatch.setenv("EVOFLOW_LICENSE_PUBLIC_KEY", pub)
        monkeypatch.setenv("EVOFLOW_LICENSE_CODE_MAC", mac)
        monkeypatch.setattr(
            "evoflow.license.entitlements.ENFORCE_LICENSE_VERIFY",
            True,
        )
        clear_key_cache()
        clear_machine_id_cache()
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield root
        reset_db_for_tests()
        reset_app_config()
        clear_machine_id_cache()
        clear_key_cache()
        gc.collect()


def test_issue_requires_private_key(sqlite_tmp, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EVOFLOW_LICENSE_PRIVATE_KEY", raising=False)
    monkeypatch.setattr(
        "evoflow.license.keys._read_private_key_b64_from_file",
        lambda: "",
    )
    clear_key_cache()
    with pytest.raises(LicenseCodecError) as ei:
        issue_activation_code(expires_at_unix=int(time.time()) + 1000)
    assert ei.value.code == "no_private_key"


def test_issue_and_verify_roundtrip(sqlite_tmp):
    mid = get_machine_id()
    exp = int(time.time()) + 86400
    code = issue_activation_code(machine_id=mid, expires_at_unix=exp)
    assert code.startswith("EF3")
    assert re.fullmatch(r"[A-Z0-9\-]+", code)
    # Compact body (no dashes): short HMAC code, far under old EF2 ~160 chars.
    compact = re.sub(r"[^A-Z0-9]", "", code)
    assert 20 <= len(compact) <= 45
    claims = verify_activation_code(code, expected_machine_id=mid)
    assert claims.machine_id == mid
    assert not claims.floating
    assert claims.expires_at_unix == exp
    assert "premium" in claims.features


def test_floating_code_binds_on_first_use(sqlite_tmp):
    mid = get_machine_id()
    code = issue_activation_code(expires_at_unix=int(time.time()) + 86400)
    claims = verify_activation_code(code, expected_machine_id=mid)
    assert claims.floating
    assert claims.machine_id == ""
    bind = resolve_bind_machine_id(claims, mid)
    assert bind == mid


def test_reject_tampered_code(sqlite_tmp):
    code = issue_activation_code(expires_at_unix=int(time.time()) + 1000)
    compact = re.sub(r"[^A-Z0-9]", "", code.upper())
    flip = "A" if compact[-1] != "A" else "B"
    bad = compact[:-1] + flip
    with pytest.raises(LicenseCodecError) as ei:
        verify_activation_code(bad, expected_machine_id=get_machine_id())
    assert ei.value.code == "bad_signature"


def test_reject_foreign_keypair(sqlite_tmp, monkeypatch: pytest.MonkeyPatch):
    """Code MAC'd by another private key must fail against builtin code MAC."""
    foreign_priv, _foreign_pub, _foreign_mac = generate_keypair()
    monkeypatch.setenv("EVOFLOW_LICENSE_PRIVATE_KEY", foreign_priv)
    clear_key_cache()
    code = issue_activation_code(expires_at_unix=int(time.time()) + 1000)
    # Verify still uses builtin code MAC (env MAC not set)
    priv, pub, mac = generate_keypair()
    monkeypatch.setenv("EVOFLOW_LICENSE_PRIVATE_KEY", priv)
    monkeypatch.setenv("EVOFLOW_LICENSE_PUBLIC_KEY", pub)
    monkeypatch.setenv("EVOFLOW_LICENSE_CODE_MAC", mac)
    clear_key_cache()
    assert BUILTIN_LICENSE_PUBLIC_KEY_B64
    with pytest.raises(LicenseCodecError) as ei:
        verify_activation_code(code, expected_machine_id=get_machine_id())
    assert ei.value.code == "bad_signature"


def test_reject_wrong_machine(sqlite_tmp, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("evoflow.license.codec.ENFORCE_MACHINE_BIND", True)
    mid = get_machine_id()
    code = issue_activation_code(machine_id=mid, expires_at_unix=int(time.time()) + 1000)
    with pytest.raises(LicenseCodecError) as ei:
        verify_activation_code(code, expected_machine_id="0123456789ABCDEF")
    assert ei.value.code == "machine_mismatch"


def test_reject_expired(sqlite_tmp):
    code = issue_activation_code(expires_at_unix=int(time.time()) - 10)
    with pytest.raises(LicenseCodecError) as ei:
        verify_activation_code(code, expected_machine_id=get_machine_id())
    assert ei.value.code == "expired"


def test_entitlement_active_and_expired(sqlite_tmp):
    mid = get_machine_id()
    assert not is_premium_active()
    assert premium_denial_code() == "license_required"

    set_license_state(
        build_activated_state(
            machine_id=mid,
            expires_at_unix=int(time.time()) + 3600,
            features=("premium",),
            code_fp="sha256:test",
        )
    )
    st = get_license_status()
    assert st.activated and st.status == "active"
    assert is_premium_active()
    d = st.to_dict()
    assert d["premium"] is True
    assert isinstance(d["days_remaining"], int)
    assert d["days_remaining"] >= 0
    assert isinstance(d["duration_days"], int)
    assert d["duration_days"] >= 1

    set_license_state(
        build_activated_state(
            machine_id=mid,
            expires_at_unix=int(time.time()) - 10,
            features=("premium",),
            code_fp="sha256:test",
        )
    )
    st2 = get_license_status()
    assert not st2.activated and st2.status == "expired"
    assert premium_denial_code() == "license_expired"

    clear_license_state()
    assert not is_premium_active()
