from pathlib import Path
from unittest.mock import patch

from evoflow.config.agent_orchestration_config import load_agent_orchestration_config_from_dict
from evoflow.context import file_read_cache as cache


def test_get_store_roundtrip(tmp_path: Path):
    load_agent_orchestration_config_from_dict({"file_read_cache": {"enabled": True}})
    cache.clear_file_read_cache()
    f = tmp_path / "a.txt"
    f.write_text("hello", encoding="utf-8")
    assert cache.get_cached_text(f) is None
    cache.store_cached_text(f, "hello")
    assert cache.get_cached_text(f) == "hello"


def test_ttl_expiry(tmp_path: Path):
    load_agent_orchestration_config_from_dict({"file_read_cache": {"enabled": True, "ttl_seconds": 5, "max_entries": 16}})
    cache.clear_file_read_cache()
    f = tmp_path / "b.txt"
    f.write_text("x", encoding="utf-8")
    t0 = 1000.0
    with patch("evoflow.context.file_read_cache.time.time", side_effect=[t0, t0, t0 + 10, t0 + 10]):
        cache.store_cached_text(f, "cached")
        assert cache.get_cached_text(f) == "cached"
        assert cache.get_cached_text(f) is None


def test_invalidate_path(tmp_path: Path):
    load_agent_orchestration_config_from_dict({"file_read_cache": {"enabled": True}})
    cache.clear_file_read_cache()
    f = tmp_path / "c.txt"
    f.write_text("z", encoding="utf-8")
    cache.store_cached_text(f, "z")
    cache.invalidate_path(f)
    assert cache.get_cached_text(f) is None
