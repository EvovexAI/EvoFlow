"""右栏契约「前后端对账」门禁。

【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新建本测试。
为什么：用户 2026-11-20 当面点破「你验证好前端和后端吗？你知道前端上面有什么东西吗？」
—— 我此前只报了「pytest 全绿 + tsс exit 0」，那只能证明各自能跑，
不能证明**两边说的是同一件事**。真源在后端 right_panel_kinds.py，
前端 right-panel-contract.ts 里有一份离线兜底表；兜底表只要漏一个 kind，
后端不可达时前端就会把能开的 kind 报成「未知」，而两边单测都不会红。
本测试把两份表逐 kind、逐必需字段对账，任一侧新增而另一侧没跟上就立刻红。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from evoflow.stage.right_panel_kinds import kind_specs

_TS_CONTRACT = (
    Path(__file__).resolve().parents[2]
    / "evopanel"
    / "src"
    / "lib"
    / "right-stage"
    / "right-panel-contract.ts"
)


def _backend_contract() -> dict[str, set[str]]:
    """后端真源：kind -> 必需字段集合（artifacts 已退役，接口对它过滤，这里同样不算）。"""
    out: dict[str, set[str]] = {}
    for spec in kind_specs():
        kind = str(spec.get("kind") or "").strip()
        if not kind or kind == "artifacts":
            continue
        out[kind] = {str(f) for f in (spec.get("required") or [])}
    return out


def _frontend_fallback() -> dict[str, set[str]]:
    """解析前端 BUILTIN_SPECS：kind -> 必需字段集合。"""
    if not _TS_CONTRACT.exists():
        pytest.skip(f"前端契约文件不存在（打包构建可能不含前端）：{_TS_CONTRACT}")
    src = _TS_CONTRACT.read_text(encoding="utf-8")
    out: dict[str, set[str]] = {}
    for m in re.finditer(
        r"kind:\s*'([A-Za-z0-9-]+)'.*?required:\s*\[([^\]]*)\]",
        src,
        re.DOTALL,
    ):
        kind = m.group(1)
        fields = {f.strip() for f in re.findall(r"'([^']+)'", m.group(2))}
        out[kind] = fields
    return out


def test_frontend_fallback_covers_every_backend_kind() -> None:
    """后端每个 kind，前端兜底表都必须在（漏项 = 后端不可达时前端报「未知」）。"""
    backend = _backend_contract()
    frontend = _frontend_fallback()
    missing = sorted(set(backend) - set(frontend))
    assert not missing, (
        f"前端兜底表缺 {len(missing)} 个 kind：{missing}；"
        f"后端有 {sorted(backend)}，前端只有 {sorted(frontend)}"
    )


def test_frontend_fallback_has_no_retired_kind() -> None:
    """前端不能残留后端已经没有的 kind（双向对账，防另一侧漂移）。"""
    backend = _backend_contract()
    frontend = _frontend_fallback()
    extra = sorted(set(frontend) - set(backend))
    assert not extra, f"前端兜底表多出后端不存在的 kind：{extra}"


def test_required_fields_match_per_kind() -> None:
    """逐个 kind 比必需字段：一边说必填、另一边说不用填，就是「按前端能开的方式调、后端报错」。"""
    backend = _backend_contract()
    frontend = _frontend_fallback()
    diffs: list[str] = []
    for kind in sorted(set(backend) & set(frontend)):
        if backend[kind] != frontend[kind]:
            diffs.append(f"{kind}: 后端要 {sorted(backend[kind])} / 前端要 {sorted(frontend[kind])}")
    assert not diffs, "必需字段前后端不一致：\n  " + "\n  ".join(diffs)


def test_employee_process_requires_agent_code_only() -> None:
    """回归锚点：employeeProcess 只要求 agentCode（taskId 可选），两边都必须如此。"""
    backend = _backend_contract()
    frontend = _frontend_fallback()
    assert backend.get("employeeProcess") == {"data.agentCode"}
    assert frontend.get("employeeProcess") == {"data.agentCode"}, (
        "前端兜底表把 employeeProcess 的必需字段改回去了；"
        "这正是第87轮修掉的「对不齐」——前端只查 agentCode、后端却要 taskId。"
    )


def test_contract_kinds_are_actually_renderable_by_frontend() -> None:
    """契约声明的每个 kind，前端渲染层必须真的实现了（否则契约说有、点了空白）。

    前端有两条渲染路径：
      1) 注册表 ``register-kinds.tsx`` 里的 ``kind: 'x'``
      2) 旧 if 链 ``render-right-stage-body.tsx`` 里的 ``kind === 'x'``
    两条都没有 = 只能落到 ``UnknownStageKind``。
    """
    front = Path(__file__).resolve().parents[2] / "evopanel" / "src"
    reg = front / "react" / "right-stage" / "register-kinds.tsx"
    body = front / "react" / "chat-app" / "right-stage" / "render-right-stage-body.tsx"
    if not reg.exists() or not body.exists():
        pytest.skip("前端源码不在（打包构建）")

    renderable: set[str] = set()
    renderable |= set(
        re.findall(r"kind:\s*'([A-Za-z0-9-]+)'", reg.read_text(encoding="utf-8"))
    )
    renderable |= set(
        re.findall(r"kind === '([A-Za-z0-9-]+)'", body.read_text(encoding="utf-8"))
    )

    contract = set(_backend_contract())
    missing = sorted(contract - renderable)
    assert not missing, (
        f"契约声明了 {len(missing)} 个前端画不出来的 kind：{missing}；"
        "模型按契约调 ui.show 会得到空白面板"
    )


_PF_TS = (
    Path(__file__).resolve().parents[2]
    / "evopanel"
    / "src"
    / "lib"
    / "right-stage"
    / "platform-feedback.ts"
)


def _frontend_action_sets() -> tuple[set[str], set[str]]:
    """解析前端 platform-feedback.ts 的兜底两张动作表。"""
    if not _PF_TS.exists():
        pytest.skip(f"前端文件不存在（打包构建可能不含前端）：{_PF_TS}")
    src = _PF_TS.read_text(encoding="utf-8")

    def _grab(name: str) -> set[str]:
        m = re.search(rf"const {name} = new Set\(\[(.*?)\]\)", src, re.DOTALL)
        if not m:
            return set()
        return set(re.findall(r"'([^']+)'", m.group(1)))

    return _grab("AUTO_OPEN_ACTIONS"), _grab("READ_ONLY_ACTIONS")


def test_auto_open_and_read_only_sets_match_backend() -> None:
    """前端兜底的两张动作表必须与后端真源逐条一致。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增本对账。第87轮只对账了 kind，没对账「哪些动作会自动弹」。
    为什么：第88轮发现后端同一个文件里还有 5 处私有白名单绕过真源
    （employees.get/brief、tasks.get、workflow.run_status），前端也有 4 处硬编码 OR。
    动作清单不同步时，后端契约还没拉到的启动瞬间会按旧表强开右栏，
    而两边单测各自都绿 —— 必须交叉对账才抓得到。
    """
    from evoflow.stage.right_panel_kinds import AUTO_OPEN_ACTIONS, READ_ONLY_ACTIONS

    fe_auto, fe_read = _frontend_action_sets()
    assert fe_auto, "没解析到前端 AUTO_OPEN_ACTIONS（正则或文件结构已变）"
    assert fe_read, "没解析到前端 READ_ONLY_ACTIONS"

    assert sorted(fe_auto) == sorted(AUTO_OPEN_ACTIONS), (
        "自动展开白名单前后端不一致："
        f"仅前端 {sorted(fe_auto - set(AUTO_OPEN_ACTIONS))}，"
        f"仅后端 {sorted(set(AUTO_OPEN_ACTIONS) - fe_auto)}"
    )
    assert sorted(fe_read) == sorted(READ_ONLY_ACTIONS), (
        "只读清单前后端不一致："
        f"仅前端 {sorted(fe_read - set(READ_ONLY_ACTIONS))}，"
        f"仅后端 {sorted(set(READ_ONLY_ACTIONS) - fe_read)}"
    )


def test_frontend_lists_are_disjoint_and_never_overlap() -> None:
    """两张表不得交集：同一动作既说「只读」又说「自动展开」= 判据自相矛盾。"""
    from evoflow.stage.right_panel_kinds import AUTO_OPEN_ACTIONS, READ_ONLY_ACTIONS

    assert not (set(AUTO_OPEN_ACTIONS) & set(READ_ONLY_ACTIONS))

    fe_auto, fe_read = _frontend_action_sets()
    assert not (fe_auto & fe_read), f"前端两张表有交集：{sorted(fe_auto & fe_read)}"


def test_allow_lists_only_contain_registered_actions() -> None:
    """白名单/只读清单里的每个动作名必须真实存在，否则是死条目。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增本门禁。
    为什么：重启后实测线上接口返回 autoOpenActions=14 条，而我按注册表统计只有 13 条，
    差的那条是 "tasks.update"——平台根本没有这个动作（只有 tasks.set_state）。
    死条目不会报错、也不会红任何测试，但会让下一个读真源的人以为它存在。
    这条只有「拿真源去对注册表」才抓得到，单测和接口 200 都看不见。
    """
    from evoflow.admin.platform_actions import get_registry
    from evoflow.stage.right_panel_kinds import AUTO_OPEN_ACTIONS, READ_ONLY_ACTIONS

    registered = set(get_registry().keys())
    assert registered, "动作注册表为空，本测试无效"

    ghosts = sorted(set(AUTO_OPEN_ACTIONS) - registered)
    assert not ghosts, (
        f"自动展开白名单里有 {len(ghosts)} 个不存在的动作：{ghosts}；"
        "（tasks.update 就踩过这条——注册表里只有 tasks.set_state）"
    )

    ghosts_ro = sorted(set(READ_ONLY_ACTIONS) - registered)
    assert not ghosts_ro, f"只读清单里有不存在的动作：{ghosts_ro}"


def test_read_only_list_covers_every_read_risk_action() -> None:
    """注册表里 risk=read 的动作必须都进只读清单（漏一个就会按兜底逻辑自动弹）。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增本反向门禁。
    为什么：前一条只防「死条目」，防不住「新加的读动作忘了登记」——
    那样 should_auto_open 会走「不在白名单即 False」的兜底，行为恰好正确，
    但语义上它既不在只读清单也不在自动清单，属于「靠巧合正确」。
    """
    from evoflow.admin.platform_actions import get_registry
    from evoflow.stage.right_panel_kinds import READ_ONLY_ACTIONS

    reg = get_registry()
    read_actions = {
        name
        for name, spec in reg.items()
        if str(getattr(spec, "risk", "") or "").strip().lower() == "read"
    }
    # 只约束会产 UI 反馈的领域（其余领域不参与右栏 auto 判据）
    scoped = {a for a in read_actions if a.split(".", 1)[0] in {
        "employees", "tasks", "items", "workflow",
    }}
    assert scoped, "没抓到任何 read 动作，本测试无效"
    missing = sorted(scoped - set(READ_ONLY_ACTIONS))
    assert not missing, f"这些 read 动作没登记进只读清单：{missing}"


def test_eager_list_is_subset_of_auto_open() -> None:
    """前端 EAGER 表只声明「args 阶段挂过程」的时机，不得单独决定开不开。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增本门禁；同时把 tryEagerAutoOpenPlatformFromArgs 的判据
    从 `EAGER.has(action)` 改为 `EAGER.has(action) && shouldAutoOpenAction(action)`。
    为什么：EAGER 表原本直接写 autoOpen:true，是同一文件里第 5 处绕过真源的私有白名单。
    它的 4 个成员当时恰好都在 AUTO_OPEN_ACTIONS 里，所以「看起来对」——
    但那是巧合：真源把某个移出自动开后，这里照样会弹，且没有任何测试会红。
    本门禁要求 EAGER ⊆ AUTO_OPEN_ACTIONS，把巧合变成约束。
    """
    from evoflow.stage.right_panel_kinds import AUTO_OPEN_ACTIONS

    if not _PF_TS.exists():
        pytest.skip(f"前端文件不存在：{_PF_TS}")
    src = _PF_TS.read_text(encoding="utf-8")
    m = re.search(
        r"const EAGER_EMPLOYEE_PROCESS_ACTIONS = new Set\(\[(.*?)\]\)", src, re.DOTALL
    )
    assert m, "没解析到 EAGER_EMPLOYEE_PROCESS_ACTIONS（正则或结构已变）"
    eager = set(re.findall(r"'([^']+)'", m.group(1)))
    assert eager, "EAGER 表为空，本测试无效"

    extra = sorted(eager - set(AUTO_OPEN_ACTIONS))
    assert not extra, (
        f"EAGER 表里有不在自动展开白名单的动作：{extra}；"
        "它们在 args 阶段会被写死 autoOpen:true，等于绕过真源。"
    )
