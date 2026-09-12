"""Smoke tests for plan verify result shaping (no live network)."""

from evoflow.plans.verify import _fail, _ok, _skip


def test_verify_result_shapes() -> None:
    ok = _ok("chat", label="对话", message="ok", checks=[{"id": "a", "label": "A", "ok": True, "message": "x"}])
    assert ok["ok"] is True
    assert ok["capability"] == "chat"
    assert len(ok["checks"]) == 1

    bad = _fail("embedding", label="向量", message="404")
    assert bad["ok"] is False
    assert "404" in bad["message"]

    skipped = _skip("video", label="生视频", message="本档不含")
    assert skipped["ok"] is None
    assert skipped["skipped"] is True
