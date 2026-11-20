"""Computer Use top-indicator state — aligned with ZCode windowsCuaOperationIndicator.

ZCode lifecycle (docs/cua/2026-09-14-windows-cua-indicator-repair-spec.md):

- **Start**: first real CUA cell begins executing (tool-started / setupComputerUseRuntime).
- **Stay on**: same turn, more CUA cells → refresh; do **not** hide when a cell ends.
- **End**:
  1. turn / session explicitly cleared, or
  2. ``AUTO_HIDE_MS`` (30s) after the last CUA activity with no new cell, or
  3. app quit / force clear.

EvoFlow mapping (LangGraph has no CLI sideband):

- node_repl CUA cell **start** → ``pulse_cua_glow_start``
- node_repl CUA cell **end** → ``pulse_cua_glow_end`` (keeps indicator for 30s grace;
  long-running cell stays on via ``_RUNNING`` until the cell returns)
- user stop / RUN_ERROR → ``clear_cua_glow``
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

# ZCode AUTO_HIDE_MS
AUTO_HIDE_MS = 30_000.0

# 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
# 用户反馈：「只看到一圈蓝光/一条提示，但不知道 AI 现在做到哪一步，也不知道怎么解除控制。」
# 原来快照只有 active/running/keys，前端只能显示固定文案「正在操作电脑」。
# 这里加 step 相关字段：由调用方把「当前动作摘要」推进来，前端原样显示。
# 边界：只加字段，不改既有语义（active/running/grace/keys 全部保持原样），
# 老调用方不传 step 时行为零变化。
_STEP = {"label": "", "seq": 0, "started_at_ms": 0.0, "done": 0}
# 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
# 用户问「时长有吗？这个可以加时长吗」。
# 原来只有单步 elapsed（step_elapsed_ms），而且前端一次都没取用。
# 这里再加「这一轮总共操作了多久」= 本轮从第一次 active 到现在的时长。
# 边界：active 变 false 就归零；新一轮由 reset_cua_glow_steps 清零 ——
# 否则用户下次看到的是上一轮的累计时长，比没有更误导。
_ACTIVE_SINCE_MS = 0.0
# 收工后冻结的累计时长（毫秒）。grace 期间不再增长，避免「已停止但秒数还在跳」。
_ELAPSED_FROZEN_MS = 0.0
# 【self-evolution-bot · 2026-11-19 · 第68轮】正在操作电脑的会话标识（供「解除控制」用）
# 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】缺陷修正：
# 只给 thread_id 不够。thread_id 是 LangGraph 的 UUID（如 ae5615a4-…），
# 而前端停止链路 chatAbort / POST /chat/sessions/<sk>/execution/stop 要的是
# session_key（如 agent:main:new-0093fe5b）。两者格式完全不同 ——
# 前端拿 thread_id 当 sessionKey 去停，会停不掉任何东西（用户点了没反应）。
# 所以这里同时存 session_key，前端优先用它。
_THREAD_ID = {"value": "", "session_key": ""}

# 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
# 用户明确纠正（原话）：「这个停止只是停止电脑控制，并不是停止AI啊。
# 只是电脑控制这个插件，当前是取消电脑控制了」。
#
# 所以「解除控制」= **只收回电脑操作权**，绝不能调 stopSessionExecution
# （那是掐整个 LangGraph run，AI 这一轮的回答会被硬切断 —— 我上一轮接错了）。
#
# 实现边界（都踩过才知道）：
#   ① 不能直接调宿主的 `stop_computer_control`：它的 KillSwitch 是**永久 latch**，
#      `ensureRunning()` 会抛 "Computer control was stopped (...). Start a new session
#      to continue."，且没有公开的 resume 接口 —— 点了以后这个会话永远不能再碰电脑。
#   ② 收回要能被模型看见：下一轮 CUA 调用要在工具返回里拿到明确文案，
#      否则模型只会反复重试到超时，用户看到「卡住」。
#   ③ 必须能自动恢复：用户下一条消息 = 重新授权。判据用 transcript 的 seq 水位
#      （新用户消息一定会推高 max_seq），不靠时间窗猜。
_CONTROL = {"revoked": False, "session_key": "", "max_seq": 0, "reason": ""}

_LOCK = threading.Lock()
# Keys of CUA cells currently inside ``_run`` (covers cells longer than 30s).
_RUNNING: set[str] = set()
# After the last running cell ends, stay visible until this monotonic deadline.
_GRACE_UNTIL_MS = 0.0
_UPDATED_AT = 0.0


def _now_ms() -> float:
    """单调时钟（毫秒）。**跨进程可比较**：Windows 上 monotonic 基于开机计时，
    两个 python 进程读到的原点相同（实测 785581718 vs 785581781，差 63ms = 启动开销）。
    所以可以把「起点/截止点」直接落盘给另一个进程用。"""
    return time.monotonic() * 1000.0


# ============================================================================
# 跨进程共享状态（2026-11-19 · 第73轮）
#
# 【self-evolution-bot · 2026-11-19 · 第73轮 · 模型:deepseek-v4.1-flash-1017】
# 真实缺陷（本轮现网取证，这是「没有蓝光」的第 2 个、也是更深的原因）：
#
#   面板同时拉起**两个 python 进程**：
#     · `--mode langgraph --langgraph-port 8384`  ← agent 真在这里跑，CUA cell
#       也在这里执行 ⇒ `pulse_cua_glow_start()` 写的是**这个进程的内存**
#     · `--mode gateway --port 8382`              ← 前端轮询
#       `GET /api/cua/glow-status` 打到这里 ⇒ 读的是**另一个进程的内存**
#
# 而 `cua_glow_state` 原来是一组纯进程内全局变量（`_RUNNING`/`_GRACE_UNTIL_MS`…），
# 两边各有一份、互不可见 ⇒ 前端永远读到 active=false。
#
# 现网数字（今日 plugin-control.log）：
#   · 后端 [py] 写入 `emit request_active=True` 186 次（真实 CUA，tool_call_id=call_xxx）
#   · 前端 [web] 读到 `poll active=true`   只有 7 次，且 keys 全是我 curl 打的探针
#     （`verify-71` / `PROBE-FWD-9001`）—— 一次都没读到真实的 call_xxx。
#   注：我 curl POST 8382 再 GET 8382 是能读到的，所以不是接口 bug，
#   而是写方和读方不在同一进程。
#
# 修法：以**文件为唯一事实来源**。每次读写都在锁内 sync/persist，
# 两个进程通过同一个文件交换状态。文件位置由 `EVOFLOW_HOME` 决定，
# 实测两进程的 EVOFLOW_HOME 都是 `C:\Users\admin\.evoflow\profiles\default`。
# ============================================================================
_STATE_ENV = "EVOFLOW_CUA_GLOW_STATE_FILE"

# 上一次成功同步的文件身份 (path, mtime_ns)；相同则跳过重复解析（前端 500ms 轮询）。
_LAST_LOAD: dict[str, Any] = {"key": None}
# 上一次落盘的源文本，内容没变就不重复写盘。
_LAST_SAVED: dict[str, Any] = {"text": None}


def _state_file() -> Path:
    """共享状态文件路径。

    【self-evolution-bot · 2026-11-19 · 第73轮】三种来源，优先级从高到低：
      ① `EVOFLOW_CUA_GLOW_STATE_FILE` —— 显式覆盖（演练/多实例）
      ② pytest 运行中 → 进程私有的临时文件。**必须隔离**：
         现有 5 个测试文件都是直接调 `clear_cua_glow()` / `pulse_*` 开头的，
         若走真实路径，跑一次单测就会把用户正在跑的 CUA 提示条清掉。
      ③ 正式路径 `<EVOFLOW_HOME>/data/app/cua_glow_state.json`
    """
    override = (os.getenv(_STATE_ENV) or "").strip()
    if override:
        return Path(override)
    if (os.getenv("PYTEST_CURRENT_TEST") or "").strip():
        import tempfile

        return Path(tempfile.gettempdir()) / f"evoflow-cua-glow-test-{os.getpid()}.json"
    from evoflow.config.paths import get_paths

    return get_paths().base_dir / "data" / "app" / "cua_glow_state.json"


def _boot_marker() -> float:
    """开机标识：`wall - monotonic`。同一趟开机内恒定，重启后跳变。

    【self-evolution-bot · 2026-11-19 · 第73轮】为什么需要它：
    落盘的是 **monotonic 毫秒**（因为只有它跨进程同源）。但机器重启后
    monotonic 从 0 重算，文件里的旧值会变成「几小时后的未来时间」，
    提示条就会一直亮着不消失。载入时比对开机标识，不一致即丢弃。
    """
    return round(time.time() - time.monotonic(), 0)


def _sync_locked() -> None:
    """从共享文件刷新模块全局量（调用方必须已持有 ``_LOCK``）。"""
    global _GRACE_UNTIL_MS, _ACTIVE_SINCE_MS, _ELAPSED_FROZEN_MS, _UPDATED_AT
    path = _state_file()
    try:
        stat = path.stat()
        key: Any = (str(path), stat.st_mtime_ns)
    except OSError:
        key = (str(path), None)
    if _LAST_LOAD["key"] == key:
        return
    data: dict[str, Any] | None = None
    try:
        with open(path, encoding="utf-8") as f:
            loaded = json.load(f)
        data = loaded if isinstance(loaded, dict) else None
    except (OSError, ValueError):
        data = None
    _LAST_LOAD["key"] = key
    if data is None:
        return
    # 跨开机：monotonic 已重算，文件里的时间戳全部作废。
    try:
        if abs(float(data.get("boot") or 0.0) - _boot_marker()) > 5.0:
            return
    except (TypeError, ValueError):
        return
    try:
        _RUNNING.clear()
        _RUNNING.update(str(x) for x in (data.get("running") or []) if str(x).strip())
        _GRACE_UNTIL_MS = float(data.get("grace_until_ms") or 0.0)
        _ACTIVE_SINCE_MS = float(data.get("active_since_ms") or 0.0)
        _ELAPSED_FROZEN_MS = float(data.get("elapsed_frozen_ms") or 0.0)
        _UPDATED_AT = float(data.get("updated_at_ms") or 0.0)
        step = data.get("step") or {}
        if isinstance(step, dict):
            _STEP["label"] = str(step.get("label") or "")
            _STEP["seq"] = int(step.get("seq") or 0)
            _STEP["done"] = int(step.get("done") or 0)
            _STEP["started_at_ms"] = float(step.get("started_at_ms") or 0.0)
        thread = data.get("thread") or {}
        if isinstance(thread, dict):
            _THREAD_ID["value"] = str(thread.get("value") or "")
            _THREAD_ID["session_key"] = str(thread.get("session_key") or "")
        control = data.get("control") or {}
        if isinstance(control, dict):
            _CONTROL["revoked"] = bool(control.get("revoked"))
            _CONTROL["session_key"] = str(control.get("session_key") or "")
            _CONTROL["max_seq"] = int(control.get("max_seq") or 0)
            _CONTROL["reason"] = str(control.get("reason") or "")
    except (TypeError, ValueError):
        # 文件被外部写坏：保持内存原状，下一轮再来。
        return


def _persist_locked() -> None:
    """把当前内存状态原子写到共享文件（调用方必须已持有 ``_LOCK``）。"""
    try:
        payload = {
            "v": 1,
            "boot": _boot_marker(),
            "running": sorted(_RUNNING),
            "grace_until_ms": _GRACE_UNTIL_MS,
            "active_since_ms": _ACTIVE_SINCE_MS,
            "elapsed_frozen_ms": _ELAPSED_FROZEN_MS,
            "updated_at_ms": _UPDATED_AT,
            "step": dict(_STEP),
            "thread": dict(_THREAD_ID),
            "control": dict(_CONTROL),
        }
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return
    if text == _LAST_SAVED["text"]:
        return
    path = _state_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # 唯一 tmp 名 + os.replace：两个进程同时写也不会互相截断。
        tmp = path.with_name(f"{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(tmp, path)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
        _LAST_SAVED["text"] = text
        try:
            _LAST_LOAD["key"] = (str(path), path.stat().st_mtime_ns)
        except OSError:
            _LAST_LOAD["key"] = None
    except OSError:
        # 落盘失败不能拦住 CUA 主路径：内存态仍然可用（单进程场景照常工作）。
        pass


def _snapshot_locked(now: float) -> dict[str, Any]:
    global _GRACE_UNTIL_MS, _ACTIVE_SINCE_MS, _ELAPSED_FROZEN_MS
    active = bool(_RUNNING) or now < _GRACE_UNTIL_MS
    if not active:
        # 提示条真正熄灭才冻表：grace 间隙里秒数必须继续走，
        # 否则用户看到的就是「秒数一直不动」（cell 之间大部分时间都在 grace）。
        if _ACTIVE_SINCE_MS:
            _ELAPSED_FROZEN_MS = max(0.0, now - _ACTIVE_SINCE_MS)
            _ACTIVE_SINCE_MS = 0.0
        if _GRACE_UNTIL_MS:
            _GRACE_UNTIL_MS = 0.0
    step_label = str(_STEP["label"] or "")
    # 本轮累计：提示条还亮着（running 或 grace）就现算；熄灭后用冻结值。
    elapsed_ms = (
        max(0, int(now - _ACTIVE_SINCE_MS)) if _ACTIVE_SINCE_MS
        else int(_ELAPSED_FROZEN_MS)
    )
    return {
        "active": active,
        "running": len(_RUNNING),
        "grace_ms_left": max(0, int(_GRACE_UNTIL_MS - now)) if not _RUNNING else None,
        "keys": sorted(_RUNNING),
        "updated_at_ms": _UPDATED_AT,
        "auto_hide_ms": int(AUTO_HIDE_MS),
        # 【self-evolution-bot · 2026-11-19 · 第68轮】进度：前端直接显示，无需再推算。
        "step": step_label,
        "step_seq": int(_STEP["seq"]),
        "steps_done": int(_STEP["done"]),
        "step_elapsed_ms": (
            max(0, int(now - _STEP["started_at_ms"])) if step_label and _STEP["started_at_ms"] else 0
        ),
        # 【self-evolution-bot · 2026-11-19 · 第72轮】本轮累计已操作时长（毫秒）。
        "elapsed_ms": elapsed_ms,
        # 【self-evolution-bot · 2026-11-19 · 第68轮】正在被控制的会话，前端「解除控制」原样带回。
        "thread_id": str(_THREAD_ID["value"] or ""),
        # 前端真正要用的：chatAbort / execution/stop 只认 session_key。
        "session_key": str(_THREAD_ID["session_key"] or ""),
        # 【self-evolution-bot · 2026-11-19 · 第72轮】电脑操作权是否已被用户收回。
        # 前端据此把按钮文案改成「已解除」，而不是继续调停止会话的接口。
        "control_revoked": bool(_CONTROL["revoked"]),
        "control_reason": str(_CONTROL["reason"] or ""),
    }


def set_cua_glow_thread(thread_id: str, session_key: str = "") -> dict[str, Any]:
    """记下正在操作电脑的会话 id（供提示条的「解除控制」精确停对会话）。

    【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
    session_key 才是前端停止链路认的键；thread_id 仅作诊断字段保留。
    """
    global _UPDATED_AT
    tid = str(thread_id or "").strip()
    sk = str(session_key or "").strip()
    now = _now_ms()
    with _LOCK:
        _sync_locked()
        if tid:
            _THREAD_ID["value"] = tid
        if sk:
            _THREAD_ID["session_key"] = sk
        _UPDATED_AT = now
        _persist_locked()
        return _snapshot_locked(now)


# 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么单独一个函数而不是复用 pulse_cua_glow_start：
#   pulse_start 会重置 grace 且语义是「一个 cell 开跑」；而「这一轮做到第几步」是另一个维度 ——
#   同一个 cell 内部可能连续推进多步，且步骤不该让提示条反复隐藏/重亮。
#   steps_done 只增不减（本轮累计），新一轮由 reset_cua_glow_steps 清零。
def set_cua_glow_step(label: str, *, key: str = "") -> dict[str, Any]:
    """推进「当前正在做什么」的进度文案（供顶部提示条显示）。"""
    global _UPDATED_AT
    text = str(label or "").strip()
    now = _now_ms()
    with _LOCK:
        _sync_locked()
        if text:
            if text != _STEP["label"]:
                _STEP["seq"] = int(_STEP["seq"]) + 1
                _STEP["done"] = int(_STEP["done"]) + 1
                _STEP["label"] = text
                _STEP["started_at_ms"] = now
        else:
            _STEP["label"] = ""
            _STEP["started_at_ms"] = 0.0
        _UPDATED_AT = now
        _persist_locked()
        return _snapshot_locked(now)


def _reset_steps_locked() -> None:
    """锁内清零步数。clear / revoke / 新一轮起表共用，避免步骤跨会话累加。"""
    _STEP["label"] = ""
    _STEP["seq"] = 0
    _STEP["done"] = 0
    _STEP["started_at_ms"] = 0.0


def reset_cua_glow_steps() -> dict[str, Any]:
    """新一轮开始 / 用户解除控制：清零步骤计数。"""
    global _UPDATED_AT
    now = _now_ms()
    with _LOCK:
        _sync_locked()
        _reset_steps_locked()
        _UPDATED_AT = now
        _persist_locked()
        return _snapshot_locked(now)


def pulse_cua_glow_start(*, key: str = "") -> dict[str, Any]:
    """CUA cell started executing — show indicator (ZCode tool-started)."""
    global _UPDATED_AT, _GRACE_UNTIL_MS, _ACTIVE_SINCE_MS, _ELAPSED_FROZEN_MS
    kid = str(key or "").strip() or "default"
    now = _now_ms()
    with _LOCK:
        _sync_locked()
        was_idle = not _RUNNING
        # 同一轮 vs 新一轮：grace 还在，或秒表锚点还在（grace 期间不再冻表）。
        same_round = now < _GRACE_UNTIL_MS or bool(_ACTIVE_SINCE_MS)
        _RUNNING.add(kid)
        if was_idle:
            if same_round and _ACTIVE_SINCE_MS:
                # grace 间隙里秒表一直在走，锚点保留即可。
                pass
            elif same_round and _ELAPSED_FROZEN_MS > 0:
                _ACTIVE_SINCE_MS = now - _ELAPSED_FROZEN_MS
            else:
                # 真正的新一轮：秒表归零，步数也必须归零。
                _ACTIVE_SINCE_MS = now
                _ELAPSED_FROZEN_MS = 0.0
                _reset_steps_locked()
        # Running cell owns visibility; grace is for the gap after it ends.
        _GRACE_UNTIL_MS = 0.0
        _UPDATED_AT = now
        _persist_locked()
        return _snapshot_locked(now)


def pulse_cua_glow_end(*, key: str = "") -> dict[str, Any]:
    """CUA cell finished — do not hard-hide; start/refresh 30s grace (ZCode)."""
    global _UPDATED_AT, _GRACE_UNTIL_MS, _ACTIVE_SINCE_MS, _ELAPSED_FROZEN_MS
    kid = str(key or "").strip() or "default"
    now = _now_ms()
    with _LOCK:
        _sync_locked()
        _RUNNING.discard(kid)
        if not _RUNNING:
            # grace 期间秒表继续走（_ACTIVE_SINCE_MS 不清）：胶囊面上的秒数才不会冻住。
            # 真正熄灭时由 _snapshot_locked 冻结。
            _GRACE_UNTIL_MS = now + AUTO_HIDE_MS
        _UPDATED_AT = now
        _persist_locked()
        return _snapshot_locked(now)


def clear_cua_glow() -> dict[str, Any]:
    """Force hide (turn error / user stop / session closed)."""
    global _UPDATED_AT, _GRACE_UNTIL_MS, _ACTIVE_SINCE_MS, _ELAPSED_FROZEN_MS
    now = _now_ms()
    with _LOCK:
        _sync_locked()
        _RUNNING.clear()
        _GRACE_UNTIL_MS = 0.0
        # 【self-evolution-bot · 2026-11-19 · 第72轮】强制清场 → 秒表归零。
        # 用户点了「解除控制」还看到「已操作 2 分 13 秒」，等于告诉他控制没停。
        _ACTIVE_SINCE_MS = 0.0
        _ELAPSED_FROZEN_MS = 0.0
        # 步数一并清零：否则下次亮起仍显示上一轮累计的「第 N 步」。
        _reset_steps_locked()
        _UPDATED_AT = now
        _persist_locked()
        return _snapshot_locked(now)


def set_cua_glow(*, active: bool, key: str = "") -> dict[str, Any]:
    """Compat wrapper used by HTTP + older callers."""
    if active:
        return pulse_cua_glow_start(key=key)
    raw = str(key or "").strip()
    if not raw:
        return clear_cua_glow()
    return pulse_cua_glow_end(key=raw)


def revoke_cua_control(*, session_key: str = "", reason: str = "user_revoked") -> dict[str, Any]:
    """用户点「解除控制」：只收回**电脑操作权**，不动 AI 回合。

    【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
    用户明确纠正：这个按钮是「取消电脑控制」，不是「停止 AI」。
    所以这里只做三件事：置收回标记、记下当前 transcript 水位、把提示条收掉。
    **不 cancel run、不改 run_status** —— AI 该继续回答就继续回答。
    """
    global _UPDATED_AT
    now = _now_ms()
    sk = str(session_key or "").strip()
    with _LOCK:
        _sync_locked()
        _CONTROL["revoked"] = True
        _CONTROL["reason"] = str(reason or "user_revoked")
        if sk:
            _CONTROL["session_key"] = sk
        _CONTROL["max_seq"] = _current_max_seq(sk or _CONTROL["session_key"])
        # 提示条与蓝光环立刻收掉：用户点了就得有反馈。
        _RUNNING.clear()
        _GRACE_UNTIL_MS = 0.0
        _ACTIVE_SINCE_MS = 0.0
        _ELAPSED_FROZEN_MS = 0.0
        # 步数清零：解除后再开控制应从第 1 步起，不能接着上一轮。
        _reset_steps_locked()
        _UPDATED_AT = now
        _persist_locked()
        return _snapshot_locked(now)


def restore_cua_control(*, session_key: str = "", reason: str = "user_resend") -> dict[str, Any]:
    """重新授权电脑操作（用户发了新消息）。

    判据用 transcript 的 max_seq 水位：新用户消息一定推高 seq，
    比时间窗猜更可靠（用户可能 3 秒后重发，也可能 3 小时后）。
    """
    global _UPDATED_AT
    now = _now_ms()
    sk = str(session_key or "").strip() or _CONTROL["session_key"]
    with _LOCK:
        _sync_locked()
        _CONTROL["revoked"] = False
        _CONTROL["reason"] = str(reason or "user_resend")
        _CONTROL["max_seq"] = 0
        if sk:
            _CONTROL["session_key"] = sk
        _UPDATED_AT = now
        _persist_locked()
        return _snapshot_locked(now)


def is_cua_control_revoked(*, session_key: str = "") -> bool:
    """电脑操作权是否已被用户收回。

    自动恢复：撤回后只要出现**更新**的用户消息（max_seq 变高）就视为重新授权 ——
    用户发新消息等于说「你继续做」。这让「解除控制」不会变成一次性废掉整个会话。
    """
    global _CONTROL
    sk = str(session_key or "").strip()
    with _LOCK:
        # 收回状态由**网关进程**写入（前端点按钮 → POST /api/cua/control/revoke），
        # 而拦截点 `node_repl_tool._run` 跑在**运行时进程** —— 不从文件同步就永远看不到。
        _sync_locked()
        if not _CONTROL["revoked"]:
            return False
        target = sk or _CONTROL["session_key"]
        if not target:
            return True
        # 【self-evolution-bot · 2026-11-19 · 第72轮】只拦**被收回的那个会话**。
        # 不区分会话的话，A 会话点「解除控制」会把 B 会话的电脑操作一起拦掉 ——
        # 用户有两个对话在跑时，另一个会莫名开始「电脑控制被收回」。
        #
        # 判据（端到端实测后改过一次，别改回去）：
        #   · 有明确目标会话（revoked_sk 非空）时，**只有**它能被拦；
        #     调用方连自己的 sk 都查不到（sk 为空）⇒ 无法证明是同一会话 ⇒ 不拦。
        #     宁可漏拦一次（用户看得到 AI 还在动，再点一次即可），
        #     也不能误拦无关会话（那个会话的用户完全无从察觉，且会莫名报错）。
        #   · 前端连 session_key 都没传（revoked_sk 为空）⇒ 这是全局收回，全部拦。
        revoked_sk = str(_CONTROL["session_key"] or "")
        if not sk:
            # 认不出调用方是谁 ⇒ **拦**（安全优先）。
            # 端到端实测过另一版「认不出就不拦」，结果是收回控制后 AI 照样动鼠标，
            # 而用户正盯着屏幕看 —— 这是最难解释的失败形态。
            # 误拦的代价小得多：另一个会话的模型会收到「控制已收回」文案，
            # 用户在那儿发一句话就自动恢复。
            return True
        if revoked_sk and sk != revoked_sk:
            return False
        cur = _current_max_seq(target)
        if cur > int(_CONTROL["max_seq"] or 0):
            _CONTROL["revoked"] = False
            _CONTROL["reason"] = "auto_restored_new_user_message"
            _CONTROL["max_seq"] = 0
            _persist_locked()
            return False
        return True


def _current_max_seq(session_key: str) -> int:
    """读 transcript 当前最大 seq（读出问题一律当 0，绝不因取证失败拦住停止）。"""
    sk = str(session_key or "").strip()
    if not sk:
        return 0
    try:
        from evoflow.persistence.db import get_db

        # 【self-evolution-bot · 2026-11-19 · 第72轮】必须只数 **role='user'** 的 seq。
        # 用「所有消息的最大 seq」会自欺：收回控制后 AI 自己还在写 assistant/tool 行，
        # seq 照样涨 ⇒ `is_cua_control_revoked()` 立刻判定「用户发新消息了，恢复吧」，
        # 等于自己给自己解封，用户的操作完全失效。只有新的**用户**消息才算重新授权。
        row = (
            get_db()
            .execute(
                "SELECT COALESCE(MAX(seq), 0) FROM evoflow_chat_messages "
                "WHERE session_key = ? AND role = 'user'",
                (sk,),
            )
            .fetchone()
        )
        return int(row[0] or 0) if row else 0
    except Exception:
        return 0


def get_cua_glow_status() -> dict[str, Any]:
    now = _now_ms()
    with _LOCK:
        _sync_locked()
        return _snapshot_locked(now)
