"""部门群聊回复镜像：员工工作会话的回复 → 群时间线。

【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】

背景（实测）：绕开前端直连网关让 20 个岗位真实发言，全部成功生成回复、各自工作
会话 +1 条，但群时间线 `dept:<id>:chat` 新增 **0 条**。根因是「把回复贴进群时间线」
这一步只由前端 `HomeDeptGroupChat.persistMsg` 完成。前端断线/关页面/刷新 → 回复不上墙。

本模块把这一步下沉到后端：TranscriptMiddleware 每轮把 AI 回复写进员工 sticky 工作会话
时（唯一收口点），若该会话上下文带 ``dept_group_timeline_session``，就同时以该员工身份
往群时间线 append 一条气泡。

与 ``dept_group_receipt.py`` 的区别：那个只报「后台 run 终态」，本模块报「每一轮回复」。

幂等与「不多出第二条气泡」（两条路都只有 1 条）：
- **前端在场**：前端开跑前已把一条 ``agent-{code}-{ts}`` 的 streaming 占位行写进群时间线。
  镜像扫到同发言人（且 work_session_key 一致）的占位行 → **用它的 id 原地定稿**。
  前端随后 finalize 同一 id，走 upsert 覆盖，群里始终 1 条。
- **前端不在场**：查不到占位行 → 用确定性键
  ``dept-reply-{sha1(session_key|run_id|turn_key)[:20]}`` 自己 append；
  同一轮重试 N 次键相同 → 群里还是 1 条。

开关：``EVOFLOW_DEPT_GROUP_REPLY_MIRROR=0`` 可关（默认开）。关闭时行为与改造前
逐字节一致——中间件那段只剩一次环境变量读取。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

_ENV_FLAG = "EVOFLOW_DEPT_GROUP_REPLY_MIRROR"

# 镜像自己的 id 前缀（前端占位行 id 形如 agent-{code}-{ts}）。
# 注意：这不是「互不覆盖」，而是「两边不能写成两条」——前端在场时镜像会
# 接管前端占位行的 id 原地定稿（见 _adopt_frontend_placeholder），只有前端
# 不在场（查不到占位行）才用本前缀自己 append。
MIRROR_ID_PREFIX = "dept-reply-"

# 接管前端占位行的时效窗口：与前端 ``STREAMING_STALE_MS``（15 分钟）同口径。
# 超过这个时间仍停在 streaming 的行是「前端跑到一半被杀掉」的残留，不能接管。
_PLACEHOLDER_ADOPT_WINDOW_S = 15 * 60


def mirror_enabled() -> bool:
    """开关：**默认开启**（功能要生效），置 0/false/off/no 可关。

    为什么默认开而不是关：关掉等于「回复照样不上墙」，用户要的正是这一步。
    重复气泡的风险已由两道闸兜住——写入侧接管前端占位行（同 id 覆盖），
    读取侧 ``dedupeMirroredReplies`` 兜底；两边都有单测与现网复算。
    需要回滚时设 ``EVOFLOW_DEPT_GROUP_REPLY_MIRROR=0`` 即可，行为退化为改造前。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    """
    raw = (os.environ.get(_ENV_FLAG) or "").strip().lower()
    if raw in ("0", "false", "off", "no"):
        return False
    return True


def build_mirror_message_id(
    *,
    session_key: str,
    run_id: str = "",
    turn_key: str = "",
) -> str:
    """确定性幂等键：同一条回复无论重写几次都得到同一个 id。

    三个输入任一变化（不同会话 / 不同 run / 不同轮次）→ 不同 id，
    从而既做到「重试不重复」，又不会把不同轮次误合并成一条。
    """
    basis = "|".join(
        [
            str(session_key or "").strip(),
            str(run_id or "").strip(),
            str(turn_key or "").strip(),
        ]
    )
    digest = hashlib.sha1(basis.encode("utf-8", "ignore")).hexdigest()[:20]
    return f"{MIRROR_ID_PREFIX}{digest}"


def _load_session_ctx(session_key: str) -> dict[str, Any]:
    """读原始 context_json（扁平视图会丢 dept_group_* 键）。"""
    from evoflow.persistence.db import get_db

    row = get_db().execute(
        "SELECT context_json FROM evoflow_chat_sessions WHERE session_key = ? AND is_deleted = 0",
        (str(session_key or "").strip(),),
    ).fetchone()
    if not row or not str(row[0] or "").strip():
        return {}
    try:
        parsed = json.loads(str(row[0]))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def normalize_reply_text(content: Any) -> str:
    """正文归一：AIMessage 的 content 可能是 list[block]，直接 str() 会把
    列表字面量写进群（``[{'type': 'text', ...}]``）。这里只取文本块。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                t = p.get("text") or p.get("content")
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts).strip()
    if isinstance(content, dict):
        t = content.get("text") or content.get("content")
        return t.strip() if isinstance(t, str) else ""
    return ""


