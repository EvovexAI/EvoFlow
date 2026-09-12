"""DDL for application tables in ``evoflow.db`` (prefix ``evoflow_``).

Public 1.0.0 epoch: schema starts at version 1 (single baseline).
Historical pre-1.0 ladder (user_version 1..142) is not shipped; existing DBs
with legacy user_version > 1 are snapped to 1 when the physical schema is present.
"""

from __future__ import annotations

import logging
import sqlite3

# Public source-available schema epoch (was 142 before the 1.0.0 squash).
APP_SCHEMA_VERSION = 1
# Pre-public ladder peak; used only to recognize legacy installs.
_LEGACY_SCHEMA_VERSION_MAX = 142

logger = logging.getLogger(__name__)

_BASELINE_DDL = """
CREATE TABLE IF NOT EXISTS eval_alert_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dimension TEXT NOT NULL DEFAULT 'business',
    metric TEXT NOT NULL DEFAULT 'pass_rate',
    operator TEXT NOT NULL DEFAULT 'lt',
    threshold REAL NOT NULL DEFAULT 60,
    level TEXT NOT NULL DEFAULT 'warn',
    channel TEXT NOT NULL DEFAULT 'panel',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_alerts (
    id TEXT PRIMARY KEY,
    rule_id TEXT,
    run_id TEXT,
    level TEXT NOT NULL DEFAULT 'warn',
    dimension TEXT NOT NULL DEFAULT '',
    metric TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    value REAL,
    threshold REAL,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_case_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    score REAL,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    detail TEXT NOT NULL DEFAULT '',
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    FOREIGN KEY (run_id) REFERENCES eval_runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS eval_cases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'business',
    level TEXT NOT NULL DEFAULT 'L1',
    description TEXT NOT NULL DEFAULT '',
    handler TEXT NOT NULL DEFAULT '',
    params_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_runs (
    run_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'smoke',
    status TEXT NOT NULL DEFAULT 'queued',
    config_json TEXT NOT NULL DEFAULT '{}',
    summary_json TEXT NOT NULL DEFAULT '{}',
    total_cases INTEGER NOT NULL DEFAULT 0,
    passed_cases INTEGER NOT NULL DEFAULT 0,
    failed_cases INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'smoke',
    cron TEXT NOT NULL DEFAULT '0 9 * * *',
    case_ids TEXT NOT NULL DEFAULT '[]',
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evoflow_a2a_external_agents (
                agent_code     TEXT PRIMARY KEY,
                agent_name     TEXT NOT NULL DEFAULT '',
                base_url       TEXT NOT NULL DEFAULT '',
                agent_card_url TEXT NOT NULL DEFAULT '',
                auth_token     TEXT NOT NULL DEFAULT '',
                status         TEXT NOT NULL DEFAULT 'registered',
                created_at     TEXT NOT NULL DEFAULT ''
            );

CREATE TABLE IF NOT EXISTS evoflow_a2a_tasks (
                task_id         TEXT PRIMARY KEY,
                agent_code      TEXT NOT NULL,
                meeting_id      TEXT NOT NULL DEFAULT '',
                session_id      TEXT NOT NULL DEFAULT '',
                state           TEXT NOT NULL DEFAULT 'submitted',
                goal            TEXT NOT NULL DEFAULT '',
                context_summary TEXT NOT NULL DEFAULT '',
                result_text     TEXT NOT NULL DEFAULT '',
                created_at      TEXT NOT NULL DEFAULT '',
                updated_at      TEXT NOT NULL DEFAULT '',
                completed_at    TEXT NOT NULL DEFAULT ''
            );

CREATE TABLE IF NOT EXISTS evoflow_acl_grants (
            org_id TEXT NOT NULL,
            owner_scope_id TEXT NOT NULL,
            ref TEXT NOT NULL,
            grantee_scope_id TEXT NOT NULL,
            permission TEXT NOT NULL,
            granted_by TEXT NOT NULL,
            created_at REAL NOT NULL,
            PRIMARY KEY (org_id, owner_scope_id, ref, grantee_scope_id, permission)
        );

CREATE TABLE IF NOT EXISTS evoflow_admin_grants (
            org_id TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            role TEXT NOT NULL,
            granted_by TEXT,
            created_at REAL NOT NULL,
            PRIMARY KEY (org_id, principal_id, scope_id, role)
        );

CREATE TABLE IF NOT EXISTS evoflow_agent_env (
    agent_code TEXT NOT NULL,
    env_key TEXT NOT NULL,
    env_value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (agent_code, env_key)
);

CREATE TABLE IF NOT EXISTS evoflow_agent_list_items (
    agent_code TEXT NOT NULL,
    list_kind TEXT NOT NULL,
    item_value TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (agent_code, list_kind, sort_order)
);

CREATE TABLE IF NOT EXISTS "evoflow_agent_runtime" (
            agent_id TEXT PRIMARY KEY,
            agent_name TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'idle',
            current_task_id TEXT,
            last_heartbeat TEXT,
            progress INTEGER NOT NULL DEFAULT 0,
            main_task_id TEXT,
            extra_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS "evoflow_agents" (
    "agent_code" TEXT PRIMARY KEY, "agent_name" TEXT, "description" TEXT NOT NULL DEFAULT '', "model" TEXT, "agent_type" TEXT NOT NULL DEFAULT 'custom', "system_prompt" TEXT, "max_turns" INTEGER NOT NULL DEFAULT 500, "prompt_language" TEXT, "timeout_seconds" INTEGER NOT NULL DEFAULT 900, "command" TEXT, "auto_approve_permissions" INTEGER NOT NULL DEFAULT 0, "soul_md" TEXT NOT NULL DEFAULT '', "extra_json" TEXT NOT NULL DEFAULT '{}', "updated_at" TEXT NOT NULL, "tags_json" TEXT NOT NULL DEFAULT '[]'
, identity_md TEXT NOT NULL DEFAULT '', org_id TEXT, owner_scope_id TEXT);

CREATE TABLE IF NOT EXISTS evoflow_api_tokens (
            token_hash    TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            identity_type TEXT NOT NULL,
            identity_id   TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            revoked_at    INTEGER
        , org_id TEXT, principal_id TEXT, acting_scope_id TEXT);

CREATE TABLE IF NOT EXISTS evoflow_app_revisions (
    app_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (app_id, version),
    FOREIGN KEY (app_id) REFERENCES evoflow_apps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evoflow_app_runs (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    app_version INTEGER NOT NULL,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    execution_mode TEXT NOT NULL DEFAULT 'workflow',
    task_id TEXT NOT NULL,
    thread_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    progress INTEGER NOT NULL DEFAULT 0,
    result_summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    FOREIGN KEY (app_id) REFERENCES evoflow_apps(id)
);

CREATE TABLE IF NOT EXISTS "evoflow_app_settings" (
    key TEXT PRIMARY KEY,
    value_text TEXT,
    value_json TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evoflow_apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    parameters_json TEXT NOT NULL DEFAULT '[]',
    steps_json TEXT NOT NULL DEFAULT '[]',
    goal_template TEXT NOT NULL DEFAULT '',
    validation_template_json TEXT NOT NULL DEFAULT '[]',
    flowchart_mermaid TEXT NOT NULL DEFAULT '',
    execution_mode TEXT NOT NULL DEFAULT 'workflow',
    auto_run INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'generated',
    source_task_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT
, canvas_json TEXT NOT NULL DEFAULT '{}', answer_from_ref TEXT NOT NULL DEFAULT '', final_rollup TEXT NOT NULL DEFAULT 'auto', final_rollup_agent TEXT NOT NULL DEFAULT '', final_rollup_instruction TEXT NOT NULL DEFAULT '', org_id TEXT, owner_scope_id TEXT, created_by TEXT);

CREATE TABLE IF NOT EXISTS evoflow_artifacts (
    session_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'file', url TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', size INTEGER, content TEXT, status TEXT NOT NULL DEFAULT 'new', created_at TEXT, meta_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (session_key, thread_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS "evoflow_automation_runs" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    run_id TEXT,
    started_at TEXT,
    trigger_type TEXT,
    status TEXT,
    output TEXT,
    error TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    langgraph_thread_id TEXT,
    langgraph_run INTEGER NOT NULL DEFAULT 0,
    extra_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, updated_at TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS "evoflow_automations" (
    task_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    schedule TEXT,
    rrule TEXT,
    scheduled_at TEXT,
    status TEXT,
    schedule_type TEXT,
    workspace TEXT,
    valid_from TEXT,
    valid_until TEXT,
    max_duration_minutes INTEGER,
    feishu_push_enabled INTEGER NOT NULL DEFAULT 0,
    langgraph_run INTEGER NOT NULL DEFAULT 1,
    langgraph_thread_mode TEXT,
    langgraph_thread_id TEXT,
    langgraph_timeout_seconds INTEGER,
    once_fired INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    last_run TEXT,
    last_status TEXT,
    run_count INTEGER,
    extra_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
, org_id TEXT, owner_scope_id TEXT, created_by TEXT);

CREATE TABLE IF NOT EXISTS "evoflow_channel_bindings" (
            channel_key TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL DEFAULT '',
            user_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS "evoflow_channel_configs" (
    platform TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    platform_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evoflow_channel_push_log (
            id TEXT PRIMARY KEY,
            direction TEXT NOT NULL,
            channel TEXT NOT NULL DEFAULT 'feishu',
            kind TEXT NOT NULL DEFAULT '',
            event TEXT NOT NULL DEFAULT '',
            transport TEXT NOT NULL DEFAULT '',
            approval_id TEXT NOT NULL DEFAULT '',
            task_id TEXT NOT NULL DEFAULT '',
            initiative_id TEXT NOT NULL DEFAULT '',
            role_agent_code TEXT NOT NULL DEFAULT '',
            receive_id TEXT NOT NULL DEFAULT '',
            receive_id_type TEXT NOT NULL DEFAULT '',
            sender_account_id TEXT NOT NULL DEFAULT '',
            external_message_id TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            content_summary TEXT NOT NULL DEFAULT '',
            payload_json TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'ok',
            error TEXT NOT NULL DEFAULT '',
            triggered_by TEXT NOT NULL DEFAULT 'system',
            created_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS "evoflow_chat_live_runs" (
            session_key TEXT PRIMARY KEY,
            thread_id TEXT,
            run_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            partial_text TEXT NOT NULL DEFAULT '',
            partial_tools_json TEXT NOT NULL DEFAULT '[]',
            last_event_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        , display_segments_json TEXT NOT NULL DEFAULT '[]');

CREATE TABLE IF NOT EXISTS evoflow_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            message_id TEXT,
            content_json TEXT NOT NULL DEFAULT '{}',
            tool_call_id TEXT,
            tool_name TEXT,
            run_id TEXT,
            thread_id TEXT,
            parent_thread_id TEXT,
            model_name TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            total_tokens INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cache_miss_tokens INTEGER, round_id TEXT,
            UNIQUE(session_key, seq)
        );

CREATE TABLE IF NOT EXISTS evoflow_chat_pending_inject (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            message_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            content_json TEXT NOT NULL DEFAULT '{}',
            tool_name TEXT,
            run_id TEXT,
            thread_id TEXT,
            created_at TEXT NOT NULL,
            consumed_at TEXT,
            consumed_by_run_id TEXT,
            UNIQUE(session_key, message_id)
        );

CREATE TABLE IF NOT EXISTS "evoflow_chat_sessions" (
            session_key TEXT PRIMARY KEY,
            thread_id TEXT,
            title TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            message_count INTEGER NOT NULL DEFAULT 0,
            context_json TEXT NOT NULL DEFAULT '{}',
            is_deleted INTEGER NOT NULL DEFAULT 0,
            local_workspace_root TEXT,
            use_virtual_paths INTEGER NOT NULL DEFAULT 0,
            model_name TEXT,
            primary_model_name TEXT,
            session_mode TEXT,
            thinking_enabled INTEGER,
            reasoning_effort TEXT,
            is_plan_mode INTEGER,
            subagent_enabled INTEGER,
            include_search INTEGER,
            memory_enabled INTEGER,
            use_claude_code_chat INTEGER,
            collab_phase TEXT,
            collab_task_id TEXT,
            agent_id TEXT,
            session_status TEXT NOT NULL DEFAULT 'active'
        , run_status TEXT NOT NULL DEFAULT 'idle', current_run_id TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0, pin_order INTEGER NOT NULL DEFAULT 0, tool_approval_policy TEXT, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cache_miss_tokens INTEGER NOT NULL DEFAULT 0, current_turn_started_at TEXT, current_turn_ended_at TEXT, active_tools_json TEXT NOT NULL DEFAULT '[]', pending_tools_json TEXT NOT NULL DEFAULT '[]', hidden_from_list INTEGER NOT NULL DEFAULT 0, permission_preset TEXT, org_id TEXT, scope_id TEXT, created_by TEXT);

CREATE TABLE IF NOT EXISTS evoflow_chat_shares (
            token TEXT PRIMARY KEY,
            session_key TEXT NOT NULL,
            title TEXT,
            snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            revoked_at TEXT,
            include_tools INTEGER NOT NULL DEFAULT 0
        , created_by TEXT);

CREATE TABLE IF NOT EXISTS "evoflow_chat_stream_mirror" (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key   TEXT NOT NULL,
            thread_id     TEXT NOT NULL,
            run_id        TEXT NOT NULL,
            seq           INTEGER NOT NULL,
            raw_frame     TEXT NOT NULL,
            is_terminal   INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL,
            UNIQUE(session_key, run_id, seq)
        );

CREATE TABLE IF NOT EXISTS "evoflow_chat_stream_mirror_meta" (
            session_key      TEXT PRIMARY KEY,
            thread_id        TEXT NOT NULL,
            run_id           TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            unavailable_json TEXT,
            expires_at       TEXT,
            frame_count      INTEGER NOT NULL DEFAULT 0,
            byte_count       INTEGER NOT NULL DEFAULT 0
        , last_persisted_seq INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS evoflow_collab_peer_messages (
            message_id TEXT NOT NULL PRIMARY KEY,
            main_task_id TEXT NOT NULL,
            thread_key TEXT NOT NULL,
            from_party TEXT NOT NULL,
            to_subtask_id TEXT NOT NULL,
            direction TEXT NOT NULL DEFAULT 'question',
            body TEXT NOT NULL,
            in_reply_to TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            visibility_json TEXT NOT NULL DEFAULT '[]',
            wake_scheduled INTEGER NOT NULL DEFAULT 0,
            wake_round_id TEXT,
            created_at TEXT NOT NULL,
            answered_at TEXT,
            expires_at TEXT,
            extra_json TEXT NOT NULL DEFAULT '{}'
        );

CREATE TABLE IF NOT EXISTS evoflow_collab_subtask_deps (
    main_task_id TEXT NOT NULL,
    parent_task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL,
    depends_on_subtask_id TEXT NOT NULL,
    link_kind TEXT NOT NULL DEFAULT 'dependency',
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (main_task_id, parent_task_id, subtask_id, depends_on_subtask_id, link_kind)
);

CREATE TABLE IF NOT EXISTS evoflow_collab_subtask_expected_outputs (
    main_task_id TEXT NOT NULL,
    parent_task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL,
    output_path TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (main_task_id, parent_task_id, subtask_id, sort_order)
);

CREATE TABLE IF NOT EXISTS evoflow_collab_subtask_skills (
    main_task_id TEXT NOT NULL,
    parent_task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL,
    item_value TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (main_task_id, parent_task_id, subtask_id, sort_order)
);

CREATE TABLE IF NOT EXISTS evoflow_collab_subtask_tools (
    main_task_id TEXT NOT NULL,
    parent_task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL,
    item_value TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (main_task_id, parent_task_id, subtask_id, sort_order)
);

CREATE TABLE IF NOT EXISTS evoflow_collab_subtasks (
    main_task_id TEXT NOT NULL,
    parent_task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    parent_id TEXT,
    assigned_to TEXT,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    completed_at TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    execution_authorized INTEGER NOT NULL DEFAULT 0,
    thread_id TEXT,
    authorized_at TEXT,
    authorized_by TEXT,
    project_path TEXT,
    claude_session_id TEXT,
    external_session_id TEXT,
    updated_at TEXT,
    result_json TEXT,
    extra_json TEXT NOT NULL DEFAULT '{}',
    worker_base_subagent TEXT,
    worker_model TEXT,
    worker_instruction TEXT,
    worker_validation TEXT,
    worker_max_retries INTEGER NOT NULL DEFAULT 3,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (main_task_id, parent_task_id, subtask_id)
);

CREATE TABLE IF NOT EXISTS evoflow_collab_task_deps (
    main_task_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    depends_on_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (main_task_id, task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS evoflow_collab_task_execution_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    main_task_id TEXT NOT NULL,
    parent_task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    event_json TEXT NOT NULL
, updated_at TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS evoflow_collab_tasks (
    main_task_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    parent_id TEXT,
    assigned_to TEXT,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    completed_at TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    execution_authorized INTEGER NOT NULL DEFAULT 0,
    thread_id TEXT,
    authorized_at TEXT,
    authorized_by TEXT,
    result_json TEXT,
    extra_json TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '', plan_goal TEXT NOT NULL DEFAULT '', plan_flowchart_mermaid TEXT NOT NULL DEFAULT '', plan_validation_json TEXT NOT NULL DEFAULT '[]', plan_open_questions TEXT NOT NULL DEFAULT '', plan_steps_json TEXT NOT NULL DEFAULT '[]', plan_bound_at TEXT NOT NULL DEFAULT '', org_id TEXT, owner_scope_id TEXT, created_by TEXT,
    PRIMARY KEY (main_task_id, task_id)
);

CREATE TABLE IF NOT EXISTS evoflow_evolution_proposals (
            id TEXT PRIMARY KEY,
            agent_code TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            field TEXT NOT NULL DEFAULT 'soul_md',
            title TEXT NOT NULL DEFAULT '',
            rationale TEXT NOT NULL DEFAULT '',
            patch_json TEXT NOT NULL DEFAULT '{}',
            evidence_json TEXT NOT NULL DEFAULT '[]',
            source TEXT NOT NULL DEFAULT 'dream',
            created_at TEXT NOT NULL,
            resolved_at TEXT NOT NULL DEFAULT '',
            resolved_by TEXT NOT NULL DEFAULT ''
        );

CREATE TABLE IF NOT EXISTS evoflow_experience_entries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    tags_json TEXT NOT NULL DEFAULT '[]',
    context_json TEXT NOT NULL DEFAULT '{}',
    steps_json TEXT NOT NULL DEFAULT '[]',
    source_sessions_json TEXT NOT NULL DEFAULT '[]',
    related_ids_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 1.0,
    use_count INTEGER NOT NULL DEFAULT 1,
    superseded_by TEXT,
    deprecated INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evoflow_exploration_edges (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id           TEXT NOT NULL,
            external_id         TEXT NOT NULL,
            from_external_id    TEXT NOT NULL,
            to_external_id      TEXT NOT NULL,
            rel                 TEXT NOT NULL DEFAULT 'depends',
            label               TEXT NOT NULL DEFAULT '',
            status              TEXT NOT NULL DEFAULT 'active',
            source_tool_call_id TEXT NOT NULL DEFAULT '',
            graph_version       INTEGER NOT NULL DEFAULT 0,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            UNIQUE(thread_id, external_id)
        );

CREATE TABLE IF NOT EXISTS evoflow_exploration_graph (
            thread_id           TEXT PRIMARY KEY,
            session_key         TEXT,
            graph_version       INTEGER NOT NULL DEFAULT 0,
            active_turn_id      TEXT NOT NULL DEFAULT '',
            node_count          INTEGER NOT NULL DEFAULT 0,
            edge_count          INTEGER NOT NULL DEFAULT 0,
            render_summary      TEXT NOT NULL DEFAULT '',
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL
        , goal TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS evoflow_exploration_nodes (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id           TEXT NOT NULL,
            external_id         TEXT NOT NULL,
            kind                TEXT NOT NULL DEFAULT 'note',
            parent_external_id  TEXT,
            title               TEXT NOT NULL DEFAULT '',
            body                TEXT NOT NULL DEFAULT '',
            status              TEXT NOT NULL DEFAULT 'active',
            refs_json           TEXT NOT NULL DEFAULT '[]',
            meta_json           TEXT NOT NULL DEFAULT '{}',
            source_tool         TEXT NOT NULL DEFAULT '',
            source_tool_call_id TEXT NOT NULL DEFAULT '',
            turn_id             TEXT NOT NULL DEFAULT '',
            sort_order          INTEGER NOT NULL DEFAULT 0,
            graph_version       INTEGER NOT NULL DEFAULT 0,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            UNIQUE(thread_id, external_id)
        );

CREATE TABLE IF NOT EXISTS evoflow_exploration_ops (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id           TEXT NOT NULL,
            scope_thread_id     TEXT NOT NULL,
            graph_version       INTEGER NOT NULL,
            turn_id             TEXT NOT NULL DEFAULT '',
            run_id              TEXT,
            tool_name           TEXT NOT NULL DEFAULT '',
            tool_call_id        TEXT NOT NULL DEFAULT '',
            op_index            INTEGER NOT NULL DEFAULT 0,
            op                  TEXT NOT NULL,
            target_external_id  TEXT NOT NULL DEFAULT '',
            payload_json        TEXT NOT NULL DEFAULT '{}',
            apply_status        TEXT NOT NULL DEFAULT 'ok',
            error_message       TEXT NOT NULL DEFAULT '',
            created_at          TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_goal_sessions (
            session_key TEXT NOT NULL PRIMARY KEY,
            user_id TEXT NOT NULL DEFAULT '',
            goal_session_id TEXT NOT NULL DEFAULT '',
            prompt TEXT NOT NULL DEFAULT '',
            max_steps INTEGER NOT NULL DEFAULT 8,
            step_delay_ms INTEGER NOT NULL DEFAULT 1200,
            retry_limit INTEGER NOT NULL DEFAULT 2,
            auto_stop_minutes INTEGER NOT NULL DEFAULT 0,
            persona_style TEXT NOT NULL DEFAULT 'professional',
            initiative INTEGER NOT NULL DEFAULT 70,
            emotional_intelligence INTEGER NOT NULL DEFAULT 1,
            feishu_push_on_complete INTEGER NOT NULL DEFAULT 1,
            continuous_learning INTEGER NOT NULL DEFAULT 0,
            use_evolution_skill INTEGER NOT NULL DEFAULT 0,
            goal_status TEXT NOT NULL DEFAULT 'active',
            goal_revision INTEGER NOT NULL DEFAULT 1,
            continuation_suppressed INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'idle',
            step_count INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 0,
            last_run_at INTEGER NOT NULL DEFAULT 0,
            last_run_id TEXT NOT NULL DEFAULT '',
            last_error TEXT NOT NULL DEFAULT '',
            pending_feedback INTEGER NOT NULL DEFAULT 0,
            feedback_prompt TEXT NOT NULL DEFAULT '',
            error_count INTEGER NOT NULL DEFAULT 0,
            ended_at INTEGER NOT NULL DEFAULT 0,
            start_time INTEGER NOT NULL DEFAULT 0,
            locked_chat_model TEXT NOT NULL DEFAULT '',
            channel_type TEXT NOT NULL DEFAULT 'web',
            system_prompt TEXT NOT NULL DEFAULT '',
            compaction_summary TEXT NOT NULL DEFAULT '',
            goal_summary TEXT NOT NULL DEFAULT '',
            completion_outcome TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        , push_channel TEXT NOT NULL DEFAULT '', push_target_id TEXT NOT NULL DEFAULT '', interpreter_fallback_streak INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS evoflow_groups (
            org_id TEXT NOT NULL,
            group_id TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'project',
            created_by TEXT NOT NULL,
            created_at REAL NOT NULL,
            attrs_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (org_id, group_id)
        );

CREATE TABLE IF NOT EXISTS evoflow_kb_chunk (
            chunk_id     TEXT PRIMARY KEY,
            dataset_id   TEXT NOT NULL,
            file_id      TEXT NOT NULL,
            seq          INTEGER NOT NULL DEFAULT 0,
            content      TEXT NOT NULL,
            token_count  INTEGER NOT NULL DEFAULT 0,
            char_start   INTEGER NOT NULL DEFAULT 0,
            char_end     INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            FOREIGN KEY (dataset_id) REFERENCES evoflow_kb_dataset(dataset_id) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES evoflow_kb_source_file(file_id) ON DELETE CASCADE
        );

CREATE TABLE IF NOT EXISTS evoflow_kb_dataset (
            dataset_id    TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            embedding_model TEXT NOT NULL DEFAULT '',
            embedding_dim INTEGER NOT NULL DEFAULT 1536,
            description   TEXT NOT NULL DEFAULT '',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

CREATE TABLE IF NOT EXISTS evoflow_kb_folder (
            folder_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            parent_id TEXT,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            FOREIGN KEY (dataset_id) REFERENCES evoflow_kb_dataset(dataset_id) ON DELETE CASCADE
        );

CREATE TABLE IF NOT EXISTS evoflow_kb_source_file (
            file_id      TEXT PRIMARY KEY,
            dataset_id   TEXT NOT NULL,
            path         TEXT NOT NULL,
            name         TEXT NOT NULL DEFAULT '',
            content_hash TEXT NOT NULL DEFAULT '',
            size_bytes   INTEGER NOT NULL DEFAULT 0,
            chunk_count  INTEGER NOT NULL DEFAULT 0,
            status       TEXT NOT NULL DEFAULT 'pending',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), folder_id TEXT, summary_text TEXT NOT NULL DEFAULT '', summary_index TEXT NOT NULL DEFAULT '', relative_path TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (dataset_id) REFERENCES evoflow_kb_dataset(dataset_id) ON DELETE CASCADE
        );

CREATE TABLE IF NOT EXISTS evoflow_license_issued_codes (
                id TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                code_fp TEXT NOT NULL,
                issued_to TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                machine_id TEXT NOT NULL DEFAULT '',
                expires_at TEXT NOT NULL DEFAULT '',
                expires_at_unix INTEGER NOT NULL DEFAULT 0,
                issued_at TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                revoked_at TEXT NOT NULL DEFAULT ''
            );

CREATE TABLE IF NOT EXISTS "evoflow_mcp_servers" (
    name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    type TEXT NOT NULL DEFAULT 'stdio',
    command TEXT,
    url TEXT,
    description TEXT NOT NULL DEFAULT '',
    args_json TEXT NOT NULL DEFAULT '[]',
    env_json TEXT NOT NULL DEFAULT '{}',
    headers_json TEXT NOT NULL DEFAULT '{}',
    oauth_json TEXT NOT NULL DEFAULT '{}',
    extra_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evoflow_media_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT,
            tool_name TEXT NOT NULL,
            media_kind TEXT NOT NULL,
            provider TEXT,
            task_id TEXT,
            status TEXT NOT NULL DEFAULT 'processing',
            remote_url TEXT,
            local_path TEXT,
            file_size_bytes INTEGER,
            meta_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_meeting_turns (
                turn_id       TEXT PRIMARY KEY,
                meeting_id    TEXT NOT NULL,
                topic         TEXT NOT NULL DEFAULT '',
                speaker_order TEXT NOT NULL DEFAULT '[]',
                status        TEXT NOT NULL DEFAULT 'pending',
                created_at    TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (meeting_id) REFERENCES evoflow_meetings(meeting_id)
            );

CREATE TABLE IF NOT EXISTS evoflow_meetings (
                meeting_id   TEXT PRIMARY KEY,
                session_key  TEXT NOT NULL DEFAULT '',
                title        TEXT NOT NULL DEFAULT '',
                participants TEXT NOT NULL DEFAULT '[]',
                status       TEXT NOT NULL DEFAULT 'active',
                created_at   TEXT NOT NULL DEFAULT '',
                updated_at   TEXT NOT NULL DEFAULT ''
            , conclusion_json TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS "evoflow_memory" (
            agent_key TEXT PRIMARY KEY,
            version TEXT NOT NULL DEFAULT '1.0',
            last_updated TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_memory_facts (
    agent_key TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    extra_json TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (agent_key, fact_id)
);

CREATE TABLE IF NOT EXISTS evoflow_memory_sections (
    agent_key TEXT NOT NULL,
    section_group TEXT NOT NULL,
    section_kind TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    section_updated_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (agent_key, section_group, section_kind)
);

CREATE TABLE IF NOT EXISTS "evoflow_mission_nodes" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL,
            snapshot_version INTEGER NOT NULL,
            turn_id TEXT NOT NULL DEFAULT '',
            parent_id INTEGER,
            kind TEXT NOT NULL,
            external_id TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            priority INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            evidence TEXT NOT NULL DEFAULT '',
            suggested_tools_json TEXT NOT NULL DEFAULT '[]',
            objective_confidence REAL NOT NULL DEFAULT 0,
            intent_hint TEXT NOT NULL DEFAULT '',
            change_type TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (parent_id) REFERENCES "evoflow_mission_nodes"(id)
        );

CREATE TABLE IF NOT EXISTS "evoflow_mission_retries" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'incremental',
            turn_id TEXT NOT NULL DEFAULT '',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '',
            messages_json TEXT NOT NULL DEFAULT '[]',
            ts TEXT NOT NULL DEFAULT '',
            next_run_at TEXT NOT NULL
        , updated_at TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS evoflow_mission_runtime (
    thread_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'bootstrap',
    drift_count INTEGER NOT NULL DEFAULT 0,
    chat_downgrade_streak INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "evoflow_mission_state" (
            thread_id TEXT PRIMARY KEY,
            wrapper_version INTEGER NOT NULL DEFAULT 1,
            wrapper_updated_at TEXT NOT NULL DEFAULT '',
            turn_id TEXT NOT NULL DEFAULT '',
            state_ts TEXT NOT NULL DEFAULT '',
            primary_objective TEXT NOT NULL DEFAULT '',
            objective_confidence REAL NOT NULL DEFAULT 0,
            intent_hint TEXT NOT NULL DEFAULT 'chat',
            change_type TEXT NOT NULL DEFAULT 'update',
            version INTEGER NOT NULL DEFAULT 1,
            bound_plan_markdown TEXT NOT NULL DEFAULT '',
            bound_plan_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_mission_state_items (
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (thread_id, kind, sort_order)
);

CREATE TABLE IF NOT EXISTS evoflow_mission_state_scenarios (
    thread_id TEXT NOT NULL,
    scenario_key TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (thread_id, scenario_key)
);

CREATE TABLE IF NOT EXISTS evoflow_mission_subproblems (
    thread_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 3,
    evidence TEXT NOT NULL DEFAULT '',
    suggested_tools_json TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (thread_id, external_id)
);

CREATE TABLE IF NOT EXISTS evoflow_model_connections (
            key TEXT PRIMARY KEY,
            base_url TEXT NOT NULL DEFAULT '',
            api_key TEXT NOT NULL DEFAULT '',
            api_type TEXT NOT NULL DEFAULT 'openai-completions',
            display_name TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

CREATE TABLE IF NOT EXISTS "evoflow_models" (
    name TEXT PRIMARY KEY,
    vendor TEXT,
    display_name TEXT,
    description TEXT,
    use TEXT NOT NULL,
    model TEXT NOT NULL,
    base_url TEXT,
    api_key TEXT,
    request_timeout REAL,
    max_retries INTEGER,
    max_tokens INTEGER,
    temperature REAL,
    use_responses_api INTEGER,
    output_version TEXT,
    supports_thinking INTEGER NOT NULL DEFAULT 0,
    supports_reasoning_effort INTEGER NOT NULL DEFAULT 0,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    when_thinking_enabled_json TEXT NOT NULL DEFAULT '{}',
    thinking_json TEXT NOT NULL DEFAULT '{}',
    extra_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
, context_length INTEGER, input_context_length INTEGER, output_context_length INTEGER, availability_status TEXT NOT NULL DEFAULT 'available', unavailable_reason TEXT, unavailable_code TEXT, unavailable_at TEXT, plan_type TEXT DEFAULT 'none', plan_config TEXT);

CREATE TABLE IF NOT EXISTS evoflow_org_artifacts (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            org_instance_id TEXT NOT NULL,
            artifact_type   TEXT NOT NULL,
            artifact_id     TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            UNIQUE(org_instance_id, artifact_type, artifact_id)
        );

CREATE TABLE IF NOT EXISTS evoflow_org_registry (
            id              TEXT PRIMARY KEY,
            pack_id         TEXT NOT NULL,
            pack_version    TEXT NOT NULL,
            kind            TEXT NOT NULL,
            workspace_path  TEXT,
            installed_at    TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'active',
            manifest_json   TEXT
        );

CREATE TABLE IF NOT EXISTS evoflow_orgs (
            org_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            config_json TEXT NOT NULL DEFAULT '{}'
        );

CREATE TABLE IF NOT EXISTS evoflow_person_affect (
            agent_code TEXT PRIMARY KEY,
            curiosity REAL NOT NULL DEFAULT 0.5,
            confidence REAL NOT NULL DEFAULT 0.55,
            pressure REAL NOT NULL DEFAULT 0.3,
            connection REAL NOT NULL DEFAULT 0.5,
            frustration REAL NOT NULL DEFAULT 0.15,
            energy REAL NOT NULL DEFAULT 0.65,
            updated_at TEXT NOT NULL,
            meta_json TEXT NOT NULL DEFAULT '{}'
        );

CREATE TABLE IF NOT EXISTS evoflow_person_commitments (
            id TEXT PRIMARY KEY,
            from_agent TEXT NOT NULL,
            to_agent TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'handoff',
            status TEXT NOT NULL DEFAULT 'open',
            parent_task_id TEXT NOT NULL DEFAULT '',
            child_task_id TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            closed_at TEXT NOT NULL DEFAULT ''
        );

CREATE TABLE IF NOT EXISTS evoflow_person_dream_log (
            agent_code TEXT NOT NULL,
            as_of_date TEXT NOT NULL,
            summary_md TEXT NOT NULL DEFAULT '',
            meta_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            PRIMARY KEY (agent_code, as_of_date)
        );

CREATE TABLE IF NOT EXISTS evoflow_person_memory_entries (
            id TEXT PRIMARY KEY,
            agent_code TEXT NOT NULL,
            layer TEXT NOT NULL DEFAULT 'journal',
            content TEXT NOT NULL,
            importance REAL NOT NULL DEFAULT 0.5,
            vitality REAL NOT NULL DEFAULT 1.0,
            round_id TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'wrap_up',
            created_at TEXT NOT NULL
        , status TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', evidence_json TEXT NOT NULL DEFAULT '{}', hit_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '', skill_name TEXT NOT NULL DEFAULT '', access_tier TEXT NOT NULL DEFAULT 'archival', embedding_json TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS evoflow_person_relations (
            agent_code TEXT NOT NULL,
            peer_code TEXT NOT NULL,
            bond REAL NOT NULL DEFAULT 0.4,
            last_event TEXT NOT NULL DEFAULT '',
            meta_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (agent_code, peer_code)
        );

CREATE TABLE IF NOT EXISTS evoflow_person_state (
            agent_code TEXT NOT NULL,
            as_of_date TEXT NOT NULL,
            stance_md TEXT NOT NULL DEFAULT '',
            meta_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (agent_code, as_of_date)
        );

CREATE TABLE IF NOT EXISTS evoflow_plan_bindings (
            id TEXT PRIMARY KEY,
            catalog_id TEXT NOT NULL,
            vendor TEXT NOT NULL,
            plan_family TEXT NOT NULL,
            tier_id TEXT,
            api_key TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL DEFAULT '',
            bound_capabilities_json TEXT NOT NULL DEFAULT '[]',
            overrides_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'active',
            last_probe_at TEXT,
            soft_quota_json TEXT,
            linked_connection_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_principal_identities (
            org_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            PRIMARY KEY (org_id, provider, external_id)
        );

CREATE TABLE IF NOT EXISTS evoflow_principals (
            principal_id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            principal_type TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            primary_email TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            team_ids_json TEXT NOT NULL DEFAULT '[]',
            attrs_json TEXT NOT NULL DEFAULT '{}',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_proactive_approvals (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL,
    role_agent_code TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'feishu',
    feishu_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    decided_at TEXT,
    decision_comment TEXT,
    escalation_level INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, rejection_reason TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (initiative_id) REFERENCES evoflow_proactive_initiatives(id)
);

CREATE TABLE IF NOT EXISTS evoflow_proactive_cost_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role_agent_code TEXT NOT NULL,
            round_id TEXT NOT NULL DEFAULT '',
            thread_id TEXT,
            model_name TEXT NOT NULL DEFAULT '',
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0.0,
            duration_seconds REAL NOT NULL DEFAULT 0.0,
            created_at TEXT NOT NULL
        , principal_id TEXT);

CREATE TABLE IF NOT EXISTS evoflow_proactive_initiatives (
    id TEXT PRIMARY KEY,
    role_agent_code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    action_type TEXT NOT NULL DEFAULT 'analysis',
    risk_level TEXT NOT NULL DEFAULT 'low',
    action_plan_json TEXT NOT NULL DEFAULT '{}',
    expected_outcome TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'proposed',
    approval_id TEXT,
    approved_by TEXT,
    approved_at TEXT,
    approval_timeout_minutes INTEGER NOT NULL DEFAULT 30,
    execution_thread_id TEXT,
    execution_result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, round_id TEXT, goal TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '', config_autonomy_level TEXT NOT NULL DEFAULT 'approval_for_risky',
    FOREIGN KEY (role_agent_code) REFERENCES evoflow_proactive_roles(agent_code)
);

CREATE TABLE IF NOT EXISTS evoflow_proactive_memory (
    role_agent_code TEXT PRIMARY KEY,
    memory_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evoflow_proactive_roles (
    agent_code TEXT PRIMARY KEY,
    role_name TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL DEFAULT '{}',
    heartbeat_rrule TEXT NOT NULL DEFAULT 'FREQ=HOURLY;INTERVAL=2',
    status TEXT NOT NULL DEFAULT 'active',
    last_heartbeat_at TEXT,
    next_heartbeat_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
, reports_to TEXT NOT NULL DEFAULT '', position_code TEXT NOT NULL DEFAULT '', heartbeat_schedule TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS evoflow_sandbox_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            path TEXT NOT NULL DEFAULT '',
            tool_name TEXT NOT NULL DEFAULT '',
            tool_call_id TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            session_key TEXT NOT NULL DEFAULT '',
            thread_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_scope_members (
            org_id TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            joined_at REAL NOT NULL,
            PRIMARY KEY (org_id, scope_id, principal_id)
        );

CREATE TABLE IF NOT EXISTS evoflow_session_compaction (
            session_key TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            conversation_summary TEXT NOT NULL DEFAULT '',
            tool_history_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_key, thread_id)
        );

CREATE TABLE IF NOT EXISTS evoflow_session_notifications (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    session_title TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'goal_closure',
    title TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    ts_ms INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    cleared INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), created_by TEXT,
    UNIQUE(fingerprint)
);

CREATE TABLE IF NOT EXISTS evoflow_session_participants (
            session_key TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            joined_at REAL NOT NULL,
            left_at REAL,
            PRIMARY KEY (session_key, principal_id)
        );

CREATE TABLE IF NOT EXISTS evoflow_session_scenario_trajectory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            thread_id TEXT NOT NULL DEFAULT '',
            scenario_key TEXT NOT NULL DEFAULT '',
            event_type TEXT NOT NULL,
            eager_tools_json TEXT NOT NULL DEFAULT '[]',
            loaded_deferred_json TEXT NOT NULL DEFAULT '[]',
            detail_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS "evoflow_session_workspace_history" (
                session_key TEXT NOT NULL,
                workspace_id INTEGER NOT NULL,
                sort_index INTEGER NOT NULL DEFAULT 0,
                bound_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (session_key, workspace_id),
                FOREIGN KEY (workspace_id) REFERENCES evoflow_workspaces(id) ON DELETE CASCADE
            );

CREATE TABLE IF NOT EXISTS "evoflow_skills" (
    name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    skill_md TEXT,
    source_path TEXT,
    category TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evoflow_soul_changelog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_code TEXT NOT NULL,
            field TEXT NOT NULL,
            old_value TEXT NOT NULL DEFAULT '',
            new_value TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            evidence_json TEXT NOT NULL DEFAULT '[]',
            source TEXT NOT NULL DEFAULT '',
            approved_by TEXT NOT NULL DEFAULT 'system',
            created_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_task_bundles_v14 (
    main_task_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    supervisor_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evoflow_task_detail_facts (
    main_task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'finding',
    confidence REAL NOT NULL DEFAULT 0.5,
    source_message TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (main_task_id, agent_id, task_id, fact_id)
);

CREATE TABLE IF NOT EXISTS "evoflow_task_details" (
    main_task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    output_summary TEXT NOT NULL DEFAULT '',
    current_step TEXT NOT NULL DEFAULT '',
    progress INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (main_task_id, agent_id, task_id)
);

CREATE TABLE IF NOT EXISTS evoflow_task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    task_id TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS evoflow_task_global_fact_rows (
    main_task_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'finding',
    confidence REAL NOT NULL DEFAULT 0.5,
    source_message TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (main_task_id, fact_id)
);

CREATE TABLE IF NOT EXISTS "evoflow_task_global_facts" (
    main_task_id TEXT PRIMARY KEY,
    version TEXT NOT NULL DEFAULT '1.0',
    last_updated TEXT NOT NULL DEFAULT ''
, updated_at TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS "evoflow_thread_collab" (
    thread_id TEXT PRIMARY KEY,
    collab_phase TEXT NOT NULL DEFAULT 'idle',
    bound_task_id TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evoflow_thread_collab_scenarios (
    thread_id TEXT NOT NULL,
    scenario_key TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (thread_id, sort_order)
);

CREATE TABLE IF NOT EXISTS evoflow_thread_collab_sidebar_steps (
    thread_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    step_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (thread_id, sort_order)
);

CREATE TABLE IF NOT EXISTS evoflow_thread_plans (
    thread_id TEXT PRIMARY KEY,
    plan_md TEXT NOT NULL DEFAULT '',
    plan_md_stamped TEXT NOT NULL DEFAULT '',
    stamped_label TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evoflow_todos (
    session_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    todos_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_key, thread_id)
);

CREATE TABLE IF NOT EXISTS evoflow_tool_approval_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL DEFAULT '',
            tool_name TEXT NOT NULL DEFAULT '',
            args_json TEXT NOT NULL DEFAULT '{}',
            action TEXT NOT NULL,
            user_source TEXT NOT NULL DEFAULT 'ui',
            created_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_tool_approval_grants (
            session_key TEXT PRIMARY KEY,
            thread_id TEXT,
            grant_all INTEGER NOT NULL DEFAULT 0,
            signatures_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_tool_approvals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            args_json TEXT NOT NULL DEFAULT '{}',
            summary TEXT NOT NULL DEFAULT '',
            signature TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(session_key, tool_call_id)
        );

CREATE TABLE IF NOT EXISTS "evoflow_tool_groups" (
    name TEXT PRIMARY KEY,
    extra_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "evoflow_tools" (
    name TEXT PRIMARY KEY,
    group_name TEXT NOT NULL,
    use TEXT NOT NULL,
    extra_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "evoflow_usage_daily" (
                day TEXT NOT NULL,
                category TEXT NOT NULL,
                subcategory TEXT NOT NULL DEFAULT '',
                sku TEXT NOT NULL DEFAULT '',
                subject_type TEXT NOT NULL,
                subject_id TEXT NOT NULL DEFAULT '',
                principal_id TEXT NOT NULL DEFAULT '',
                quantity_sum REAL NOT NULL DEFAULT 0,
                quantity_in_sum REAL NOT NULL DEFAULT 0,
                quantity_out_sum REAL NOT NULL DEFAULT 0,
                amount_sum REAL NOT NULL DEFAULT 0,
                event_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (day, category, subcategory, sku, subject_type, subject_id, principal_id)
            );

CREATE TABLE IF NOT EXISTS evoflow_usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            occurred_at TEXT NOT NULL,
            category TEXT NOT NULL,
            subcategory TEXT NOT NULL DEFAULT '',
            unit TEXT NOT NULL,
            quantity REAL NOT NULL DEFAULT 0,
            quantity_in REAL NOT NULL DEFAULT 0,
            quantity_out REAL NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'USD',
            amount REAL NOT NULL DEFAULT 0,
            pricing_source TEXT NOT NULL DEFAULT '',
            provider TEXT NOT NULL DEFAULT '',
            sku TEXT NOT NULL DEFAULT '',
            session_key TEXT,
            thread_id TEXT,
            run_id TEXT,
            message_id TEXT,
            app_id TEXT,
            agent_code TEXT,
            workspace_id TEXT,
            subject_type TEXT NOT NULL DEFAULT 'install',
            subject_id TEXT NOT NULL DEFAULT '',
            meta_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        , principal_id TEXT);

CREATE TABLE IF NOT EXISTS evoflow_verification_rounds (
            round_id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            scenario TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'queued',
            progress INTEGER NOT NULL DEFAULT 0,
            conclusion TEXT NOT NULL DEFAULT '',
            exceptions_json TEXT NOT NULL DEFAULT '[]',
            summary_json TEXT NOT NULL DEFAULT '{}',
            config_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            updated_at TEXT NOT NULL
        );

CREATE TABLE IF NOT EXISTS evoflow_verification_steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            round_id TEXT NOT NULL,
            seq INTEGER NOT NULL DEFAULT 0,
            feature TEXT NOT NULL DEFAULT '',
            api TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            request_json TEXT NOT NULL DEFAULT '{}',
            response_json TEXT NOT NULL DEFAULT '{}',
            result TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '',
            exception TEXT NOT NULL DEFAULT '',
            duration_ms INTEGER,
            started_at TEXT,
            finished_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (round_id) REFERENCES evoflow_verification_rounds(round_id)
                ON DELETE CASCADE
        );

CREATE TABLE IF NOT EXISTS evoflow_webui_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL DEFAULT 'admin',
            password_hash TEXT NOT NULL,
            is_primary INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

CREATE TABLE IF NOT EXISTS "evoflow_workspace_global_history" (
                workspace_id INTEGER NOT NULL PRIMARY KEY,
                sort_index INTEGER NOT NULL DEFAULT 0,
                last_used_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (workspace_id) REFERENCES evoflow_workspaces(id) ON DELETE CASCADE
            );

CREATE TABLE IF NOT EXISTS "evoflow_workspaces" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT '',
                last_used_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            , org_id TEXT, owner_scope_id TEXT);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_agent ON evoflow_a2a_tasks(agent_code);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_meeting ON evoflow_a2a_tasks(meeting_id);

CREATE INDEX IF NOT EXISTS idx_audit_session ON evoflow_tool_approval_audit(session_key);

CREATE INDEX IF NOT EXISTS idx_audit_thread ON evoflow_tool_approval_audit(thread_id);

CREATE INDEX IF NOT EXISTS idx_channel_push_approval_created
            ON evoflow_channel_push_log(approval_id, created_at);

CREATE INDEX IF NOT EXISTS idx_channel_push_channel_created
            ON evoflow_channel_push_log(channel, created_at);

CREATE INDEX IF NOT EXISTS idx_channel_push_external_msg
            ON evoflow_channel_push_log(external_message_id);

CREATE INDEX IF NOT EXISTS idx_channel_push_task_created
            ON evoflow_channel_push_log(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_collab_peer_msg_main_thread
        ON evoflow_collab_peer_messages(main_task_id, thread_key, created_at);

CREATE INDEX IF NOT EXISTS idx_collab_peer_msg_to_pending
        ON evoflow_collab_peer_messages(main_task_id, to_subtask_id, status);

CREATE INDEX IF NOT EXISTS idx_eval_alert_rules_enabled
    ON eval_alert_rules(enabled, dimension);

CREATE INDEX IF NOT EXISTS idx_eval_alerts_created
    ON eval_alerts(created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_eval_alerts_run
    ON eval_alerts(run_id);

CREATE INDEX IF NOT EXISTS idx_eval_case_results_run
    ON eval_case_results(run_id, id);

CREATE INDEX IF NOT EXISTS idx_eval_cases_category
    ON eval_cases(category, enabled);

CREATE INDEX IF NOT EXISTS idx_eval_runs_created
    ON eval_runs(created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_eval_runs_status
    ON eval_runs(status, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_eval_schedules_enabled
    ON eval_schedules(enabled, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_evo_acl_grants_grantee
            ON evoflow_acl_grants(org_id, grantee_scope_id);

CREATE INDEX IF NOT EXISTS idx_evo_acl_grants_ref
            ON evoflow_acl_grants(org_id, owner_scope_id, ref);

CREATE INDEX IF NOT EXISTS idx_evo_api_tokens_identity
            ON evoflow_api_tokens(identity_type, identity_id);

CREATE INDEX IF NOT EXISTS idx_evo_app_revisions_app
    ON evoflow_app_revisions(app_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_evo_app_runs_app ON evoflow_app_runs(app_id);

CREATE INDEX IF NOT EXISTS idx_evo_app_runs_status ON evoflow_app_runs(status);

CREATE INDEX IF NOT EXISTS idx_evo_app_runs_task ON evoflow_app_runs(task_id);

CREATE INDEX IF NOT EXISTS idx_evo_apps_category ON evoflow_apps(category);

CREATE INDEX IF NOT EXISTS idx_evo_apps_name ON evoflow_apps(name);

CREATE INDEX IF NOT EXISTS idx_evo_apps_owner
                    ON evoflow_apps(owner_scope_id);

CREATE INDEX IF NOT EXISTS idx_evo_apps_status ON evoflow_apps(status);

CREATE INDEX IF NOT EXISTS idx_evo_apps_usage ON evoflow_apps(usage_count DESC);

CREATE INDEX IF NOT EXISTS idx_evo_artifacts_session_updated
            ON evoflow_artifacts(session_key, updated_at);

CREATE INDEX IF NOT EXISTS idx_evo_automation_runs_v6_task
    ON "evoflow_automation_runs"(task_id, id);

CREATE INDEX IF NOT EXISTS idx_evo_automations_owner
                ON evoflow_automations(owner_scope_id);

CREATE INDEX IF NOT EXISTS idx_evo_chat_live_runs_run ON evoflow_chat_live_runs(run_id);

CREATE INDEX IF NOT EXISTS idx_evo_chat_live_runs_thread ON evoflow_chat_live_runs(thread_id);

CREATE INDEX IF NOT EXISTS idx_evo_chat_messages_ctime
            ON evoflow_chat_messages(created_at);

CREATE INDEX IF NOT EXISTS idx_evo_chat_messages_parent_thread
            ON evoflow_chat_messages(parent_thread_id);

CREATE INDEX IF NOT EXISTS idx_evo_chat_messages_session_msg_id
            ON evoflow_chat_messages(session_key, message_id);

CREATE INDEX IF NOT EXISTS idx_evo_chat_messages_session_round
            ON evoflow_chat_messages(session_key, round_id);

CREATE INDEX IF NOT EXISTS idx_evo_chat_messages_session_seq
            ON evoflow_chat_messages(session_key, seq);

CREATE INDEX IF NOT EXISTS idx_evo_chat_messages_session_thread
            ON evoflow_chat_messages(session_key, thread_id);

CREATE INDEX IF NOT EXISTS idx_evo_chat_messages_thread_seq
            ON evoflow_chat_messages(thread_id, seq);

CREATE INDEX IF NOT EXISTS idx_evo_chat_messages_tool_call
            ON evoflow_chat_messages(session_key, tool_call_id);

CREATE INDEX IF NOT EXISTS idx_evo_chat_sessions_created_by
                ON evoflow_chat_sessions(created_by)
                WHERE is_deleted = 0;

CREATE INDEX IF NOT EXISTS idx_evo_chat_sessions_hidden_from_list
        ON evoflow_chat_sessions(hidden_from_list, updated_at)
        WHERE is_deleted = 0 AND COALESCE(hidden_from_list, 0) != 0;

CREATE INDEX IF NOT EXISTS idx_evo_chat_sessions_model ON evoflow_chat_sessions(model_name);

CREATE INDEX IF NOT EXISTS idx_evo_chat_sessions_pinned
        ON evoflow_chat_sessions(is_pinned, pin_order, updated_at)
        WHERE is_deleted = 0 AND COALESCE(is_pinned, 0) != 0;

CREATE INDEX IF NOT EXISTS idx_evo_chat_sessions_prewarmed
        ON evoflow_chat_sessions(agent_id, session_status)
        WHERE is_deleted = 0 AND session_status = 'prewarmed';

CREATE INDEX IF NOT EXISTS idx_evo_chat_sessions_run_status
        ON evoflow_chat_sessions(run_status)
        WHERE is_deleted = 0 AND run_status IN ('running', 'pending');

CREATE INDEX IF NOT EXISTS idx_evo_chat_sessions_scope
                ON evoflow_chat_sessions(org_id, scope_id)
                WHERE is_deleted = 0;

CREATE INDEX IF NOT EXISTS idx_evo_chat_sessions_thread ON evoflow_chat_sessions(thread_id);

CREATE INDEX IF NOT EXISTS idx_evo_chat_sessions_updated ON evoflow_chat_sessions(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_evo_chat_sessions_workspace ON evoflow_chat_sessions(local_workspace_root);

CREATE INDEX IF NOT EXISTS idx_evo_chat_shares_session
            ON evoflow_chat_shares(session_key, created_at);

CREATE INDEX IF NOT EXISTS idx_evo_chat_stream_mirror_run
            ON evoflow_chat_stream_mirror(session_key, run_id, seq);

CREATE INDEX IF NOT EXISTS idx_evo_collab_exec_hist_main
    ON evoflow_collab_task_execution_history(main_task_id, parent_task_id, subtask_id);

CREATE INDEX IF NOT EXISTS idx_evo_collab_subtasks_main ON evoflow_collab_subtasks(main_task_id);

CREATE INDEX IF NOT EXISTS idx_evo_collab_tasks_main ON evoflow_collab_tasks(main_task_id);

CREATE INDEX IF NOT EXISTS idx_evo_exploration_edges_thread_from
            ON evoflow_exploration_edges(thread_id, from_external_id);

CREATE INDEX IF NOT EXISTS idx_evo_exploration_edges_thread_to
            ON evoflow_exploration_edges(thread_id, to_external_id);

CREATE INDEX IF NOT EXISTS idx_evo_exploration_graph_session
            ON evoflow_exploration_graph(session_key);

CREATE INDEX IF NOT EXISTS idx_evo_exploration_nodes_thread_kind
            ON evoflow_exploration_nodes(thread_id, kind);

CREATE INDEX IF NOT EXISTS idx_evo_exploration_nodes_thread_parent
            ON evoflow_exploration_nodes(thread_id, parent_external_id);

CREATE INDEX IF NOT EXISTS idx_evo_exploration_nodes_thread_status
            ON evoflow_exploration_nodes(thread_id, status);

CREATE INDEX IF NOT EXISTS idx_evo_exploration_ops_thread_ver
            ON evoflow_exploration_ops(thread_id, graph_version);

CREATE INDEX IF NOT EXISTS idx_evo_exploration_ops_tool_call
            ON evoflow_exploration_ops(tool_call_id);

CREATE INDEX IF NOT EXISTS idx_evo_kb_chunk_dataset ON evoflow_kb_chunk(dataset_id);

CREATE INDEX IF NOT EXISTS idx_evo_kb_chunk_file ON evoflow_kb_chunk(file_id, seq);

CREATE INDEX IF NOT EXISTS idx_evo_kb_dataset_name ON evoflow_kb_dataset(name);

CREATE INDEX IF NOT EXISTS idx_evo_kb_folder_dataset ON evoflow_kb_folder(dataset_id, parent_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_evo_kb_source_file_dataset ON evoflow_kb_source_file(dataset_id);

CREATE INDEX IF NOT EXISTS idx_evo_kb_source_file_hash ON evoflow_kb_source_file(content_hash);

CREATE INDEX IF NOT EXISTS idx_evo_media_assets_kind
            ON evoflow_media_assets(media_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_evo_media_assets_task
            ON evoflow_media_assets(provider, task_id);

CREATE INDEX IF NOT EXISTS idx_evo_media_assets_thread
            ON evoflow_media_assets(thread_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_evo_mission_nodes_parent ON evoflow_mission_nodes(thread_id, parent_id);

CREATE INDEX IF NOT EXISTS idx_evo_mission_nodes_thread_ver ON evoflow_mission_nodes(thread_id, snapshot_version);

CREATE INDEX IF NOT EXISTS idx_evo_mission_retry_due ON evoflow_mission_retries(next_run_at);

CREATE INDEX IF NOT EXISTS idx_evo_model_connections_updated ON evoflow_model_connections(updated_at);

CREATE INDEX IF NOT EXISTS idx_evo_pending_inject_created
            ON evoflow_chat_pending_inject(created_at);

CREATE INDEX IF NOT EXISTS idx_evo_pending_inject_session_unconsumed
            ON evoflow_chat_pending_inject(session_key, consumed_at)
            WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_evo_plan_bindings_status
            ON evoflow_plan_bindings(status);

CREATE INDEX IF NOT EXISTS idx_evo_plan_bindings_vendor_family
            ON evoflow_plan_bindings(vendor, plan_family);

CREATE INDEX IF NOT EXISTS idx_evo_principal_identities_uid
            ON evoflow_principal_identities(principal_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evo_principals_email
            ON evoflow_principals(org_id, primary_email)
            WHERE primary_email IS NOT NULL AND primary_email != '';

CREATE INDEX IF NOT EXISTS idx_evo_principals_org
            ON evoflow_principals(org_id, status);

CREATE INDEX IF NOT EXISTS idx_evo_proactive_cost_principal
                ON evoflow_proactive_cost_log(principal_id);

CREATE INDEX IF NOT EXISTS idx_evo_proposals_agent_status ON evoflow_evolution_proposals(agent_code, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_evo_scope_members_principal
            ON evoflow_scope_members(org_id, principal_id);

CREATE INDEX IF NOT EXISTS idx_evo_session_compaction_thread
            ON evoflow_session_compaction(thread_id);

CREATE INDEX IF NOT EXISTS idx_evo_session_notifications_fp
    ON evoflow_session_notifications(fingerprint);

CREATE INDEX IF NOT EXISTS idx_evo_session_notifications_read
    ON evoflow_session_notifications(cleared, read, ts_ms DESC);

CREATE INDEX IF NOT EXISTS idx_evo_session_notifications_session
    ON evoflow_session_notifications(session_key, cleared, ts_ms DESC);

CREATE INDEX IF NOT EXISTS idx_evo_session_notifications_visible
    ON evoflow_session_notifications(cleared, ts_ms DESC);

CREATE INDEX IF NOT EXISTS idx_evo_session_participants_uid
            ON evoflow_session_participants(principal_id);

CREATE INDEX IF NOT EXISTS idx_evo_task_events_type_task
    ON evoflow_task_events(event_type, task_id, id);

CREATE INDEX IF NOT EXISTS idx_evo_thread_collab_bound_task
            ON evoflow_thread_collab(bound_task_id)
            WHERE bound_task_id IS NOT NULL AND TRIM(bound_task_id) != '';

CREATE INDEX IF NOT EXISTS idx_evo_tool_approval_grants_thread
            ON evoflow_tool_approval_grants(thread_id);

CREATE INDEX IF NOT EXISTS idx_evo_tool_approvals_session_status
            ON evoflow_tool_approvals(session_key, status);

CREATE INDEX IF NOT EXISTS idx_evo_tool_approvals_thread_status
            ON evoflow_tool_approvals(thread_id, status);

CREATE INDEX IF NOT EXISTS idx_evo_usage_daily_principal
                ON evoflow_usage_daily(day, principal_id);

CREATE INDEX IF NOT EXISTS idx_evo_usage_events_principal
                ON evoflow_usage_events(principal_id);

CREATE INDEX IF NOT EXISTS idx_evo_verification_rounds_status
            ON evoflow_verification_rounds(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_evo_verification_steps_round
            ON evoflow_verification_steps(round_id, seq, id);

CREATE INDEX IF NOT EXISTS idx_evoflow_workspaces_last_used ON evoflow_workspaces(last_used_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evoflow_workspaces_path_norm ON evoflow_workspaces(LOWER(RTRIM(REPLACE(workspace_path, '\', '/'), '/')));

CREATE INDEX IF NOT EXISTS idx_exp_cat ON evoflow_experience_entries(category);

CREATE INDEX IF NOT EXISTS idx_exp_conf ON evoflow_experience_entries(confidence DESC);

CREATE INDEX IF NOT EXISTS idx_exp_title ON evoflow_experience_entries(title);

CREATE INDEX IF NOT EXISTS idx_exp_used ON evoflow_experience_entries(last_used_at DESC);

CREATE INDEX IF NOT EXISTS idx_goal_sessions_goal_status
        ON evoflow_goal_sessions(goal_status, enabled, updated_at);

CREATE INDEX IF NOT EXISTS idx_goal_sessions_user_enabled
        ON evoflow_goal_sessions(user_id, enabled, updated_at);

CREATE INDEX IF NOT EXISTS idx_license_issued_at
                ON evoflow_license_issued_codes(issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_license_issued_fp
                ON evoflow_license_issued_codes(code_fp);

CREATE INDEX IF NOT EXISTS idx_license_issued_status
                ON evoflow_license_issued_codes(status);

CREATE INDEX IF NOT EXISTS idx_org_artifacts_instance ON evoflow_org_artifacts(org_instance_id);

CREATE INDEX IF NOT EXISTS idx_org_registry_pack ON evoflow_org_registry(pack_id, status);

CREATE INDEX IF NOT EXISTS idx_person_commit_child ON evoflow_person_commitments(child_task_id);

CREATE INDEX IF NOT EXISTS idx_person_commit_open ON evoflow_person_commitments(to_agent, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_person_mem_agent_created ON evoflow_person_memory_entries(agent_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_person_mem_agent_layer ON evoflow_person_memory_entries(agent_code, layer, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_person_mem_craft ON evoflow_person_memory_entries(agent_code, layer, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_person_mem_tier ON evoflow_person_memory_entries(agent_code, access_tier, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proactive_approval_status
    ON evoflow_proactive_approvals(status, created_at);

CREATE INDEX IF NOT EXISTS idx_proactive_approval_task
            ON evoflow_proactive_approvals(task_id);

CREATE INDEX IF NOT EXISTS idx_proactive_cost_role_date
            ON evoflow_proactive_cost_log(role_agent_code, created_at);

CREATE INDEX IF NOT EXISTS idx_proactive_cost_round
            ON evoflow_proactive_cost_log(round_id);

CREATE INDEX IF NOT EXISTS idx_proactive_init_role_status
    ON evoflow_proactive_initiatives(role_agent_code, status, created_at);

CREATE INDEX IF NOT EXISTS idx_proactive_roles_position ON evoflow_proactive_roles(position_code) WHERE position_code != '';

CREATE INDEX IF NOT EXISTS idx_proactive_roles_reports_to
            ON evoflow_proactive_roles(reports_to);

CREATE INDEX IF NOT EXISTS idx_sandbox_audit_event ON evoflow_sandbox_audit(event_type);

CREATE INDEX IF NOT EXISTS idx_sandbox_audit_session ON evoflow_sandbox_audit(session_key);

CREATE INDEX IF NOT EXISTS idx_sandbox_audit_thread ON evoflow_sandbox_audit(thread_id);

CREATE INDEX IF NOT EXISTS idx_session_ws_hist_key_sort ON evoflow_session_workspace_history(session_key, sort_index);

CREATE INDEX IF NOT EXISTS idx_soul_changelog_agent_created ON evoflow_soul_changelog(agent_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trajectory_session
            ON evoflow_session_scenario_trajectory(session_key, id DESC);

CREATE INDEX IF NOT EXISTS idx_trajectory_session_scenario
            ON evoflow_session_scenario_trajectory(session_key, scenario_key, id DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_agent
            ON evoflow_usage_events(agent_code, occurred_at);

CREATE INDEX IF NOT EXISTS idx_usage_events_app
            ON evoflow_usage_events(app_id);

CREATE INDEX IF NOT EXISTS idx_usage_events_category_occurred
            ON evoflow_usage_events(category, occurred_at);

CREATE INDEX IF NOT EXISTS idx_usage_events_occurred
            ON evoflow_usage_events(occurred_at);

CREATE INDEX IF NOT EXISTS idx_usage_events_session
            ON evoflow_usage_events(session_key, occurred_at);

CREATE INDEX IF NOT EXISTS idx_usage_events_sku_occurred
            ON evoflow_usage_events(sku, occurred_at);

CREATE INDEX IF NOT EXISTS idx_usage_events_thread
            ON evoflow_usage_events(thread_id);

CREATE INDEX IF NOT EXISTS idx_webui_users_primary
        ON evoflow_webui_users(is_primary);

CREATE INDEX IF NOT EXISTS idx_workspace_global_hist_sort ON evoflow_workspace_global_history(sort_index);
"""


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (name,),
    ).fetchone()
    return row is not None


