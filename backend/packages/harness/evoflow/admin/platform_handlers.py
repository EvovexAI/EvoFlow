"""platform 工具各域 handler（副作用走 evoflow.admin.*）。"""

from __future__ import annotations

import json
from typing import Any

from evoflow.admin.errors import ValidationError


def _arg_str(args: dict[str, Any], *keys: str) -> str:
    for k in keys:
        v = args.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()
    return ""


def _arg_bool(args: dict[str, Any], key: str, default: bool = False) -> bool:
    if key not in args:
        return default
    v = args.get(key)
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() not in {"0", "false", "no", "off", ""}
    return bool(v)


def _arg_json_value(args: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        v = args.get(k)
        if v is None:
            continue
        if isinstance(v, (dict, list)):
            return v
        if isinstance(v, str) and v.strip():
            try:
                return json.loads(v)
            except Exception:
                return v
    return None


def _workflow_app_result(data: dict[str, Any]) -> dict[str, Any]:
    app = data.get("app") if isinstance(data.get("app"), dict) else {}
    app_id = _arg_str(data, "appId", "app_id") or _arg_str(app, "id")
    out: dict[str, Any] = {"ok": True, **data}
    if app_id:
        out["appId"] = app_id
        out["app_id"] = app_id
    name = _arg_str(app, "name") or _arg_str(data, "name", "title")
    if name:
        out["name"] = name
        out["title"] = name
    status = _arg_str(app, "status") or _arg_str(data, "status")
    if status:
        out["status"] = status
    return out


# ── knowledge ──────────────────────────────────────────────────────────────


def knowledge_list(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    # Primary: platform-owned KB. Legacy Obsidian vaults remain available via CLI vaults.
    data = kn.list_bases()
    return {"ok": True, **data}


def knowledge_search(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    query = _arg_str(args, "query")
    if not query:
        raise ValidationError("query is required")
    vault_id = _arg_str(args, "vaultId", "vault_id", "kbId", "kb_id") or None
    limit = int(args.get("top_k") or args.get("limit") or 8)
    mode = _arg_str(args, "mode") or "fulltext"
    data = kn.recall(query, vault_id=vault_id, limit=limit, mode=mode)
    entries = data.get("entries") or data.get("results") or data.get("hits") or []
    if not isinstance(entries, list):
        entries = []
    return {
        "ok": True,
        **data,
        "hits": len(entries),
        "results": entries,
        "hint": "用片段口语回答；无命中勿编造。",
    }


def knowledge_create(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    name = _arg_str(args, "name", "title")
    if not name:
        raise ValidationError("name is required")
    # Platform knowledge = owned KB. Obsidian vaultPath / accessMode are ignored
    # (legacy vault create remains on CLI: knowledge create --legacy-vault).
    data = kn.create_owned_base(
        name=name,
        description=_arg_str(args, "description", "desc"),
        embedding_model_ref=_arg_str(args, "embeddingModelRef", "embedding_model_ref") or None,
    )
    return {
        "ok": True,
        **data,
        "hint": "已创建平台自有知识库；写入内容用 knowledge.ingest（vaultId/kbId 均可）。",
    }


def knowledge_enable(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    vault_id = _arg_str(args, "vaultId", "vault_id", "kbId", "kb_id")
    if not vault_id:
        raise ValidationError("vaultId is required")
    if vault_id.startswith("kb_"):
        raise ValidationError(
            "自有知识库无需启用/停用；删除请在面板「知识库」操作，或继续用 knowledge.ingest / search。"
        )
    data = kn.set_vault_enabled(vault_id, _arg_bool(args, "enabled", True))
    return {"ok": True, **data}


def knowledge_reindex(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    kb_id = _arg_str(args, "kbId", "kb_id", "vaultId", "vault_id")
    if not kb_id:
        raise ValidationError("kbId is required")
    data = kn.reindex_owned_base(
        kb_id,
        embedding_model_ref=_arg_str(args, "embeddingModelRef", "embedding_model_ref") or None,
        force=_arg_bool(args, "force", True),
    )
    return {
        "ok": True,
        **data,
        "kbId": kb_id,
        "vaultId": kb_id,
        "hint": "已排队重索引；大文档切 local 时可传 embeddingModelRef=bge-small-zh。",
    }


def knowledge_requeue(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    kb_id = _arg_str(args, "kbId", "kb_id", "vaultId", "vault_id") or None
    limit = int(args.get("limit") or 200)
    data = kn.requeue_owned_orphans(kb_id, limit=limit)
    return {
        "ok": True,
        **data,
        "hint": "已把卡住的 pending/processing 文档重新排队索引。",
    }


def knowledge_ingest(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    title = _arg_str(args, "title")
    content = _arg_str(args, "content", "knowledge")
    if not title or not content:
        raise ValidationError("title and content are required")
    vault_id = _arg_str(args, "vaultId", "vault_id", "kbId", "kb_id") or None
    payload = {
        "title": title,
        "content": content,
        "summary": _arg_str(args, "summary"),
        "source": _arg_str(args, "source") or "platform",
        "tags": list(args.get("tags") or []),
    }
    data = kn.remember(payload, vault_id=vault_id)
    nested = data.get("result") if isinstance(data.get("result"), dict) else {}
    path = str(nested.get("path") or data.get("path") or data.get("note_path") or "")
    out = {"ok": True, **data}
    if path:
        out["path"] = path
        out["notePath"] = path
        out["note_path"] = path
    return out


def knowledge_notes(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    vault_id = _arg_str(args, "vaultId", "vault_id", "kbId", "kb_id") or None
    prefix = _arg_str(args, "prefix", "path")
    limit = int(args.get("limit") or 80)
    return {"ok": True, **kn.list_knowledge(vault_id=vault_id, prefix=prefix, limit=limit)}


def knowledge_note_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    path = _arg_str(args, "path")
    if not path:
        raise ValidationError("path is required")
    vault_id = _arg_str(args, "vaultId", "vault_id", "kbId", "kb_id") or None
    return {"ok": True, **kn.get_knowledge(path, vault_id=vault_id)}


def knowledge_note_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    path = _arg_str(args, "path")
    if not path:
        raise ValidationError("path is required")
    vault_id = _arg_str(args, "vaultId", "vault_id", "kbId", "kb_id") or None
    return {"ok": True, **kn.delete_knowledge(path, vault_id=vault_id)}


# ── workflow ───────────────────────────────────────────────────────────────


def workflow_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    return {
        "ok": True,
        **apps_admin.list_apps(
            status=_arg_str(args, "status") or None,
            search=_arg_str(args, "search", "query") or None,
            limit=int(args.get("limit") or 50),
        ),
    }


def workflow_schema(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.platform_workflow_schema import build_workflow_platform_schema

    return {"ok": True, **build_workflow_platform_schema()}


def workflow_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    app_id = _arg_str(args, "appId", "app_id", "id")
    if not app_id:
        raise ValidationError("appId is required")
    data = apps_admin.get_app(app_id)
    app = data.get("app") if isinstance(data.get("app"), dict) else {}
    return {
        "ok": True,
        **data,
        "appId": app_id,
        "goal_template": app.get("goal_template") or "",
        "steps_preview": app.get("steps_preview") or [],
        "steps_count": app.get("steps_count") or 0,
    }


def workflow_run(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    app_id = _arg_str(args, "appId", "app_id", "id")
    if not app_id:
        raise ValidationError("appId is required")
    parameters = args.get("parameters") if isinstance(args.get("parameters"), dict) else {}
    data = apps_admin.run_app(app_id, parameters=parameters)
    run = data.get("run") if isinstance(data.get("run"), dict) else {}
    run_id = str(run.get("run_id") or data.get("run_id") or data.get("runId") or "")
    out = {"ok": True, **data}
    if run_id:
        out["runId"] = run_id
        out["run_id"] = run_id
    return out


def workflow_stop(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    run_id = _arg_str(args, "runId", "run_id")
    if not run_id:
        raise ValidationError("runId is required")
    reason = _arg_str(args, "reason") or "小V按用户要求停止"
    if _arg_bool(args, "pause", False):
        return {"ok": True, **apps_admin.pause_run(run_id, reason=reason)}
    return {"ok": True, **apps_admin.cancel_run(run_id, reason=reason)}


def workflow_run_status(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    run_id = _arg_str(args, "runId", "run_id")
    if not run_id:
        raise ValidationError("runId is required")
    data = apps_admin.get_run(run_id)
    run = data.get("run") if isinstance(data.get("run"), dict) else {}
    status = str(data.get("status") or run.get("status") or "")
    progress = run.get("progress") if "progress" in run else data.get("progress")
    steps = run.get("steps") if isinstance(run.get("steps"), list) else data.get("steps")
    out = {
        "ok": True,
        **data,
        "runId": run_id,
        "run_id": run_id,
        "progress": progress,
        "steps": steps if isinstance(steps, list) else [],
        "subtask_status": run.get("subtask_status") or data.get("subtask_status") or {},
        "result_summary": run.get("result_summary") or data.get("result_summary") or "",
        "task_id": run.get("task_id") or data.get("task_id"),
        "error": run.get("error") or data.get("error"),
    }
    if status:
        out["status"] = status
    # Compact trail for agents / verification ledgers
    trail = []
    for st in out["steps"] or []:
        if not isinstance(st, dict):
            continue
        trail.append(
            {
                "ref": st.get("ref"),
                "name": st.get("name"),
                "status": st.get("status"),
                "assigned_agent": st.get("assigned_agent"),
                "progress": st.get("progress"),
                "description": (str(st.get("description") or "")[:400]),
                "result_summary": (str(st.get("result_summary") or "")[:400]),
                "error_text": (str(st.get("error_text") or "")[:200]),
            }
        )
    out["trail"] = trail
    return out


def workflow_create(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    name = _arg_str(args, "name", "title")
    if not name:
        raise ValidationError("name is required")
    steps = _arg_json_value(args, "steps")
    if not isinstance(steps, list):
        steps = []
    parameters = _arg_json_value(args, "parameters")
    if not isinstance(parameters, list):
        parameters = []
    plan = _arg_json_value(args, "plan")
    canvas = _arg_json_value(args, "canvas")
    tags = _arg_json_value(args, "tags")
    if not isinstance(tags, list):
        tags = []
    data = apps_admin.create_app(
        name=name,
        description=_arg_str(args, "description"),
        icon=_arg_str(args, "icon"),
        category=_arg_str(args, "category") or "general",
        parameters=parameters,
        steps=steps,
        goal_template=_arg_str(args, "goal", "goal_template"),
        execution_mode=_arg_str(args, "execution_mode", "executionMode") or "workflow",
        auto_run=_arg_bool(args, "auto_run", False),
        tags=tags,
        canvas=canvas if isinstance(canvas, dict) else None,
        plan=plan if isinstance(plan, dict) else None,
    )
    return _workflow_app_result({**data, "hint": "已创建草稿；发布前可用 workflow.publish。"})


def workflow_update(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    app_id = _arg_str(args, "appId", "app_id", "id")
    if not app_id:
        raise ValidationError("appId is required")
    patch = {
        k: v
        for k, v in args.items()
        if k not in {"appId", "app_id", "id", "confirm", "confirmed", "yes"} and v is not None
    }
    data = apps_admin.update_app(app_id, patch)
    return _workflow_app_result(data)


def workflow_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    app_id = _arg_str(args, "appId", "app_id", "id")
    if not app_id:
        raise ValidationError("appId is required")
    data = apps_admin.delete_app(app_id)
    return {"ok": True, **data}


def workflow_publish(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    app_id = _arg_str(args, "appId", "app_id", "id")
    if not app_id:
        raise ValidationError("appId is required")
    data = apps_admin.publish_app(app_id)
    return _workflow_app_result({**data, "hint": "已发布，可 workflow.run 或创建 API Key。"})


def workflow_unpublish(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    app_id = _arg_str(args, "appId", "app_id", "id")
    if not app_id:
        raise ValidationError("appId is required")
    data = apps_admin.unpublish_app(app_id)
    return _workflow_app_result({**data, "hint": "已退回草稿，可继续 workflow.update 修改。"})


def workflow_generate(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    name = _arg_str(args, "name", "title")
    goal = _arg_str(args, "goal", "goal_template")
    if not name:
        raise ValidationError("name is required")
    if not goal:
        raise ValidationError("goal is required")
    steps = _arg_json_value(args, "steps")
    if not isinstance(steps, list):
        steps = []
    tags = _arg_json_value(args, "tags")
    if not isinstance(tags, list):
        tags = []
    canvas = _arg_json_value(args, "canvas")
    data = apps_admin.generate_app(
        name=name,
        goal=goal,
        steps=steps,
        description=_arg_str(args, "description"),
        icon=_arg_str(args, "icon") or "📋",
        category=_arg_str(args, "category") or "general",
        execution_mode=_arg_str(args, "execution_mode", "executionMode") or "workflow",
        auto_run=_arg_bool(args, "auto_run", False),
        auto_extract=_arg_bool(args, "auto_extract", True),
        max_params=int(args.get("max_params") or args.get("maxParams") or 5),
        tags=tags,
        canvas=canvas if isinstance(canvas, dict) else None,
    )
    return _workflow_app_result({**data, "hint": "已从目标+步骤生成草稿应用。"})


def workflow_duplicate(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    app_id = _arg_str(args, "appId", "app_id", "id")
    if not app_id:
        raise ValidationError("appId is required")
    data = apps_admin.duplicate_app(app_id, name=_arg_str(args, "name", "title") or None)
    return _workflow_app_result({**data, "hint": "已复制为新的草稿应用。"})


def workflow_list_runs(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    app_id = _arg_str(args, "appId", "app_id", "id")
    if not app_id:
        raise ValidationError("appId is required")
    return {
        "ok": True,
        **apps_admin.list_app_runs(
            app_id,
            limit=int(args.get("limit") or 20),
            page=int(args.get("page") or 1),
        ),
    }


def workflow_resume(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    run_id = _arg_str(args, "runId", "run_id")
    if not run_id:
        raise ValidationError("runId is required")
    return {"ok": True, **apps_admin.resume_run(run_id)}


def workflow_revisions(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    app_id = _arg_str(args, "appId", "app_id", "id")
    if not app_id:
        raise ValidationError("appId is required")
    return {
        "ok": True,
        **apps_admin.list_app_revisions(app_id, limit=int(args.get("limit") or 50)),
    }


def workflow_restore_revision(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin

    app_id = _arg_str(args, "appId", "app_id", "id")
    version_raw = args.get("version")
    if not app_id:
        raise ValidationError("appId is required")
    if version_raw is None:
        raise ValidationError("version is required")
    data = apps_admin.restore_app_revision(
        app_id,
        int(version_raw),
        as_draft=_arg_bool(args, "as_draft", True),
    )
    return _workflow_app_result({**data, "hint": "已从历史版本恢复为当前草稿。"})


# ── settings / models ──────────────────────────────────────────────────────


def settings_list_models(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import models as models_admin

    primary = models_admin.get_primary_model()
    listed = models_admin.list_models()
    return {
        "ok": True,
        "primary_model": primary.get("primary_model"),
        "models": listed.get("models") or [],
    }


def settings_get_default_model(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import models as models_admin

    primary = models_admin.get_primary_model()
    name = primary.get("primary_model")
    return {
        "ok": True,
        "primary_model": name,
        "model": name,
        "default_model": name,
    }


def settings_set_default_model(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import models as models_admin

    name = _arg_str(args, "model", "modelName", "model_name", "name")
    if not name:
        raise ValidationError("model is required")
    return {"ok": True, **models_admin.set_primary_model(name)}


def settings_get_model(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import models as models_admin

    name = _arg_str(args, "model", "name", "modelName")
    if not name:
        raise ValidationError("model is required")
    return {"ok": True, "model": models_admin.get_model(name)}


def settings_create_model(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import models as models_admin

    return {"ok": True, "model": models_admin.create_model(args)}


def settings_delete_model(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import models as models_admin

    name = _arg_str(args, "model", "name", "modelName")
    if not name:
        raise ValidationError("model is required")
    return {"ok": True, **models_admin.delete_model(name)}


def assets_get_profile(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import profile as profile_admin

    return {"ok": True, **profile_admin.get_user_profile(principal_id=_arg_str(args, "principal_id"))}


def assets_update_profile(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import profile as profile_admin

    path = _arg_str(args, "path", "dimension", "dim")
    content = args.get("content")
    if content is None:
        content = args.get("text") or args.get("profile")
    if not path:
        raise ValidationError("path is required (basic-info | preferences | persona)")
    if content is None or not str(content).strip():
        raise ValidationError("content is required")
    mode = _arg_str(args, "mode") or "append"
    return {
        "ok": True,
        **profile_admin.update_user_profile_dimension(
            path,
            str(content),
            mode=mode,
            principal_id=_arg_str(args, "principal_id"),
        ),
    }


def settings_get_web_search(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import web_search as ws

    data = ws.get_web_search()
    # Put guide first so models read diagnosis before raw tables.
    guide = data.pop("assistant_guide", None)
    out: dict[str, Any] = {"ok": True}
    if guide is not None:
        out["assistant_guide"] = guide
    out.update(data)
    return out


def settings_patch_web_search(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import web_search as ws

    if not ws.normalize_web_search_patch(args):
        raise ValidationError(
            "pass preferredBackend and/or provider keys "
            "(doubaoApiKey / bochaApiKey / tavilyApiKey / searxngUrl / …)"
        )
    data = ws.patch_web_search(args)
    guide = data.pop("assistant_guide", None)
    out: dict[str, Any] = {"ok": True}
    if guide is not None:
        out["assistant_guide"] = guide
    out.update(data)
    return out


def settings_test_web_search(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import web_search as ws

    engines = args.get("engines")
    if isinstance(engines, str) and engines.strip():
        engines = [x.strip() for x in engines.replace(",", " ").split() if x.strip()]
    elif not isinstance(engines, list):
        engines = None
    max_results = args.get("max_results")
    try:
        max_results_i = int(max_results) if max_results is not None else 5
    except (TypeError, ValueError):
        max_results_i = 5
    adopt = _arg_bool(args, "adopt_recommended", False) or _arg_bool(args, "adoptRecommended", False)
    return {
        "ok": True,
        **ws.test_web_search(
            query=_arg_str(args, "query") or None,
            engines=engines,
            max_results=max_results_i,
            adopt_recommended=adopt,
        ),
    }


# ── agents ─────────────────────────────────────────────────────────────────


def agents_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import agents as agents_admin

    tag = _arg_str(args, "tag", "tags") or None
    agent_name = _arg_str(args, "agent_name", "agentName", "name_cn") or None
    include_soul = _arg_bool(args, "include_soul", False)
    limit = args.get("limit")
    offset = args.get("offset")
    kwargs: dict[str, Any] = {
        "tag": tag,
        "agent_name": agent_name or None,
        "include_soul": include_soul,
    }
    if limit is not None:
        try:
            kwargs["limit"] = int(limit)
        except (TypeError, ValueError) as e:
            raise ValidationError("limit must be an integer >= 0") from e
        if kwargs["limit"] < 0:
            raise ValidationError("limit must be >= 0")
    if offset is not None:
        try:
            kwargs["offset"] = int(offset)
        except (TypeError, ValueError) as e:
            raise ValidationError("offset must be an integer >= 0") from e
        if kwargs["offset"] < 0:
            raise ValidationError("offset must be >= 0")
    return {"ok": True, **agents_admin.list_agents(**kwargs)}


def agents_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import agents as agents_admin

    name = _arg_str(args, "name", "agent_code", "agentCode", "id")
    if not name:
        raise ValidationError("name/agent_code is required")
    return {"ok": True, "agent": agents_admin.get_agent(name)}


def agents_create(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import agents as agents_admin

    return {"ok": True, "agent": agents_admin.create_agent(args)}


def agents_update(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import agents as agents_admin

    name_key = _arg_str(args, "name")
    code_key = _arg_str(args, "agent_code", "agentCode")
    if name_key and code_key and name_key.lower() != code_key.lower():
        raise ValidationError("agent_code is immutable and cannot be changed via agents.update")
    name = name_key or code_key
    if not name:
        raise ValidationError("name/agent_code is required")
    patch = {
        k: v
        for k, v in args.items()
        if k not in {"name", "agent_code", "agentCode", "confirm", "confirmed", "yes"}
    }
    return {"ok": True, "agent": agents_admin.update_agent(name, patch)}


def agents_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import agents as agents_admin

    name = _arg_str(args, "name", "agent_code", "agentCode")
    if not name:
        raise ValidationError("name/agent_code is required")
    keep_employee = _arg_bool(args, "keep_employee", False)
    # Platform confirm=true (stripped before handler) OR explicit confirm_cascade.
    confirm_cascade = (
        not keep_employee
        and (
            _arg_bool(args, "confirm_cascade", False)
            or _arg_bool(args, "confirm", False)
        )
    )
    return {
        "ok": True,
        **agents_admin.delete_agent(
            name,
            confirm_cascade=confirm_cascade,
            keep_employee=keep_employee,
        ),
    }


# ── employees ──────────────────────────────────────────────────────────────


def employees_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    status = _arg_str(args, "status") or None
    include_archived = _arg_bool(args, "include_archived", False)
    data = emp.list_roles(status=status, include_archived=include_archived)
    roles = data.get("roles") if isinstance(data.get("roles"), list) else []
    # Aliases for agents / verification runners that expect employees|items
    return {"ok": True, **data, "employees": roles, "items": roles}


def employees_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code", "name")
    if not code:
        raise ValidationError("agent_code is required")
    return {"ok": True, **emp.get_role(code, recent_limit=int(args.get("recent_limit") or 10))}


def employees_hire(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    return {"ok": True, **emp.hire(args)}


def employees_update(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code")
    if not code:
        raise ValidationError("agent_code is required")
    patch = {
        k: v
        for k, v in args.items()
        if k not in {"agent_code", "agentCode", "code", "confirm", "confirmed", "yes"}
    }
    return {"ok": True, **emp.update_role(code, patch)}


def employees_pause(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code")
    if not code:
        raise ValidationError("agent_code is required")
    return {"ok": True, **emp.pause_role(code)}


def employees_resume(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code")
    if not code:
        raise ValidationError("agent_code is required")
    return {"ok": True, **emp.resume_role(code)}


def employees_stop(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code")
    if not code:
        raise ValidationError("agent_code is required")
    return {"ok": True, **emp.stop_role(code)}


def employees_archive(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code")
    if not code:
        raise ValidationError("agent_code is required")
    return {"ok": True, **emp.archive_role(code)}


def employees_worklog(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code")
    if not code:
        raise ValidationError("agent_code is required")
    day = _arg_str(args, "day", "date") or None
    # Accept legacy/typo ``days`` as a soft alias only when it looks like YYYY-MM-DD.
    if not day:
        raw_days = args.get("days")
        if isinstance(raw_days, str) and len(raw_days.strip()) == 10 and raw_days.strip()[4] == "-":
            day = raw_days.strip()
    return {
        "ok": True,
        **emp.worklog(code, day=day, limit=int(args.get("limit") or 20)),
    }


def employees_trail(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code", "name")
    if not code:
        raise ValidationError("agent_code is required")
    raw_steps = args.get("max_steps", args.get("maxSteps", 60))
    try:
        max_steps = int(raw_steps)
    except (TypeError, ValueError) as e:
        raise ValidationError("max_steps must be a positive integer") from e
    if max_steps <= 0:
        raise ValidationError("max_steps must be a positive integer")
    return {
        "ok": True,
        **emp.round_trail(
            code,
            round_id=_arg_str(args, "round_id", "roundId") or None,
            max_steps=max_steps,
        ),
    }


# ── tasks ──────────────────────────────────────────────────────────────────


def tasks_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import tasks as tasks_admin

    return {
        "ok": True,
        **tasks_admin.list_tasks(
            status=_arg_str(args, "status") or None,
            assignee=_arg_str(args, "assignee", "agent_code", "agentCode") or None,
            role=_arg_str(args, "role", "role_name") or None,
            source=_arg_str(args, "source") or None,
            include_subtasks=_arg_bool(args, "include_subtasks", True),
        ),
    }


def tasks_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import tasks as tasks_admin

    tid = _arg_str(args, "task_id", "taskId", "id")
    if not tid:
        raise ValidationError("task_id is required")
    return {
        "ok": True,
        **tasks_admin.get_task(tid, subtask_id=_arg_str(args, "subtask_id", "subtaskId") or None),
    }


def tasks_execution_trail(args: dict[str, Any]) -> dict[str, Any]:
    """Tool-call steps inside a main task / subtask session (not just status list)."""
    from collections import Counter

    from evoflow.admin import employees as emp
    from evoflow.admin import tasks as tasks_admin
    from evoflow.persistence.chat_message_repositories import list_messages

    tid = _arg_str(args, "task_id", "taskId", "id")
    if not tid:
        raise ValidationError("task_id is required")
    sub_id = _arg_str(args, "subtask_id", "subtaskId") or None
    max_steps = int(args.get("max_steps") or args.get("maxSteps") or 80)
    data = tasks_admin.get_task(tid, subtask_id=sub_id)
    subs = data.get("subtasks") if isinstance(data.get("subtasks"), list) else []
    targets: list[dict[str, Any]] = []
    if sub_id:
        targets.append({"subtask_id": sub_id, "session_key": f"agent:executor:SubThread_{sub_id}"})
    elif subs:
        for st in subs:
            if not isinstance(st, dict):
                continue
            sid = str(st.get("subtask_id") or st.get("id") or "").strip()
            if sid:
                targets.append(
                    {
                        "subtask_id": sid,
                        "name": st.get("name"),
                        "session_key": f"agent:executor:SubThread_{sid}",
                    }
                )
    else:
        code = str(data.get("assigned_to") or data.get("assigned_role") or "").strip()
        if code:
            trail = emp.round_trail(code, max_steps=max_steps)
            return {"ok": True, "task_id": tid, "mode": "employee_round", **trail}

    trails = []
    for t in targets:
        sk = t["session_key"]
        # Executor subtask sessions are filtered out of "lead" display APIs — read raw.
        raw_messages = list(list_messages(sk, limit=max(200, max_steps * 4)) or [])
        messages: list[dict[str, Any]] = []
        for msg in raw_messages:
            if not isinstance(msg, dict):
                continue
            m = dict(msg)
            cj = m.get("content_json")
            if isinstance(cj, str):
                try:
                    import json as _json

                    m["content_json"] = _json.loads(cj)
                except Exception:
                    m["content_json"] = {}
            if not m.get("timestamp"):
                m["timestamp"] = m.get("created_at") or m.get("created_at_ms") or ""
            if m.get("role") == "tool" and not m.get("name"):
                m["name"] = m.get("tool_name")
            messages.append(m)
        steps = emp._extract_tool_steps(messages, max_steps=max_steps)
        tool_counts = Counter(s["tool"] for s in steps)
        trails.append(
            {
                "subtask_id": t.get("subtask_id"),
                "name": t.get("name"),
                "session_key": sk,
                "message_count": len(messages),
                "tool_step_count": len(steps),
                "tool_counts": dict(tool_counts.most_common(20)),
                "steps": steps,
            }
        )
    return {
        "ok": True,
        "task_id": tid,
        "mode": "subtask_sessions",
        "trails": trails,
        "tool_step_count": sum(int(x.get("tool_step_count") or 0) for x in trails),
    }


def tasks_create(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import tasks as tasks_admin

    name = _arg_str(args, "name", "title")
    if not name:
        raise ValidationError("name is required")
    return {
        "ok": True,
        **tasks_admin.create_task(
            name=name,
            description=_arg_str(args, "description", "desc"),
            assignee=_arg_str(args, "assignee", "agent_code", "agentCode") or None,
            assigned_role=_arg_str(args, "assigned_role", "role", "role_name") or None,
            main_task_id=_arg_str(args, "main_task_id", "mainTaskId") or None,
            initial_status=_arg_str(args, "status", "initial_status") or "pending",
            result=_arg_str(args, "result") or None,
            source=_arg_str(args, "source") or None,
            raised_by=_arg_str(args, "raised_by") or "xiaomi",
        ),
    }


def tasks_set_state(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import tasks as tasks_admin

    tid = _arg_str(args, "task_id", "taskId", "id")
    state = _arg_str(args, "state", "status", "target")
    if not tid or not state:
        raise ValidationError("task_id and state are required")
    return {
        "ok": True,
        **tasks_admin.set_task_state(
            tid,
            state,
            subtask_id=_arg_str(args, "subtask_id", "subtaskId") or None,
            summary=_arg_str(args, "summary", "result") or None,
        ),
    }


def tasks_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import tasks as tasks_admin

    tid = _arg_str(args, "task_id", "taskId", "id")
    if not tid:
        raise ValidationError("task_id is required")
    return {"ok": True, **tasks_admin.delete_task(tid)}


# ── skills ─────────────────────────────────────────────────────────────────


def skills_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import skills as skills_admin

    return {"ok": True, **skills_admin.list_skills(enabled_only=_arg_bool(args, "enabled_only", False))}


def skills_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import skills as skills_admin

    name = _arg_str(args, "name", "skill")
    if not name:
        raise ValidationError("name is required")
    return {"ok": True, "skill": skills_admin.get_skill(name)}


def skills_enable(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import skills as skills_admin

    name = _arg_str(args, "name", "skill")
    if not name:
        raise ValidationError("name is required")
    return {
        "ok": True,
        **skills_admin.set_skill_enabled(name, enabled=_arg_bool(args, "enabled", True)),
    }


def skills_install(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import skills as skills_admin

    path = _arg_str(args, "path")
    slug = _arg_str(args, "slug")
    if path:
        return {"ok": True, **skills_admin.install_skill(path)}
    if slug:
        return {
            "ok": True,
            **skills_admin.install_skill_from_market(
                slug,
                owner_handle=_arg_str(args, "owner", "owner_handle") or None,
            ),
        }
    raise ValidationError("path or slug is required")


def skills_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import skills as skills_admin

    name = _arg_str(args, "name", "skill")
    if not name:
        raise ValidationError("name is required")
    return {"ok": True, **skills_admin.delete_skill(name)}


# ── mcp ────────────────────────────────────────────────────────────────────


def mcp_get(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import mcp as mcp_admin

    return {"ok": True, **mcp_admin.get_mcp_config()}


def mcp_set(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import mcp as mcp_admin

    payload = args.get("mcp_servers") if isinstance(args.get("mcp_servers"), dict) else args
    return {"ok": True, **mcp_admin.set_mcp_config(payload if isinstance(payload, dict) else args)}


# ── automation ─────────────────────────────────────────────────────────────


def automation_list(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import automation as auto_admin

    return {"ok": True, **auto_admin.list_automations()}


def automation_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import automation as auto_admin

    tid = _arg_str(args, "id", "task_id", "automation_id")
    if not tid:
        raise ValidationError("id is required")
    return {"ok": True, **auto_admin.get_automation(tid)}


def automation_history(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import automation as auto_admin

    tid = _arg_str(args, "id", "task_id", "automation_id")
    if not tid:
        raise ValidationError("id is required")
    return {"ok": True, **auto_admin.get_automation_history(tid, limit=int(args.get("limit") or 50))}


def automation_create(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import automation as auto_admin

    return {"ok": True, **auto_admin.create_automation(args)}


def automation_update(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import automation as auto_admin

    tid = _arg_str(args, "id", "task_id", "automation_id")
    if not tid:
        raise ValidationError("id is required")
    patch = {k: v for k, v in args.items() if k not in {"id", "task_id", "automation_id", "confirm", "confirmed", "yes"}}
    return {"ok": True, **auto_admin.update_automation(tid, patch)}


def automation_set_status(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import automation as auto_admin

    tid = _arg_str(args, "id", "task_id", "automation_id")
    status = _arg_str(args, "status")
    if not tid or not status:
        raise ValidationError("id and status are required")
    return {"ok": True, **auto_admin.set_automation_status(tid, status=status)}


def automation_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import automation as auto_admin

    tid = _arg_str(args, "id", "task_id", "automation_id")
    if not tid:
        raise ValidationError("id is required")
    return {"ok": True, **auto_admin.delete_automation(tid)}


# ── approvals ──────────────────────────────────────────────────────────────


def approvals_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import approvals as appr

    return {
        "ok": True,
        **appr.list_approvals(
            status=_arg_str(args, "status") or "pending",
            limit=int(args.get("limit") or 50),
        ),
    }


def approvals_approve(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import approvals as appr

    item_id = _arg_str(args, "id", "item_id", "task_id", "approval_id")
    if not item_id:
        raise ValidationError("id/task_id is required")
    return {
        "ok": True,
        **appr.approve(
            item_id,
            comment=_arg_str(args, "comment"),
            decided_by=_arg_str(args, "decided_by") or "xiaomi",
        ),
    }


def approvals_reject(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import approvals as appr

    item_id = _arg_str(args, "id", "item_id", "task_id", "approval_id")
    reason = _arg_str(args, "reason", "rejection_reason", "comment")
    if not item_id:
        raise ValidationError("id/task_id is required")
    if not reason:
        raise ValidationError("reason is required when rejecting")
    return {
        "ok": True,
        **appr.reject(
            item_id,
            reason=reason,
            comment=_arg_str(args, "comment"),
            decided_by=_arg_str(args, "decided_by") or "xiaomi",
        ),
    }


# ── memory ─────────────────────────────────────────────────────────────────


def memory_agents(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import memory as mem

    return {"ok": True, **mem.list_memory_agents()}


def memory_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import memory as mem

    agent = _arg_str(args, "agent", "agent_code") or None
    return {"ok": True, **mem.get_memory(agent=agent)}


def memory_clear(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import memory as mem

    agent = _arg_str(args, "agent", "agent_code") or None
    return {"ok": True, **mem.clear_memory(agent=agent)}


def memory_delete_fact(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import memory as mem

    fact_id = _arg_str(args, "fact_id", "factId", "id")
    if not fact_id:
        raise ValidationError("fact_id is required")
    agent = _arg_str(args, "agent", "agent_code") or None
    return {"ok": True, **mem.delete_fact(fact_id, agent=agent)}


# ── sessions ───────────────────────────────────────────────────────────────


def sessions_search(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import sessions as sess

    query = _arg_str(args, "query", "q")
    if not query:
        raise ValidationError("query is required")
    return {
        "ok": True,
        **sess.search_sessions(
            query,
            search_titles=_arg_bool(args, "search_titles", False),
            max_results=int(args.get("max_results") or args.get("limit") or 5),
            max_age_days=int(args.get("max_age_days") or 90),
        ),
    }


# ── items（用户事项）───────────────────────────────────────────────────────


def items_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import items as items_admin

    include_done = _arg_bool(args, "include_done", True)
    page = int(args.get("page") or 1)
    page_size = int(args.get("page_size") or args.get("limit") or 50)
    return items_admin.list_items(
        status=_arg_str(args, "status") or None,
        priority=_arg_str(args, "priority") or None,
        tag=_arg_str(args, "tag") or None,
        q=_arg_str(args, "q", "query") or None,
        include_done=include_done,
        page=page,
        page_size=page_size,
    )


def items_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import items as items_admin

    item_id = _arg_str(args, "item_id", "id")
    if not item_id:
        raise ValidationError("item_id is required")
    return items_admin.get_item(item_id)


def items_create(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import items as items_admin

    title = _arg_str(args, "title", "name")
    if not title:
        raise ValidationError("title is required")
    return {
        **items_admin.create_item(
            {
                "title": title,
                "notes": _arg_str(args, "notes", "description"),
                "conclusion": _arg_str(args, "conclusion", "result"),
                "status": _arg_str(args, "status") or None,
                "priority": _arg_str(args, "priority") or None,
                "due_at": _arg_str(args, "due_at", "due") or None,
                "tags": args.get("tags"),
                "assignee_intent": _arg_str(args, "assignee_intent", "assignee", "agent_code") or None,
                "assignee_label": _arg_str(args, "assignee_label", "role") or None,
                "source": _arg_str(args, "source") or "xiaomi",
                "progress": int(args["progress"]) if args.get("progress") is not None else None,
            }
        ),
        "hint": "已记入「事项」表；若要员工立刻干活请再用 items.dispatch。",
    }


def items_update(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import items as items_admin

    item_id = _arg_str(args, "item_id", "id")
    if not item_id:
        raise ValidationError("item_id is required")
    patch = {
        k: v
        for k, v in args.items()
        if k
        not in {
            "item_id",
            "id",
            "confirm",
            "confirmed",
            "yes",
        }
    }
    return items_admin.update_item(item_id, patch)


def items_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import items as items_admin

    item_id = _arg_str(args, "item_id", "id")
    if not item_id:
        raise ValidationError("item_id is required")
    return items_admin.delete_item(item_id)


def items_dispatch(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import items as items_admin

    item_id = _arg_str(args, "item_id", "id")
    agent_code = _arg_str(args, "agent_code", "assignee", "code")
    if not item_id:
        raise ValidationError("item_id is required")
    if not agent_code:
        raise ValidationError("agent_code is required")
    return items_admin.dispatch_item(
        item_id,
        agent_code=agent_code,
        wake_now=_arg_bool(args, "wake_now", True),
        goal=_arg_str(args, "goal") or None,
        force=_arg_bool(args, "force", False),
        interrupt=_arg_bool(args, "interrupt", False),
    )


# ── experience ─────────────────────────────────────────────────────────────


def experience_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import experience as exp

    return {
        "ok": True,
        **exp.list_experiences(
            category=_arg_str(args, "category"),
            query=_arg_str(args, "query", "q"),
            max_results=int(args.get("limit") or args.get("max_results") or 10),
            principal_id=_arg_str(args, "principal_id"),
        ),
    }


def experience_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import experience as exp

    eid = _arg_str(args, "id", "experience_id")
    if not eid:
        raise ValidationError("id is required")
    return {"ok": True, **exp.get_experience(eid)}


def experience_save(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import experience as exp

    return {"ok": True, **exp.save_experience(args)}


def experience_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import experience as exp

    eid = _arg_str(args, "id", "experience_id")
    if not eid:
        raise ValidationError("id is required")
    return {
        "ok": True,
        **exp.delete_experience(eid, permanent=_arg_bool(args, "permanent", False)),
    }


# ── diagnostics（日志异常）──────────────────────────────────────────────────


def _diagnostics_sources_arg(args: dict[str, Any]) -> list[str] | None:
    raw = args.get("sources") if "sources" in args else args.get("source")
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.replace(";", ",").split(",") if p.strip()]
        return parts or None
    if isinstance(raw, (list, tuple)):
        return [str(x).strip() for x in raw if str(x).strip()] or None
    return [str(raw).strip()]


def diagnostics_sources(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import diagnostics as diag

    hours = int(args.get("hours") or 72)
    return {"ok": True, **diag.list_sources(hours=hours)}


def diagnostics_scan(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import diagnostics as diag

    return diag.scan_errors(
        hours=int(args.get("hours") or 24),
        sources=_diagnostics_sources_arg(args),
        max_events=int(args.get("max_events") or args.get("limit") or 200),
    )


def diagnostics_timeline(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import diagnostics as diag

    return diag.anomaly_timeline(
        hours=int(args.get("hours") or 24),
        sources=_diagnostics_sources_arg(args),
        max_events=int(args.get("max_events") or args.get("limit") or 80),
        format=_arg_str(args, "format") or "both",
    )


def diagnostics_run(args: dict[str, Any]) -> dict[str, Any]:
    """综合系统诊断：一次调用检查全模块健康状态 + 日志异常，输出可读的诊断报告。

    可选传 ``focus`` 指定重点关注模块（如 "员工" / "对话" / "定时" / "知识库" / "模型"），
    未指定时全量检查。
    """
    import time

    from evoflow.admin import automation as auto_admin
    from evoflow.admin import diagnostics as diag
    from evoflow.admin import employees as emp
    from evoflow.admin import knowledge as kn
    from evoflow.admin import models as models_admin

    t0 = time.time()
    focus = _arg_str(args, "focus")
    modules: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []

    # ── 1. 日志异常扫描 ──────────────────────────────────────
    try:
        sources_scan = diag.scan_errors(hours=24, max_events=50)
        err_sources = sources_scan.get("sources_with_errors") or []
        event_count = sources_scan.get("event_count") or 0
        modules.append({
            "module": "logs",
            "title": "系统日志",
            "status": "error" if err_sources else "ok",
            "detail": f"最近24小时有 {event_count} 条异常，来源: {', '.join(err_sources) if err_sources else '无'}",
            "error_sources": err_sources,
            "event_count": event_count,
            "top_events": (sources_scan.get("events") or [])[:5],
        })
        if err_sources:
            for src in err_sources:
                issues.append({
                    "module": "logs",
                    "severity": "high" if src in ("gateway", "langgraph") else "medium",
                    "title": f"{src} 日志有异常",
                    "detail": f"来源 {src} 在最近24小时有报错记录",
                })
    except Exception as e:
        modules.append({"module": "logs", "title": "系统日志", "status": "error", "detail": f"扫描失败: {e}"})
        issues.append({"module": "logs", "severity": "high", "title": "日志扫描失败", "detail": str(e)})

    # ── 2. 知识库 ─────────────────────────────────────────────
    try:
        bases = kn.list_bases()
        base_list = bases.get("items") or []
        total_bases = len(base_list)
        modules.append({
            "module": "knowledge",
            "title": "知识库",
            "status": "ok" if total_bases else "warn",
            "detail": f"共 {total_bases} 个平台自有知识库",
            "total": total_bases,
        })
        if not total_bases:
            issues.append({
                "module": "knowledge",
                "severity": "low",
                "title": "尚未创建自有知识库",
                "detail": "可用 knowledge.create 或面板「知识库」新建",
            })
    except Exception as e:
        modules.append({"module": "knowledge", "title": "知识库", "status": "error", "detail": f"检查失败: {e}"})

    # ── 3. 模型配置 ───────────────────────────────────────────
    try:
        primary = models_admin.get_primary_model()
        model_list = models_admin.list_models()
        models_data = model_list.get("models") or model_list.get("items") or []
        modules.append({
            "module": "models",
            "title": "模型配置",
            "status": "ok" if models_data else "warn",
            "detail": f"共 {len(models_data)} 个模型，默认: {primary.get('model_name', primary.get('name', '未设置'))}",
            "total": len(models_data),
            "primary": primary.get("model_name") or primary.get("name"),
        })
        if not models_data:
            issues.append({"module": "models", "severity": "high", "title": "无可用模型配置", "detail": "未配置任何模型，对话和员工均无法正常工作"})
    except Exception as e:
        modules.append({"module": "models", "title": "模型配置", "status": "error", "detail": f"检查失败: {e}"})

    # ── 4. 员工/智能体 ────────────────────────────────────────
    try:
        emp_data = emp.list_roles(status=None, include_archived=False)
        emp_list = emp_data.get("roles") or emp_data.get("items") or emp_data.get("employees") or []
        paused = [e for e in emp_list if str(e.get("status", "")).lower() in ("paused", "stopped", "inactive")]
        modules.append({
            "module": "employees",
            "title": "员工/智能体",
            "status": "warn" if paused else "ok",
            "detail": f"共 {len(emp_list)} 个员工，{len(paused)} 个暂停/停止",
            "total": len(emp_list),
            "paused_count": len(paused),
            "paused": [e.get("agent_code") or e.get("name", "?") for e in paused],
        })
        if paused:
            issues.append({
                "module": "employees",
                "severity": "medium",
                "title": f"{len(paused)} 个员工处于暂停/停止状态",
                "detail": ", ".join(e.get("agent_code") or e.get("name", "?") for e in paused),
            })
    except Exception as e:
        modules.append({"module": "employees", "title": "员工/智能体", "status": "error", "detail": f"检查失败: {e}"})

    # ── 5. 定时任务/自动化 ────────────────────────────────────
    try:
        auto_data = auto_admin.list_automations()
        auto_list = auto_data.get("automations") or auto_data.get("items") or []
        disabled_auto = [a for a in auto_list if not a.get("enabled", True) and not a.get("is_active", True)]
        modules.append({
            "module": "automation",
            "title": "定时任务",
            "status": "warn" if disabled_auto else "ok",
            "detail": f"共 {len(auto_list)} 个定时任务，{len(disabled_auto)} 个未启用",
            "total": len(auto_list),
            "disabled_count": len(disabled_auto),
        })
        if disabled_auto:
            issues.append({
                "module": "automation",
                "severity": "low",
                "title": f"{len(disabled_auto)} 个定时任务未启用",
                "detail": ", ".join(a.get("name", a.get("id", "?")) for a in disabled_auto),
            })
    except Exception as e:
        modules.append({"module": "automation", "title": "定时任务", "status": "error", "detail": f"检查失败: {e}"})

    # ── 汇总 ──────────────────────────────────────────────────
    elapsed = round(time.time() - t0, 2)
    has_errors = any(m.get("status") == "error" for m in modules)
    has_warns = any(m.get("status") in ("error", "warn") for m in modules)

    # 生成可读报告
    report_lines = [
        "## 🔍 EvoFlow 系统诊断报告",
        f"- 诊断时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 耗时：{elapsed}s",
        f"- 关注模块：{focus or '全量'}",
        "",
    ]

    if not issues:
        report_lines.append("✅ **各模块状态正常，未发现异常。**")
    else:
        report_lines.append(f"⚠️ **发现 {len(issues)} 个潜在问题：**\n")
        for i, issue in enumerate(issues, 1):
            sev_icon = {"high": "🔴", "medium": "🟡", "low": "🟢"}.get(issue.get("severity", "low"), "⚪")
            report_lines.append(f"{i}. {sev_icon} **{issue['title']}**（{issue['module']}）")
            report_lines.append(f"   {issue['detail']}")
        report_lines.append("")

    report_lines.append("### 模块详情\n")
    report_lines.append("| 模块 | 状态 | 说明 |")
    report_lines.append("|---|---|---|")
    for m in modules:
        status_icon = {"ok": "✅", "warn": "🟡", "error": "🔴"}.get(m.get("status", "ok"), "⚪")
        report_lines.append(f"| {m['title']} | {status_icon} | {m['detail']} |")

    markdown = "\n".join(report_lines)

    return {
        "ok": True,
        "focus": focus,
        "elapsed_s": elapsed,
        "modules": modules,
        "issues": issues,
        "issue_count": len(issues),
        "has_errors": has_errors,
        "has_warnings": has_warns,
        "markdown": markdown,
    }


# ── verification（系统验证轮次）────────────────────────────────────────────


def verification_catalog(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import verification as ver

    return {
        "ok": True,
        **ver.list_api_catalog(
            domain=args.get("domain", args.get("domains")),
            risk=args.get("risk", args.get("risks")),
            query=_arg_str(args, "query", "q"),
            include_verification=_arg_bool(args, "includeVerification", False)
            if "includeVerification" in args
            else _arg_bool(args, "include_verification", False),
        ),
    }


def verification_start(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import verification as ver

    resume = True if "resume" not in args else _arg_bool(args, "resume", True)
    seed = _arg_bool(args, "seed", False)
    return {
        "ok": True,
        **ver.start_round(
            title=_arg_str(args, "title", "name"),
            scenario=_arg_str(args, "scenario"),
            round_id=_arg_str(args, "roundId", "round_id", "id"),
            config=args.get("config"),
            resume=resume,
            seed=seed,
            domains=args.get("domains", args.get("domain")),
            apis=args.get("apis", args.get("api")),
            risks=args.get("risks", args.get("risk")),
            include_verification=_arg_bool(args, "includeVerification", False)
            if "includeVerification" in args
            else _arg_bool(args, "include_verification", False),
            only_missing=True if "onlyMissing" not in args and "only_missing" not in args else (
                _arg_bool(args, "onlyMissing", True)
                if "onlyMissing" in args
                else _arg_bool(args, "only_missing", True)
            ),
        ),
    }


def verification_init(args: dict[str, Any]) -> dict[str, Any]:
    """Create (or reuse) a round and seed pending steps from the API catalog."""
    from evoflow.admin import verification as ver

    rid = _arg_str(args, "roundId", "round_id", "id")
    title = _arg_str(args, "title", "name") or "全平台接口验证"
    scenario = _arg_str(args, "scenario") or "platform-api-inventory"
    started = ver.start_round(
        title=title,
        scenario=scenario,
        round_id=rid,
        resume=True,
        seed=True,
        domains=args.get("domains", args.get("domain")),
        apis=args.get("apis", args.get("api")),
        risks=args.get("risks", args.get("risk")),
        include_verification=_arg_bool(args, "includeVerification", False)
        if "includeVerification" in args
        else _arg_bool(args, "include_verification", False),
        only_missing=True if "onlyMissing" not in args and "only_missing" not in args else (
            _arg_bool(args, "onlyMissing", True)
            if "onlyMissing" in args
            else _arg_bool(args, "only_missing", True)
        ),
        config=args.get("config"),
    )
    return {"ok": True, **started}


def verification_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import verification as ver

    return {
        "ok": True,
        **ver.list_rounds(
            status=_arg_str(args, "status"),
            query=_arg_str(args, "query", "q"),
            limit=int(args.get("limit") or args.get("max_results") or 20),
        ),
    }


def verification_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import verification as ver

    rid = _arg_str(args, "roundId", "round_id", "id")
    if not rid:
        raise ValidationError("roundId is required")
    include_steps = True if "includeSteps" not in args and "include_steps" not in args else (
        _arg_bool(args, "includeSteps", True)
        if "includeSteps" in args
        else _arg_bool(args, "include_steps", True)
    )
    return {"ok": True, **ver.get_round(rid, include_steps=include_steps)}


def verification_step(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import verification as ver

    rid = _arg_str(args, "roundId", "round_id", "id")
    if not rid:
        raise ValidationError("roundId is required")
    duration = args.get("durationMs", args.get("duration_ms"))
    seq = args.get("seq")
    upsert = True if "upsert" not in args else _arg_bool(args, "upsert", True)
    return {
        "ok": True,
        **ver.record_step(
            round_id=rid,
            feature=_arg_str(args, "feature", "domain"),
            api=_arg_str(args, "api", "action", "interface"),
            status=_arg_str(args, "status") or "pending",
            request=args.get("request", args.get("input", args.get("args"))),
            response=args.get("response", args.get("output")),
            result=_arg_str(args, "result"),
            detail=_arg_str(args, "detail", "message"),
            exception=_arg_str(args, "exception", "error"),
            duration_ms=None if duration in (None, "") else int(duration),
            seq=None if seq in (None, "") else int(seq),
            started_at=_arg_str(args, "startedAt", "started_at"),
            finished_at=_arg_str(args, "finishedAt", "finished_at"),
            upsert=upsert,
        ),
    }


def verification_update(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import verification as ver

    rid = _arg_str(args, "roundId", "round_id", "id")
    if not rid:
        raise ValidationError("roundId is required")
    progress = args.get("progress")
    return {
        "ok": True,
        **ver.update_round(
            round_id=rid,
            status=_arg_str(args, "status"),
            progress=None if progress in (None, "") else int(progress),
            conclusion=args.get("conclusion") if "conclusion" in args else None,
            exceptions=args.get("exceptions") if "exceptions" in args else None,
            summary=args.get("summary") if "summary" in args else None,
            title=args.get("title") if "title" in args else None,
            scenario=args.get("scenario") if "scenario" in args else None,
        ),
    }


def verification_conclude(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import verification as ver

    rid = _arg_str(args, "roundId", "round_id", "id")
    if not rid:
        raise ValidationError("roundId is required")
    progress = args.get("progress")
    return {
        "ok": True,
        **ver.conclude_round(
            round_id=rid,
            conclusion=_arg_str(args, "conclusion"),
            status=_arg_str(args, "status"),
            exceptions=args.get("exceptions") if "exceptions" in args else None,
            summary=args.get("summary") if "summary" in args else None,
            progress=None if progress in (None, "") else int(progress),
        ),
    }


def verification_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import verification as ver

    rid = _arg_str(args, "roundId", "round_id", "id")
    if not rid:
        raise ValidationError("roundId is required")
    return {"ok": True, **ver.delete_round(rid)}


# ── appearance（EvoPanel 界面外观）──────────────────────────────────────────


def appearance_get(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.appearance import get_appearance_state

    return get_appearance_state()


def appearance_patch(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.appearance import patch_appearance

    return patch_appearance(args)
