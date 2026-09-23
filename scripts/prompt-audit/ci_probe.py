"""CI probe for the L1 prompt-audit pipeline.

The probe feeds ``apply_prompt_template`` a synthetic SOUL that bears an Identity
heading (the live-bug surface) and writes the assembled system prompt to the path
given in ``$PROBE_OUT``. The workflow then runs ``prompt_audit.py`` against that
file. Regression here catches:

  - reintroduction of duplicate identity (P-002)
  - revert of the omit_identity_section heuristic
  - regressions in the _inject_identity_layers single-entry refactor

Standalone runner-safe; uses mock to bypass real config lookups so we do not need
an evoflow.db on the runner.
"""
import os
import sys
import unittest.mock as mock

sys.path.insert(0, os.environ.get("PYTHONPATH", ""))

from evoflow.agents.lead_agent import prompt as lp  # noqa: E402

MOCK_SOUL = """Identity

超级助手——用户的任务编排伙伴

Core Traits

先弄清用户这条消息要什么，再动工具；用户没点名的旧任务不自动续跑。

Communication

默认中文，简洁务实。
"""


def main() -> int:
    out_path = os.environ["PROBE_OUT"]
    workspace = os.environ.get("GITHUB_WORKSPACE", "/home/runner/work/EvoFlow/EvoFlow")
    with mock.patch("evoflow.config.agents_config.load_agent_soul", return_value=MOCK_SOUL):
        out = lp.apply_prompt_template(
            subagent_enabled=False,
            agent_name="main",
            custom_system_prompt="",
            available_skills=None,
            loaded_tool_names=["web_search"],
            all_tool_names=["web_search"],
            use_virtual_paths=False,
            local_workspace_root=os.path.join(workspace, "backend"),
            intent_hint="ask",
            prompt_source="ci_audit_probe",
            user_question="hello",
            include_memory=False,
            thread_id="ci",
            prompt_language="zh",
            session_mode="agent",
        )
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(out)
    print(f"wrote {len(out)} chars to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
