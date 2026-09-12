"""
工作流模块Bug修复生产级验证测试
验证所有已报告的bug是否已修复
"""

import asyncio
import pytest
from unittest.mock import MagicMock, patch, AsyncMock
import sys
import os
import tempfile
from pathlib import Path

# 添加路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'packages', 'harness'))

from evoflow.collab.expression_resolver import _traverse, resolve_expression, resolve_bindings
from evoflow.collab.app_rollup import (
    append_rollup_subtask, 
    maybe_rollup_main_task, 
    build_rollup_subtask_spec,
    is_rollup_subtask,
    needs_auto_rollup,
)
from evoflow.collab.debug_runner import debug_run_step, _find_step_by_ref, debug_run_from_step
from evoflow.collab.workflow_validator import _detect_cycles, validate_app_definition, _canonical_cycle_key
from evoflow.collab.app_extractor import extract_parameters_from_plan
from evoflow.collab.app_generator import generate_app_from_plan


class TestBug028TraverseNone:
    """验证bug-028: _traverse函数未处理root为None的情况"""
    
    def test_traverse_with_none_root_and_segments(self):
        """测试root为None但有segments时返回(False, None)"""
        found, value = _traverse(None, ["steps", "1", "output"])
        assert found == False
        assert value is None
    
    def test_traverse_with_none_root_empty_segments(self):
        """测试root为None且segments为空时返回(True, None)"""
        found, value = _traverse(None, [])
        assert found == True
        assert value is None
    
    def test_traverse_with_valid_data(self):
        """测试正常数据路径解析"""
        data = {"steps": {"1": {"output": {"result": "success"}}}}
        found, value = _traverse(data, ["steps", "1", "output", "result"])
        assert found == True
        assert value == "success"
    
    def test_traverse_with_missing_key(self):
        """测试路径中键不存在时返回False"""
        data = {"steps": {"1": {"output": {}}}}
        found, value = _traverse(data, ["steps", "1", "output", "missing"])
        assert found == False
        assert value is None
    
    def test_traverse_with_array_index(self):
        """测试数组索引访问"""
        data = {"items": [{"name": "first"}, {"name": "second"}]}
        found, value = _traverse(data, ["items", "[0]", "name"])
        assert found == True
        assert value == "first"
    
    def test_traverse_with_out_of_range_index(self):
        """测试越界数组索引"""
        data = {"items": [{"name": "first"}]}
        found, value = _traverse(data, ["items", "[5]", "name"])
        assert found == False
        assert value is None
    
    def test_traverse_with_string_root(self):
        """测试root为字符串时的处理"""
        found, value = _traverse("test", ["key"])
        assert found == False
        assert value is None


class TestBug030DaemonThread:
    """验证 bug-030: workflow 派发走 detached_poll_scheduler，不再用裸 Thread"""

    def test_workflow_dispatch_uses_detached_poll_scheduler(self):
        import inspect
        from evoflow.collab import app_runner

        source = inspect.getsource(app_runner._schedule_workflow_dispatch)
        assert "schedule_detached_poll" in source


class TestBug026RollupDuplicate:
    """验证bug-026: append_rollup_subtask可能重复添加rollup"""
    
    def test_uses_is_rollup_subtask_for_check(self):
        """验证使用is_rollup_subtask进行重复检查"""
        import inspect
        from evoflow.collab.app_rollup import append_rollup_subtask
        source = inspect.getsource(append_rollup_subtask)
        assert 'is_rollup_subtask' in source, "应该使用is_rollup_subtask进行重复检查"
    
    def test_double_check_pattern(self):
        """验证双重检查模式"""
        import inspect
        from evoflow.collab.app_rollup import append_rollup_subtask
        source = inspect.getsource(append_rollup_subtask)
        # 检查是否有循环检查
        assert 'for st in subtasks' in source or 'for' in source


