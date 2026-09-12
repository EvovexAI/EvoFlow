"""tiktoken loads must not stall the Gateway event loop via sync downloads."""

from __future__ import annotations

import threading

import pytest

from evoflow.context import compaction_token_utils as mod


@pytest.fixture(autouse=True)
def _reset_encoder_state():
    with mod._ENCODER_LOCK:
        mod._ENCODER_CACHE.clear()
        mod._ENCODER_FAILED.clear()
        mod._ENCODER_LOADING.clear()
    mod._count_cached.cache_clear()
    yield
    with mod._ENCODER_LOCK:
        mod._ENCODER_CACHE.clear()
        mod._ENCODER_FAILED.clear()
        mod._ENCODER_LOADING.clear()
    mod._count_cached.cache_clear()


def test_load_encoding_skips_network_when_blob_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    if mod.tiktoken is None:
        pytest.skip("tiktoken not installed")

    monkeypatch.setattr(mod, "encoding_blob_cached_on_disk", lambda _name: False)

    started = threading.Event()
    release = threading.Event()

    def fake_blocking(name: str):
        started.set()
        release.wait(timeout=2.0)
        enc = object()
        mod._store_encoding_success(name, enc)
        return enc

    monkeypatch.setattr(mod, "_load_encoding_blocking", fake_blocking)

    # Hot path must return immediately (heuristic path), not wait on download.
    assert mod._load_encoding("o200k_base") is None
    assert started.wait(timeout=1.0)
    # Still None while background warm is in flight.
    assert mod._load_encoding("o200k_base") is None
    release.set()


def test_load_encoding_never_blocks_on_disk_either(monkeypatch: pytest.MonkeyPatch) -> None:
    if mod.tiktoken is None:
        pytest.skip("tiktoken not installed")

    monkeypatch.setattr(mod, "encoding_blob_cached_on_disk", lambda _name: True)
    started = threading.Event()

    def fake_blocking(name: str):
        started.set()
        enc = object()
        mod._store_encoding_success(name, enc)
        return enc

    monkeypatch.setattr(mod, "_load_encoding_blocking", fake_blocking)
    assert mod._load_encoding("cl100k_base") is None
    assert started.wait(timeout=1.0)
    # After background warm stores the encoder, hot path returns it.
    for _ in range(50):
        if mod._load_encoding("cl100k_base") is not None:
            break
        threading.Event().wait(0.02)
    assert mod._load_encoding("cl100k_base") is not None


def test_count_text_tokens_degrades_without_encoder(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "_load_encoding", lambda _name: None)
    n = mod.count_text_tokens("你好世界 hello", model="gpt-4o")
    assert n >= 1


def test_warm_token_encodings_records_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    if mod.tiktoken is None:
        pytest.skip("tiktoken not installed")

    monkeypatch.setattr(mod, "_load_encoding_blocking", lambda _name: None)
    out = mod.warm_token_encodings(["o200k_base"], force=True)
    assert out == {"o200k_base": False}


def test_read_file_patch_passes_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    if mod.tiktoken is None:
        pytest.skip("tiktoken not installed")

    mod._READ_FILE_PATCHED = False
    calls: list[tuple] = []

    class _Resp:
        def raise_for_status(self) -> None:
            return None

        @property
        def content(self) -> bytes:
            return b"abc"

    def fake_get(url, timeout=None):
        calls.append((url, timeout))
        return _Resp()

    monkeypatch.setattr("requests.get", fake_get)
    mod._install_tiktoken_read_timeout_patch()
    import tiktoken.load as tiktoken_load

    data = tiktoken_load.read_file("https://example.test/encodings/x.tiktoken")
    assert data == b"abc"
    assert calls and calls[0][1] == (
        mod._tiktoken_connect_timeout(),
        mod._tiktoken_read_timeout(),
    )
