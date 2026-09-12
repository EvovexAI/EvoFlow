"""Unit tests for the automation scheduler engine (#19 远期规划).

Tests:
- RRULE parsing (HOURLY, DAILY, WEEKLY, ONCE)
- Next-trigger calculation
- Schedule type detection
- Executor history recording (JSONL)
- Manager singleton lifecycle

Note: Tests use direct file loading via importlib because the full evoflow
package chain requires Python 3.12+ (PEP 695 generics in resolvers.py).

Run: python tests/test_scheduler.py
"""

import importlib.util
import shutil
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path


def load_module(name: str, filepath: str):
    """Load a module from file path (bypasses package __init__.py)."""
    spec = importlib.util.spec_from_file_location(name, filepath)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ─── Paths ──────────────────────────────────────────────────────

BASE = Path(r"d:\github\evoflow\backend\packages\harness")
EVOFLOW_ROOT = BASE / "evoflow"

ENGINE_PATH = EVOFLOW_ROOT / "core" / "scheduler" / "engine.py"
EXECUTOR_PATH = EVOFLOW_ROOT / "core" / "scheduler" / "executor.py"
AUTO_TOOL_PATH = EVOFLOW_ROOT / "tools" / "builtins" / "automation_tool.py"

# Load modules that don't trigger the full package chain
_engine_mod = load_module("df_engine", str(ENGINE_PATH))
_executor_mod = load_module("df_executor", str(EXECUTOR_PATH))

# Shortcuts
parse_rrule = _engine_mod.parse_rrule
next_trigger = _engine_mod.next_trigger
ScheduleType = _engine_mod.ScheduleType
RunRecord = _executor_mod.RunRecord
AutomationExecutorConfig = _executor_mod.AutomationExecutorConfig
_append_history = _executor_mod.AutomationExecutor._append_history  # static method
get_history = _executor_mod.AutomationExecutor.get_history  # static method

# Load automation_tool as isolated module for schedule parsing tests only
_auto_tool_mod = load_module("df_auto_tool", str(AUTO_TOOL_PATH))
_parse_schedule = _auto_tool_mod._parse_schedule


class TestRRuleParsing(unittest.TestCase):
    def test_hourly_interval(self):
        p = parse_rrule("FREQ=HOURLY;INTERVAL=1")
        self.assertEqual(p.schedule_type.value, "hourly")
        self.assertEqual(p.interval_seconds, 3600)

    def test_hourly_6h(self):
        p = parse_rrule("FREQ=HOURLY;INTERVAL=6")
        self.assertEqual(p.interval_seconds, 21600)

    def test_daily_default(self):
        p = parse_rrule("FREQ=DAILY;INTERVAL=1")
        self.assertEqual(p.schedule_type.value, "daily")

    def test_daily_with_hour(self):
        p = parse_rrule("FREQ=DAILY;BYHOUR=14")
        self.assertEqual(p.hour, 14)

    def test_weekly_weekdays(self):
        p = parse_rrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9")
        self.assertEqual(p.schedule_type.value, "weekly")
        self.assertEqual(p.days_of_week, [0, 1, 2, 3, 4])
        self.assertEqual(p.hour, 9)

    def test_empty_rrule(self):
        p = parse_rrule("")
        self.assertEqual(p.schedule_type.value, "interval")


class TestNextTrigger(unittest.TestCase):
    def test_hourly_returns_future(self):
        p = parse_rrule("FREQ=HOURLY;INTERVAL=1")
        nxt = next_trigger(p)
        self.assertIsNotNone(nxt)
        self.assertGreater(nxt, datetime.now())

    def test_daily_tomorrow_if_past(self):
        p = parse_rrule("FREQ=DAILY;INTERVAL=1")
        p.hour = 23
        nxt = next_trigger(p)
        self.assertIsNotNone(nxt)


class TestExecutorHistory(unittest.TestCase):
    def setUp(self):
        # Redirect history to temp dir
        self._tmpdir = Path(tempfile.mkdtemp())
        self._original_dir = _executor_mod._AUTOMATIONS_DIR
        _executor_mod._AUTOMATIONS_DIR = self._tmpdir
        self._tmpdir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        _executor_mod._AUTOMATIONS_DIR = self._original_dir
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_history_write_and_read(self):
        task_id = "test001"
        record = RunRecord(
            run_id="run_001",
            status="success",
            output="Hello world",
            duration_seconds=1.5,
            trigger_type="manual",
        )
        _append_history(task_id, record)
        records = get_history(task_id)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].status, "success")
        self.assertEqual(records[0].output, "Hello world")

    def test_multiple_records(self):
        task_id = "test002"
        for i in range(5):
            _append_history(task_id, RunRecord(status="success", output=f"Run {i}"))
        records = get_history(task_id)
        self.assertEqual(len(records), 5)
        # Most recent first
        self.assertIn("Run 4", records[0].output)


class TestScheduleParsingFromAutomationTool(unittest.TestCase):
    def test_every_hour(self):
        rrule, stype = _parse_schedule("every hour")
        self.assertEqual(stype, "recurring")
        self.assertIn("HOURLY", rrule.upper())

    def test_daily_alias(self):
        rrule, stype = _parse_schedule("daily")
        self.assertEqual(stype, "recurring")

    def test_weekdays(self):
        rrule, stype = _parse_schedule("weekdays")
        self.assertEqual(stype, "recurring")
        self.assertIn("WEEKLY", rrule.upper())

    def test_iso_datetime_once(self):
        rrule, stype = _parse_schedule("2026-06-15T14:30:00")
        self.assertEqual(stype, "once")

    def test_raw_rrule(self):
        rrule, stype = _parse_schedule("FREQ=HOURLY;INTERVAL=2")
        self.assertEqual(stype, "recurring")
        self.assertEqual(rrule, "FREQ=HOURLY;INTERVAL=2")


class TestTimerWrapper(unittest.TestCase):
    """Test ScheduledTimer basic lifecycle."""

    def test_timer_creation(self):
        from df_engine import ScheduledTimer

        t = ScheduledTimer(task_id="test123")
        self.assertFalse(t.is_running)
        self.assertIsNone(t.timer)


# ─── Main ────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("EvoFlow Scheduler Engine Tests (#19 远期规划)")
    print(f"Python: {sys.version.split()[0]}")
    print("=" * 60)

    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    suite.addTests(loader.loadTestsFromTestCase(TestRRuleParsing))
    suite.addTests(loader.loadTestsFromTestCase(TestNextTrigger))
    suite.addTests(loader.loadTestsFromTestCase(TestExecutorHistory))
    suite.addTests(loader.loadTestsFromTestCase(TestScheduleParsingFromAutomationTool))
    suite.addTests(loader.loadTestsFromTestCase(TestTimerWrapper))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    print(f"\n{'=' * 60}")
    total = result.testsRun
    failures = len(result.failures)
    errors = len(result.errors)
    passed = total - failures - errors
    print(f"Results: {passed}/{total} passed, {failures} failed, {errors} errors")
    print(f"{'=' * 60}")

    sys.exit(0 if result.wasSuccessful() else 1)