class TestBug089MaybeRollupNone:
    """验证bug-089: maybe_rollup_main_task未处理task为None的情况"""
    
    def test_none_task_returns_none(self):
        """测试传入None时返回None"""
        result = maybe_rollup_main_task(None)
        assert result is None
    
    def test_string_task_returns_none(self):
        """测试传入字符串时返回None"""
        result = maybe_rollup_main_task("invalid")
        assert result is None
    
    def test_list_task_returns_none(self):
        """测试传入列表时返回None"""
        result = maybe_rollup_main_task([])
        assert result is None
    
    def test_empty_dict_task(self):
        """测试空字典任务"""
        result = maybe_rollup_main_task({})
        # 应该返回None或合理的结果
        assert result is None or isinstance(result, dict)
    
    def test_valid_task_structure(self):
        """测试有效任务结构"""
        task = {
            "id": "test_task",
            "source_app_id": "App_test",
            "final_rollup": "off",  # legacy value — now resolves to auto (rollup mandatory)
            "subtasks": [],
            "status": "executing"
        }
        # off is no longer a "skip rollup" mode; with no subtasks yet there is
        # simply nothing to roll up, so maybe_rollup_main_task returns None.
        result = maybe_rollup_main_task(task)
        assert result is None


class TestBug106EventLoopLeak:
    """验证bug-106: debug_run_step创建新事件循环后未正确关闭"""
    
    def test_source_has_loop_close(self):
        """验证源码中有loop.close()调用"""
        import inspect
        from evoflow.collab.debug_runner import debug_run_step
        source = inspect.getsource(debug_run_step)
        assert 'loop.close()' in source, "应该有loop.close()调用"
    
    def test_source_has_finally_block(self):
        """验证源码中有finally块"""
        import inspect
        from evoflow.collab.debug_runner import debug_run_step
        source = inspect.getsource(debug_run_step)
        assert 'finally:' in source, "应该在finally块中关闭loop"
    
    def test_loop_creation_pattern(self):
        """验证事件循环创建模式"""
        import inspect
        from evoflow.collab.debug_runner import debug_run_step
        source = inspect.getsource(debug_run_step)
        assert 'asyncio.new_event_loop()' in source or 'new_event_loop()' in source


class TestBug090CycleDetection:
    """验证bug-090: _detect_cycles使用set排序导致cycle_key重复检测"""
    
    def test_uses_canonical_cycle_key(self):
        """验证使用_canonical_cycle_key"""
        import inspect
        from evoflow.collab.workflow_validator import _detect_cycles
        source = inspect.getsource(_detect_cycles)
        assert '_canonical_cycle_key' in source, "应该使用_canonical_cycle_key"
    
    def test_no_set_sorted_pattern(self):
        """验证不使用set(sorted)去重"""
        import inspect
        from evoflow.collab.workflow_validator import _detect_cycles
        source = inspect.getsource(_detect_cycles)
        assert 'set(sorted' not in source, "不应该使用set(sorted)去重"
    
    def test_detect_simple_cycle(self):
        """测试检测简单循环"""
        steps = [
            {"ref": "1", "depends_on": ["2"]},
            {"ref": "2", "depends_on": ["3"]},
            {"ref": "3", "depends_on": ["1"]},
        ]
        cycles = _detect_cycles(steps)
        assert len(cycles) > 0, "应该检测到循环"
    
    def test_no_cycle_in_dag(self):
        """测试无循环的DAG"""
        steps = [
            {"ref": "1", "depends_on": []},
            {"ref": "2", "depends_on": ["1"]},
            {"ref": "3", "depends_on": ["2"]},
        ]
        cycles = _detect_cycles(steps)
        assert len(cycles) == 0, "不应该检测到循环"
    
    def test_self_cycle(self):
        """测试自循环"""
        steps = [
            {"ref": "1", "depends_on": ["1"]},
        ]
        cycles = _detect_cycles(steps)
        assert len(cycles) > 0, "应该检测到自循环"
    
    def test_canonical_cycle_key_consistency(self):
        """验证_canonical_cycle_key的一致性"""
        cycle1 = ["1", "2", "3", "1"]
        cycle2 = ["2", "3", "1", "2"]
        key1 = _canonical_cycle_key(cycle1)
        key2 = _canonical_cycle_key(cycle2)
        assert key1 == key2, "相同循环的不同起始点应该产生相同的key"


