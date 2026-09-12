"""Test that security handlers accept module kwarg from eval framework."""
from __future__ import annotations


def test_scan_data_leaks_accepts_module():
    """scan_data_leaks should accept module kwarg without TypeError."""
    from evoflow.eval.security import scan_data_leaks

    # This is what eval_engine passes when module taxonomy is applied
    result = scan_data_leaks(module="obs_security")
    assert isinstance(result, dict)
    assert "total_findings" in result


def test_get_permission_matrix_accepts_module():
    """get_permission_matrix should accept module kwarg without TypeError."""
    from evoflow.eval.security import get_permission_matrix

    result = get_permission_matrix(module="obs_security")
    assert isinstance(result, dict)
    assert "roles" in result


def test_check_security_config_accepts_module():
    """check_security_config should accept module kwarg without TypeError."""
    from evoflow.eval.security import check_security_config

    result = check_security_config(module="obs_security")
    assert isinstance(result, dict)
    assert "vulnerabilities" in result


def test_all_security_handlers_accept_module_kwarg():
    """All three security handlers must accept module kwarg."""
    from evoflow.eval.security import (
        check_security_config,
        get_permission_matrix,
        scan_data_leaks,
    )

    handlers = [scan_data_leaks, get_permission_matrix, check_security_config]
    for handler in handlers:
        # Should not raise TypeError
        handler(module="obs_security")
