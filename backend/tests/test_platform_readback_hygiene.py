"""platform 读接口三处「静默不合理」的回归锁。

【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】

这三条都不是崩溃，是**返回了错的东西**，所以任何纯编译/冒烟都抓不到：

1. ``settings.list_models`` / ``settings.get_model`` 把 **明文 api_key** 回给调用方。
   根因是 ``admin/models._mask_api_key`` 名叫 mask 却 ``return api_key``——现网实测
   一条 68 字符的 ``sk-sp-…`` 全裸进了模型上下文。同仓 gateway 路由与
   ``credential_sanitize.is_masked_api_key`` 早就实现过掩码，属单点漏接。
2. ``agents.list`` 在 57 个 agent 上回 183KB，其中 **133KB（73%）是每个人的
   ``system_prompt`` 全文**。list 的语义是「有谁」；需要正文走 ``agents.get``。
   同函数里 ``include_soul`` 早就按此收窄，唯独 system_prompt 没受控。
3. ``employees.messages`` 每条消息 ``created_at`` 恒为 null——display 行只带
   ``created_at_ms``，而读侧只取 ``created_at``，字段名对不上。

判据都写成「可证伪」的形式：拿真实序列化结果量体积 / 量 null 数，而不是断言
「函数被调用了」。
"""

from __future__ import annotations

import json

import pytest


def test_model_readback_masks_api_key():
    """任何模型读接口都不许把明文密钥交出去，且掩码必须能被 is_masked_api_key 认出。"""
    from evoflow.admin import models as models_admin
    from evoflow.models.credential_sanitize import is_masked_api_key

    rows = models_admin.list_models().get("models") or []
    if not rows:
        pytest.skip("本机没有配置模型")
    with_key = [r for r in rows if r.get("api_key")]
    if not with_key:
        pytest.skip("本机模型都没配 api_key")

    for row in with_key:
        key = str(row["api_key"])
        assert "****" in key, f"{row.get('name')} 的 api_key 没掩码: {key!r}"
        # 关键：掩码必须被写回侧识别为「掩码」，否则 update 会把 **** 存进配置。
        assert is_masked_api_key(key), f"{row.get('name')} 的掩码不被 is_masked_api_key 认可: {key!r}"
        # 明文长度不可能只有掩码这么点；真泄漏时这里会明显超长。
        assert len(key) <= max(len(str(row.get("name") or "")), 8) + 8, (
            f"{row.get('name')} 的 api_key 看起来仍是明文: len={len(key)}"
        )

    # get_model 同一序列化点，也要过。
    name = str(with_key[0].get("name") or "").strip()
    got = models_admin.get_model(name)
    assert isinstance(got, dict)
    assert "****" in str(got.get("api_key") or "")


def test_agents_list_omits_system_prompt_by_default():
    """list 默认不回 system_prompt 全文，只给字数；include_prompt=True 才回。"""
    from evoflow.admin import agents as agents_admin

    slim = agents_admin.list_agents()
    rows = slim.get("agents") or []
    if not rows:
        pytest.skip("没有任何 agent")
    assert not any(r.get("system_prompt") for r in rows), "list 默认仍带 system_prompt 全文"
    assert all("system_prompt_chars" in r for r in rows), "缺少 system_prompt_chars 提示"

    slim_bytes = len(json.dumps(slim, ensure_ascii=False).encode())
    full = agents_admin.list_agents(include_prompt=True)
    full_bytes = len(json.dumps(full, ensure_ascii=False).encode())

    # 打开后必须真的把正文带回来（否则这个开关是假的）。
    assert any(r.get("system_prompt") for r in (full.get("agents") or [])), "include_prompt 没生效"
    assert full_bytes > slim_bytes, "include_prompt=True 未带来任何额外体积，开关形同虚设"
    # 体积必须显著降下来（现网 183KB → 51KB）。留足余量避免脆测试。
    assert slim_bytes < full_bytes * 0.85, (
        f"list 收窄无效：slim={slim_bytes}B full={full_bytes}B"
    )


def test_display_rows_carry_created_at_ms():
    """display 行必须带时间，否则「最近几条消息」看不出先后。"""
    from evoflow.persistence.chat_message_repositories import _row_to_display_dict

    row = {
        "seq": 1,
        "role": "assistant",
        "content_json": json.dumps({"text": "hi"}),
        "created_at_ms": 1795020269095,
    }
    msg = _row_to_display_dict(row)
    assert msg.get("created_at_ms") == 1795020269095

    # 没时间戳的行不许凭空造一个。
    msg2 = _row_to_display_dict({"seq": 2, "role": "assistant", "content_json": "{}"})
    assert "created_at_ms" not in msg2

