"""PyInstaller runtime hook: fix stdio/colorama before the entry script imports uvicorn."""

from __future__ import annotations

import os
import sys

if getattr(sys, "frozen", False):
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ["NO_COLOR"] = "1"
    os.environ["FORCE_COLOR"] = "0"
    os.environ["COLORAMA_DISABLE"] = "1"
    try:
        from evoflow.desktop_stdio import prepare_frozen_process_stdio

        prepare_frozen_process_stdio()
    except Exception:
        pass
