"""Prompt templates for the async mission / user-intent analyzer."""

from __future__ import annotations

_JSON_SCHEMA_INTENT_ONLY = """\
{
  "thread_id": "<same as input>",
  "primary_objective": "<用户当前要达成的结果，一句话>",
  "objective_confidence": 0.0,
  "success_criteria": ["<可验证的完成标准，0-3 条>"],
  "constraints": ["<用户明确提出的限制，无则 []>"],
  "active_subproblems": [
    {"id": "sp_1", "title": "<子问题标题>", "status": "pending|in_progress|blocked|done", "priority": 3, "evidence": "<依据，可选>"}
  ],
  "done_subproblems": ["<已从 active 移出且已完成的摘要>"],
  "out_of_scope": ["<用户明确排除的事项，无则 []>"],
  "exploration_summary": "<3-5 条要点：已读代码的关键符号/职责/关系；勿贴代码>",
  "exploration_gaps": ["<仍需确认的路径或问题，无则 []>"],
  "task_type": "locate_file|understand_code|data_bug|implement|runtime|general",
  "change_type": "noop|update|reset",
  "version": 1
}"""

_JSON_SCHEMA_WITH_SCENARIOS = _JSON_SCHEMA_INTENT_ONLY.replace(
    '"change_type": "noop|update|reset",',
    '"intent_hint": "chat|plan|workspace",\n  "change_type": "noop|update|reset",',
)


def build_mission_analyzer_prompt(
    *,
    thread_id: str,
    mode: str,
    previous_state_json: str,
    conversation: str,
    analyze_scenarios: bool,
    read_registry: str = "",
    write_registry: str = "",
) -> str:
    """Build the user-intent analyzer prompt (strict JSON out, no markdown fence)."""
    schema = _JSON_SCHEMA_WITH_SCENARIOS if analyze_scenarios else _JSON_SCHEMA_INTENT_ONLY
    scenario_block = ""
    if analyze_scenarios:
        scenario_block = "\n## intent_hint（仅当 analyze_scenarios 开启时输出）\n单值或逗号分隔多场景：chat|plan|workspace。\n不确定时输出 chat；不要因助手调用了工具就推断为 plan/workspace。\n"

    mode_note = {
        "incremental": "本轮为增量更新：在 previous_state 基础上，只修正有证据的变化。",
        "rebootstrap": "用户可能已换题或目标漂移：可重建 primary_objective 与子问题，change_type 常为 reset。",
        "bootstrap": "首次建立快照：从对话提取用户目标，子问题宁缺毋滥。",
    }.get(mode, "根据对话更新快照。")

    base = f"""你是「会话意图快照」后台分析器，为主智能体下一轮提供优先级参考。
你不与用户对话，不执行工具，不替用户做决定。

## 你的唯一任务
从「最近对话 + 上一轮快照」提炼：用户**此刻**最想达成什么、还有哪些未闭合子线、完成度如何。
输出**严格 JSON**（不要 markdown 代码块、不要解释文字）。

## 本轮模式
{mode_note}

## 字段语义（简短）
- primary_objective：一句话，写**用户要的结果**（动词+对象+成功画面），勿写助手已做的动作。
- objective_confidence：0~1；用户目标越清晰越高；纯寒暄/空泛探索可 0.3~0.5。
- success_criteria：0~3 条**可验证**标准（用户或对话能判断是否达成）；不要写「用户满意」等空话。
- constraints：用户**明确说过**的限制（时间、技术栈、禁止事项）；勿臆造。
- active_subproblems：用户**在对话中提出**的并行/阶段性子问题，或同一主目标下用户点名的多条待办。
  - 禁止：把助手的执行步骤、工具调用、内部计划拆成子问题。
  - 仅 1 个笼统目标时 → 必须 []。
  - 最多 5 条；status：pending / in_progress（用户或助手正在推进）/ blocked（缺信息或受阻）/ done（本回合可判定完成）。
  - 每条 title ≤ 80 字；evidence 可写一句对话依据。
- done_subproblems：从 active 移除且已完成的**短摘要**（≤ 120 字/条），可累积，不要重复 active 里仍存在的项。
- out_of_scope：用户明确说「不要做/先别管」的事项；无则 []。
- exploration_summary：结合 read_registry（若有）与对话，写 3-5 条**代码探索结论**（关键路径/符号/调用关系）；禁止罗列工具步骤。
- exploration_gaps：仍缺**关键**信息才能 act 时，写 0-3 条；无则 []。
- **取证足够时 gaps 必须 []**：implement/locate/understand 且 read_registry 已覆盖目标路径；data_bug 在尚未 curl/对比数据源前可保留 1 条「验证 API/日志」类 gap，但禁止「继续读 CSS/通读页面」类 gap。
- task_type：locate_file / understand_code / data_bug / implement / runtime / general；按 `<task_router>` 选 act，勿把所有类型都当成改文件。
- change_type：
  - noop：相对 previous_state，主目标与子问题理解**无实质变化**（仅寒暄、致谢、重复确认）。
  - update：目标细化、进度变化、新增/完成子问题、约束变化。
  - reset：用户**换了一个无关的新主任务**（新 topic），需重建 primary_objective 与 active_subproblems。
{scenario_block}
## 硬性规则
1. 主目标归属：primary_objective 必须来自**用户诉求**，不是 Assistant 单方面提出的方案。
2. 完成度保守：无明确证据表明主目标已达成时，active_subproblems 不要轻易清空；勿把「助手回复很长」当成任务完成。
3. 增量优先：previous_state 非空时，未变化的字段保持语义一致；仅在有新证据时改 status 或移动 done。
4. 助手进展：若 Assistant 报告完成了用户关心的某一步，可将对应子问题标 done 并写入 done_subproblems。
5. 语言：与用户对话同语言（中文对话用中文写快照字段）。

## 反例（禁止）
- 把「调用 supervisor / 读文件 / 写 Plan」当成用户的 primary_objective。
- 用户只问「这是什么」却拆出 4 个子问题。
- 用户新问「帮我写周报」但仍保留上周「修 bug」的主目标（应 reset）。

## 输出 JSON 结构（字段必须齐全）
{schema}

thread_id={thread_id}
mode={mode}

## previous_state
{previous_state_json}

## conversation（最近若干轮）
{conversation}
"""
    suffix = ""
    if read_registry.strip():
        suffix += f"\n\n## read_registry（本会话已读路径 + 短 note，非全文）\n{read_registry.strip()}\n"
    if write_registry.strip():
        suffix += (
            "\n\n## write_registry（本会话已修改的文件）\n"
            f"{write_registry.strip()}\n"
            "若 active_subproblems 中有子问题对应这些文件的修改，且对话中已确认修改完成，"
            "请将该子问题 status 标为 done 并移入 done_subproblems。\n"
        )
    return base + suffix if suffix else base