# 【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
# 补两条：这两处我上一轮**只在摘要里写了"已修"，实测根本没接上**——
#   * skills.list 传 limit=2 与不传完全同款（97 条 / 60071 字节），handler 从未读 limit；
#   * employees.messages 的 created_at 全为 null，因为 display 行的 ISO 键叫 timestamp，
#     而消费方只读 created_at / createdAt。
# 判据按现网数据算，不看"代码里有没有那行字"。


def test_skills_list_actually_applies_limit():
    """传 limit 必须真的截断，且带 total/has_more（不许静默忽略）。"""
    import json

    from evoflow.admin.platform_handlers import skills_list

    full = skills_list({})
    capped = skills_list({"limit": 2})

    assert capped["count"] == 2
    assert len(capped["skills"]) == 2
    assert capped["total"] == full["total"]
    assert capped["has_more"] is True
    # 体积必须真的掉下来，否则"截断"只是计数骗人
    assert len(json.dumps(capped, ensure_ascii=False).encode()) < len(
        json.dumps(full, ensure_ascii=False).encode()
    )


def test_skills_list_offset_pages_without_overlap():
    """offset 必须翻页，且先过滤后分页。"""
    from evoflow.admin.platform_handlers import skills_list

    page1 = skills_list({"limit": 2})
    page2 = skills_list({"limit": 2, "offset": 2})
    names1 = [s.get("name") for s in page1["skills"]]
    names2 = [s.get("name") for s in page2["skills"]]
    assert names1 and names2
    assert not set(names1) & set(names2)


def test_employee_messages_carry_created_at():
    """employees.messages 的时间不许恒为 null（显示行的键叫 timestamp）。"""
    from evoflow.admin.employees import list_chat_messages

    data = list_chat_messages("release-engineer", limit=3)
    stamps = [m.get("created_at") for m in data.get("messages") or []]
    assert stamps, "no messages returned"
    assert any(s for s in stamps), f"all created_at empty: {stamps}"

# 【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
# verification.catalog 原返回 101420 字节，其中「每个域节点再挂一份完整 items」
# 与顶层 items 是同一批字典重复序列化，白占 45931 字节；且默认排除 verification
# 域后报 172，而 platform.catalog 报 180，**谁也不说差在哪**。


def test_verification_catalog_has_no_duplicated_items():
    """域节点只给 apis 短名单，不许再挂整份 items（重复序列化）。"""
    from evoflow.admin.platform_handlers import verification_catalog

    data = verification_catalog({})
    for dom in data["domains"]:
        assert "items" not in dom, f"{dom['domain']} 又挂了一份 items"
        assert dom["apis"], f"{dom['domain']} 丢了 apis"
    # 顶层 items 必须保留：start_round 读的是 catalog["items"]
    assert data["items"], "顶层 items 被误删，start_round 会拿不到种子"


def test_verification_catalog_reports_excluded_domain():
    """默认排除的域必须显式上报，否则 total 172 vs 180 无法自行解释。"""
    from evoflow.admin.platform_handlers import verification_catalog

    default = verification_catalog({})
    included = verification_catalog({"includeVerification": True})

    assert default["excludedDomains"] == ["verification"]
    assert default["registryTotal"] == included["total"]
    assert default["total"] < included["total"]
    assert "include_verification" in default["excludedNote"]
    assert included["excludedDomains"] == []

# 【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
# 接口层两处「说了不实的话」，都是现网真调撞出来的：
#   1. 只读动作被 UI 播报成「已记入任务中心」（没发生任何写）；
#   2. 异常时间线把「配置里排在第一位」的源说成「异常主要出现在」，
#      而真正的第一名（frontend 610 条）排在第 3 位。


