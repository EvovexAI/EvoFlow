"""右栏面板类型清单 + 当前状态接口 —— 前端与模型共用同一份真源。

【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新增 GET /api/stage/right-stage/kinds，直接读
``evoflow.stage.right_panel_kinds``，把类型契约暴露给前端。
为什么：用户 2026-11-20 要求「前端跟后端架构不能是混乱的」。此前
「右栏支持哪些 kind / 每种必需字段」在前端（open-progress-from-panel-set.ts
逐个 if 校验）和后端（stage_tool._build_progress_surface 逐个 if 校验）各写一遍，
已经漂移（后端要 taskId、前端只查 agentCode）。现在只有后端一份，前端从这里取；
若取不到则退回本地默认表，保证离线/构建期不炸。

【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新增 POST /api/stage/right-stage/state 与 GET 同名接口 + ``read_right_stage_state()``。
为什么（用户明确指出）：「你知道我当前右侧标签页是哪个吗？这个在你的管理体系里边能查到吗？」
  答：查不到 —— 右栏 activeKey 此前只活在前端内存（``grep activeKey backend`` 命中 0 次）。
  于是模型 ui.show 时不知道用户正在看什么：要么把视线抢走，要么把同一份东西开成第二个签。
现在前端每次状态变化上报（尾部节流 400ms），后端保存最新一份，模型用
``platform action=ui.current`` 读回来后再决定「复用/切换/新开」。

【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】
改了什么：状态落盘（``{data_root}/stage/right-stage-state.json``），不再只用进程内 dict。
为什么（重启后现网实测抓到的真缺陷 —— 本轮的第二个「写了等于没写」）：
  打包形态下 **gateway 与模型工具是两个独立 Python 进程**：
    网关      pid 19288/10588  ``gateway_entry.py --mode gateway --port 8382``
    模型工具  pid 19368/31584  ``gateway_entry.py --mode langgraph --port 8384``
  而 ``_STATE`` 是模块级 dict = 各自进程一份。前端 POST 写进网关进程，
  ``ui.current`` 却在工具进程里读 —— 实测同一秒：curl GET 返回
  ``known:true, activeKey=employeeProcess:process:live:reviewer``，
  而 ``platform action=ui.current`` 返回 ``known:false, reason=no_report_yet``。
  也就是说读侧「通了但永远空」，用户看到的就是「你查不到我开的标签页」。
  只用内存还有第二个隐患：网关重启即丢失。
现在写侧落盘 + 读侧先看内存再看盘（网关进程自己写内存也写盘，工具进程读盘），
两个进程都能看到同一份事实；盘上没有时仍老实返回 ``known=False``。
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import UTC
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body

router = APIRouter(prefix="/api/stage/right-stage", tags=["stage-right-panel"])

# 进程内缓存：同进程（网关自己）读写走这里；跨进程以落盘文件为准。
_STATE_LOCK = threading.Lock()
_STATE: dict[str, Any] = {}
_STATE_FILE_REL = ("stage", "right-stage-state.json")
# 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
# 模块导入时刻 = 进程启动的近似下界（psutil 拿不到时用它兜底判 stale）。
_MODULE_IMPORT_EPOCH = time.time()


def right_stage_state_path() -> Path | None:
    """右栏状态的落盘路径（跨进程共享）。解析失败返回 None，退化为纯内存。

    用 harness 的 ``resolve_data_root()``：gateway 进程与 langgraph 工具进程
    都会解析到同一个 profile 数据目录（``~/.evoflow/profiles/<id>/data``）。
    """
    try:
        from evoflow.config.data_paths import resolve_data_root

        root = resolve_data_root()
    except Exception:
        return None
    try:
        directory = root.joinpath(*_STATE_FILE_REL[:-1])
        directory.mkdir(parents=True, exist_ok=True)
        return directory / _STATE_FILE_REL[-1]
    except OSError:
        return None


def _tab_key(tab: dict[str, Any]) -> str:
    """按 store 的口径算 key：显式 key 优先，否则 ``${kind}:${id}``。

    【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】
    改了什么：**后端自己补 key**，不再假定前端上报里带 key；并用 ``keyRepairable``
    如实标记补不出来的情况。
    为什么（现网实测原文，2026-11-20 21:37:34 那份上报）::

        tabs:[{"key":"","kind":"employeeProcess","title":"审核员",...},
              {"key":"","kind":"employeeProcess","title":"发版工程师",...}]

    打包 exe（20:34）内嵌的是旧前端：它读 ``surface.key``，而 RightStageSurface
    根本没有这个字段（键由 ``tabKeyOf`` 算 ``${kind}:${id}``），**而且它连 ``id`` 都没上报**。
    所以后端**无法**凭空还原 key —— 靠 kind/title/data 去猜 id 会让 ui.activate
    指向错误的签，比报错更糟。这里只补能补的（有 id 就补），补不了的老实标记。
    """
    explicit = str(tab.get("key") or "")
    if explicit:
        return explicit
    kind = str(tab.get("kind") or "")
    ident = str(tab.get("id") or "")
    if kind and ident:
        return f"{kind}:{ident}"
    return ""


def _clean_payload(payload: dict[str, Any]) -> dict[str, Any]:
    raw_tabs = payload.get("tabs")
    tabs: list[dict[str, Any]] = []
    keys_repairable = True
    if isinstance(raw_tabs, list):
        for raw in raw_tabs:
            if not isinstance(raw, dict):
                continue
            tab = dict(raw)
            tab["key"] = _tab_key(tab)
            # key 里带着 kind，回填给缺 kind 的条目。
            if not tab.get("kind") and ":" in tab["key"]:
                tab["kind"] = tab["key"].split(":", 1)[0]
            if not tab["key"]:
                keys_repairable = False
            tabs.append(tab)

    active_key = str(payload.get("activeKey") or "") or None
    active_kind = str(payload.get("activeKind") or "") or None
    active_title = str(payload.get("activeTitle") or "") or None

    # activeKey 的 ``kind:`` 前缀是精确事实（不是猜），老前端报 null 时用它回填。
    if active_key and active_kind is None and ":" in active_key:
        active_kind = active_key.split(":", 1)[0] or None
    # 标题只能靠 activeKey 命中同一 tab；命中不了就留 null，不编。
    if active_key and active_title is None:
        hit = next((t for t in tabs if t.get("key") == active_key), None)
        if hit is not None:
            active_title = str(hit.get("title") or "") or None

    # 【self-evolution-bot · 2026-11-21 · 第106轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：补顶层 ``sessionKey`` 透传。
    # 为什么（本轮现网实测）：前端 ``buildPayload`` 从第104轮起就在发这个字段
    #   （「右栏此刻挂在哪条会话上」的唯一事实），但只要经过本函数就被**静默丢掉**——
    #   ``_clean_payload`` 是白名单式重建返回体，没列进去的字段一律消失。
    #   盘上 ``right-stage-state.json`` 实测确实没有它，于是
    #   ``ui.show`` 回执里判「这次写进了别的会话，用户看不见」的判据
    #   ``owner_session_key`` 只能走 tabs 兜底，而 activeKey 为空时兜底也拿不到。
    # 判据：POST 带了顶层 sessionKey，GET 必须原样回得来。
    top_session_key = str(payload.get("sessionKey") or "").strip() or None
    if top_session_key is None and active_key:
        # 老前端不发顶层字段时，用当前激活签的归属会话兜底（同一事实的另一种携带方式）。
        hit = next((t for t in tabs if t.get("key") == active_key), None)
        if hit is not None:
            top_session_key = str(hit.get("sessionKey") or "").strip() or None
    return {
        "activeKey": active_key,
        "activeKind": active_kind,
        "activeTitle": active_title,
        "collapsed": payload.get("collapsed") is True,
        "sessionKey": top_session_key,
        "tabs": tabs,
        # 【self-evolution-bot · 2026-11-20 · 第100轮续】补不了 key 时如实标记：
        # 模型据此知道「能读当前页、但还不能按 key 切签」，而不是拿到一堆空键瞎切。
        "keysRepairable": keys_repairable,
        "rev": int(payload.get("rev") or 0),
        "reportedAt": str(payload.get("reportedAt") or "") or None,
        # 【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash】
        # 改了什么：透传 writerPid（写这份文件的进程号）。
        # 为什么：``_clean_payload`` 是**白名单式重建**，不在这里列出的字段一律消失；
        #   我上一版只在 ``_write_state_file`` 里塞 writerPid，读侧却被这里洗掉 →
        #   ``_writer_process_gone`` 恒拿到 0，改动等于死代码（第95轮同型坑）。
        # 判据：落盘后 ``_read_state_file()`` 必须能拿到 writerPid。
        "writerPid": int(payload.get("writerPid") or 0) or None,
    }


def _write_state_file(clean: dict[str, Any]) -> None:
    """原子写：先写 .tmp 再 replace，避免读侧读到半个 JSON。"""
    path = right_stage_state_path()
    if path is None:
        return
    try:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(clean, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        # 落盘失败不拖垮接口：内存里那份仍然可用（同进程调用方）。
        return


def _snapshot_age_seconds(snap: dict[str, Any]) -> float | None:
    """``reportedAt`` 距今多少秒；解析不出来返回 None（不猜）。

    【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
    为什么要有它：``known=True`` 只证明"有人上报过"，不证明"现在还是这样"。
    本轮我就因为看不见年龄，把 7 小时前的落盘快照当成实时状态误报了一整轮。
    """
    stamp = _parse_reported_at(snap)
    if stamp is None:
        return None
    from datetime import datetime

    return max(0.0, (datetime.now(UTC) - stamp).total_seconds())


# 超过这个年龄就标记 stale。取 10 分钟：前端状态变化节流 400ms，
# 正常使用下快照一直在刷新；10 分钟没动过的快照几乎一定不是"此刻"。
_STALE_AFTER_SECONDS = 600


def _parse_reported_at(snap: dict[str, Any]):
    """``reportedAt`` → aware datetime；解析不出来返回 None。"""
    raw = str(snap.get("reportedAt") or "").strip()
    if not raw:
        return None
    try:
        from datetime import datetime

        stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return stamp if stamp.tzinfo is not None else stamp.replace(tzinfo=UTC)
    except (ValueError, TypeError):
        return None


def _pid_alive(pid: int) -> bool:
    """该进程还在不在（跨进程残留判据用；不引第三方依赖）。

    【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash】
    """
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            k32 = ctypes.windll.kernel32
            k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            k32.OpenProcess.restype = wintypes.HANDLE
            k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            k32.GetExitCodeProcess.restype = wintypes.BOOL
            k32.CloseHandle.argtypes = [wintypes.HANDLE]
            # PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = k32.OpenProcess(0x1000, False, int(pid))
            if not handle:
                return False
            try:
                code = wintypes.DWORD(0)
                if not k32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return False
                return code.value == 259  # STILL_ACTIVE
            finally:
                k32.CloseHandle(handle)
        except Exception:  # noqa: BLE001 - 判不了就当作不知道
            return True
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _writer_process_gone(snap: dict[str, Any]) -> bool:
    """这份快照是否由**一个已经不在的进程**写下的（跨进程残留的精确判据）。

    【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash】
    改了什么：取代原来「``reportedAt`` 早于本进程启动」这条判据。
    为什么（现网实证）：那条判据在两个进程的架构下**语义就是错的** ——
      落盘文件由 **gateway** 进程写，读的人却是 **langgraph 工具进程**；
      只要读侧进程比写侧晚起一分钟，前者的新鲜上报就会被判成「上一个进程的残留」。
      实测：``reportedAt=08:52:43Z``、网关 08:28 启动、前端一直在 400ms 节流上报，
      回执却写「早于本进程启动」—— 真正原因是 ``psutil`` 没装、兜底取了本模块
      **懒加载**时刻（09:01），比上报晚 9 分钟。
      正确判据只能是「写这份文件的进程还在不在」，与谁在读无关。
    判据：文件里带 ``writerPid`` 且该 pid 已消失 → 残留；pid 还在 → 不是残留。
      老格式文件没有 ``writerPid`` 时退回进程启动比较（只影响重启后首次上报前的瞬间）。
    """
    pid = snap.get("writerPid")
    try:
        writer_pid = int(pid) if pid is not None else 0
    except (TypeError, ValueError):
        writer_pid = 0
    if writer_pid > 0:
        return not _pid_alive(writer_pid)
    return _older_than_process_start(snap)


def _older_than_process_start(snap: dict[str, Any]) -> bool:
    """``reportedAt`` 是否早于**本进程**启动时刻（老格式文件的兜底判据）。

    【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash】
    注意：读侧与写侧是两个进程时这条**不可靠**（见 ``_writer_process_gone``），
    只保留给没有 ``writerPid`` 的老格式落盘文件兜底。
    """
    stamp = _parse_reported_at(snap)
    if stamp is None:
        return False
    started = _process_start_time()
    return started is not None and stamp < started


_PROCESS_START: Any = None
_PROCESS_START_RESOLVED = False


def _process_start_time():
    """本进程启动时刻（UTC aware）；取不到返回 None。只算一次。"""
    global _PROCESS_START, _PROCESS_START_RESOLVED
    if _PROCESS_START_RESOLVED:
        return _PROCESS_START
    _PROCESS_START_RESOLVED = True
    try:
        from datetime import datetime

        _PROCESS_START = datetime.fromtimestamp(_process_start_epoch(), tz=UTC)
    except Exception:  # noqa: BLE001 - 拿不到就不做进程级判断
        _PROCESS_START = None
    return _PROCESS_START


def _win_process_create_epoch() -> float | None:
    """Windows：用 ctypes 直接问内核要**本进程创建时刻**（epoch 秒）。

    【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash】
    为什么不用 psutil：``psutil`` 不是本仓依赖（``backend/pyproject.toml`` 与打包
    产物里都没有），打包形态下必然 ImportError；此前只能回落到模块导入时刻，
    而本模块在 langgraph 工具进程里是**懒加载**的 —— 兜底值就成了「首次 import
    时刻」，晚于真正的进程启动，于是把「本进程启动后刚上报的新鲜快照」误判成
    「上一个进程的落盘残留」（现网症状：``ageSeconds=21`` 却写「早于本进程启动」）。
    判据：返回值必须与 PowerShell ``(Get-Process -Id $pid).StartTime`` 对齐（误差 <2s）。

    注意 ``argtypes`` 必须声明：不声明时 64 位 HANDLE 会被 ctypes 截成 32 位，
    ``GetProcessTimes`` 直接返回 0（我第一版就栽在这，拿到 epoch=-11644473600）。
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class _FileTime(ctypes.Structure):
            _fields_ = [("lo", wintypes.DWORD), ("hi", wintypes.DWORD)]

        class _ProcessTimes(ctypes.Structure):
            _fields_ = [
                ("create", _FileTime),
                ("exit", _FileTime),
                ("kernel", _FileTime),
                ("user", _FileTime),
            ]

        k32 = ctypes.windll.kernel32
        k32.GetProcessTimes.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(_FileTime),
            ctypes.POINTER(_FileTime),
            ctypes.POINTER(_FileTime),
            ctypes.POINTER(_FileTime),
        ]
        k32.GetProcessTimes.restype = wintypes.BOOL
        times = _ProcessTimes()
        if not k32.GetProcessTimes(
            wintypes.HANDLE(k32.GetCurrentProcess()),
            ctypes.byref(times.create),
            ctypes.byref(times.exit),
            ctypes.byref(times.kernel),
            ctypes.byref(times.user),
        ):
            return None
        # FILETIME = 100ns 单位，起点 1601-01-01；换算到 Unix epoch。
        ticks = (times.create.hi << 32) | times.create.lo
        return ticks / 10_000_000 - 11_644_473_600
    except Exception:  # noqa: BLE001 - 拿不到就走下一档兜底
        return None


