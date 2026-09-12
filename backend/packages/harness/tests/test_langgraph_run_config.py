from evoflow.langgraph_run_config import (
    apply_interactive_chat_multitask_strategy,
    is_thread_or_assistant_not_found_error,
    json_safe_run_dict,
    merge_configurable_into_context,
)


def test_merge_configurable_into_context_drops_configurable():
    run_config = {"configurable": {"thread_id": "goal-tid", "planner_model_name": "m1"}, "recursion_limit": 200}
    run_context = {"thread_id": "lead-tid", "goal_automated": True}
    cfg, ctx = merge_configurable_into_context(run_config, run_context)
    assert "configurable" not in cfg
    assert cfg["recursion_limit"] == 200
    assert ctx["thread_id"] == "lead-tid"
    assert ctx["planner_model_name"] == "m1"
    assert ctx["goal_automated"] is True


def test_is_thread_or_assistant_not_found_error():
    class _Resp:
        status_code = 404
        text = "Thread or assistant not found."

    class _Err(Exception):
        response = _Resp()

    assert is_thread_or_assistant_not_found_error(_Err("404"))
    assert is_thread_or_assistant_not_found_error(Exception("Thread or assistant not found."))
    assert not is_thread_or_assistant_not_found_error(Exception("timeout"))


def test_json_safe_run_dict_drops_callables():
    def fn():
        return 1

    safe = json_safe_run_dict(
        {
            "thread_id": "t1",
            "bad": fn,
            "nested": {"ok": True, "typ": type(str)},
            "recursion_limit": 100,
        }
    )
    assert safe == {"thread_id": "t1", "nested": {"ok": True}, "recursion_limit": 100}


def test_interactive_ui_stream_forces_interrupt_over_enqueue():
    body = {
        "assistant_id": "lead_agent",
        "multitask_strategy": "enqueue",
        "context": {"session_key": "agent:main:x", "source": "web"},
    }
    out, meta = apply_interactive_chat_multitask_strategy(body, ui_stream=True)
    assert out["multitask_strategy"] == "interrupt"
    assert meta["changed"] is True
    assert meta["before"] == "enqueue"
    assert meta["reason"] == "ui_stream"


def test_employee_talk_forces_interrupt_without_ui_header():
    body = {
        "context": {
            "employee_talk_mode": "chat",
            "session_key": "proactive:role:task:1",
            "source": "proactive",
        }
    }
    out, meta = apply_interactive_chat_multitask_strategy(body, ui_stream=False)
    assert out["multitask_strategy"] == "interrupt"
    assert meta["changed"] is True
    assert meta["reason"] == "employee_talk"


def test_background_enqueue_preserved_without_ui_or_talk():
    body = {
        "multitask_strategy": "enqueue",
        "context": {"source": "unattended_task", "session_key": "agent:main:bg"},
    }
    out, meta = apply_interactive_chat_multitask_strategy(body, ui_stream=False)
    assert out["multitask_strategy"] == "enqueue"
    assert meta["changed"] is False
    assert meta["reason"] == "non_interactive"


def test_explicit_reject_kept_for_interactive():
    body = {
        "multitask_strategy": "reject",
        "context": {"employee_talk_mode": "chat"},
    }
    out, meta = apply_interactive_chat_multitask_strategy(body, ui_stream=True)
    assert out["multitask_strategy"] == "reject"
    assert meta["changed"] is False
    assert meta["reason"] == "already_set"