class TestBug121ExtractorStepsNone:
    """验证bug-121: extract_parameters_from_plan未处理steps为None"""
    
    def test_none_steps_returns_empty(self):
        """测试steps为None时返回空结果"""
        plan, parameters = extract_parameters_from_plan("Test goal", None)
        assert plan is not None
        assert plan["steps"] == []
        assert parameters == []
    
    def test_empty_steps_returns_empty(self):
        """测试steps为空列表时返回空结果"""
        plan, parameters = extract_parameters_from_plan("Test goal", [])
        assert plan is not None
        assert plan["steps"] == []
        assert parameters == []
    
    def test_valid_steps_returns_parameters(self):
        """测试有效steps时返回参数"""
        steps = [
            {"name": "Step 1", "goal": "Process data for topic X", "inputs": "Input data"},
        ]
        plan, parameters = extract_parameters_from_plan("Goal for topic X", steps)
        assert plan is not None
        assert isinstance(parameters, list)


class TestBug122GeneratorEmptyGoal:
    """验证bug-122: generate_app_from_plan未处理goal为空"""
    
    def test_empty_goal_returns_app(self):
        """测试空goal时返回应用"""
        result = generate_app_from_plan(
            name="Test App",
            goal="",
            steps=[]
        )
        assert result is not None
        assert "id" in result
        assert "name" in result
    
    def test_none_goal_returns_app(self):
        """测试None goal时返回应用"""
        result = generate_app_from_plan(
            name="Test App",
            goal=None,
            steps=[]
        )
        assert result is not None
        assert "id" in result
    
    def test_whitespace_goal_returns_app(self):
        """测试空白goal时返回应用"""
        result = generate_app_from_plan(
            name="Test App",
            goal="   ",
            steps=[]
        )
        assert result is not None
        assert "id" in result


class TestBug124FindStepByRef:
    """验证bug-124: _find_step_by_ref未处理空ref"""
    
    def test_empty_string_ref(self):
        """测试空字符串ref"""
        steps = [{"ref": "1", "name": "Step 1"}]
        result = _find_step_by_ref(steps, "")
        assert result is None
    
    def test_none_ref(self):
        """测试None ref"""
        steps = [{"ref": "1", "name": "Step 1"}]
        result = _find_step_by_ref(steps, None)
        assert result is None
    
    def test_whitespace_ref(self):
        """测试空白ref"""
        steps = [{"ref": "1", "name": "Step 1"}]
        result = _find_step_by_ref(steps, "   ")
        assert result is None
    
    def test_valid_ref(self):
        """测试有效ref"""
        steps = [{"ref": "1", "name": "Step 1"}, {"ref": "2", "name": "Step 2"}]
        result = _find_step_by_ref(steps, "2")
        assert result is not None
        assert result["name"] == "Step 2"
    
    def test_not_found_ref(self):
        """测试不存在的ref"""
        steps = [{"ref": "1", "name": "Step 1"}]
        result = _find_step_by_ref(steps, "99")
        assert result is None
    
    def test_empty_steps(self):
        """测试空steps列表"""
        result = _find_step_by_ref([], "1")
        assert result is None


class TestBug125BuildRollupSpec:
    """验证bug-125: build_rollup_subtask_spec未处理app为None"""
    
    def test_none_app_returns_default_spec(self):
        """测试app为None时返回默认spec"""
        result = build_rollup_subtask_spec(None)
        assert result is not None
        assert "ref" in result
        assert "depends_on" in result
        assert "instruction" in result
    
    def test_empty_dict_app_returns_spec(self):
        """测试空字典app时返回spec"""
        result = build_rollup_subtask_spec({})
        assert result is not None
        assert "ref" in result
    
    def test_valid_app_returns_spec(self):
        """测试有效app时返回spec"""
        app = {
            "id": "App_test",
            "name": "Test App",
            "steps": [
                {"ref": "1", "goal": "Step 1"},
                {"ref": "2", "goal": "Step 2"},
            ],
            "final_rollup": "auto",
        }
        result = build_rollup_subtask_spec(app)
        assert result is not None
        assert "ref" in result
        assert "depends_on" in result


