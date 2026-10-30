"""platform tool domain handlers (side effects via evoflow.admin.*)."""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
from typing import Any

from evoflow.admin.errors import ValidationError
from evoflow.models.credential_sanitize import is_masked_api_key


def _run_coro_sync(coro: Any) -> Any:
    """Run an async coroutine from sync platform handlers (may already be on a loop)."""

    def _run() -> Any:
        return asyncio.run(coro)

    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None and running.is_running():
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(_run).result(timeout=120)
    return _run()


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
    # Accept both legacy vaultId/vault_id and current kbId/kb_id spellings;
    # ``knowledge.recall`` now takes ``kb_id`` (owned KB), vault_id is optional/legacy.
    kb_id = _arg_str(args, "kbId", "kb_id", "vaultId", "vault_id") or None
    limit = int(args.get("top_k") or args.get("limit") or 8)
    # 默认 hybrid：与前小V专用检索一致（多库扇出 + 语义/关键词）；无向量时 recall 侧会退化
    mode = _arg_str(args, "mode") or "hybrid"
    data = kn.recall(query, kb_id=kb_id, limit=limit, mode=mode)
    entries = data.get("entries") or data.get("results") or data.get("hits") or []
    if not isinstance(entries, list):
        entries = []
    return {
        "ok": True,
        **data,
        "hits": len(entries),
        "results": entries,
        "hint": "用片段口语回答；引用 title/path；无命中勿编造。",
    }


