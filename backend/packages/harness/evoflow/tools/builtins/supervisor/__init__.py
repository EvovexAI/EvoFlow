"""Supervisor submodules — extracted from the monolithic supervisor_tool.py.

Package layout:
- dependency.py     : DAG depends_on resolution, auto-finalize, subtask picking
- execution.py      : Delegation (task_tool via collab_bridge), auto-followup wave
- monitor.py        : Background task monitor, recommendation engine
- memory.py         : Memory aggregation, SSE broadcast
- utils.py          : Runtime helpers, debug, clamping
- display.py        : Subtask row formatting, worker_profile rendering

The thin routing layer (@tool + action dispatch) lives in
``evoflow.tools.builtins.supervisor_tool`` (parent package).
"""

__all__: list[str] = []