def _process_start_epoch() -> float:
    """本进程启动的 epoch 秒。

    三档：``psutil``（若装了）→ Windows ctypes 内核取真值 →
    模块导入时刻（最后兜底，进程级近似，仍能挡住"上一个进程的落盘"）。

    【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：删掉本文件里**重复定义的第二份**（此前 228 行与 242 行各一份，
    后者覆盖前者，纯死代码）。
    为什么：两份内容相同所以行为没变，但它是我上一轮写 patch 时重复插入的结果 ——
    同一文件里两份同名实现，下一个人改了一份会以为生效了，实际被后一份盖掉。
    判据：`rg -c "^def _process_start_epoch" = 1`。
    """
    # 【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash】
    # 改了什么：psutil 之后补一档 Windows ctypes 内核取真启动时刻，再才轮到导入时刻。
    # 为什么：psutil 不是本仓依赖（现网实测 ModuleNotFoundError），于是恒走导入时刻兜底，
    #   而本模块在工具进程里懒加载 → 误判「新鲜快照来自上一个进程」（ageSeconds 与文案打架）。
    try:
        import psutil  # type: ignore

        return float(psutil.Process().create_time())
    except Exception:  # noqa: BLE001
        pass
    real = _win_process_create_epoch()
    if real is not None:
        return real
    return _MODULE_IMPORT_EPOCH


