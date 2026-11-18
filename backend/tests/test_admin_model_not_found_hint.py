"""`settings.get_model` / `settings.set_primary_model` 报 Model not found 时必须给出候选名。

【self-evolution-bot · 2026-11-18 · 第52轮 · 模型:deepseek-v4.1-flash-1017】

## 为什么

现网 obs 实证（2026-11-18 当日 `platform` 报错之一）：
```
{"ok": false, "error": "Model 'qwen3.8-flash' not found", "action": "settings.get_model"}
```
这条只说了「没有」，没说「现有的是哪些」——调用方只能先调一次
`settings.list_models` 再回来重试，白绕一步。

同一个 admin 层里 `unknown action` 分支（`platform_actions.py:1585`）早就带
`suggestions`；这条只是同一套能力的漏接，不是设计如此。

判据：报错文案里必须同时出现
1. 用户传错的那个名字（可自查）；
2. 至少一个**真实存在**的模型名（可直接改用）；
3. 下一步动作（list_models / create_model）。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from evoflow.admin import models as M
from evoflow.admin.errors import NotFoundError


class _Cfg:
    def __init__(self, names: list[str]):
        self.models = [SimpleNamespace(name=n) for n in names]

    def get_model_config(self, name: str):
        for m in self.models:
            if m.name == name:
                return m
        return None


@pytest.fixture()
def cfg_two_models(monkeypatch):
    cfg = _Cfg(["deepseek-v4.1-flash-1017", "doubao-seed-1.6"])
    monkeypatch.setattr(M, "get_app_config", lambda: cfg)
    return cfg


def test_get_model_error_lists_available_models(cfg_two_models):
    with pytest.raises(NotFoundError) as ei:
        M.get_model("qwen3.8-flash")
    msg = str(ei.value)
    assert "qwen3.8-flash" in msg, "必须回显用户传错的名字"
    assert "deepseek-v4.1-flash-1017" in msg, "必须列出真实存在的模型名"
    assert "list_models" in msg, "必须给出下一步动作"


def test_set_primary_model_error_lists_available_models(cfg_two_models):
    with pytest.raises(NotFoundError) as ei:
        M.set_primary_model("qwen3.8-flash")
    msg = str(ei.value)
    assert "qwen3.8-flash" in msg
    assert "doubao-seed-1.6" in msg
    assert "list_models" in msg


def test_no_models_configured_says_how_to_add(monkeypatch):
    """一个模型都没配时，不能给空候选列表——要说清该怎么加。"""
    monkeypatch.setattr(M, "get_app_config", lambda: _Cfg([]))
    with pytest.raises(NotFoundError) as ei:
        M.get_model("anything")
    msg = str(ei.value)
    assert "no models are configured" in msg
    assert "settings.create_model" in msg


def test_message_lists_each_model_once(cfg_two_models):
    """候选名不得重复——重复列表说明取源取错了。"""
    with pytest.raises(NotFoundError) as ei:
        M.get_model("nope")
    msg = str(ei.value)
    assert msg.count("doubao-seed-1.6") == 1
