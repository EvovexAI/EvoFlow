"""L2 MCP：字段 roundtrip + agent None/[]/allowlist 三种绑定语义."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import check_db_absent, expect_no_mcp_server


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import mcp as mcp_admin

    name = "eval-mcp-l2"
    payload = {
        "mcp_servers": {
            name: {
                "enabled": True,
                "type": "stdio",
                "command": "echo",
                "args": ["ping"],
                "description": "l2 mcp fields",
            }
        }
    }
    mcp_admin.set_mcp_config(payload)
    got = (mcp_admin.get_mcp_config().get("mcp_servers") or {}).get(name) or {}

    code = "eval-mod-mcp-l2"
    try:
        agents_admin.delete_agent(code, confirm_cascade=True)
    except Exception:  # noqa: BLE001
        pass

    # None = unrestricted (stored as null)
    agents_admin.create_agent(
        {
            "agent_code": code,
            "agent_name": "MCP L2",
            "description": "mcp detail",
            "soul": "mcp",
            "skills": [],
            "mcp_servers": None,
        }
    )
    unbound = agents_admin.get_agent(code).get("mcp_servers")

    agents_admin.update_agent(code, {"mcp_servers": [name]})
    allow = list(agents_admin.get_agent(code).get("mcp_servers") or [])

    agents_admin.update_agent(code, {"mcp_servers": []})
    empty = list(agents_admin.get_agent(code).get("mcp_servers") or [])

    mcp_admin.set_mcp_config({"mcp_servers": {}})
    agents_admin.delete_agent(code, confirm_cascade=True)

    assertions = [
        check(
            "fields_roundtrip",
            got.get("type") == "stdio"
            and got.get("command") == "echo"
            and list(got.get("args") or []) == ["ping"]
            and bool(got.get("enabled")),
            inputs=payload,
            expected={"type": "stdio", "command": "echo", "args": ["ping"], "enabled": True},
            actual=got,
            api="mcp_admin.set/get_mcp_config",
        ),
        check(
            "agent_unrestricted_none",
            unbound is None,
            inputs={"mcp_servers": None},
            expected=None,
            actual=unbound,
            api="agents_admin.create_agent",
        ),
        check(
            "agent_allowlist",
            allow == [name],
            inputs={"mcp_servers": [name]},
            expected=[name],
            actual=allow,
            api="agents_admin.update_agent",
        ),
        check(
            "agent_empty_drops_all_mcp",
            empty == [],
            inputs={"mcp_servers": []},
            expected=[],
            actual=empty,
            api="agents_admin.update_agent",
        ),
    ]
    persist = [
        expect_no_mcp_server(name),
        check_db_absent(
            f"db_no_agent_{code}",
            "SELECT agent_code FROM evoflow_agents WHERE lower(agent_code)=lower(?)",
            (code,),
        ),
    ]
    return finalize(
        assertions + persist,
        metrics={"server": name, "agent": code},
        steps=[
            {"step": 1, "api": "set_mcp_config fields", "result": got},
            {"step": 2, "api": "agent mcp_servers=None/[name]/[]", "result": {"none": unbound, "allow": allow, "empty": empty}},
            {"step": 3, "api": "cleanup config + agent"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