def _read_state_file() -> dict[str, Any] | None:
    path = right_stage_state_path()
    if path is None:
        return None
    try:
        if not path.is_file():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    clean = _clean_payload(data)
    return clean if clean.get("reportedAt") or clean.get("activeKey") is not None else None


def store_right_stage_state(payload: dict[str, Any]) -> dict[str, Any]:
    """保存前端上报的右栏状态（覆盖式，只留最新一份）：内存 + 落盘。"""
    if not isinstance(payload, dict):
        raise ValueError("right stage state must be an object")
    clean = _clean_payload(payload)
    # 【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash】
    # 改了什么：每次保存都盖章 ``writerPid`` = 写这份快照的进程号。
    # 为什么：判「这份快照是不是上个进程的残留」只能看**写的人还在不在**；
    #   网关写、工具进程读，用「读侧启动时刻」当边界会冤枉新鲜上报（现网实测）。
    # 判据：落盘后 ``_read_state_file()`` 拿到的 writerPid == 当前进程 pid；
    #   把它换成已死 pid 时 ``_writer_process_gone()`` 必须变 True。
    clean = {**clean, "writerPid": os.getpid()}
    with _STATE_LOCK:
        _STATE.clear()
        _STATE.update(clean)
    _write_state_file(clean)
    return clean