def _apply_baseline(conn: sqlite3.Connection) -> None:
    conn.executescript(_BASELINE_DDL)
    conn.execute(f"PRAGMA user_version = {APP_SCHEMA_VERSION}")
    conn.commit()


def _snap_legacy_user_version(conn: sqlite3.Connection, version: int) -> int:
    """Map pre-1.0 ladder versions onto the public epoch."""
    if version <= APP_SCHEMA_VERSION:
        return version
    if version > _LEGACY_SCHEMA_VERSION_MAX:
        logger.warning(
            "Unexpected PRAGMA user_version=%s (above legacy max %s); leaving as-is",
            version,
            _LEGACY_SCHEMA_VERSION_MAX,
        )
        return version
    markers = (
        "evoflow_proactive_initiatives",
        "evoflow_chat_messages",
        "evoflow_usage_events",
        "evoflow_principals",
    )
    if any(_table_exists(conn, t) for t in markers):
        logger.info(
            "Snapping legacy PRAGMA user_version %s -> %s (public 1.0.0 schema epoch)",
            version,
            APP_SCHEMA_VERSION,
        )
        conn.execute(f"PRAGMA user_version = {APP_SCHEMA_VERSION}")
        conn.commit()
        return APP_SCHEMA_VERSION
    logger.warning(
        "Legacy user_version=%s without expected tables; applying baseline idempotently",
        version,
    )
    _apply_baseline(conn)
    return APP_SCHEMA_VERSION


def ensure_app_schema(conn: sqlite3.Connection) -> None:
    """Ensure ``evoflow.db`` matches the public baseline schema."""
    version = int(conn.execute("PRAGMA user_version").fetchone()[0] or 0)
    if version == 0:
        _apply_baseline(conn)
        return
    if version > APP_SCHEMA_VERSION:
        _snap_legacy_user_version(conn, version)
        # After snap, physical schema should already match; avoid re-executing
        # the full baseline on every connection open.
        if int(conn.execute("PRAGMA user_version").fetchone()[0] or 0) == APP_SCHEMA_VERSION:
            return
        _apply_baseline(conn)
        return
    # version == APP_SCHEMA_VERSION: already current.
    return


def ensure_chat_messages_thread_index(conn: sqlite3.Connection) -> None:
    """Compatibility shim: index is part of baseline DDL."""
    if not _table_exists(conn, "evoflow_chat_messages"):
        return
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_evo_chat_messages_thread_seq "
        "ON evoflow_chat_messages(thread_id, seq)"
    )
    conn.commit()


_ensure_chat_messages_thread_index = ensure_chat_messages_thread_index