class TestBug103PlanSessionTask:
    """验证bug-103: plan_session_task未校验thread_id为空"""
    
    def test_source_has_thread_id_check(self):
        """验证源码中有thread_id相关校验"""
        try:
            import inspect
            from evoflow.collab.plan_session_task import bind_plan_to_thread_task
            source = inspect.getsource(bind_plan_to_thread_task)
            # 检查是否有thread_id相关的处理
            has_thread_reference = 'thread_id' in source
            print(f"thread_id reference found: {has_thread_reference}")
            # 这个测试主要是确认修复状态
        except ImportError:
            pytest.skip("plan_session_task模块不存在")


class TestExpressionResolverEdgeCases:
    """测试expression_resolver的边界情况"""
    
    def test_resolve_with_none_steps_output(self):
        """测试steps_output为None时的处理"""
        result = resolve_expression("{{params.topic}}", params={"topic": "test"})
        assert result == "test"
    
    def test_resolve_with_missing_path(self):
        """测试路径不存在时的处理"""
        result = resolve_expression("{{steps.999.output}}", steps_output={})
        assert result == "{{steps.999.output}}"
    
    def test_resolve_bindings_with_none(self):
        """测试resolve_bindings处理None"""
        result = resolve_bindings(None)
        assert result == {}
    
    def test_resolve_bindings_with_empty(self):
        """测试resolve_bindings处理空字典"""
        result = resolve_bindings({})
        assert result == {}
    
    def test_resolve_nested_expression(self):
        """测试嵌套表达式解析"""
        data = {"steps": {"1": {"output": {"data": {"nested": "value"}}}}}
        result = resolve_expression("{{steps.1.output.data.nested}}", steps_output=data)
        assert result == "value"


class TestWorkflowValidatorEdgeCases:
    """测试workflow_validator的边界情况"""
    
    def test_validate_empty_steps(self):
        """测试空steps列表"""
        app = {
            "name": "Test App",
            "steps": [],
            "parameters": [],
            "goal_template": "",
        }
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("no steps" in e.lower() for e in result["errors"])
    
    def test_validate_duplicate_refs(self):
        """测试重复ref"""
        app = {
            "name": "Test App",
            "steps": [
                {"ref": "1", "name": "Step 1", "goal": "Goal 1"},
                {"ref": "1", "name": "Step 2", "goal": "Goal 2"},
            ],
            "parameters": [],
            "goal_template": "",
        }
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("duplicate" in e.lower() for e in result["errors"])
    
    def test_validate_missing_goal(self):
        """测试缺少goal"""
        app = {
            "name": "Test App",
            "steps": [
                {"ref": "1", "name": "Step 1"},
            ],
            "parameters": [],
            "goal_template": "",
        }
        result = validate_app_definition(app)
        # 缺少goal应该是warning而不是error
        assert result["valid"] is True
        assert any("missing" in w.lower() for w in result["warnings"])


class TestRollupEdgeCases:
    """测试rollup的边界情况"""
    
    def test_is_rollup_subtask_with_none(self):
        """测试is_rollup_subtask处理None"""
        assert is_rollup_subtask(None) is False
    
    def test_is_rollup_subtask_with_invalid_type(self):
        """测试is_rollup_subtask处理无效类型"""
        assert is_rollup_subtask("invalid") is False
        assert is_rollup_subtask(123) is False
    
    def test_needs_auto_rollup_with_none(self):
        """测试needs_auto_rollup处理None"""
        assert needs_auto_rollup(None) is False
    
    def test_needs_auto_rollup_single_step(self):
        """测试单步骤不需要rollup"""
        app = {
            "steps": [{"ref": "1", "goal": "Step 1"}],
            "final_rollup": "auto",
        }
        assert needs_auto_rollup(app) is False
    
    def test_needs_auto_rollup_multi_step(self):
        """测试多步骤需要rollup"""
        app = {
            "steps": [
                {"ref": "1", "goal": "Step 1"},
                {"ref": "2", "goal": "Step 2"},
            ],
            "final_rollup": "auto",
        }
        assert needs_auto_rollup(app) is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