def read_right_stage_state() -> dict[str, Any]:
    """读回最新一次上报。**从没上报过**时返回 ``known=False``，不要假装「右栏是空的」。

    顺序：本进程内存 → 落盘（跨进程）。两处都有时**取较新的一份**。

    【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：原来「内存有值就绝不看盘」，改为内存与落盘都读、按 ``rev``/``reportedAt``
    取较新者。
    为什么（本轮真机实测抓到的真缺陷，表现为「模型说看不到用户右栏 / 控制不了」）：
      · 前端上报 POST 打进 **gateway** 进程，内存 ``_STATE`` 写的是 gateway 那份；
      · 而 ``ui.current`` / ``ui.show`` 的 ``userScreen.before`` 跑在 **langgraph 工具进程**，
        它的 ``_STATE`` 永远为空 → 走落盘分支 → 本该读到最新，但一旦同进程先被写过一次旧值，
        旧值就会永久压住更新的一份。
      · 实证：11:13:55 落盘 rev=28 / active=browser:primary（18,000 字节的时间戳可查），
        而工具侧同一时刻回的是 rev=5 / reportedAt 03:10:21Z —— 整整差 3 分半，
        期间我给它的 4 次 ui.show 全都显示过期 before，等于拿旧照片做判断。
    判据：同一次调用，落盘 rev 大于内存 rev 时必须返回落盘那份；
      两份都没有才算 ``known=False``。
    """
    with _STATE_LOCK:
        snap = dict(_STATE)
    from_file = _read_state_file()
    if from_file:
        if not snap:
            snap = from_file
        elif int(from_file.get("rev") or 0) > int(snap.get("rev") or 0):
            # 落盘更新（通常是 gateway 进程刚写的）→ 以盘为准，跨进程才看得到真实状态。
            snap = from_file
    if not snap:
        return {
            "ok": True,
            "known": False,
            "reason": "no_report_yet",
            "hint": "前端还没上报过右栏状态（可能窗口没开或刚重启）；此时不要假设右栏为空。",
        }
    snap["ok"] = True
    snap["known"] = True
    # 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：读回时算一个显式 ``stale`` 与 ``ageSeconds``，过期就在回执里喊出来。
    # 为什么（本轮我自己就被它骗了一次）：08:11 新进程起来后我调 ui.current，
    #   它返回 ``ok:true known:true tabs=7 rev=42``，而 ``reportedAt`` 是
    #   ``2026-11-20T17:03:48Z`` —— 本地 **01:03:48**，上一个进程 7 小时前写下的盘。
    #   我把这份陈旧快照当成了"用户此刻右栏有 7 个签"，随后 ui.show 看到只有 1 个签，
    #   就误报了一整轮"标签莫名消失"。**known=true 只说明"有人上报过"，不说明"现在是这样"。**
    # 判据：写这份快照的那个进程已经不在了 → stale=True（精确、与谁在读无关）；
    #   超过 STALE_AFTER_SECONDS（无论来源）也置 stale。
    # 【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash】
    #   更正上一轮的判据：原来用「reportedAt 早于本进程启动」判残留，是错的 ——
    #   网关写、工具进程读，读侧晚起一分钟就冤枉一次新鲜上报（现网实测 08:52:43Z 被
    #   写成「早于本进程启动」）。改为「写者 pid 是否还在」（见 ``_writer_process_gone``）。
    age = _snapshot_age_seconds(snap)
    writer_gone = _writer_process_gone(snap)
    if age is not None:
        snap["ageSeconds"] = int(age)
        if age > _STALE_AFTER_SECONDS or writer_gone:
            snap["stale"] = True
            snap["staleHint"] = (
                f"这份快照是 {int(age)} 秒前上报的"
                + ("，且写它的进程已经不在了（多半来自上一个进程的落盘残留）。" if writer_gone else "。")
                + "它只代表当时的状态，不代表用户此刻的右栏；"
                "需要实时值时让前端重新上报，或直接以 ui.show/activate 之后的回执为准。"
            )
    return snap