def knowledge_create(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn
    from evoflow.admin.assistant_guides import build_knowledge_create_assistant_guide

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
    out = {
        "ok": True,
        **data,
        "hint": "已创建平台自有知识库；写入内容用 knowledge.ingest（vaultId/kbId 均可）。",
    }
    out["assistant_guide"] = build_knowledge_create_assistant_guide(out)
    return out


def knowledge_enable(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import knowledge as kn

    vault_id = _arg_str(args, "vaultId", "vault_id", "kbId", "kb_id")
    if not vault_id:
        raise ValidationError("vaultId is required")
    if vault_id.startswith("kb_"):
        raise ValidationError("自有知识库无需启用/停用；删除请在面板「知识库」操作，或继续用 knowledge.ingest / search。")
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
        # Default false: omit force → incremental/cheaper path; force=true rebuilds all (DEF-06).
        force=_arg_bool(args, "force", False),
    )
    return {
        "ok": True,
        **data,
        "kbId": kb_id,
        "vaultId": kb_id,
        "hint": "已排队重索引；全量重建请传 force=true；大文档切 local 时可传 embeddingModelRef=bge-small-zh。",
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


def knowledge_delete(args: dict[str, Any]) -> dict[str, Any]:
    """Delete an owned knowledge base (destructive; requires confirm)."""
    from evoflow.admin import knowledge as kn

    kb_id = _arg_str(args, "kbId", "kb_id", "vaultId", "vault_id", "id")
    if not kb_id:
        raise ValidationError("kbId is required")
    return {"ok": True, **kn.delete_owned_base(kb_id)}


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
    # Avoid duplicating app fields at the top level (CORE-WF-06).
    return {
        "ok": True,
        "appId": app_id,
        "app_id": app_id,
        "app": data.get("app") if isinstance(data.get("app"), dict) else data,
    }


def workflow_run(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import apps as apps_admin
    from evoflow.authz.agent_actor import resolve_invoker_stamp

    app_id = _arg_str(args, "appId", "app_id", "id")
    if not app_id:
        raise ValidationError("appId is required")
    parameters = args.get("parameters") if isinstance(args.get("parameters"), dict) else {}
    # 责任人 = 运行时注入的 principal_id / proactive_agent_code（platform_tool 已绑 ambient）
    # 不是 session agent_id（agent:main:…）——那是频道标识，不是调用人身份
    invoker = resolve_invoker_stamp()
    data = apps_admin.run_app(
        app_id,
        parameters=parameters,
        raised_by=invoker.get("raised_by"),
        created_by=invoker.get("created_by"),
        principal_id=invoker.get("principal_id"),
        operator_label=invoker.get("operator_label"),
    )
    run = data.get("run") if isinstance(data.get("run"), dict) else {}
    run_id = str(run.get("run_id") or data.get("run_id") or data.get("runId") or "")
    task_id = str(run.get("task_id") or data.get("task_id") or data.get("taskId") or "").strip()
    out = {"ok": True, **data}
    if run_id:
        out["runId"] = run_id
        out["run_id"] = run_id
    # Hoist for platform_ui openStage (右栏工作流需要 mainTaskId)
    if task_id:
        out["task_id"] = task_id
        out["taskId"] = task_id
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
    patch = {k: v for k, v in args.items() if k not in {"appId", "app_id", "id", "confirm", "confirmed", "yes"} and v is not None}
    # Align with create: accept ``goal`` as alias of ``goal_template`` (CORE-WF-02).
    if "goal" in patch and "goal_template" not in patch:
        patch["goal_template"] = patch.pop("goal")
    elif "goal" in patch and "goal_template" in patch:
        patch.pop("goal", None)
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


def workflow_recover(args: dict[str, Any]) -> dict[str, Any]:
    """Crash / failed-node recover from DB state (not pause-only resume)."""
    from evoflow.admin import apps as apps_admin

    run_id = _arg_str(args, "runId", "run_id")
    task_id = _arg_str(args, "taskId", "task_id")
    reason = _arg_str(args, "reason") or "platform"
    if run_id:
        return {"ok": True, **apps_admin.recover_run(run_id, reason=reason)}
    if task_id:
        return {"ok": True, **apps_admin.recover_task(task_id, reason=reason)}
    raise ValidationError("runId or taskId is required")


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


def settings_update_model(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import models as models_admin

    name = _arg_str(args, "model", "name", "modelName")
    if not name:
        raise ValidationError("model is required（要更新的模型名）")
    skip = {"model", "name", "modelName", "model_name", "confirm", "principal_id"}
    payload = {k: v for k, v in args.items() if k not in skip and v is not None}
    api_key = payload.get("api_key")
    if is_masked_api_key(api_key):
        payload.pop("api_key", None)
    if not payload:
        raise ValidationError("至少提供一个要更新的字段（如 base_url / api_key / temperature）")
    return {"ok": True, "model": models_admin.update_model(name, payload), "name": name}


def settings_delete_model(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import models as models_admin

    name = _arg_str(args, "model", "name", "modelName")
    if not name:
        raise ValidationError("model is required")
    return {"ok": True, **models_admin.delete_model(name)}


def settings_invoke_model(args: dict[str, Any]) -> dict[str, Any]:
    """Single-shot chat via configured models (mirrors ``evoflow models invoke``)."""
    from evoflow.admin import models as models_admin

    result = models_admin.invoke_model(args if isinstance(args, dict) else {})
    return {"ok": True, "action": "settings.invoke_model", **result}


def openai_models(_args: dict[str, Any]) -> dict[str, Any]:
    """List configured models in OpenAI ``/v1/models`` shape (``evoflow openai models``)."""
    from evoflow.models.openai_compat_invoke import list_configured_models_openai

    listed = list_configured_models_openai()
    return {"ok": True, "action": "openai.models", **listed}


def openai_chat(args: dict[str, Any]) -> dict[str, Any]:
    """Single chat completion (``evoflow openai chat`` / models invoke)."""
    from evoflow.admin import models as models_admin

    payload: dict[str, Any] = dict(args) if isinstance(args, dict) else {}
    # CLI-style aliases → admin.invoke_model
    if not payload.get("model_name") and not payload.get("model"):
        m = _arg_str(payload, "modelName", "name")
        if m:
            payload["model_name"] = m
    result = models_admin.invoke_model(payload)
    return {"ok": True, "action": "openai.chat", **result}


def openai_vision(args: dict[str, Any]) -> dict[str, Any]:
    """Describe / ask about one image (``evoflow openai vision``)."""
    from evoflow.admin.errors import NotFoundError
    from evoflow.models.openai_compat_invoke import (
        OpenAICompatError,
        invoke_chat_completion,
        vision_messages,
    )

    image = _arg_str(args, "image", "image_url", "imageUrl", "path", "file")
    prompt = _arg_str(args, "message", "prompt", "question", "text")
    if not image:
        raise ValidationError("image is required（本地路径 / https / data: URL）")
    if not prompt:
        raise ValidationError("message is required（对图片的问题或指令）")

    model = _arg_str(args, "model", "model_name", "modelName", "name") or None
    system = _arg_str(args, "system") or None
    temperature = args.get("temperature")
    messages = vision_messages(prompt=prompt, image=image, system=system)
    try:
        result = invoke_chat_completion(
            model=model,
            messages=messages,
            temperature=float(temperature) if temperature is not None else None,
            record_usage=True,
        )
    except OpenAICompatError as e:
        if e.status_code == 404:
            raise NotFoundError(e.message) from e
        raise ValidationError(e.message) from e

    text = ""
    try:
        text = str((((result.get("choices") or [{}])[0].get("message") or {}).get("content")) or "")
    except Exception:
        text = ""
    return {
        "ok": True,
        "action": "openai.vision",
        "content": text,
        "openai": result,
    }


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


def assets_init(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.assets.hub import ensure_assets_tree, list_entities

    root = ensure_assets_tree()
    return {"ok": True, "root": str(root.resolve()), "entities": list_entities()}


def assets_migrate(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.assets.migrate import (
        migrate_all,
        migrate_experiences,
        migrate_memory_namespaces,
        migrate_slim_atoms,
    )

    dry = _arg_bool(args, "dry_run", False) or _arg_bool(args, "dryRun", False)
    only = (_arg_str(args, "only", "scope") or "all").strip().lower()
    if only == "experience":
        data = migrate_experiences(dry_run=dry)
    elif only == "memory":
        data = migrate_memory_namespaces(dry_run=dry)
    elif only == "slim":
        data = migrate_slim_atoms(dry_run=dry)
    elif only in {"agent-memory", "agent_memory"}:
        from evoflow.assets.migrate_agent_memory import migrate_agent_memory_to_user

        data = migrate_agent_memory_to_user(dry_run=dry)
    else:
        data = migrate_all(dry_run=dry)
    return {"ok": True, **(data if isinstance(data, dict) else {"result": data}), "only": only, "dry_run": dry}


def assets_export(args: dict[str, Any]) -> dict[str, Any]:
    from pathlib import Path

    from evoflow.assets.pack import export_entity_pack
    from evoflow.assets.paths import EntityRef

    entity_type = _arg_str(args, "entity_type", "type") or "user"
    entity_id = _arg_str(args, "entity_id", "id") or "user"
    out_raw = _arg_str(args, "output", "output_path", "path")
    out = Path(out_raw).expanduser() if out_raw else None
    data = export_entity_pack(EntityRef(entity_type, entity_id), output_path=out)
    return {
        "ok": True,
        **(data if isinstance(data, dict) else {"result": data}),
        "name": f"{entity_type}:{entity_id}",
    }


def assets_import(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.assets.pack import import_entity_pack
    from evoflow.assets.paths import EntityRef

    pack = _arg_str(args, "pack", "path", "pack_path")
    entity_type = _arg_str(args, "entity_type", "type")
    entity_id = _arg_str(args, "entity_id", "id")
    if not pack:
        raise ValidationError("pack path is required（.evoflow-pack）")
    if not entity_type or not entity_id:
        raise ValidationError("entity_type and entity_id are required")
    conflict = _arg_str(args, "conflict") or "skip"
    data = import_entity_pack(pack, EntityRef(entity_type, entity_id), conflict=conflict)
    return {
        "ok": True,
        **(data if isinstance(data, dict) else {"result": data}),
        "name": f"{entity_type}:{entity_id}",
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
        raise ValidationError("pass preferredBackend and/or provider keys (doubaoApiKey / bochaApiKey / tavilyApiKey / searxngUrl / …)")
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


def agents_bindings(args: dict[str, Any]) -> dict[str, Any]:
    """Catalog of assignable tools / skills / MCP for create & hire."""
    from evoflow.admin import agents as agents_admin

    include_disabled = _arg_bool(args, "include_disabled_skills", False)
    return {"ok": True, **agents_admin.list_bindings_catalog(include_disabled_skills=include_disabled)}


def agents_create(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import agents as agents_admin
    from evoflow.admin.assistant_guides import build_agent_create_assistant_guide

    agent = agents_admin.create_agent(args)
    out: dict[str, Any] = {"ok": True, "agent": agent}
    # Flatten bindings for easy verification (also nested under agent).
    if isinstance(agent, dict):
        if agent.get("bindings_applied"):
            out["bindings_applied"] = agent.get("bindings_applied")
        if agent.get("capability_pack"):
            out["capability_pack"] = agent.get("capability_pack")
        if agent.get("hint"):
            out["hint"] = agent.get("hint")
        if agent.get("warning"):
            out["warning"] = agent.get("warning")
    out["assistant_guide"] = build_agent_create_assistant_guide(out)
    return out


def agents_update(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import agents as agents_admin
    from evoflow.admin.errors import NotFoundError as _NF

    name_key = _arg_str(args, "name")
    code_key = _arg_str(args, "agent_code", "agentCode")
    if name_key and code_key and name_key.lower() != code_key.lower():
        raise ValidationError("agent_code is immutable and cannot be changed via agents.update")
    name = name_key or code_key
    if not name:
        raise ValidationError("name/agent_code is required")
    patch = {k: v for k, v in args.items() if k not in {"name", "agent_code", "agentCode", "confirm", "confirmed", "yes"}}
    try:
        return {"ok": True, "agent": agents_admin.update_agent(name, patch)}
    except _NF:
        # CORE-AGENT-02: callers often pass the *new* code as lookup key when trying to rename.
        raise ValidationError(
            f"Agent '{name}' not found. Pass name=<existing_agent_code> to update; "
            "agent_code is immutable and cannot be used to rename."
        ) from None


def agents_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import agents as agents_admin

    name = _arg_str(args, "name", "agent_code", "agentCode")
    if not name:
        raise ValidationError("name/agent_code is required")
    keep_employee = _arg_bool(args, "keep_employee", False)
    # Platform confirm=true (stripped before handler) OR explicit confirm_cascade.
    confirm_cascade = not keep_employee and (_arg_bool(args, "confirm_cascade", False) or _arg_bool(args, "confirm", False))
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
    data = emp.list_roles(status=status)
    roles = data.get("roles") if isinstance(data.get("roles"), list) else []
    return {"ok": True, **data, "employees": roles, "items": roles}


def employees_org_status(_args: dict[str, Any]) -> dict[str, Any]:
    """名册汇总：人数 / 忙闲 / 待审批（原 xiaomi_org_status）。"""
    from evoflow.admin.employee_front_desk import org_status

    return org_status()


def employees_board_overview(args: dict[str, Any]) -> dict[str, Any]:
    """跨岗未结看板 + stuck_candidates（原 xiaomi_board_overview）。"""
    from evoflow.admin.employee_front_desk import board_overview

    lim = int(args.get("limit_per_role") or args.get("limitPerRole") or args.get("limit") or 8)
    return board_overview(limit_per_role=lim)


def employees_brief(args: dict[str, Any]) -> dict[str, Any]:
    """单岗近况简报：忙闲 / 未结 / 轨迹（原 xiaomi_employee_brief）。"""
    from evoflow.admin.employee_front_desk import employee_brief

    code = _arg_str(args, "agent_code", "agentCode", "code", "role", "role_name", "name", "target")
    if not code:
        raise ValidationError("agent_code is required (or role_name)")
    include_trail = True
    if "include_trail" in args:
        include_trail = _arg_bool(args, "include_trail", True)
    elif "includeTrail" in args:
        include_trail = _arg_bool(args, "includeTrail", True)
    task_limit = int(args.get("task_limit") or args.get("taskLimit") or 8)
    return employee_brief(code, include_trail=include_trail, task_limit=task_limit)


def employees_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code", "name")
    if not code:
        raise ValidationError("agent_code is required")
    return {"ok": True, **emp.get_role(code, recent_limit=int(args.get("recent_limit") or 10))}


def employees_hire(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp
    from evoflow.admin.assistant_guides import build_employee_create_assistant_guide

    out = {"ok": True, **emp.hire(args)}
    out["assistant_guide"] = build_employee_create_assistant_guide(out)
    return out


def employees_create(args: dict[str, Any]) -> dict[str, Any]:
    """One-step employee create (capability pack + duty contract)."""
    from evoflow.admin import employees as emp
    from evoflow.admin.assistant_guides import build_employee_create_assistant_guide

    out = {"ok": True, **emp.create_employee(args)}
    out["assistant_guide"] = build_employee_create_assistant_guide(out)
    return out


def employees_update(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code")
    if not code:
        raise ValidationError("agent_code is required")
    patch = {k: v for k, v in args.items() if k not in {"agent_code", "agentCode", "code", "confirm", "confirmed", "yes"}}
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


def employees_chat_send(args: dict[str, Any]) -> dict[str, Any]:
    """Open / continue employee chat: queue message for Panel chatSend + right-stage."""
    from evoflow.admin import employees as emp
    from evoflow.agents.xiaomi.identity import is_xiaomi_agent

    target = _arg_str(args, "target", "agent_code", "agentCode", "code", "role", "role_name")
    message = _arg_str(args, "message", "text", "content", "goal")
    if not target:
        raise ValidationError("agent_code is required (or role_name)")
    if not message:
        raise ValidationError("message is required")
    role = emp.resolve_role_ref(target)
    if is_xiaomi_agent(role.agent_code):
        raise ValidationError("cannot chat_send to xiaomi herself")
    data = emp.chat_send(
        role.agent_code,
        message,
        session_key=_arg_str(args, "session_key", "sessionKey") or "",
        task_id=_arg_str(args, "task_id", "taskId", "related_task_id", "relatedTaskId") or "",
        source=_arg_str(args, "source") or "xiaomi",
    )
    # Display: Chinese role_name, else agent_name; never use English agent_code as title.
    display = str(role.role_name or "").strip()
    if not display or display == role.agent_code:
        try:
            from evoflow.admin.agents import get_agent

            display = str(get_agent(role.agent_code).get("agent_name") or "").strip()
        except Exception:
            display = ""
    if isinstance(data, dict) and display:
        data.setdefault("role_name", display)
    return {
        "ok": True,
        **(data if isinstance(data, dict) else {"result": data}),
        "name": display or role.role_name or role.agent_code,
        "agent_code": role.agent_code,
        "role_name": display or str(role.role_name or "").strip(),
    }


def employees_messages(args: dict[str, Any]) -> dict[str, Any]:
    """Read recent employee conversation messages (for Xiaomi to inspect results)."""
    from evoflow.admin import employees as emp

    target = _arg_str(args, "target", "agent_code", "agentCode", "code", "role", "role_name")
    if not target:
        raise ValidationError("agent_code is required（或 role_name）")
    role = emp.resolve_role_ref(target)
    raw_limit = args.get("limit", args.get("max", 20))
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError) as e:
        raise ValidationError("limit must be a positive integer") from e
    data = emp.list_chat_messages(
        role.agent_code,
        session_key=_arg_str(args, "session_key", "sessionKey") or "",
        task_id=_arg_str(args, "task_id", "taskId", "related_task_id", "relatedTaskId") or "",
        limit=limit,
    )
    return {
        "ok": True,
        **(data if isinstance(data, dict) else {"result": data}),
        "name": role.role_name or role.agent_code,
        "agent_code": role.agent_code,
    }


def employees_delete(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code", "name")
    if not code:
        raise ValidationError("agent_code is required")
    delete_agent = _arg_bool(args, "delete_agent", False) or _arg_bool(args, "deleteAgent", False)
    return {"ok": True, **emp.delete_role(code, delete_agent=delete_agent)}


def employees_worklog(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp

    code = _arg_str(args, "agent_code", "agentCode", "code")
    if not code:
        raise ValidationError("agent_code is required")
    day = _arg_str(args, "day", "date") or None
    raw_days = args.get("days")
    # Integer/range ``days`` = look-back window (CORE-EMP-01); YYYY-MM-DD string stays day alias.
    days_n: int | None = None
    if not day and raw_days is not None:
        if isinstance(raw_days, str) and len(raw_days.strip()) == 10 and raw_days.strip()[4] == "-":
            day = raw_days.strip()
        else:
            try:
                days_n = int(raw_days)
            except (TypeError, ValueError) as e:
                raise ValidationError("days must be a positive integer (look-back) or YYYY-MM-DD") from e
            if days_n <= 0:
                raise ValidationError("days must be >= 1")
            days_n = min(days_n, 30)
    return {
        "ok": True,
        **emp.worklog(code, day=day, days=days_n, limit=int(args.get("limit") or 20)),
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


def employees_dispatch(args: dict[str, Any]) -> dict[str, Any]:
    """派新目标给员工（底层 ``employees.dispatch``；催已有 Task 用 ``employees.wake``）。"""
    from evoflow.admin import employees as emp
    from evoflow.agents.xiaomi.identity import XIAOMI_AGENT_CODE, is_xiaomi_agent

    target = _arg_str(args, "target", "agent_code", "agentCode", "code", "role", "role_name")
    goal = _arg_str(args, "goal")
    if not target:
        raise ValidationError("agent_code is required（或 role_name）")
    if not goal:
        raise ValidationError("goal is required")
    role = emp.resolve_role_ref(target)
    if is_xiaomi_agent(role.agent_code):
        raise ValidationError("cannot dispatch to xiaomi herself")
    from_agent = _arg_str(args, "from_agent", "fromAgent") or ""
    source = _arg_str(args, "source") or "role"
    # 小V 前台：source=xiaomi 且未传 from_agent 时盖章，便于轨迹归因
    if source == "xiaomi" and not from_agent:
        from_agent = XIAOMI_AGENT_CODE
    data = emp.dispatch(
        role.agent_code,
        goal,
        description=_arg_str(args, "description") or "",
        priority=_arg_str(args, "priority") or "normal",
        source=source,
        from_agent=from_agent,
        related_task_id=_arg_str(args, "task_id", "taskId", "related_task_id", "relatedTaskId") or "",
        round_id=_arg_str(args, "round_id", "roundId") or "",
        resume_round=_arg_bool(args, "resume_round", False) or _arg_bool(args, "resumeRound", False),
        fresh_round=_arg_bool(args, "fresh_round", False) or _arg_bool(args, "freshRound", False),
        skip_done_guard=_arg_bool(args, "skip_done_guard", False) or _arg_bool(args, "skipDoneGuard", False),
    )
    return {
        "ok": True,
        **(data if isinstance(data, dict) else {"result": data}),
        "name": role.role_name or role.agent_code,
        "agent_code": role.agent_code,
    }


def employees_wake(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import employees as emp
    from evoflow.agents.xiaomi.identity import XIAOMI_AGENT_CODE

    target = _arg_str(args, "target", "agent_code", "agentCode", "code", "role", "role_name")
    if not target:
        raise ValidationError("target is required（agent_code 或 role_name）")
    from_agent = _arg_str(args, "from_agent", "fromAgent") or ""
    source = _arg_str(args, "source") or "role"
    if source == "xiaomi" and not from_agent:
        from_agent = XIAOMI_AGENT_CODE
    data = emp.wake(
        target,
        _arg_str(args, "goal") or "",
        from_agent=from_agent,
        task_id=_arg_str(args, "task_id", "taskId") or "",
        description=_arg_str(args, "description") or "",
        priority=_arg_str(args, "priority") or "normal",
        source=source,
        round_id=_arg_str(args, "round_id", "roundId") or "",
        resume_round=_arg_bool(args, "resume_round", False) or _arg_bool(args, "resumeRound", False),
        fresh_round=_arg_bool(args, "fresh_round", False) or _arg_bool(args, "freshRound", False),
        skip_done_guard=_arg_bool(args, "skip_done_guard", False) or _arg_bool(args, "skipDoneGuard", False),
    )
    return {"ok": True, **(data if isinstance(data, dict) else {"result": data}), "name": target}


def employees_migrate(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.proactive.migrate_initiatives import migrate_actionable_initiatives_to_tasks

    code = _arg_str(args, "agent_code", "agentCode", "code") or None
    dry = _arg_bool(args, "dry_run", False) or _arg_bool(args, "dryRun", False)
    data = migrate_actionable_initiatives_to_tasks(dry_run=dry, role_agent_code=code)
    return {
        "ok": True,
        **(data if isinstance(data, dict) else {"result": data}),
        "dry_run": dry,
        "name": code or "all",
    }


_EMPLOYEE_BIND_CHANNELS = frozenset({"feishu", "wecom"})


def _normalize_employee_bind_channel(raw: str) -> str:
    ch = str(raw or "").strip().lower()
    if ch in {"dingding"}:
        ch = "dingtalk"
    if ch in {"wechat"}:
        ch = "weixin"
    if ch not in _EMPLOYEE_BIND_CHANNELS:
        raise ValidationError(
            "channel must be feishu|wecom（绑定本岗 AI 员工；钉钉/微信请用员工页绑定，"
            "全局主机器人用 channels.registration_*）"
        )
    return ch


def _employee_bind_role(agent_code: str) -> Any:
    from evoflow.proactive.repositories import ProactiveRepository

    code = str(agent_code or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    role = ProactiveRepository.get_role(code)
    if role is None:
        raise ValidationError(f"员工「{code}」不存在；请先 employees.create / hire")
    return role


def employees_bind_channel_begin(args: dict[str, Any]) -> dict[str, Any]:
    """Start per-employee IM QR binding (Feishu / WeCom PersonalAgent bot)."""
    from evoflow.admin.assistant_guides import build_bind_channel_begin_assistant_guide

    code = _arg_str(args, "agent_code", "agentCode", "code")
    channel = _normalize_employee_bind_channel(_arg_str(args, "channel", "name", "platform") or "feishu")
    role = _employee_bind_role(code)
    role_name = str(getattr(role, "role_name", None) or code).strip() or code

    session = _registration_begin(channel)

    session_id = str(getattr(session, "session_id", None) or "").strip()
    qr_url = str(getattr(session, "qr_url", None) or "").strip()
    status = getattr(session, "status", None)
    if not session_id:
        raise ValidationError(f"{channel} registration begin returned empty session_id")

    out: dict[str, Any] = {
        "ok": True,
        "agent_code": code,
        "role_name": role_name,
        "channel": channel,
        "session_id": session_id,
        "qr_url": qr_url,
        "status": status,
        "hint": "扫码完成后自动绑定本岗 AI 员工。",
    }
    out["assistant_guide"] = build_bind_channel_begin_assistant_guide(
        agent_code=code,
        role_name=role_name,
        channel=channel,
        qr_url=qr_url,
        session_id=session_id,
    )
    return out


def employees_bind_channel_poll(args: dict[str, Any]) -> dict[str, Any]:
    """Poll per-employee IM QR binding session."""
    code = _arg_str(args, "agent_code", "agentCode", "code")
    channel = _normalize_employee_bind_channel(_arg_str(args, "channel", "name", "platform") or "feishu")
    session_id = _arg_str(args, "session_id", "sessionId")
    if not session_id:
        raise ValidationError("session_id is required")
    if code:
        _employee_bind_role(code)

    session = _registration_poll(channel, session_id)

    status = getattr(session, "status", None)
    out: dict[str, Any] = {
        "ok": True,
        "agent_code": code or None,
        "channel": channel,
        "session_id": session_id,
        "status": status,
        "qr_url": str(getattr(session, "qr_url", None) or "").strip() or None,
    }
    if status == "completed":
        out["hint"] = "扫码已完成；请 employees.bind_channel_apply（confirm=true）绑到该员工"
        if channel == "feishu":
            for key in ("app_id", "open_id"):
                val = getattr(session, key, None)
                if val:
                    out[key] = val
        elif channel == "wecom":
            for key in ("bot_id",):
                val = getattr(session, key, None)
                if val:
                    out[key] = val
    if status in {"failed", "expired"}:
        out["error"] = getattr(session, "error", None) or status
        out["ok"] = False
    return out


def _employee_bind_apply_via_gateway(agent_code: str, channel: str, session_id: str) -> dict[str, Any]:
    """Apply bind via Gateway proactive HTTP (LangGraph off-process path)."""
    import httpx

    from evoflow.admin.proactive_http import resolve_proactive_api_base

    ch = channel.strip().lower()
    if ch not in {"feishu", "wecom"}:
        raise ValidationError(f"unsupported employee bind channel via Gateway: {channel}")
    base = resolve_proactive_api_base().rstrip("/")
    url = f"{base}/roles/{agent_code}/{ch}/registration/{session_id}/apply"
    try:
        with httpx.Client(timeout=45.0) as client:
            r = client.post(url)
    except Exception as exc:
        raise ValidationError(
            f"{ch} bind apply failed: Gateway 不可达（{exc}）。"
            "确认 Gateway 已启动且 EVOFLOW_GATEWAY_URL 正确。"
        ) from exc
    if r.status_code >= 400:
        detail = ""
        try:
            body = r.json()
            detail = str(body.get("detail") or body.get("error") or body)[:240]
        except Exception:
            detail = (r.text or "")[:240]
        raise ValidationError(
            f"{ch} bind apply failed: HTTP {r.status_code}"
            + (f" — {detail}" if detail else "")
        )
    data = r.json() if r.content else {}
    return data if isinstance(data, dict) else {"ok": True, "result": data}


def employees_bind_channel_apply(args: dict[str, Any]) -> dict[str, Any]:
    """Apply completed QR registration onto this employee's dedicated bot."""
    code = _arg_str(args, "agent_code", "agentCode", "code")
    channel = _normalize_employee_bind_channel(_arg_str(args, "channel", "name", "platform") or "feishu")
    session_id = _arg_str(args, "session_id", "sessionId")
    if not code:
        raise ValidationError("agent_code is required")
    if not session_id:
        raise ValidationError("session_id is required")
    role = _employee_bind_role(code)
    role_name = str(getattr(role, "role_name", None) or code).strip() or code

    # Prefer Gateway proactive apply so off-process agents share the Gateway
    # registration singleton (sessions are in-memory on that process).
    client, _ch = _registration_client(channel)
    if client is None:
        data = _employee_bind_apply_via_gateway(code, channel, session_id)
    else:
        session = client.get_session(session_id)
        if session is None:
            raise ValidationError("Registration session not found")
        status = getattr(session, "status", None)
        if status != "completed":
            raise ValidationError(f"Registration is not complete (status={status})")

        if channel == "feishu":
            app_id = str(getattr(session, "app_id", None) or "").strip()
            app_secret = str(getattr(session, "app_secret", None) or "").strip()
            open_id = str(getattr(session, "open_id", None) or "").strip()
            if not app_id or not app_secret:
                raise ValidationError("Registration completed but Feishu credentials are missing")
            from evoflow.proactive.feishu_binding import apply_registration_to_role

            data = _run_coro_sync(
                apply_registration_to_role(
                    code,
                    app_id=app_id,
                    app_secret=app_secret,
                    open_id=open_id,
                )
            )
        else:
            bot_id = str(getattr(session, "bot_id", None) or "").strip()
            secret = str(getattr(session, "secret", None) or "").strip()
            if not bot_id or not secret:
                raise ValidationError("Registration completed but WeCom credentials are missing")
            from evoflow.proactive.wecom_binding import apply_registration_to_role

            data = _run_coro_sync(
                apply_registration_to_role(
                    code,
                    bot_id=bot_id,
                    secret=secret,
                )
            )

    out = {
        "ok": True,
        **(data if isinstance(data, dict) else {"result": data}),
        "agent_code": code,
        "role_name": role_name,
        "channel": channel,
        "session_id": session_id,
        "hint": f"已绑定本岗 AI 员工到{('飞书' if channel == 'feishu' else '企微')}；拉进群即可 @{role_name}",
        "assistant_guide": {
            "status": "bind_applied",
            "say_to_user": (
                f"「{role_name}」本岗 AI 员工已绑定{('飞书' if channel == 'feishu' else '企微')}。"
                f"把他拉进同事所在群，@{role_name} 即可协作。"
            ),
            "next_steps": ["把 say_to_user 告诉用户", "可选：employees.get 确认 binding 状态"],
            "instruction": "向用户复述 say_to_user。",
        },
    }
    return out


# ── tasks ──────────────────────────────────────────────────────────────────


def tasks_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import tasks as tasks_admin

    # Default include_subtasks=false; hard-cap limit at 200 to avoid million-token dumps (DEF-03).
    raw_limit = args.get("limit", args.get("max_results"))
    limit: int | None
    if raw_limit in (None, ""):
        limit = 50
    else:
        try:
            limit = max(1, min(int(raw_limit), 200))
        except (TypeError, ValueError) as e:
            raise ValidationError("limit must be an integer") from e
    raw_offset = args.get("offset", 0)
    try:
        offset = max(0, int(raw_offset or 0))
    except (TypeError, ValueError) as e:
        raise ValidationError("offset must be an integer") from e

    return {
        "ok": True,
        **tasks_admin.list_tasks(
            status=_arg_str(args, "status") or None,
            assignee=_arg_str(args, "assignee", "agent_code", "agentCode") or None,
            role=_arg_str(args, "role", "role_name") or None,
            source=_arg_str(args, "source") or None,
            include_subtasks=_arg_bool(args, "include_subtasks", False),
            limit=limit,
            offset=offset,
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
            # Accept assigned_to as alias of assignee (CORE-TASK-03).
            assignee=_arg_str(args, "assignee", "assigned_to", "agent_code", "agentCode") or None,
            assigned_role=_arg_str(args, "assigned_role", "role", "role_name") or None,
            main_task_id=_arg_str(args, "main_task_id", "mainTaskId") or None,
            initial_status=_arg_str(args, "status", "initial_status") or "pending",
            result=_arg_str(args, "result") or None,
            source=_arg_str(args, "source") or None,
            raised_by=_arg_str(args, "raised_by") or "xiaomi",
            risk_level=_arg_str(args, "risk_level", "riskLevel") or None,
            action_type=_arg_str(args, "action_type", "actionType") or None,
            round_id=_arg_str(args, "round_id", "roundId") or None,
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


def tasks_progress(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import tasks as tasks_admin

    tid = _arg_str(args, "task_id", "taskId", "id")
    if not tid:
        raise ValidationError("task_id is required")
    if "progress" not in args:
        raise ValidationError("progress is required（0-100）")
    try:
        progress = int(args.get("progress"))
    except (TypeError, ValueError) as e:
        raise ValidationError("progress must be an integer 0-100") from e
    data = tasks_admin.update_progress(
        tid,
        progress,
        status=_arg_str(args, "status", "state") or None,
        subtask_id=_arg_str(args, "subtask_id", "subtaskId") or None,
    )
    return {"ok": True, **(data if isinstance(data, dict) else {}), "id": tid, "name": tid}


def tasks_cleanup_noise(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.collab.task_noise import cleanup_noise_tasks

    if "apply" in args:
        dry_run = not _arg_bool(args, "apply", False)
    elif "dry_run" in args:
        dry_run = _arg_bool(args, "dry_run", True)
    elif "dryRun" in args:
        dry_run = _arg_bool(args, "dryRun", True)
    else:
        dry_run = True  # default preview
    stuck_days = int(args.get("stuck_days") or args.get("stuckDays") or 3)
    limit = int(args.get("limit") or 0)
    data = cleanup_noise_tasks(dry_run=dry_run, stuck_days=stuck_days, limit=limit)
    return {"ok": True, **(data if isinstance(data, dict) else {"result": data}), "dry_run": dry_run}


def tasks_reclaim_zombies(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.collab.task_reclaim import reclaim_zombie_tasks

    apply = _arg_bool(args, "apply", False)
    if "apply" in args:
        dry_run = not apply
    elif "dry_run" in args:
        dry_run = _arg_bool(args, "dry_run", True)
    elif "dryRun" in args:
        dry_run = _arg_bool(args, "dryRun", True)
    else:
        dry_run = True
    data = reclaim_zombie_tasks(
        dry_run=dry_run,
        stuck_days=int(args.get("stuck_days") or args.get("stuckDays") or 3),
        awaiting_close_days=int(args.get("awaiting_close_days") or args.get("awaitingCloseDays") or 3),
        limit=int(args.get("limit") or 0),
    )
    return {"ok": True, **(data if isinstance(data, dict) else {"result": data}), "dry_run": dry_run}


# ── eval（评测中心）─────────────────────────────────────────────────────────


def eval_cases(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.eval import eval_engine as engine
    from evoflow.persistence.db import get_db

    get_db()
    cat = _arg_str(args, "category") or None
    return {"ok": True, **engine.list_eval_cases(category=cat)}


def eval_run(args: dict[str, Any]) -> dict[str, Any]:
    import time

    from evoflow.eval import eval_engine as engine
    from evoflow.persistence.db import get_db

    get_db()
    mode = _arg_str(args, "mode", "type") or "smoke"
    name = _arg_str(args, "name") or f"platform {mode} {time.strftime('%Y-%m-%d %H:%M')}"
    days = int(args.get("days") or 7)
    async_mode = _arg_bool(args, "async", False) or _arg_bool(args, "async_mode", False)
    wait = _arg_bool(args, "wait", True)
    result = engine.run_eval(
        name=name,
        type=mode,
        config={"mode": mode, "days": days},
        async_mode=async_mode,
    )
    if async_mode and wait and isinstance(result, dict) and result.get("run_id"):
        run_id = str(result["run_id"])
        for _ in range(600):
            prog = engine.get_eval_progress(run_id)
            if prog.get("status") not in ("running", "queued"):
                break
            time.sleep(0.5)
        result = engine.get_eval_run(run_id)
    rid = ""
    if isinstance(result, dict):
        rid = str(result.get("run_id") or (result.get("run") or {}).get("run_id") or "")
    return {"ok": True, **(result if isinstance(result, dict) else {"result": result}), "id": rid, "name": name}


def eval_runs(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.eval import eval_engine as engine
    from evoflow.persistence.db import get_db

    get_db()
    return {
        "ok": True,
        **engine.list_eval_runs(
            limit=int(args.get("limit") or 20),
            offset=int(args.get("offset") or 0),
            type=_arg_str(args, "type", "mode") or None,
            status=_arg_str(args, "status") or None,
        ),
    }


def eval_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.eval import eval_engine as engine
    from evoflow.persistence.db import get_db

    get_db()
    run_id = _arg_str(args, "run_id", "runId", "id")
    if not run_id:
        raise ValidationError("run_id is required")
    data = engine.get_eval_run(run_id)
    return {"ok": True, **(data if isinstance(data, dict) else {}), "id": run_id, "name": run_id}


def eval_progress(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.eval import eval_engine as engine
    from evoflow.persistence.db import get_db

    get_db()
    run_id = _arg_str(args, "run_id", "runId", "id")
    if not run_id:
        raise ValidationError("run_id is required")
    data = engine.get_eval_progress(run_id)
    return {"ok": True, **(data if isinstance(data, dict) else {}), "id": run_id}


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
    from pathlib import Path

    from evoflow.admin import skills as skills_admin
    from evoflow.skills.installer import SkillAlreadyExistsError, install_skill_from_directory
    from evoflow.skills.loader import clear_skills_cache

    path = _arg_str(args, "path")
    slug = _arg_str(args, "slug")
    link = _arg_bool(args, "link", False)
    mode = _arg_str(args, "mode") or None
    if path:
        p = Path(path)
        if p.is_dir():
            # Folder install defaults to in-place register (bound). link=true → bound.
            install_mode = (mode or "").strip().lower()
            if not install_mode:
                install_mode = "bound"
            try:
                result = install_skill_from_directory(p, mode=install_mode, link=link)
            except SkillAlreadyExistsError as e:
                from evoflow.admin.errors import ConflictError

                raise ConflictError(str(e)) from e
            clear_skills_cache()
            return {"ok": True, **result}
        if link or (mode and mode.strip().lower() in ("bound", "link")):
            raise ValidationError("mode=bound/link only applies to a skill directory path, not a zip archive")
        return {"ok": True, **skills_admin.install_skill(path)}
    if slug:
        if link or (mode and mode.strip().lower() in ("bound", "link")):
            raise ValidationError("mode=bound/link is not supported for market slug installs")
        return {
            "ok": True,
            **skills_admin.install_skill_from_market(
                slug,
                owner_handle=_arg_str(args, "owner", "owner_handle") or None,
            ),
        }
    raise ValidationError("path or slug is required")


def skills_import_orphans(args: dict[str, Any]) -> dict[str, Any]:
    """Dry-run by default; platform confirm=true → execute copy into active skills root."""
    from evoflow.admin import skills as skills_admin

    # Platform write gate already passed when confirm=true; treat as execute.
    # When called without confirm the dispatcher returns pending_confirm and never reaches here.
    dry_run = _arg_bool(args, "dry_run", False)
    return {"ok": True, **skills_admin.import_orphan_custom_skills(dry_run=dry_run)}


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


def mcp_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.mcp.cli_ops import mcp_list_servers

    names = args.get("servers") or args.get("names") or args.get("server_names")
    server_names: list[str] | None = None
    if isinstance(names, str) and names.strip():
        server_names = [n.strip() for n in names.split(",") if n.strip()]
    elif isinstance(names, (list, tuple)):
        server_names = [str(n).strip() for n in names if str(n).strip()]
    return {"ok": True, **mcp_list_servers(server_names=server_names)}


def mcp_add(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.mcp.cli_ops import mcp_add_server

    name = _arg_str(args, "server", "name", "server_name")
    if not name:
        raise ValidationError("server/name is required")
    document = _arg_json_value(args, "document", "config", "server_config")
    if not isinstance(document, dict):
        # Allow flat args as document (excluding identity keys).
        skip = {"server", "name", "server_name", "document", "config", "server_config", "confirm", "principal_id"}
        document = {k: v for k, v in args.items() if k not in skip}
    if not document:
        raise ValidationError("document/config is required（url 或 command+args）")
    return {"ok": True, **mcp_add_server(name, document), "name": name}


def mcp_remove(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.mcp.cli_ops import mcp_remove_server

    name = _arg_str(args, "server", "name", "server_name")
    if not name:
        raise ValidationError("server/name is required")
    return {"ok": True, **mcp_remove_server(name), "name": name}


def mcp_test(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.mcp.cli_ops import mcp_test_server

    name = _arg_str(args, "server", "name", "server_name")
    if not name:
        raise ValidationError("server/name is required")
    return {"ok": True, **mcp_test_server(name), "name": name}


def mcp_login(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.mcp.cli_ops import mcp_login_server

    name = _arg_str(args, "server", "name", "server_name")
    if not name:
        raise ValidationError("server/name is required")
    return {"ok": True, **mcp_login_server(name), "name": name}


def mcp_logout(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.mcp.cli_ops import mcp_logout_server

    name = _arg_str(args, "server", "name", "server_name")
    if not name:
        raise ValidationError("server/name is required")
    return {"ok": True, **mcp_logout_server(name), "name": name}


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


def sessions_status(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import sessions as sess

    return {
        "ok": True,
        "action": "sessions.status",
        **sess.get_session_status(
            session_key=_arg_str(args, "session_key", "sessionKey", "session"),
            thread_id=_arg_str(args, "thread_id", "threadId"),
        ),
    }


def sessions_compact(args: dict[str, Any]) -> dict[str, Any]:
    """主动压缩当前（或指定）会话上下文 — 与 UI ``/compact`` 同引擎。"""
    from evoflow.admin import sessions as sess
    from evoflow.agents.manual_context_compaction import ManualCompactionError, run_manual_context_compaction

    prep = sess.prepare_session_compact(
        session_key=_arg_str(args, "session_key", "sessionKey", "session"),
        thread_id=_arg_str(args, "thread_id", "threadId"),
    )
    try:
        result = _run_coro_sync(
            run_manual_context_compaction(prep["session_key"], session_row=prep["session_row"])
        )
    except ManualCompactionError as exc:
        return {
            "ok": False,
            "action": "sessions.compact",
            "error": str(exc),
            "session_key": prep["session_key"],
            "running": prep["running"],
            "run_status": prep["run_status"],
        }
    out = sess.format_compact_result(
        session_key=prep["session_key"],
        running=bool(prep["running"]),
        result=result,
    )
    out["action"] = "sessions.compact"
    out["run_status"] = prep["run_status"]
    out["title"] = prep.get("title") or ""
    return out


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


def _diagnostics_focus_modules(focus: str) -> set[str] | None:
    """Map focus string → module keys to run; None means all modules."""
    f = str(focus or "").strip().lower()
    if not f:
        return None
    aliases: dict[str, set[str]] = {
        "logs": {"logs"},
        "log": {"logs"},
        "日志": {"logs"},
        "对话": {"logs"},  # chat disappear often needs log scan
        "chat": {"logs"},
        "knowledge": {"knowledge"},
        "知识库": {"knowledge"},
        "kb": {"knowledge"},
        "models": {"models"},
        "model": {"models"},
        "模型": {"models"},
        "employees": {"employees"},
        "employee": {"employees"},
        "员工": {"employees"},
        "智能体": {"employees"},
        "automation": {"automation"},
        "定时": {"automation"},
        "定时任务": {"automation"},
        "cron": {"automation"},
    }
    if f in aliases:
        return set(aliases[f])
    # comma / space separated
    parts = {p.strip() for p in f.replace("，", ",").replace("|", ",").split(",") if p.strip()}
    if not parts:
        return None
    out: set[str] = set()
    for p in parts:
        mapped = aliases.get(p)
        if mapped:
            out |= mapped
        elif p in {"logs", "knowledge", "models", "employees", "automation"}:
            out.add(p)
    return out or None


def diagnostics_run(args: dict[str, Any]) -> dict[str, Any]:
    """综合系统诊断：检查模块健康状态 + 日志异常，输出可读诊断报告。

    ``focus`` 为真过滤：只跑对应模块（logs/knowledge/models/employees/automation 或中文别名）。
    """
    import time

    from evoflow.admin import automation as auto_admin
    from evoflow.admin import diagnostics as diag
    from evoflow.admin import employees as emp
    from evoflow.admin import knowledge as kn
    from evoflow.admin import models as models_admin

    t0 = time.time()
    focus = _arg_str(args, "focus")
    want = _diagnostics_focus_modules(focus)
    modules: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []

    def _run(mod: str) -> bool:
        return want is None or mod in want

    # ── 1. 日志异常扫描 ──────────────────────────────────────
    if _run("logs"):
        try:
            sources_scan = diag.scan_errors(hours=24, max_events=50)
            err_sources = sources_scan.get("sources_with_errors") or []
            event_count = sources_scan.get("event_count") or 0
            modules.append(
                {
                    "module": "logs",
                    "title": "系统日志",
                    "status": "error" if err_sources else "ok",
                    "detail": f"最近24小时有 {event_count} 条异常，来源: {', '.join(err_sources) if err_sources else '无'}",
                    "error_sources": err_sources,
                    "event_count": event_count,
                    "top_events": (sources_scan.get("events") or [])[:5],
                }
            )
            if err_sources:
                for src in err_sources:
                    issues.append(
                        {
                            "module": "logs",
                            "severity": "high" if src in ("gateway", "langgraph") else "medium",
                            "title": f"{src} 日志有异常",
                            "detail": f"来源 {src} 在最近24小时有报错记录",
                        }
                    )
        except Exception as e:
            modules.append({"module": "logs", "title": "系统日志", "status": "error", "detail": f"扫描失败: {e}"})
            issues.append({"module": "logs", "severity": "high", "title": "日志扫描失败", "detail": str(e)})

    # ── 2. 知识库 ─────────────────────────────────────────────
    if _run("knowledge"):
        try:
            bases = kn.list_bases()
            base_list = bases.get("items") or []
            total_bases = len(base_list)
            modules.append(
                {
                    "module": "knowledge",
                    "title": "知识库",
                    "status": "ok" if total_bases else "warn",
                    "detail": f"共 {total_bases} 个平台自有知识库",
                    "total": total_bases,
                }
            )
            if not total_bases:
                issues.append(
                    {
                        "module": "knowledge",
                        "severity": "low",
                        "title": "尚未创建自有知识库",
                        "detail": "可用 knowledge.create 或面板「知识库」新建",
                    }
                )
        except Exception as e:
            modules.append({"module": "knowledge", "title": "知识库", "status": "error", "detail": f"检查失败: {e}"})

    # ── 3. 模型配置 ───────────────────────────────────────────
    if _run("models"):
        try:
            primary = models_admin.get_primary_model()
            model_list = models_admin.list_models()
            models_data = model_list.get("models") or model_list.get("items") or []
            modules.append(
                {
                    "module": "models",
                    "title": "模型配置",
                    "status": "ok" if models_data else "warn",
                    "detail": f"共 {len(models_data)} 个模型，默认: {primary.get('model_name', primary.get('name', '未设置'))}",
                    "total": len(models_data),
                    "primary": primary.get("model_name") or primary.get("name"),
                }
            )
            if not models_data:
                issues.append(
                    {
                        "module": "models",
                        "severity": "high",
                        "title": "无可用模型配置",
                        "detail": "未配置任何模型，对话和员工均无法正常工作",
                    }
                )
        except Exception as e:
            modules.append({"module": "models", "title": "模型配置", "status": "error", "detail": f"检查失败: {e}"})

    # ── 4. 员工/智能体 ────────────────────────────────────────
    if _run("employees"):
        try:
            emp_data = emp.list_roles(status=None)
            emp_list = emp_data.get("roles") or emp_data.get("items") or emp_data.get("employees") or []
            paused = [e for e in emp_list if str(e.get("status", "")).lower() in ("paused", "stopped", "inactive")]
            modules.append(
                {
                    "module": "employees",
                    "title": "员工/智能体",
                    "status": "warn" if paused else "ok",
                    "detail": f"共 {len(emp_list)} 个员工，{len(paused)} 个暂停/停止",
                    "total": len(emp_list),
                    "paused_count": len(paused),
                    "paused": [e.get("agent_code") or e.get("name", "?") for e in paused],
                }
            )
            if paused:
                issues.append(
                    {
                        "module": "employees",
                        "severity": "medium",
                        "title": f"{len(paused)} 个员工处于暂停/停止状态",
                        "detail": ", ".join(e.get("agent_code") or e.get("name", "?") for e in paused),
                    }
                )
        except Exception as e:
            modules.append({"module": "employees", "title": "员工/智能体", "status": "error", "detail": f"检查失败: {e}"})

    # ── 5. 定时任务/自动化 ────────────────────────────────────
    if _run("automation"):
        try:
            auto_data = auto_admin.list_automations()
            auto_list = auto_data.get("automations") or auto_data.get("items") or []
            disabled_auto = [a for a in auto_list if not a.get("enabled", True) and not a.get("is_active", True)]
            modules.append(
                {
                    "module": "automation",
                    "title": "定时任务",
                    "status": "warn" if disabled_auto else "ok",
                    "detail": f"共 {len(auto_list)} 个定时任务，{len(disabled_auto)} 个未启用",
                    "total": len(auto_list),
                    "disabled_count": len(disabled_auto),
                }
            )
            if disabled_auto:
                issues.append(
                    {
                        "module": "automation",
                        "severity": "low",
                        "title": f"{len(disabled_auto)} 个定时任务未启用",
                        "detail": ", ".join(a.get("name", a.get("id", "?")) for a in disabled_auto),
                    }
                )
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
            sev_icon = {"high": "🔴", "medium": "🟡", "low": "🟢"}.get(
                issue.get("severity", "low"), "⚫"
            )
            report_lines.append(f"{i}. {sev_icon} **{issue['title']}**（{issue['module']}）")
            report_lines.append(f"   {issue['detail']}")
        report_lines.append("")

    report_lines.append("### 模块详情\n")
    report_lines.append("| 模块 | 状态 | 说明 |")
    report_lines.append("|---|---|---|")
    for m in modules:
        status_icon = {"ok": "✅", "warn": "🟡", "error": "🔴"}.get(m.get("status", "ok"), "⚫")
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


def diagnostics_status(args: dict[str, Any]) -> dict[str, Any]:
    """当前系统运行快照：端口 / 前后端 / 服务状态 / 数据目录 / 安装目录。"""
    from evoflow.admin.system_status import build_system_status_snapshot

    _ = args  # no args yet; keep signature consistent with other handlers
    snap = build_system_status_snapshot()
    return {"ok": True, "action": "diagnostics.status", **snap}


# ── verification（系统验证轮次）────────────────────────────────────────────


def verification_catalog(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import verification as ver

    return {
        "ok": True,
        **ver.list_api_catalog(
            domain=args.get("domain", args.get("domains")),
            risk=args.get("risk", args.get("risks")),
            query=_arg_str(args, "query", "q"),
            include_verification=_arg_bool(args, "includeVerification", False) if "includeVerification" in args else _arg_bool(args, "include_verification", False),
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
            include_verification=_arg_bool(args, "includeVerification", False) if "includeVerification" in args else _arg_bool(args, "include_verification", False),
            only_missing=True if "onlyMissing" not in args and "only_missing" not in args else (_arg_bool(args, "onlyMissing", True) if "onlyMissing" in args else _arg_bool(args, "only_missing", True)),
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
        include_verification=_arg_bool(args, "includeVerification", False) if "includeVerification" in args else _arg_bool(args, "include_verification", False),
        only_missing=True if "onlyMissing" not in args and "only_missing" not in args else (_arg_bool(args, "onlyMissing", True) if "onlyMissing" in args else _arg_bool(args, "only_missing", True)),
        config=args.get("config"),
    )
    return {"ok": True, **started}


def verification_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin import verification as ver

    rid = _arg_str(args, "roundId", "round_id", "id")
    if not rid:
        raise ValidationError("roundId is required")
    include_steps = True if "includeSteps" not in args and "include_steps" not in args else (_arg_bool(args, "includeSteps", True) if "includeSteps" in args else _arg_bool(args, "include_steps", True))
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


# ── appearance（EvoPanel 界面外观；读设置走 HTTP）────────────────────────────


def appearance_patch(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.appearance import patch_appearance

    return patch_appearance(args)


# ── ui（右侧面板；原 panel_set）─────────────────────────────────────────────


def _ui_panel_args(args: dict[str, Any]) -> dict[str, Any]:
    kind = _arg_str(args, "kind", "panel_kind", "surface_kind")
    title = _arg_str(args, "title") or None
    layout = _arg_str(args, "layout") or None
    data = args.get("data")
    if data is None:
        # Allow flat progress fields at top level for convenience.
        data = {
            k: v
            for k, v in args.items()
            if k
            not in {
                "kind",
                "panel_kind",
                "surface_kind",
                "title",
                "layout",
                "action",
                "confirm",
            }
        }
    if not isinstance(data, dict):
        data = {}
    return {"kind": kind or None, "title": title, "layout": layout, "data": data}


def ui_show(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    panel = _ui_panel_args(args)
    if not panel.get("kind"):
        raise ValidationError(
            "ui.show requires kind "
            "(collab-workflow | collabSubtaskTranscript | employeeProcess | web-embed | artifacts | …)"
        )
    return apply_right_panel(action="show", **panel)


def ui_update(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    panel = _ui_panel_args(args)
    if not panel.get("kind"):
        raise ValidationError("ui.update requires kind")
    return apply_right_panel(action="update", **panel)


def ui_hide(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    return apply_right_panel(action="hide")


# ── extensions（Agent应用 / UI 扩展；侧栏 #/extensions）─────────────────────


def _map_extension_error(exc: Exception) -> None:
    from evoflow.admin.errors import NotFoundError
    from evoflow.admin.ui_extensions_registry import (
        ExtensionIOError,
        ExtensionNotFoundError,
        ExtensionValidationError,
    )

    if isinstance(exc, ExtensionNotFoundError):
        raise NotFoundError(str(exc)) from exc
    if isinstance(exc, (ExtensionValidationError, ExtensionIOError)):
        raise ValidationError(str(exc)) from exc
    raise exc


def _remote_extension_manifest(*, ext_id: str, name: str, entry: str) -> dict[str, Any]:
    from urllib.parse import urlparse

    origin = ""
    try:
        parsed = urlparse(entry)
        if parsed.scheme and parsed.netloc:
            origin = f"{parsed.scheme}://{parsed.netloc}"
    except Exception:
        origin = ""
    return {
        "schema": 1,
        "id": ext_id,
        "name": name or ext_id,
        "version": "0.0.0",
        "ui": {"kind": "webview", "entry": entry},
        "permissions": ["embed"],
        "service": {"mode": "none"},
        "bridge": {"origin_allowlist": [origin] if origin else []},
    }


def extensions_list(_args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.ui_extensions_registry import read_registry, registry_path

    try:
        rows = read_registry()
    except Exception as exc:
        _map_extension_error(exc)
        raise
    return {
        "ok": True,
        "extensions": rows,
        "count": len(rows),
        "registry_path": str(registry_path()),
    }


def extensions_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.errors import NotFoundError
    from evoflow.admin.ui_extensions_registry import get_row

    ext_id = _arg_str(args, "id", "ext_id", "extension_id")
    if not ext_id:
        raise ValidationError("id is required")
    try:
        row = get_row(ext_id)
    except Exception as exc:
        _map_extension_error(exc)
        raise
    if row is None:
        raise NotFoundError(f"扩展不存在: {ext_id}")
    manifest = row.get("manifest") if isinstance(row.get("manifest"), dict) else {}
    return {"ok": True, "extension": row, "id": ext_id, "name": _arg_str(manifest, "name") or ext_id}


def extensions_install(args: dict[str, Any]) -> dict[str, Any]:
    """Install Agent应用: local ``path``, remote ``id``+``url``/``entry``, or ``manifest``(+``install_path``)."""
    from pathlib import Path

    from evoflow.admin.ui_extensions_registry import (
        read_manifest_from_dir,
        register_directory,
        upsert_row,
    )

    path = _arg_str(args, "path")
    manifest = _arg_json_value(args, "manifest")
    install_path = _arg_str(args, "install_path", "installPath")
    entry = _arg_str(args, "url", "entry", "entry_url")
    ext_id = _arg_str(args, "id", "ext_id", "extension_id")
    name = _arg_str(args, "name")
    link = args.get("link")
    source = _arg_str(args, "source") or None

    try:
        if path:
            src = Path(path).expanduser()
            # Validate early for clearer errors; register_directory re-reads.
            read_manifest_from_dir(src)
            link_flag = None if link is None else _arg_bool(args, "link", False)
            row = register_directory(src, link=link_flag, source=source)
        elif isinstance(manifest, dict):
            if not install_path:
                ui = manifest.get("ui") if isinstance(manifest.get("ui"), dict) else {}
                install_path = str(ui.get("entry") or "").strip()
            if not install_path:
                raise ValidationError("manifest 安装须提供 install_path（或 manifest.ui.entry）")
            row = upsert_row(manifest, install_path, source or "api")
        elif ext_id and entry:
            built = _remote_extension_manifest(ext_id=ext_id, name=name, entry=entry)
            row = upsert_row(built, entry, source or "remote")
        else:
            raise ValidationError(
                "须提供 path（本地目录）、或 id+url/entry（远程入口）、或 manifest（+install_path）"
            )
    except Exception as exc:
        _map_extension_error(exc)
        raise

    mid = str(row.get("id") or ext_id or "")
    mname = _arg_str(row.get("manifest") or {}, "name") or mid
    return {"ok": True, "extension": row, "id": mid, "name": mname, "installed": True}


def extensions_enable(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.ui_extensions_registry import set_enabled

    ext_id = _arg_str(args, "id", "ext_id", "extension_id")
    if not ext_id:
        raise ValidationError("id is required")
    try:
        out = set_enabled(ext_id, enabled=_arg_bool(args, "enabled", True))
    except Exception as exc:
        _map_extension_error(exc)
        raise
    return {"ok": True, **out, "name": ext_id}


def extensions_uninstall(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.ui_extensions_registry import remove_row

    ext_id = _arg_str(args, "id", "ext_id", "extension_id")
    if not ext_id:
        raise ValidationError("id is required")
    try:
        row = remove_row(ext_id)
    except Exception as exc:
        _map_extension_error(exc)
        raise
    return {"ok": True, "id": ext_id, "uninstalled": True, "extension": row, "name": ext_id}


# ── plugins（ZCode 兼容插件市场：安装/启停/市场）────────────────────────────


def _plugins_service():
    from evoflow.plugins.service import PluginManagementService
    from evoflow.plugins.storage import resolve_storage_root

    return PluginManagementService(resolve_storage_root())


def _map_plugin_error(exc: Exception) -> None:
    from evoflow.admin.errors import NotFoundError
    from evoflow.plugins.manifest import PluginManifestError
    from evoflow.plugins.sources import PluginSourceError

    if isinstance(exc, (PluginManifestError, PluginSourceError)):
        msg = str(exc)
        lowered = msg.lower()
        if "not found" in lowered or "not installed" in lowered:
            raise NotFoundError(msg) from exc
        raise ValidationError(msg) from exc
    raise exc


def plugins_overview(_args: dict[str, Any]) -> dict[str, Any]:
    try:
        data = _plugins_service().overview()
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    return {"ok": True, **data}


def plugins_list(_args: dict[str, Any]) -> dict[str, Any]:
    try:
        data = _plugins_service().list_plugins()
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    return {"ok": True, **data}


def plugins_describe(args: dict[str, Any]) -> dict[str, Any]:
    marketplace = _arg_str(args, "marketplace", "marketplace_id")
    name = _arg_str(args, "name", "pluginName", "plugin_name")
    if not marketplace or not name:
        raise ValidationError("marketplace and name are required")
    try:
        data = _plugins_service().describe_plugin(marketplace, name)
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    return {"ok": True, **data, "name": name, "marketplace": marketplace}


def plugins_install(args: dict[str, Any]) -> dict[str, Any]:
    marketplace = _arg_str(args, "marketplace", "marketplace_id")
    name = _arg_str(args, "pluginName", "plugin_name", "name")
    scope = _arg_str(args, "scope") or "user"
    if not marketplace or not name:
        raise ValidationError("marketplace and pluginName/name are required")
    try:
        data = _plugins_service().install_plugin(marketplace, name, scope)
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    plugin_id = f"{name}@{marketplace}"
    return {"ok": True, **data, "id": plugin_id, "name": name, "pluginId": plugin_id}


def plugins_enable(args: dict[str, Any]) -> dict[str, Any]:
    plugin_id = _arg_str(args, "pluginId", "plugin_id", "id")
    if not plugin_id:
        raise ValidationError("pluginId is required（形如 name@marketplace）")
    try:
        data = _plugins_service().set_plugin_enabled(plugin_id, _arg_bool(args, "enabled", True))
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    return {"ok": True, **data, "id": plugin_id, "name": plugin_id}


def plugins_update(args: dict[str, Any]) -> dict[str, Any]:
    plugin_id = _arg_str(args, "pluginId", "plugin_id", "id")
    if not plugin_id:
        raise ValidationError("pluginId is required")
    try:
        data = _plugins_service().update_plugin(plugin_id)
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    return {"ok": True, **data, "id": plugin_id, "name": plugin_id}


def plugins_restore(args: dict[str, Any]) -> dict[str, Any]:
    plugin_id = _arg_str(args, "pluginId", "plugin_id", "id")
    if not plugin_id:
        raise ValidationError("pluginId is required")
    try:
        data = _plugins_service().restore_builtin_plugin(plugin_id)
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    return {"ok": True, **data, "id": plugin_id, "name": plugin_id}


def plugins_uninstall(args: dict[str, Any]) -> dict[str, Any]:
    plugin_id = _arg_str(args, "pluginId", "plugin_id", "id")
    if not plugin_id:
        raise ValidationError("pluginId is required")
    if "removeCache" in args:
        remove_cache = _arg_bool(args, "removeCache", True)
    elif "remove_cache" in args:
        remove_cache = _arg_bool(args, "remove_cache", True)
    else:
        remove_cache = True
    try:
        data = _plugins_service().uninstall_plugin(plugin_id, remove_cache)
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    return {"ok": True, **data, "id": plugin_id, "name": plugin_id, "uninstalled": True}


def plugins_marketplace_add(args: dict[str, Any]) -> dict[str, Any]:
    source = _arg_str(args, "source")
    if not source:
        raise ValidationError("source is required（URL / git / owner/repo / 本地路径）")
    try:
        record, diagnostics = _plugins_service().add_marketplace(source)
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    return {
        "ok": True,
        "marketplace": {"id": record.id, "name": record.name, "source": record.source},
        "id": record.id,
        "name": record.name,
        "diagnostics": [d.to_json() if hasattr(d, "to_json") else d for d in (diagnostics or [])],
    }


def plugins_marketplace_remove(args: dict[str, Any]) -> dict[str, Any]:
    marketplace_id = _arg_str(args, "marketplace", "marketplace_id", "id")
    if not marketplace_id:
        raise ValidationError("marketplace id is required")
    try:
        _plugins_service().remove_marketplace(marketplace_id)
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    return {"ok": True, "id": marketplace_id, "name": marketplace_id, "removed": True}


def plugins_marketplace_refresh(args: dict[str, Any]) -> dict[str, Any]:
    marketplace_id = _arg_str(args, "marketplace", "marketplace_id", "id") or None
    try:
        updated, diagnostics = _plugins_service().refresh_marketplace(marketplace_id)
    except Exception as exc:
        _map_plugin_error(exc)
        raise
    return {
        "ok": True,
        "marketplaces": [{"id": r.id, "name": r.name, "pluginCount": r.pluginCount} for r in (updated or [])],
        "id": marketplace_id or "",
        "diagnostics": [d.to_json() if hasattr(d, "to_json") else d for d in (diagnostics or [])],
    }


# ── org（资源包 / Organization Pack）─────────────────────────────────────────


def _org_source_from_args(args: dict[str, Any]) -> dict[str, Any]:
    source = _arg_json_value(args, "source")
    if isinstance(source, dict) and source:
        out = dict(source)
        st = str(out.get("type") or "path").strip() or "path"
        out["type"] = st
        return out
    path = _arg_str(args, "path")
    url = _arg_str(args, "url")
    if path:
        is_zip = _arg_bool(args, "zip", False) or path.lower().endswith(".zip")
        src_type = "market_path" if _arg_bool(args, "market", False) else ("zip_path" if is_zip else "path")
        out = {"type": src_type, "path": path}
        repo = _arg_str(args, "repo")
        if repo:
            out["repo"] = repo
        return out
    if url:
        return {"type": "zip_url", "url": url, "repo": _arg_str(args, "repo") or None}
    raise ValidationError("须提供 source 对象，或 path / url")


def _org_install_options(args: dict[str, Any]) -> dict[str, Any]:
    options = _arg_json_value(args, "options")
    opts: dict[str, Any] = dict(options) if isinstance(options, dict) else {}
    prefix = _arg_str(args, "id_prefix", "idPrefix")
    if prefix:
        opts["id_prefix"] = prefix
    conflict = _arg_str(args, "conflict", "conflict_policy", "conflictPolicy")
    if conflict:
        opts["conflict_policy"] = conflict
    return opts


def org_preflight(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.organizations.installer import preflight_organization

    return {
        "ok": True,
        **preflight_organization(
            source=_org_source_from_args(args),
            workspace_path=_arg_str(args, "workspace_path", "workspace") or None,
            options=_org_install_options(args) or None,
        ),
    }


def org_install(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.organizations.installer import OrganizationInstallError, install_organization

    try:
        data = install_organization(
            source=_org_source_from_args(args),
            workspace_path=_arg_str(args, "workspace_path", "workspace") or None,
            options=_org_install_options(args) or None,
        )
    except OrganizationInstallError as exc:
        raise ValidationError(f"{exc}（rolled_back={getattr(exc, 'rolled_back', None)}）") from exc
    oid = _arg_str(data if isinstance(data, dict) else {}, "org_instance_id", "id")
    return {"ok": True, **(data if isinstance(data, dict) else {"result": data}), "id": oid, "name": oid}


def org_list(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.organizations.registry import list_org_instances

    status = _arg_str(args, "status") or "active"
    if status == "all":
        status = ""
    items = list_org_instances(status=status or None)
    return {"ok": True, "items": items, "count": len(items)}


def org_get(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.errors import NotFoundError
    from evoflow.organizations.registry import get_org_instance

    oid = _arg_str(args, "org_instance_id", "id", "org_id")
    if not oid:
        raise ValidationError("org_instance_id is required")
    inst = get_org_instance(oid)
    if not inst:
        raise NotFoundError(f"Organization not found: {oid}")
    pack = inst.get("pack") if isinstance(inst.get("pack"), dict) else {}
    name = _arg_str(inst, "name") or _arg_str(pack, "name") or oid
    return {"ok": True, "organization": inst, "id": oid, "name": name}


def org_uninstall(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.organizations.installer import OrganizationInstallError, uninstall_organization

    oid = _arg_str(args, "org_instance_id", "id", "org_id")
    if not oid:
        raise ValidationError("org_instance_id is required")
    options = _arg_json_value(args, "options")
    opts: dict[str, Any] = dict(options) if isinstance(options, dict) else {}
    if "keep_primitives" in args:
        opts["keep_primitives"] = _arg_bool(args, "keep_primitives", False)
    elif "keepPrimitives" in args:
        opts["keep_primitives"] = _arg_bool(args, "keepPrimitives", False)
    if "delete_workspace" in args or "deleteWorkspace" in args:
        delete_ws = (
            _arg_bool(args, "delete_workspace", False)
            if "delete_workspace" in args
            else _arg_bool(args, "deleteWorkspace", False)
        )
        opts["keep_workspace"] = not delete_ws
    elif "keep_workspace" in args:
        opts["keep_workspace"] = _arg_bool(args, "keep_workspace", True)
    elif "keepWorkspace" in args:
        opts["keep_workspace"] = _arg_bool(args, "keepWorkspace", True)
    try:
        data = uninstall_organization(oid, options=opts or None)
    except OrganizationInstallError as exc:
        raise ValidationError(str(exc)) from exc
    return {"ok": True, **(data if isinstance(data, dict) else {}), "id": oid, "name": oid, "uninstalled": True}


def org_export(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.organizations.export import OrganizationExportError, export_organization

    pack = _arg_json_value(args, "pack")
    if not isinstance(pack, dict):
        pack = {
            "id": _arg_str(args, "pack_id", "id") or "exported-pack",
            "name": _arg_str(args, "pack_name", "name") or "导出的资源包",
            "version": _arg_str(args, "version") or "1.0.0",
        }
    include = _arg_json_value(args, "include")
    if not isinstance(include, dict):
        employees = _arg_str(args, "employees", "employee_codes")
        apps = _arg_str(args, "apps", "app_ids")
        include = {
            "employee_codes": [x.strip() for x in employees.split(",") if x.strip()] if employees else [],
            "app_ids": [x.strip() for x in apps.split(",") if x.strip()] if apps else [],
        }
    output = _arg_json_value(args, "output")
    if not isinstance(output, dict):
        out_dir = _arg_str(args, "output_dir", "dir", "output")
        if not out_dir:
            raise ValidationError("output.dir / output_dir is required")
        output = {"dir": out_dir, "zip": _arg_bool(args, "zip", False)}
    try:
        data = export_organization(pack=pack, include=include, output=output)
    except OrganizationExportError as exc:
        raise ValidationError(str(exc)) from exc
    return {"ok": True, **(data if isinstance(data, dict) else {}), "name": pack.get("name") or pack.get("id")}


def org_market_catalog(_args: dict[str, Any]) -> dict[str, Any]:
    import urllib.request

    from evoflow.organizations.fetch import market_catalog_url

    url = market_catalog_url()
    empty = {
        "ok": True,
        "schema": 1,
        "marketId": "evoflow-resource-market",
        "packs": [],
        "configured": bool(url),
        "source": url or None,
    }
    if not url:
        return empty

    def _fetch() -> dict[str, Any]:
        with urllib.request.urlopen(url, timeout=15) as resp:  # noqa: S310
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
        if not isinstance(data, dict):
            raise ValidationError("catalog must be a JSON object")
        data.setdefault("schema", 1)
        data["source"] = url
        data["configured"] = True
        if not isinstance(data.get("packs"), list):
            data["packs"] = []
        return data

    try:
        return {"ok": True, **_fetch()}
    except ValidationError:
        raise
    except Exception as exc:
        raise ValidationError(f"Failed to fetch market catalog: {exc}") from exc


def org_market_install(args: dict[str, Any]) -> dict[str, Any]:
    path = _arg_str(args, "path", "pack_path")
    if not path:
        raise ValidationError("path is required（市场内相对路径，如 packs/foo）")
    merged = dict(args)
    merged["source"] = {
        "type": "market_path",
        "path": path,
        "repo": _arg_str(args, "repo") or None,
    }
    if "conflict" not in merged and "conflict_policy" not in merged:
        merged["conflict"] = "fail"
    return org_install(merged)


# ── channels（IM 渠道：飞书/企微/钉钉/微信）────────────────────────────────


def _channels_service_or_none():
    try:
        from evoflow.runtime.ports import get_channel_service

        return get_channel_service()
    except Exception:
        return None


def _channels_ensure_service():
    service = _channels_service_or_none()
    if service is not None:
        return service
    try:
        from evoflow.runtime.ports import start_channel_service

        return _run_coro_sync(start_channel_service())
    except Exception:
        return None


def channels_list(_args: dict[str, Any]) -> dict[str, Any]:
    service = _channels_ensure_service()
    if service is not None:
        status = service.get_status()
        return {"ok": True, **(status if isinstance(status, dict) else {"status": status})}
    try:
        from evoflow.runtime.ports import registry_channel_status

        status = registry_channel_status(service_running=False)
        if status is not None:
            return {"ok": True, **status}
    except Exception:
        pass
    from evoflow.persistence import config_repositories as cfg_repo

    configs = cfg_repo.get_all_channel_configs()
    return {
        "ok": True,
        "service_running": False,
        "channels": {
            name: {"enabled": bool((cfg or {}).get("enabled")), "running": False, "config": cfg}
            for name, cfg in (configs or {}).items()
        },
    }


def channels_get(args: dict[str, Any]) -> dict[str, Any]:
    name = _arg_str(args, "name", "channel", "platform")
    if not name:
        raise ValidationError("name is required（feishu|weixin|wecom|dingtalk）")
    service = _channels_service_or_none()
    if service is not None:
        config, enabled, running = service.get_channel_config(name)
        return {
            "ok": True,
            "name": name,
            "enabled": enabled,
            "running": running,
            "config": config or {},
        }
    from evoflow.admin.errors import NotFoundError
    from evoflow.persistence import config_repositories as cfg_repo

    cfg = cfg_repo.get_all_channel_configs().get(name)
    if cfg is None:
        raise NotFoundError(f"Channel not found: {name}")
    return {
        "ok": True,
        "name": name,
        "enabled": bool(cfg.get("enabled")),
        "running": False,
        "config": cfg,
        "hint": "Channel service 未运行；仅返回持久化配置",
    }


def channels_set_config(args: dict[str, Any]) -> dict[str, Any]:
    name = _arg_str(args, "name", "channel", "platform")
    if not name:
        raise ValidationError("name is required")
    config = _arg_json_value(args, "config")
    if not isinstance(config, dict):
        skip = {"name", "channel", "platform", "config", "merge", "confirm", "principal_id"}
        config = {k: v for k, v in args.items() if k not in skip}
    if not config:
        raise ValidationError("config is required")
    merge = _arg_bool(args, "merge", True)

    service = _channels_service_or_none()
    if service is not None:
        payload = config
        if merge:
            existing, _, _ = service.get_channel_config(name)
            payload = {**(existing or {}), **config}
        ok = bool(_run_coro_sync(service.update_channel_config(name, payload)))
        return {"ok": ok, "name": name, "success": ok, "config": payload}

    from evoflow.persistence import config_repositories as cfg_repo

    existing = cfg_repo.get_all_channel_configs().get(name) or {}
    doc = {**existing, **config} if merge else dict(config)
    cfg_repo.upsert_channel_config(name, doc)
    return {
        "ok": True,
        "name": name,
        "success": True,
        "config": doc,
        "hint": "已写入配置；重启 Gateway 或 channels.restart 后生效",
    }


def channels_enable(args: dict[str, Any]) -> dict[str, Any]:
    name = _arg_str(args, "name", "channel", "platform")
    if not name:
        raise ValidationError("name is required")
    enabled = _arg_bool(args, "enabled", True)
    service = _channels_ensure_service()
    if service is None:
        # Persist enabled flag even if runtime is down.
        from evoflow.persistence import config_repositories as cfg_repo

        existing = cfg_repo.get_all_channel_configs().get(name) or {}
        existing["enabled"] = enabled
        cfg_repo.upsert_channel_config(name, existing)
        return {
            "ok": True,
            "name": name,
            "enabled": enabled,
            "success": True,
            "hint": "Channel service 未运行；仅写入 enabled，重启 Gateway 后生效",
        }
    ok = bool(_run_coro_sync(service.set_channel_enabled(name, enabled)))
    return {"ok": ok, "name": name, "enabled": enabled, "success": ok}


def channels_restart(args: dict[str, Any]) -> dict[str, Any]:
    name = _arg_str(args, "name", "channel", "platform")
    if not name:
        raise ValidationError("name is required")
    service = _channels_ensure_service()
    if service is None:
        raise ValidationError("Channel service is not running（请先启动 Gateway）")
    ok = bool(_run_coro_sync(service.restart_channel(name)))
    return {"ok": ok, "name": name, "success": ok, "restarted": ok}


def channels_push_targets(args: dict[str, Any]) -> dict[str, Any]:
    try:
        from evoflow.runtime.ports import list_push_targets

        targets = list_push_targets(limit=int(args.get("limit") or 200))
    except Exception as exc:
        raise ValidationError(f"push targets unavailable: {exc}") from exc
    if targets is None:
        raise ValidationError("push targets unavailable: channel push adapter not registered")
    return {"ok": True, "targets": targets}


def channels_send_message(args: dict[str, Any]) -> dict[str, Any]:
    """Push text/files to the IM chat+bot that originated this session.

    Routing is taken from ``evoflow_chat_sessions.context`` (channel /
    channel_chat_id / account_id / topic_id). Callers must **not** pick a bot —
    wrong-bot delivery is prevented by ignoring any channel/account overrides.
    """
    sk = _arg_str(args, "session_key", "sessionKey", "session")
    if not sk:
        raise ValidationError("session_key missing（平台会自动注入；请在 IM 会话中调用）")

    text = _arg_str(args, "text", "message", "content", "markdown", "body")
    title = _arg_str(args, "title")
    raw_paths = args.get("paths")
    if raw_paths is None:
        raw_paths = args.get("files")
    if raw_paths is None:
        raw_paths = args.get("attachments")
    paths: list[str] = []
    if isinstance(raw_paths, str) and raw_paths.strip():
        paths = [raw_paths.strip()]
    elif isinstance(raw_paths, list):
        for item in raw_paths:
            if isinstance(item, str) and item.strip():
                paths.append(item.strip())
            elif isinstance(item, dict):
                p = str(item.get("path") or item.get("file") or item.get("url") or "").strip()
                if p:
                    paths.append(p)
    single = _arg_str(args, "path", "file", "image", "attachment")
    if single:
        paths.append(single)

    # Ignore any agent-supplied channel/account — origin session is authoritative.
    try:
        from evoflow.runtime.ports import push_to_inbound_origin
    except Exception as exc:
        raise ValidationError(f"channel push port unavailable: {exc}") from exc

    result = push_to_inbound_origin(
        session_key=sk,
        text=text,
        paths=paths,
        title=title,
    )
    if result is None:
        raise ValidationError(
            "channel push adapter not registered（请确认 Gateway 已启动并注册 channels.push_to_inbound_origin）"
        )
    if not result.get("ok"):
        err = str(result.get("error") or "push_failed")
        hint = str(result.get("hint") or "").strip()
        raise ValidationError(f"{err}" + (f"：{hint}" if hint else ""))
    return result


def _registration_client(channel: str):
    """Return ``(client|None, normalized_channel)``.

    Client is None when runtime adapters are not registered (external LangGraph
    process). Callers must use ``_registration_begin`` / ``_registration_poll``
    which fall back to Gateway HTTP so sessions live on the Gateway singleton.
    """
    ch = channel.strip().lower()
    if ch == "feishu":
        from evoflow.runtime.ports import get_feishu_registration_client

        return get_feishu_registration_client(), ch
    if ch in {"weixin", "wechat"}:
        from evoflow.runtime.ports import get_weixin_registration_client

        return get_weixin_registration_client(), "weixin"
    if ch == "wecom":
        from evoflow.runtime.ports import get_wecom_registration_client

        return get_wecom_registration_client(), "wecom"
    if ch in {"dingtalk", "dingding"}:
        from evoflow.runtime.ports import get_dingtalk_registration_client

        return get_dingtalk_registration_client(), "dingtalk"
    raise ValidationError("name must be feishu|weixin|wecom|dingtalk")


def _channels_api_base() -> str:
    from evoflow.gateway_http import resolve_gateway_base_url

    base = resolve_gateway_base_url(allow_legacy_default=True) or "http://127.0.0.1:8070"
    return f"{base.rstrip('/')}/api/channels"


def _registration_http_paths(channel: str) -> tuple[str, str, str]:
    """Return ``(begin_path, poll_path_tmpl, apply_path_tmpl)`` under ``/api/channels``."""
    ch = channel.strip().lower()
    if ch not in {"feishu", "weixin", "wecom", "dingtalk"}:
        raise ValidationError(f"unsupported registration channel: {channel}")
    return (
        f"/{ch}/registration/begin",
        f"/{ch}/registration/{{session_id}}/poll",
        f"/{ch}/registration/{{session_id}}/apply",
    )


def _session_from_http_payload(data: dict[str, Any], *, session_id: str = "") -> Any:
    """Build a duck-typed session object from Gateway registration JSON."""
    from types import SimpleNamespace

    sid = str(data.get("session_id") or session_id or "").strip()
    return SimpleNamespace(
        session_id=sid,
        qr_url=str(data.get("qr_url") or data.get("qrUrl") or "") or None,
        fallback_url=data.get("fallback_url") or data.get("fallbackUrl"),
        status=str(data.get("status") or "pending").strip() or "pending",
        error=data.get("error"),
        app_id=data.get("app_id") or data.get("appId"),
        app_secret=data.get("app_secret") or data.get("appSecret"),
        open_id=data.get("open_id") or data.get("openId"),
        account_id=data.get("account_id") or data.get("accountId"),
        token=data.get("token"),
        bot_id=data.get("bot_id") or data.get("botId"),
        secret=data.get("secret"),
        user_id=data.get("user_id") or data.get("userId"),
        base_url=data.get("base_url") or data.get("baseUrl"),
    )


def _registration_http_begin(channel: str) -> Any:
    import httpx

    begin_path, _poll, _apply = _registration_http_paths(channel)
    url = f"{_channels_api_base()}{begin_path}"
    try:
        with httpx.Client(timeout=45.0) as client:
            r = client.post(url)
    except Exception as exc:
        raise ValidationError(
            f"{channel} registration begin failed: Gateway 不可达（{exc}）。"
            "确认 Gateway 已启动且 EVOFLOW_GATEWAY_URL 指向正确端口。"
        ) from exc
    if r.status_code >= 400:
        detail = ""
        try:
            body = r.json()
            detail = str(body.get("detail") or body.get("error") or body)[:240]
        except Exception:
            detail = (r.text or "")[:240]
        raise ValidationError(
            f"{channel} registration begin failed: HTTP {r.status_code}"
            + (f" — {detail}" if detail else "")
        )
    data = r.json() if r.content else {}
    if not isinstance(data, dict):
        raise ValidationError(f"{channel} registration begin failed: invalid Gateway response")
    session = _session_from_http_payload(data)
    if not session.session_id:
        raise ValidationError(f"{channel} registration begin returned empty session_id")
    return session


def _registration_http_poll(channel: str, session_id: str) -> Any:
    import httpx

    _begin, poll_tmpl, _apply = _registration_http_paths(channel)
    url = f"{_channels_api_base()}{poll_tmpl.format(session_id=session_id)}"
    try:
        with httpx.Client(timeout=30.0) as client:
            r = client.get(url)
    except Exception as exc:
        raise ValidationError(f"{channel} registration poll failed: Gateway 不可达（{exc}）") from exc
    if r.status_code >= 400:
        detail = ""
        try:
            body = r.json()
            detail = str(body.get("detail") or body.get("error") or body)[:240]
        except Exception:
            detail = (r.text or "")[:240]
        raise ValidationError(
            f"{channel} registration poll failed: HTTP {r.status_code}"
            + (f" — {detail}" if detail else "")
        )
    data = r.json() if r.content else {}
    if not isinstance(data, dict):
        raise ValidationError(f"{channel} registration poll failed: invalid Gateway response")
    return _session_from_http_payload(data, session_id=session_id)


def _registration_begin(channel: str) -> Any:
    """Start QR registration via in-process port or Gateway HTTP fallback."""
    client, ch = _registration_client(channel)
    if client is None:
        return _registration_http_begin(ch)
    try:
        return _run_coro_sync(client.begin())
    except Exception as exc:
        raise ValidationError(f"{ch} registration begin failed: {exc}") from exc


def _registration_poll(channel: str, session_id: str) -> Any:
    client, ch = _registration_client(channel)
    if client is None:
        return _registration_http_poll(ch, session_id)
    try:
        return _run_coro_sync(client.poll(session_id))
    except Exception as exc:
        raise ValidationError(f"{ch} registration poll failed: {exc}") from exc


def _registration_require_session(channel: str, session_id: str) -> tuple[Any, str]:
    """Resolve a completed-capable session; prefer in-process, else HTTP poll snapshot."""
    client, ch = _registration_client(channel)
    if client is not None:
        session = client.get_session(session_id)
        if session is None:
            raise ValidationError("Registration session not found")
        return session, ch
    # Off-process: poll Gateway so we see the same in-memory session as /begin.
    session = _registration_http_poll(ch, session_id)
    return session, ch


def channels_registration_begin(args: dict[str, Any]) -> dict[str, Any]:
    name = _arg_str(args, "name", "channel", "platform") or "feishu"
    _client, channel = _registration_client(name)
    session = _registration_begin(channel)
    return {
        "ok": True,
        "name": channel,
        "session_id": getattr(session, "session_id", None),
        "qr_url": getattr(session, "qr_url", None) or "",
        "status": getattr(session, "status", None),
        "hint": "用对应 App 扫码；再 channels.registration_poll 轮询，完成后 registration_apply",
    }


def channels_registration_poll(args: dict[str, Any]) -> dict[str, Any]:
    name = _arg_str(args, "name", "channel", "platform") or "feishu"
    session_id = _arg_str(args, "session_id", "sessionId")
    if not session_id:
        raise ValidationError("session_id is required")
    _client, channel = _registration_client(name)
    session = _registration_poll(channel, session_id)
    status = getattr(session, "status", None)
    out: dict[str, Any] = {
        "ok": True,
        "name": channel,
        "session_id": session_id,
        "status": status,
    }
    if status == "completed":
        for key in ("app_id", "app_secret", "account_id", "token", "bot_id", "secret", "user_id", "base_url"):
            val = getattr(session, key, None)
            if val:
                out[key] = val
    if status in {"failed", "expired"}:
        out["error"] = getattr(session, "error", None)
    return out


def channels_registration_apply(args: dict[str, Any]) -> dict[str, Any]:
    """Apply completed registration credentials into channel config + start if possible."""
    name = _arg_str(args, "name", "channel", "platform") or "feishu"
    session_id = _arg_str(args, "session_id", "sessionId")
    if not session_id:
        raise ValidationError("session_id is required")
    enabled = _arg_bool(args, "enabled", True)
    session, channel = _registration_require_session(name, session_id)
    if getattr(session, "status", None) != "completed":
        raise ValidationError(
            f"Registration is not complete (status={getattr(session, 'status', None)})"
        )

    config: dict[str, Any] = {"enabled": enabled}
    if channel == "feishu":
        if not getattr(session, "app_id", None) or not getattr(session, "app_secret", None):
            raise ValidationError("Registration completed but credentials are missing")
        config.update({"app_id": session.app_id, "app_secret": session.app_secret})
    elif channel == "weixin":
        try:
            from evoflow.runtime.ports import save_weixin_credentials

            saved = save_weixin_credentials(
                getattr(session, "account_id", None),
                getattr(session, "token", None),
                getattr(session, "base_url", None),
                getattr(session, "user_id", None),
            )
            if not saved:
                raise ValidationError("weixin setup adapter not registered")
        except Exception as exc:
            raise ValidationError(f"save weixin credentials failed: {exc}") from exc
        service = _channels_ensure_service()
        running = False
        if service is not None:
            _, _, running = service.get_channel_config("weixin")
        return {
            "ok": True,
            "name": channel,
            "success": True,
            "channel_running": running,
            "hint": "微信凭证已保存" + ("" if running else "；如未运行请 channels.restart"),
        }
    elif channel == "wecom":
        try:
            from evoflow.runtime.ports import save_wecom_credentials

            saved = save_wecom_credentials(getattr(session, "bot_id", None), getattr(session, "secret", None))
            if not saved:
                raise ValidationError("wecom setup adapter not registered")
        except Exception as exc:
            raise ValidationError(f"save wecom credentials failed: {exc}") from exc
        agent_code = _arg_str(args, "agent_code", "agentCode")
        if agent_code:
            # Binding is router-specific; surface for caller.
            return {
                "ok": True,
                "name": channel,
                "success": True,
                "agent_code": agent_code,
                "hint": "企微凭证已保存；如需绑定员工请在面板完成 agent_code 关联",
            }
        return {"ok": True, "name": channel, "success": True}
    elif channel == "dingtalk":
        # Persist whatever the session exposes.
        for key in ("app_key", "app_secret", "client_id", "client_secret", "robot_code", "agent_id"):
            val = getattr(session, key, None)
            if val:
                config[key] = val
        if len(config) <= 1:
            raise ValidationError("Registration completed but dingtalk credentials are missing")

    return {
        **channels_set_config({"name": channel, "config": config, "merge": True}),
        "channel": channel,
        "hint": "凭证已写入；可用 channels.restart 拉起渠道",
    }

# --- media（图片 / 视频生成；即梦 jimeng / Agent Plan） ---


def media_catalog(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.platform_media import media_catalog as _catalog

    return _catalog(tier_hint=_arg_str(args, "tier_id", "tierId", "tier") or None)


def media_status(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.platform_media import media_status as _status

    return _status()


def media_generate_image(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.platform_media import generate_image

    tid = _arg_str(args, "thread_id", "threadId")
    out = generate_image(args, thread_id=tid or None)
    out.setdefault("action", "media.generate_image")
    return out


def media_generate_video(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.platform_media import generate_video

    tid = _arg_str(args, "thread_id", "threadId")
    out = generate_video(args, thread_id=tid or None)
    out.setdefault("action", "media.generate_video")
    return out


def media_task_wait(args: dict[str, Any]) -> dict[str, Any]:
    from evoflow.admin.platform_media import task_wait

    tid = _arg_str(args, "thread_id", "threadId")
    out = task_wait(args, thread_id=tid or None)
    out.setdefault("action", "media.task_wait")
    return out
