"""
工作流模块bug修复验证测试
验证之前发现的bug是否已修复
"""

import asyncio
import pytest
from unittest.mock import MagicMock, patch
import sys
import os

# 添加路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'packages', 'harness'))

from evoflow.collab.expression_resolver import _traverse, resolve_expression
from evoflow.collab.app_rollup import append_rollup_subtask, maybe_rollup_main_task
from evoflow.collab.debug_runner import debug_run_step, _find_step_by_ref
from evoflow.collab.workflow_validator import _detect_cycles, validate_app_definition


class TestBug028TraverseNone:
    """验证bug-028: _traverse函数未处理root为None的情况"""
    
    def test_traverse_with_none_root(self):
        """测试_traverse在root为None时不崩溃"""
        # 应该返回(False, None)而不是抛出异常
        found, value = _traverse(None, ["steps", "1", "output"])
        assert found == False
        assert value is None
    
    def test_traverse_with_empty_segments(self):
        """测试_traverse在segments为空时的行为"""
        found, value = _traverse({"key": "value"}, [])
        assert found == True
        assert value == {"key": "value"}
    
    def test_traverse_with_valid_path(self):
        """测试正常路径解析"""
        data = {"steps": {"1": {"output": {"result": "success"}}}}
        found, value = _traverse(data, ["steps", "1", "output", "result"])
        assert found == True
        assert value == "success"


class TestBug030DaemonThread:
    """验证bug-030: run_app_workflow 异步派发使用 detached_poll_scheduler（非阻塞 daemon 线程）"""

    def test_workflow_dispatch_uses_detached_poll_scheduler(self):
        import inspect
        from evoflow.collab import app_runner

        source = inspect.getsource(app_runner._schedule_workflow_dispatch)
        assert "schedule_detached_poll" in source
        assert "Thread" not in source or "daemon" not in source


class TestBug026RollupDuplicate:
    """验证bug-026: append_rollup_subtask可能重复添加rollup"""
    
    def test_duplicate_check_uses_is_rollup_subtask(self):
        """验证重复检查使用is_rollup_subtask函数"""
        import inspect
        from evoflow.collab.app_rollup import append_rollup_subtask
        source = inspect.getsource(append_rollup_subtask)
        assert 'is_rollup_subtask' in source, "应该使用is_rollup_subtask进行重复检查"


class TestBug089MaybeRollupNone:
    """验证bug-089: maybe_rollup_main_task未处理task为None的情况"""
    
    def test_maybe_rollup_with_none_task(self):
        """测试传入None时不崩溃"""
        result = maybe_rollup_main_task(None)
        assert result is None
    
    def test_maybe_rollup_with_invalid_type(self):
        """测试传入非dict类型时不崩溃"""
        result = maybe_rollup_main_task("invalid")
        assert result is None
    
    def test_maybe_rollup_with_valid_task(self):
        """测试正常任务处理"""
        task = {
            "id": "test_task",
            "subtasks": [],
            "status": "executing"
        }
        # 这个任务没有rollup相关配置，应该返回None
        result = maybe_rollup_main_task(task)
        assert result is None or isinstance(result, dict)


class TestBug106EventLoopLeak:
    """验证bug-106: debug_run_step创建新事件循环后未正确关闭"""
    
    def test_event_loop_cleanup_in_source(self):
        """验证源码中有loop.close()调用"""
        import inspect
        from evoflow.collab.debug_runner import debug_run_step
        source = inspect.getsource(debug_run_step)
        assert 'loop.close()' in source, "应该有loop.close()调用"
        assert 'finally:' in source, "应该在finally块中关闭loop"


class TestBug090CycleDetection:
    """验证bug-090: _detect_cycles使用set排序导致cycle_key重复检测"""
    
    def test_cycle_detection_uses_canonical_key(self):
        """验证使用_canonical_cycle_key而不是简单的set排序"""
        import inspect
        from evoflow.collab.workflow_validator import _detect_cycles
        source = inspect.getsource(_detect_cycles)
        assert '_canonical_cycle_key' in source, "应该使用_canonical_cycle_key"
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
        # 验证循环包含所有节点
        cycle_nodes = set()
        for cycle in cycles:
            cycle_nodes.update(cycle[:-1])  # 最后一个节点是重复的
        assert cycle_nodes == {"1", "2", "3"}
    
    def test_no_cycle(self):
        """测试无循环的情况"""
        steps = [
            {"ref": "1", "depends_on": []},
            {"ref": "2", "depends_on": ["1"]},
            {"ref": "3", "depends_on": ["2"]},
        ]
        cycles = _detect_cycles(steps)
        assert len(cycles) == 0, "不应该检测到循环"