def _speaker_name_for(agent_code: str, ctx_agent_name: Any = None) -> str:
    """群里显示名：**岗位花名优先**，上下文里的 ``agent_name`` 只作兜底。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    为什么不能直接用会话上下文里的 ``agent_name``：现网实测该字段是 ``"main"``
    （主智能体的名字），不是岗位花名。镜像照抄的结果是同一个岗位在群里出现两个名字
    ——前端气泡写「新粉引导Bot」，后端镜像行写「main」。同一个人在群里两个名字，
    观众一眼就看出来是两个人。

    真源是 ``ProactiveRepository.get_role(code).role_name``（与
    ``engine._role_name_for_agent`` / ``task_assignee._role_name_for`` 同一口径）。
    查不到才退回上下文值，再退回 agent_code——绝不因为查库失败而丢掉整条气泡。
    """
    code = str(agent_code or "").strip()
    if code:
        try:
            from evoflow.proactive.repositories import ProactiveRepository

            role = ProactiveRepository.get_role(code)
            name = str(getattr(role, "role_name", "") or "").strip()
            if name:
                return name
        except Exception:
            logger.debug("dept reply mirror: role name lookup failed code=%s", code, exc_info=True)
    fallback = str(ctx_agent_name or "").strip()
    # "main" 是主对话的占位名，显示出来比不显示更糟
    if fallback and fallback.lower() not in ("main", "lead_agent"):
        return fallback
    return code


def _is_fresh_placeholder(created_at: Any) -> bool:
    """占位行是否仍在「这一轮」的时效内。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    为什么必须有时效窗口：现网实测里存在**几天前的前端占位行**永不定稿
    （前端跑到一半被关掉/刷新，`turn_state` 永远停在 streaming）。没有窗口时，
    后端镜像会去接管那条陈旧行 → 新回复的内容被写进旧气泡，群里既看不到新消息、
    旧消息又被篡改。窗口取 15 分钟，与前端 `STREAMING_STALE_MS` 同口径：
    超过这个时间的 streaming 在前端眼里本来就已是 stale/error。
    """
    import datetime as _dt

    raw = str(created_at or "").strip()
    if not raw:
        # 拿不到时间就不冒风险接管，宁可自己 append 一条新的
        return False
    try:
        iso = raw.replace("Z", "+00:00")
        dt = _dt.datetime.fromisoformat(iso)
    except Exception:
        return False
    now_aware = _dt.datetime.now().astimezone()
    local_tz = now_aware.tzinfo
    if dt.tzinfo is not None:
        try:
            age = (now_aware - dt).total_seconds()
        except Exception:
            return False
        return 0 <= age <= _PLACEHOLDER_ADOPT_WINDOW_S
    # 裸时间串有歧义：现网实测**两种写法同时存在**——绝大多数行是带 +08:00 的
    # ISO，但前端经 API 落下的占位行出现过来自 ``datetime.now()`` 的本地串，
    # 也出现过 UTC 裸串（例：``2026-11-20 00:12:00`` 实为本地 08:12）。
    # 只按本地解释会把刚写下 19 秒的行判成 8 小时前 → 拒绝接管 → 群里两条气泡。
    # 判据取两种解释的**较年轻者**：只要任一解释落在窗口内就算新，
    # 真正的陈旧行（几天前）两种解释都超窗，仍然不会被接管。
    # 注意：naive 与 aware 不能相减（TypeError），两侧都补上 tzinfo 再算。
    candidates = [
        (now_aware - dt.replace(tzinfo=local_tz)).total_seconds(),
        (now_aware - dt.replace(tzinfo=_dt.UTC)).total_seconds(),
    ]
    return any(0 <= age <= _PLACEHOLDER_ADOPT_WINDOW_S for age in candidates)