def test_read_only_actions_do_not_claim_written():
    """读操作不许播报「已记入」——那是假的状态变更。"""
    from evoflow.admin.platform_ui_feedback import _build_subtitle

    for action in ("tasks.list", "tasks.get", "tasks.execution_trail"):
        text = _build_subtitle("tasks", action, {"total": 291, "count": 1})
        assert "已记入" not in text, f"{action} 播报成写入了：{text}"
    for action in ("items.list", "items.get"):
        text = _build_subtitle("items", action, {"total": 5, "count": 5})
        assert "已记入" not in text, f"{action} 播报成写入了：{text}"
    # 真正写入的仍要说记入
    for action in ("tasks.create", "items.create", "items.update"):
        assert "已记入" in _build_subtitle(action.split(".")[0], action, {}), action


def test_timeline_top_source_is_by_count_not_config_order():
    """「异常主要出现在 X」的 X 必须是数量最多的源，不是配置里第一个。"""
    from evoflow.admin import diagnostics as diag

    fake_scan = {
        "logs_dir": "C:/tmp",
        "hours": 1,
        # 故意让顺序与数量相反：gateway 先出现但只有 25 条，frontend 610 条排后面
        "counts_by_source": {"gateway": 25, "frontend": 610, "langgraph": 2},
        "sources_with_errors": ["gateway", "frontend", "langgraph"],
        "event_count": 2,
        "truncated": True,
        "events": [
            {"ts": "2026-11-19T01:00:00", "source": "gateway", "level": "ERROR", "summary": "a", "count": 1},
            {"ts": "2026-11-19T01:00:01", "source": "frontend", "level": "ERROR", "summary": "b", "count": 1},
        ],
    }
    orig = diag.scan_errors
    diag.scan_errors = lambda **kw: fake_scan
    try:
        out = diag.anomaly_timeline(hours=1, max_events=2)
    finally:
        diag.scan_errors = orig

    assert "frontend" in out["conclusion"], out["conclusion"]
    assert "gateway" not in out["conclusion"].split("**")[1], "仍把 gateway 说成主要源"
    # 截断必须写进结论，不能只留在结构体字段里
    assert "637" in out["conclusion"] or "只列出" in out["conclusion"], out["conclusion"]

# 【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
# 两个「列表页把部署细节一起回」的动作：extensions.list 19867B / plugins.overview
# 11248B，其中 manifest 的启动参数、listing 里与父级逐字重复的 description
# 都是列表页用不上的。改成默认摘要 + 显式开关，判据按**真实序列化体积**量。

def test_extensions_list_defaults_to_summary():
    from evoflow.admin.platform_handlers import extensions_list

    slim = extensions_list({})
    full = extensions_list({"include_manifest": True})
    if not slim.get("extensions"):
        pytest.skip("本机没装 Agent应用")

    assert slim["full"] is False and full["full"] is True
    assert slim["count"] == full["count"]
    # 默认不许再回整份 manifest
    assert not any("manifest" in row for row in slim["extensions"]), "默认仍带完整 manifest"
    # 但摘要必须够用：名字 + 体积 + 键清单，否则只是砍掉信息没给替代
    for row in slim["extensions"]:
        assert row["id"] and row["name"]
        assert isinstance(row["manifestKeys"], list) and row["manifestKeys"]
        assert row["manifestBytes"] >= 0
        assert row["serviceMode"]
    # 真降体积（不明显下降说明开关是假的）
    import json as _json

    slim_b = len(_json.dumps(slim, ensure_ascii=False).encode())
    full_b = len(_json.dumps(full, ensure_ascii=False).encode())
    assert full_b > slim_b * 1.2, f"默认收窄无效 slim={slim_b} full={full_b}"


def test_plugins_overview_defaults_dedup_listing():
    from evoflow.admin.platform_handlers import plugins_overview

    slim = plugins_overview({})
    full = plugins_overview({"full": True})
    if not slim.get("availablePlugins"):
        pytest.skip("本机没有插件")

    # 与父级逐字重复的 listing.description / displayName 必须去掉
    for row in slim["availablePlugins"]:
        listing = row.get("listing") or {}
        assert listing.get("description") != row.get("description"), "description 仍重复"
        assert listing.get("displayName") != row.get("name"), "displayName 仍重复"
    avail_ids = {r["id"] for r in slim["availablePlugins"]}
    for row in slim["installedPlugins"]:
        if row["id"] in avail_ids:
            assert "listing" not in row, f"{row['id']} 的 listing 与 available 重复回了第二遍"

    import json as _json

    slim_b = len(_json.dumps(slim, ensure_ascii=False).encode())
    full_b = len(_json.dumps(full, ensure_ascii=False).encode())
    assert full_b > slim_b, f"去重无效 slim={slim_b} full={full_b}"
    # full=true 必须逐字回到 service 原文（开关不能是空壳）
    assert any((r.get("listing") or {}).get("description") for r in full["availablePlugins"])

