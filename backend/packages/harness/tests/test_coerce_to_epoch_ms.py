"""Tests for mixed legacy timestamp coercion."""

from evoflow.persistence.timestamps import coerce_to_epoch_ms


def test_coerce_to_epoch_ms_parses_beijing_iso():
    iso = "2026-06-01T20:16:28.072000+08:00"
    ms = coerce_to_epoch_ms(iso)
    assert ms > 1_700_000_000_000


def test_coerce_to_epoch_ms_accepts_epoch_ms():
    assert coerce_to_epoch_ms(1_700_000_000_000) == 1_700_000_000_000


def test_coerce_to_epoch_ms_empty_uses_default():
    assert coerce_to_epoch_ms("", default_ms=99) == 99
    assert coerce_to_epoch_ms(None, default_ms=42) == 42