def _adopt_frontend_placeholder(
    group_sk: str, *, speaker_code: str, work_session_key: str
) -> str:
    """前端在场时群里已有一条同发言人的 streaming 占位行（id ``agent-*``）。

    直接接管它（用它的 message_id 写定稿）→ 群里始终只有一条气泡；
    前端随后自己 finalize 同一个 id，走 upsert 覆盖，不会多出第二条。
    前端不在场（关页面/断线/占位行已陈旧）时查不到可用占位行 → 返回 ""，
    由镜像自己 append。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    """
    if not group_sk or not speaker_code:
        return ""
    try:
        from evoflow.persistence.db import get_db

        rows = get_db().execute(
            "SELECT message_id, content_json, created_at FROM evoflow_chat_messages "
            "WHERE session_key = ? AND turn_state = 'streaming' "
            "ORDER BY seq DESC LIMIT 20",
            (group_sk,),
        ).fetchall()
    except Exception:
        logger.debug("dept reply mirror: placeholder scan failed g=%s", group_sk, exc_info=True)
        return ""
    for row in rows:
        try:
            mid = str(row[0] or "").strip()
        except Exception:
            continue
        if not mid or mid.startswith(MIRROR_ID_PREFIX):
            continue
        # 陈旧占位行不接管（否则新回复会写进几天前的旧气泡）
        if not _is_fresh_placeholder(row[2] if len(row) > 2 else None):
            continue
        try:
            payload = json.loads(str(row[1] or "{}"))
        except Exception:
            continue
        dg = payload.get("dept_group") if isinstance(payload, dict) else None
        if not isinstance(dg, dict):
            continue
        if str(dg.get("speaker_code") or "").strip() != speaker_code:
            continue
        wsk = str(dg.get("work_session_key") or "").strip()
        if wsk and work_session_key and wsk != work_session_key:
            continue
        return mid
    return ""


def mirror_reply_to_dept_group(
    *,
    session_key: str,
    content: Any,
    run_id: str = "",
    turn_key: str = "",
    message_id: str = "",
) -> bool:
    """把一条员工回复镜像进所属部门群时间线。

    ``session_key`` 必须是**员工工作会话**（``proactive:{code}:chat:dept-{id}``），
    其上下文里带 ``dept_group_timeline_session`` 才会镜像。

    任何异常都静默降级——镜像失败绝不能拖垮正常的会话落库。
    """
    if not mirror_enabled():
        return False
    text = normalize_reply_text(content)
    if not text:
        return False
    sk = str(session_key or "").strip()
    if not sk:
        return False
    # 群时间线会话自身不镜像（否则自我循环）
    if sk.startswith("dept:") and sk.endswith(":chat"):
        return False
    # 快路径：只有员工群工作会话（``proactive:{code}:chat:dept-{id}``）才可能有群键。
    # 不加这条，每个普通 1:1 会话每轮都要多读一次 context_json。
    if ":dept-" not in sk:
        return False

    try:
        ctx = _load_session_ctx(sk)
    except Exception:
        logger.debug("dept reply mirror: session ctx read failed sk=%s", sk, exc_info=True)
        return False
    if not ctx:
        return False

    group_sk = str(ctx.get("dept_group_timeline_session") or "").strip()
    if not group_sk:
        return False
    agent_code = str(ctx.get("proactive_agent_code") or "").strip()
    agent_name = _speaker_name_for(agent_code, ctx.get("agent_name"))
    dept_id = str(ctx.get("dept_group_id") or "").strip()
    dept_name = str(ctx.get("dept_group_name") or "").strip()

    mid = str(message_id or "").strip()
    if not mid:
        # 前端在场：接管它已写下的 streaming 占位行 → 群里只有一条气泡。
        # 前端不在场：占位行不存在，用确定性幂等键自己 append。
        mid = _adopt_frontend_placeholder(
            group_sk, speaker_code=agent_code, work_session_key=sk
        )
    if not mid:
        mid = build_mirror_message_id(session_key=sk, run_id=run_id, turn_key=turn_key)

    meta: dict[str, Any] = {
        "dept_id": dept_id,
        "dept_name": dept_name or None,
        "msg_kind": "agent" if agent_code else "system",
        "speaker_code": agent_code or None,
        "speaker_name": agent_name or None,
        "stream_state": "final",
        # 显式标记来源，便于验证与排障，也供前端做去重判断
        "origin": "backend_mirror",
        "mirror_source_session": sk,
    }
    content_json = {"content": text, "dept_group": meta}

    try:
        from evoflow.persistence import chat_session_service as chat_svc

        chat_svc.upsert_message_and_touch_session(
            group_sk,
            role="assistant",
            message_id=mid,
            content=text,
            content_json=content_json,
            turn_state="final",
        )
        logger.info(
            "dept reply mirrored group=%s from=%s mid=%s", group_sk, sk, mid
        )
        return True
    except Exception:
        logger.warning(
            "dept reply mirror append failed group=%s src=%s", group_sk, sk, exc_info=True
        )
        return False