# 【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
# tasks.list 默认 50 条实测 **200865 字节**：description 91524 + summary 39945
# 占 65%，handlers[].content 再占 17399。而 list 的语义是「有哪些活、到哪一步」，
# 正文是 tasks.get 的事。这里锁三件事：真降体积 / 裁了必须报字数 / full_text 能逐字还原。


def test_tasks_list_defaults_to_previews():
    from evoflow.admin.platform_handlers import tasks_list

    slim = tasks_list({})
    full = tasks_list({"full_text": True})
    if not slim.get("tasks"):
        pytest.skip("台账为空")

    assert slim["textSlim"] is True and slim.get("full_text") is None
    assert slim["count"] == full["count"] and slim["total"] == full["total"]

    import json as _json

    slim_b = len(_json.dumps(slim, ensure_ascii=False, default=str).encode())
    full_b = len(_json.dumps(full, ensure_ascii=False, default=str).encode())
    # 现网 200865 → 97592（-51.4%）。留余量避免脆测试。
    assert slim_b < full_b * 0.7, f"默认未减重 slim={slim_b} full={full_b}"


def test_tasks_list_clipping_is_announced_not_silent():
    """裁掉的正文必须报原字数并指向 tasks.get，不许静默砍半句。"""
    from evoflow.admin.platform_handlers import tasks_list

    slim = tasks_list({})
    clipped = [t for t in slim["tasks"] if t.get("descriptionChars")]
    if not clipped:
        pytest.skip("没有超长 description")
    for t in clipped:
        assert t["descriptionChars"] > 200
        assert "…" in t["description"]
        assert "tasks.get" in t["description"], "没告诉调用方去哪看全文"

    # handlers[].content 同理，且 full_text 不许被裁
    full = tasks_list({"full_text": True})
    for t in full["tasks"]:
        for h in t.get("handlers") or []:
            assert "contentChars" not in h, "full_text=true 仍裁 handler.content"

# 【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
# employees.list 实测 37309 字节，roles / employees / items **是同一个对象**
# （`d["roles"] is d["employees"] is d["items"]` 为 True），同一批 23 个岗位
# 被序列化了三遍，白占 24666 字节（66%）。


def test_employees_list_no_duplicate_alias_keys():
    from evoflow.admin.platform_handlers import employees_list

    slim = employees_list({})
    if not slim.get("roles"):
        pytest.skip("没有岗位")
    assert "employees" not in slim and "items" not in slim, "别名键仍重复返回"
    assert slim["aliases"] == {"employees": "roles", "items": "roles"}, "别名映射没交代清楚"

    legacy = employees_list({"legacy_keys": True})
    assert legacy["employees"] == slim["roles"] == legacy["items"]

    import json as _json

    slim_b = len(_json.dumps(slim, ensure_ascii=False, default=str).encode())
    legacy_b = len(_json.dumps(legacy, ensure_ascii=False, default=str).encode())
    assert slim_b < legacy_b * 0.5, f"去重无效 slim={slim_b} legacy={legacy_b}"


# 【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
# assets.get_profile 不传 principal_id 时读的是**空白模板**（「（希望 Agent 如何
# 称呼您…）」），却和真画像一样回 ok:true + dimensions，分不出「没写」和「没找对人」。


def test_assets_get_profile_flags_default_entity():
    from evoflow.admin.platform_handlers import assets_get_profile

    blank = assets_get_profile({})
    assert blank["ok"] is True
    assert "degraded_reason" in blank, "不传 principal_id 却没有任何提示"
    assert blank["principal_id"] == ""

    real = assets_get_profile({"principal_id": "admin"})
    assert real["principal_id"] == "admin"
    assert "degraded_reason" not in real, "指定了 principal_id 还报降级"

# 【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
# 又两处「列表页拖着正文一起回」：items.list 14679B（notes 占 51%）、
# org.list 9038B（manifest 占 49%）。同上的开关式收窄，full 可逐字还原。