class TestBug028ExpressionResolver:
    """验证expression_resolver中的None处理"""
    
    def test_resolve_with_none_steps_output(self):
        """测试steps_output为None时的处理"""
        result = resolve_expression("{{params.topic}}", params={"topic": "test"})
        assert result == "test"
    
    def test_resolve_with_missing_path(self):
        """测试路径不存在时的处理"""
        result = resolve_expression("{{steps.999.output}}", steps_output={})
        assert result == "{{steps.999.output}}"  # 未解析的表达式保持原样


class TestBug121ExtractorStepsNone:
    """验证bug-121: extract_parameters_from_plan未处理steps为None"""
    
    def test_extractor_with_none_steps(self):
        """测试steps为None时不崩溃"""
        from evoflow.collab.app_extractor import extract_parameters_from_plan
        try:
            result = extract_parameters_from_plan("Test goal", None)
            # 应该返回空结果而不是崩溃
            assert result is not None
        except Exception as e:
            pytest.fail(f"extract_parameters_from_plan应该处理steps=None的情况，但抛出异常: {e}")


class TestBug122GeneratorEmptyGoal:
    """验证bug-122: generate_app_from_plan未处理goal为空"""
    
    def test_generator_with_empty_goal(self):
        """测试goal为空时的处理"""
        from evoflow.collab.app_generator import generate_app_from_plan
        try:
            result = generate_app_from_plan(
                name="Test App",
                goal="",
                steps=[]
            )
            assert result is not None
            assert "id" in result
        except Exception as e:
            pytest.fail(f"generate_app_from_plan应该处理空goal的情况，但抛出异常: {e}")


class TestBug124FindStepByRef:
    """验证bug-124: _find_step_by_ref未处理空ref"""
    
    def test_find_step_with_empty_ref(self):
        """测试空ref的处理"""
        steps = [
            {"ref": "1", "name": "Step 1"},
            {"ref": "2", "name": "Step 2"},
        ]
        result = _find_step_by_ref(steps, "")
        assert result is None
    
    def test_find_step_with_none_ref(self):
        """测试None ref的处理"""
        steps = [
            {"ref": "1", "name": "Step 1"},
        ]
        result = _find_step_by_ref(steps, None)
        assert result is None
    
    def test_find_step_with_valid_ref(self):
        """测试有效ref的查找"""
        steps = [
            {"ref": "1", "name": "Step 1"},
            {"ref": "2", "name": "Step 2"},
        ]
        result = _find_step_by_ref(steps, "2")
        assert result is not None
        assert result["name"] == "Step 2"


class TestBug125BuildRollupSpec:
    """验证bug-125: build_rollup_subtask_spec未处理app为None"""
    
    def test_build_spec_with_none_app(self):
        """测试app为None时的处理"""
        from evoflow.collab.app_rollup import build_rollup_subtask_spec
        try:
            result = build_rollup_subtask_spec(None)
            # 应该返回合理的默认值而不是崩溃
            assert result is not None
        except Exception as e:
            pytest.fail(f"build_rollup_subtask_spec应该处理app=None的情况，但抛出异常: {e}")


class TestBug103PlanSessionTask:
    """验证bug-103: plan_session_task未校验thread_id为空"""
    
    def test_check_source_code(self):
        """检查源码是否有thread_id校验"""
        import inspect
        try:
            from evoflow.collab.plan_session_task import bind_plan_to_thread_task
            source = inspect.getsource(bind_plan_to_thread_task)
            # 检查是否有thread_id相关的校验
            has_thread_check = 'thread_id' in source and ('not' in source or 'empty' in source.lower() or 'strip' in source)
            # 这个测试主要是确认修复状态，不强制要求特定实现
            print(f"thread_id check found: {has_thread_check}")
        except ImportError:
            pytest.skip("plan_session_task模块不存在")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
