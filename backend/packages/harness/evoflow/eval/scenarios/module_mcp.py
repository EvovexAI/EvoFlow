"""Module scenario: MCP — config roundtrip + agent binding (no process spawn)."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import (
    check_db_absent,
    expect_agent,
    expect_no_mcp_server,
)


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import mcp as mcp_admin

    server_name = "eval-fake-mcp"
    payload = {
        "mcp_servers": {
            server_name: {
                "enabled": True,
                "type": "stdio",
                "command": "echo",
                "args": [],
                "description": "eval mcp config only",
            }
        }
    }
    saved = mcp_admin.set_mcp_config(payload)
    got = mcp_admin.get_mcp_config()
    servers = got.get("mcp_servers") or {}
    has_server = server_name in servers

    agent_code = "eval-mod-mcp"
    try:
        agents_admin.create_agent(
            {
                "agent_code": agent_code,
                "agent_name": "MCP绑定评测",
                "description": "mcp module",
                "soul": "mcp bind",
                "skills": [],
                "mcp_servers": [server_name],
            }
        )
    except Exception:  # noqa: BLE001
        agents_admin.update_agent(agent_code, {"mcp_servers": [server_name]})
    agent = agents_admin.get_agent(agent_code)
    bound = list(agent.get("mcp_servers") or [])

    cleared_agent = agents_admin.update_agent(agent_code, {"mcp_servers": []})
    agent2 = agents_admin.get_agent(agent_code)
    cleared_bind = list(agent2.get("mcp_servers") or cleared_agent.get("mcp_servers") or [])

    emptied = mcp_admin.set_mcp_config({"mcp_servers": {}})
    after = mcp_admin.get_mcp_config().get("mcp_servers") or {}

    assertions = [
        check(
            "config_saved",
            has_server and bool((saved.get("mcp_servers") or {}).get(server_name)),
            inputs=payload,
            expected=server_name,
            actual=list(servers.keys()),
            api="mcp_admin.set_mcp_config",
        ),
        check(
            "config_get",
            has_server,
            inputs={},
            expected=server_name,
            actual=list(servers.keys()),
            api="mcp_admin.get_mcp_config",
        ),
        check(
            "agent_bound",
            server_name in bound,
            inputs={"agent_code": agent_code, "mcp_servers": [server_name]},
            expected=[server_name],
            actual=bound,
            api="agents_admin.create_agent/update_agent",
        ),
        check(
            "agent_unbind",
            cleared_bind == [],
            inputs={"agent_code": agent_code, "mcp_servers": []},
            expected=[],
            actual=cleared_bind,
            api="agents_admin.update_agent",
        ),
        check(
            "config_cleared",
            server_name not in after and len(after) == 0,
            inputs={"mcp_servers": {}},
            expected={},
            actual=after,
            api="mcp_admin.set_mcp_config({})",
        ),
    ]
    persist = [
        expect_agent(agent_code, agent_name="MCP绑定评测"),
        expect_no_mcp_server(server_name),
        check_db_absent(
            f"db_no_agent_mcp_{agent_code}_{server_name}",
            "SELECT item_value FROM evoflow_agent_list_items "
            "WHERE lower(agent_code)=lower(?) AND list_kind='mcp_servers' AND item_value=?",
            (agent_code, server_name),
        ),
    ]
    return finalize(
        assertions + persist,
        metrics={"server_name": server_name, "agent_code": agent_code, "config_plane_only": True},
        steps=[
            {"step": 1, "api": "set_mcp_config", "inputs": payload},
            {"step": 2, "api": "get_mcp_config", "result": list(servers.keys())},
            {"step": 3, "api": "agent mcp_servers bind/unbind", "result": {"bound": bound, "cleared": cleared_bind}},
            {"step": 4, "api": "set_mcp_config({})", "result": after},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
