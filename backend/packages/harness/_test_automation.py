"""Quick functional test for automation_tool (Gateway TOML + scheduler compat)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from evoflow.tools.builtins.automation_tool import (
    AutomationStatus,
    AutomationTask,
    _delete_file,
    _effective_schedule_fields,
    _list_all_tasks,
    _load_task,
    _save_task,
)


def main() -> None:
    tmp = Path(tempfile.mkdtemp())
    os.environ["EVOFLOW_AUTOMATIONS_DIR"] = str(tmp)

    try:
        assert _effective_schedule_fields("0 9 * * *")["schedule"] == "0 9 * * *"
        assert _effective_schedule_fields("daily")["schedule_type"] == "recurring"

        task = AutomationTask(
            id="manual-id",
            name="Test task",
            prompt="Run daily health check",
            schedule_type="recurring",
            rrule="FREQ=DAILY;INTERVAL=1",
            schedule_cron="0 9 * * *",
        )
        _save_task(task)
        assert (tmp / "manual-id.toml").is_file(), "Task file not created"

        loaded = _load_task("manual-id")
        assert loaded is not None
        assert loaded.name == "Test task"
        assert loaded.status == "active"
        assert loaded.prompt == "Run daily health check"

        tasks = _list_all_tasks()
        assert len(tasks) == 1

        loaded.status = AutomationStatus.PAUSED.value
        _save_task(loaded)
        reloaded = _load_task("manual-id")
        assert reloaded is not None
        assert reloaded.status == "paused"

        assert _delete_file("manual-id") is True
        assert not (tmp / "manual-id.toml").exists()
        assert _delete_file("manual-id") is False

        print("PASS: automation_tool persistence + scheduler compat")
    finally:
        os.environ.pop("EVOFLOW_AUTOMATIONS_DIR", None)
        for f in tmp.glob("*.toml"):
            try:
                f.unlink()
            except OSError:
                pass
        try:
            tmp.rmdir()
        except OSError:
            pass


if __name__ == "__main__":
    main()