@router.post("/state")
def post_right_stage_state(payload: dict[str, Any] = Body(default_factory=dict)) -> dict:
    """前端每次右栏状态变化上报一份（只含身份字段，不含预览载荷）。

    【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：每次上报额外 append 一行到 ``{logs}/right-stage-YYYY-MM-DD.log``。
    为什么（用户明确要求）：「你可以在日志文件里看到操作了什么样的工具、右侧有什么
      东西出现…有助于你方便排查后面处理这种问题。」
      此前 ``_STATE`` 是覆盖式单快照，只留最新一份 —— 于是「我调工具那一刻，
      用户右栏到底是什么样」永远查不回来。这正是本轮排查卡住的原因：
      22:19 我派出 chat_send，22:22 再读状态已经变成别的会话的标签，
      中间那一步到底展开没展开，没有任何时刻可以回溯。
    判据：日志里每次上报一行，带 activeKey / collapsed / 标签数与各签 key，
      能按时间对齐 ``[py] emit sent ...`` 那几行做「发了什么 → 变成什么样」。
    """
    saved = store_right_stage_state(payload)
    _audit_state("report", saved)
    return {"ok": True, "activeKey": saved.get("activeKey"), "tabs": len(saved.get("tabs") or [])}


def _audit_state(phase: str, saved: dict[str, Any]) -> None:
    """把一次上报/读回写进右栏审计日志（失败静默，绝不影响接口）。"""
    try:
        from evoflow.stage.right_stage_audit_log import right_stage_log

        tabs = saved.get("tabs") or []
        keys = [str((t or {}).get("key") or "-") for t in tabs]
        right_stage_log(
            "web-state",
            f"{phase} activeKey={saved.get('activeKey')} kind={saved.get('activeKind')} "
            f"collapsed={saved.get('collapsed')} tabs={len(tabs)} keys={keys} "
            f"keysRepairable={saved.get('keysRepairable')} rev={saved.get('rev')}",
        )
    except Exception:  # noqa: BLE001 - 审计绝不冒泡
        pass


@router.get("/state")
def get_right_stage_state() -> dict:
    """模型/调试读回用户当前右栏停在哪一页。"""
    return read_right_stage_state()


@router.get("/kinds")
def get_right_stage_kinds() -> dict:
    """返回右栏支持的面板类型、必需字段与触发语义。"""
    try:
        from evoflow.stage.right_panel_kinds import (
            AUTO_OPEN_ACTIONS,
            READ_ONLY_ACTIONS,
            kind_specs,
            should_auto_open,
        )

        kinds = [spec for spec in kind_specs() if spec.get("kind") != "artifacts"]
        return {
            "ok": True,
            "count": len(kinds),
            "kinds": kinds,
            "autoOpenActions": sorted(AUTO_OPEN_ACTIONS),
            "readOnlyActions": sorted(READ_ONLY_ACTIONS),
            # 示例便于前端/调试直接看到判据，不必重新推导
            "samples": {
                "tasks.list": should_auto_open("tasks.list"),
                "employees.wake": should_auto_open("employees.wake"),
            },
        }
    except Exception as exc:  # pragma: no cover - 契约表异常不应拖垮前端
        return {"ok": False, "error": str(exc), "kinds": []}