def test_items_list_defaults_to_note_previews():
    from evoflow.admin.platform_handlers import items_list

    slim = items_list({})
    full = items_list({"full_text": True})
    if not slim.get("items"):
        pytest.skip("没有事项")
    assert slim.get("textSlim") is True
    assert slim["total"] == full["total"]
    # full 不许被裁
    for row in full["items"]:
        assert "notesChars" not in row, "full_text=true 仍裁 notes"
    # 裁了必须报字数
    for row in slim["items"]:
        if row.get("notesChars"):
            assert "items.get" in row["notes"]


def test_org_list_defaults_to_manifest_summary():
    from evoflow.admin.platform_handlers import org_list

    slim = org_list({})
    full = org_list({"include_manifest": True})
    if not slim.get("items"):
        pytest.skip("没装资源包")
    assert slim["full"] is False and full["full"] is True
    assert slim["count"] == full["count"]
    for row in slim["items"]:
        assert "manifest" not in row, "默认仍回整份 manifest"
        assert row["manifestKeys"], "连键清单都没给，等于砍掉信息"
    assert any("manifest" in row for row in full["items"]), "include_manifest 没生效"

    import json as _json

    slim_b = len(_json.dumps(slim, ensure_ascii=False, default=str).encode())
    full_b = len(_json.dumps(full, ensure_ascii=False, default=str).encode())
    assert slim_b < full_b * 0.8, f"收窄无效 slim={slim_b} full={full_b}"

# 【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
# 重启后真调才发现：assets.get_profile 的 `dimensions["USER.md"]` 与
# `fields["USER.md"]` **逐字相同**，同一份 565 字画像序列化两遍（4907B 里占 1401）。


def test_assets_get_profile_does_not_repeat_user_md():
    from evoflow.admin.platform_handlers import assets_get_profile

    slim = assets_get_profile({"principal_id": "admin"})
    full = assets_get_profile({"principal_id": "admin", "full": True})

    if not (full.get("dimensions") and full.get("fields")):
        pytest.skip("没有画像文件")
    # 前提：两者确实逐字相同（不同说明这条去重不适用，不必强行去）
    same = all(full["fields"].get(k) == v for k, v in full["dimensions"].items())
    if not same:
        pytest.skip("dimensions 与 fields 不同值，本去重不适用")

    assert "dimensions" not in slim, "仍在重复回 USER.md"
    assert slim["dimensionsAliasOfFields"] is True, "省掉却没说它等于 fields"
    assert slim["fields"] == full["fields"], "fields 被动过"
    assert "dimensions" in full, "full=true 没还原"

    import json as _json

    slim_b = len(_json.dumps(slim, ensure_ascii=False, default=str).encode())
    full_b = len(_json.dumps(full, ensure_ascii=False, default=str).encode())
    assert slim_b < full_b, f"去重无效 slim={slim_b} full={full_b}"


def test_assets_get_profile_blank_template_flag_is_per_user_md():
    """无参读默认 entity 的空白模板时必须判成 empty_template=True。

    反证价值：我第一版改完把判据写成「遍历所有 dimensions」，而 fields 里还含
    有内容的 README.md / affect.md，于是空白模板被判成「已填写」——这条测试抓住的。
    """
    from evoflow.admin.platform_handlers import assets_get_profile

    blank = assets_get_profile({})
    assert blank["principal_id"] == ""
    assert blank.get("degraded_reason")
    # 默认 entity 的 USER.md 是脚手架模板 → 必须为 True
    user_md = str((blank.get("fields") or {}).get("USER.md") or "")
    if "填写后" in user_md or not user_md.strip():
        assert blank["empty_template"] is True, "空白模板被判成已填写"


@pytest.fixture()
def _fake_model_rows(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """给 `settings.list_models` 一组确定性模型行：20 条，19 条同值 + 1 条少数派。

    【self-evolution-bot · 2026-11-20 · 第92轮 · 模型:deepseek-v4.1-flash-1017】
    下面的用例原来直接读 `evoflow.admin.models.list_models()`——即**本机现网配置**。
    本机返回 0 条时 `assert len(orig) >= 2` 直接红，报错「现网模型太少，本去重不适用」。
    这不是用例要守的语义：要验的是去重逻辑，数据就该由测试自己造。
    证据：单跑本文件绿（前面的用例装了假 AppConfig 留下 2 个假模型），
    全量跑红（0 条）——判据取决于「前面谁跑过」，属测试不隔离。
    修法：注入 20 条确定性行。条数取 20 而不是 5：去重要回 sharedConfig +
    configOmitted + note 三段开销（约 280 B），条数太少时净体积反而变大
    （5 条实测 slim=1950 > full=1938），会误红「没有减重」这条真断言。
    19/20 = 0.95 ≥ 0.8 → thinking 提走，其差异值留在第 1 条；
    use 12/20 = 0.6 < 0.8 → 不许提走，全留着。
    """
    rows: list[dict] = []
    for i in range(20):
        rows.append(
            {
                "name": f"m{i}",
                "vendor": "v",
                "model": f"model-{i}",
                "display_name": f"M{i}",
                "description": "",
                "base_url": None,
                "api_key": "",
                "supports_thinking": True,
                "supports_reasoning_effort": False,
                "supports_vision": False,
                "max_tokens": 4096,
                "context_length": 8192,
                "thinking": {"type": "enabled", "budget": 1024},
                "when_thinking_enabled": {"temperature": 1.0},
                "use": "chat",
            }
        )
    # 少数派：thinking 取值不同 —— 19/20 仍达阈值，但它的差异值必须留在条目上
    rows[0]["thinking"] = {"type": "enabled", "budget": 4096}
    # use 只有 12/20 相同（0.6 < 0.8）→ 不许提走，20 条全保留
    for i in range(8, 20):
        rows[i]["use"] = "embedding"

    monkeypatch.setattr("evoflow.admin.models.list_models", lambda: {"models": rows})
    monkeypatch.setattr("evoflow.admin.models.get_primary_model", lambda: {"primary_model": "m0"})
    return rows


def test_settings_list_models_hoists_shared_config_without_losing_variance(_fake_model_rows):
    """`settings.list_models` 默认把「多数模型相同」的实例化开关提到 sharedConfig。

    反证价值：
    1. 必须逐字相等才算「相同」——不能按 key 存在与否就吞掉；
    2. **少数派取值绝不能被静默丢弃**：还原 sharedConfig 后逐条比对原始
       ``include_config=true`` 输出，任何一条不逐字相等即为失败；
    3. 不许拿「体积变小了」当唯一判据（键漂移 ≠ 修好）。
    """
    import json as _json

    from evoflow.admin.platform_handlers import settings_list_models

    slim = settings_list_models({})
    full = settings_list_models({"include_config": True})

    orig = full["models"]
    assert len(slim["models"]) == len(orig), "条目数被改了"
    assert len(orig) == 20, "夹具没生效（应为 20 条确定性模型）"

    shape = slim.get("configOmitted") or []
    assert shape, "一个都没提到 sharedConfig，等于没省"
    assert shape == sorted(shape), "configOmitted 应有序，便于阅读"

    shared = slim.get("sharedConfig") or {}
    for key in shape:
        assert key in shared, f"{key} 被声明省去，却没给共同取值"

    # 还原校验：条目 + sharedConfig 必须与原始逐字相等，缺任何一条都是静默丢数据
    mismatched = []
    for o, s in zip(orig, slim["models"]):
        merged = dict(s)
        for key in shape:
            if key not in merged:
                merged[key] = shared.get(key)
        if _json.dumps(merged, sort_keys=True, default=str) != _json.dumps(
            o, sort_keys=True, default=str
        ):
            mismatched.append(o.get("name") or o.get("model"))
    assert not mismatched, f"还原后与原值不一致（静默丢字段）: {mismatched[:5]}"

    slim_b = len(_json.dumps(slim, ensure_ascii=False, default=str).encode())
    full_b = len(_json.dumps(full, ensure_ascii=False, default=str).encode())
    assert slim_b < full_b, f"没有减重 slim={slim_b} full={full_b}"

    # 差异项必须在条目上，不许被 sharedConfig 顶掉
    kept = sum(1 for s in slim["models"] if any(k in s for k in shape))
    assert kept > 0, "少数派差异值被吞了（应留在各自条目上）"


def test_settings_list_models_note_matches_actually_omitted_keys():
    """note 里列举的键必须与实际提出去的键逐字一致。

    反证价值（真调撞出来的）：我第一版把 note 写死成「已省去 thinking /
    when_thinking_enabled / use」，而 when_thinking_enabled 只占 25/43（低于阈值）
    根本没提走，43 条里全都在——固定文案随数据漂移就成了假话。
    """
    import re

    from evoflow.admin.platform_handlers import settings_list_models

    out = settings_list_models({})
    note = out.get("note") or ""
    omitted = out.get("configOmitted") or []

    m = re.search(r"实例化开关（([^）]*)）", note)
    listed = [x.strip() for x in m.group(1).split("/")] if m else []
    assert listed == omitted, f"文案列举 {listed} ≠ 实际提出 {omitted}"

    # 反向：被声称「省去」的键，不许在全量条目上都还在
    for key in listed:
        still = sum(1 for row in out["models"] if key in row)
        assert still < len(out["models"]), f"{key} 被声称省去，但 {still}/{len(out['models'])} 条都还在"

    # 没有可省的东西时不许说「已省去」
    if not omitted:
        assert "已省去" not in note, "没省任何键却说省了"

    # 少数派保留：仍带该键的条目，其值不许等于 sharedConfig 的共同值（那等于没省）
    import json as _json

    for key in listed:
        shared_val = _json.dumps((out.get("sharedConfig") or {}).get(key), sort_keys=True, default=str)
        redundant = [
            i
            for i, row in enumerate(out["models"])
            if key in row and _json.dumps(row[key], sort_keys=True, default=str) == shared_val
        ]
        assert not redundant, f"{key} 有 {len(redundant)} 条与 sharedConfig 重复，等于没省"


def test_automation_list_hoists_universal_fields_without_losing_variance():
    """`automation.list` 只把「每条都存在且取值完全一致」的字段提走。

    反证价值：现网 23 条里 description 是同一句话重复 23 次（1633 B），
    kind/managed_by/schedule_type/langgraph_thread_mode 各仅 1 种取值。
    但 status 是 22 paused + 1 active —— 这种有差异的字段绝不能提走。
    """
    import json as _json

    from evoflow.admin.platform_handlers import automation_list

    slim = automation_list({})
    full = automation_list({"full": True})

    rows = full["automations"]
    if len(rows) < 2:
        pytest.skip("自动化条目过少，本去重不适用")

    omitted = slim.get("defaultsOmitted") or []
    shared = slim.get("sharedDefaults") or {}

    for key in omitted:
        assert key in shared, f"{key} 声明省去却没有共同值"
        # 前提校验：确实每条都有且取值一致，否则不该提
        values = {
            _json.dumps(r.get(key), sort_keys=True, default=str) for r in rows if key in r
        }
        assert len(values) == 1, f"{key} 取值不一致却被提走"
        assert all(key in r for r in rows), f"{key} 并非每条都有却被提走"

    # 有差异的字段必须留在条目上
    for key in ("status", "id", "name"):
        if key in rows[0]:
            assert any(key in s for s in slim["automations"]), f"{key} 被误提走"

    # 还原校验
    bad = []
    for o, s in zip(rows, slim["automations"]):
        merged = dict(s)
        for k, v in shared.items():
            merged.setdefault(k, v)
        if _json.dumps(merged, sort_keys=True, default=str) != _json.dumps(
            o, sort_keys=True, default=str
        ):
            bad.append(o.get("id"))
    assert not bad, f"还原后与 full 不一致: {bad[:5]}"

    slim_b = len(_json.dumps(slim, ensure_ascii=False, default=str).encode())
    full_b = len(_json.dumps(full, ensure_ascii=False, default=str).encode())
    assert slim_b < full_b, f"没有减重 slim={slim_b} full={full_b}"

    # 文案点名集合 == 实际动作集合（第62轮踩过的坑）
    note = slim.get("note") or ""
    assert all(key in note for key in omitted), "note 没点名实际省去的字段"
    assert "when_thinking_enabled" not in note


def test_workflow_list_reports_has_more_instead_of_silent_truncation():
    """`workflow.list` 必须显式告知还有没有更多，而不是静默截断。

    反证价值：原来返回只有 count（=本页条数）与 limit，超过 limit 时
    调用方完全看不出被截断——与已修的 skills.list 静默忽略 limit 同类。
    """
    from evoflow.admin.platform_handlers import workflow_list

    out = workflow_list({"limit": 1})
    assert "has_more" in out, "没有 has_more，仍无法判断是否被截断"
    assert out["has_more"] is True, "limit=1 却报没有再多的了"
    assert len(out["items"]) == 1, "limit=1 没有真截断"

    wide = workflow_list({"limit": 100})
    assert "has_more" in wide
    if len(wide["items"]) >= 100:
        assert wide["has_more"] is True
