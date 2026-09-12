"""Server-side LangGraph state poll tail for ``/stream-resume`` live phase.

When the client disconnects, Gateway ASGI stops forwarding but may launch
``run_mirror_tail_until_terminal`` to keep writing mirror frames via the same
``enqueue_wire_text`` path as the live POST ``/runs/stream`` proxy.
the **same** stream-resume SSE — the browser never calls GET attach.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

from app.gateway.streaming.attach_evf_stream import AttachEvfDiffEmitter

logger = logging.getLogger(__name__)

_ACTIVE_RUN_STATUSES = frozenset({"pending", "running"})


def _wire_evf_frame(raw: str) -> str:
    text = str(raw or "")
    if not text.strip():
        return ""
    if text.endswith("\n\n"):
        return text
    return text + "\n\n"


def _parse_runs_items(runs_data: Any) -> list[dict[str, Any]]:
    items: Any = runs_data
    if isinstance(runs_data, dict):
        items = runs_data.get("items", runs_data.get("runs", []))
    if not isinstance(items, list):
        return []
    return [r for r in items if isinstance(r, dict)]


def _run_status_for_id(items: list[dict[str, Any]], run_id: str) -> str | None:
    rid_pref = str(run_id or "").strip()
    for r in items:
        rid = r.get("run_id") or r.get("runId")
        if rid is None or str(rid) != rid_pref:
            continue
        st = str(r.get("status") or "").strip().lower()
        return st or None
    return None


def make_langgraph_tail_emitter(*, anchor_text: str = "") -> AttachEvfDiffEmitter:
    emitter = AttachEvfDiffEmitter()
    baseline = str(anchor_text or "")
    if baseline:
        emitter.baseline_text = baseline
        emitter.last_emitted_text = baseline
        emitter.baseline_locked = True
    return emitter


@dataclass
class LangGraphTailPollState:
    emitter: AttachEvfDiffEmitter
    last_state_sig: str = ""
    poll_tick: int = 0


async def poll_langgraph_live_tick(
    client: httpx.AsyncClient,
    *,
    langgraph_base_url: str,
    thread_id: str,
    run_id: str,
    session_key: str,
    state: LangGraphTailPollState,
) -> tuple[list[str], bool]:
    """One LangGraph poll tick. Returns ``(wire_frames, run_terminal)``."""
    tid = str(thread_id or "").strip()
    rid = str(run_id or "").strip()
    sk = str(session_key or "").strip()
    if not tid or not rid:
        return [], True

    from app.gateway.sse_slim import SSE_SLIM_ENABLED, slim_values_payload
    from app.gateway.streaming.stream_mirror import enqueue_wire_text

    out: list[str] = []
    state.poll_tick += 1

    state_url = f"{langgraph_base_url.rstrip('/')}/threads/{tid}/state"
    try:
        resp = await client.get(state_url)
        if resp.status_code == 200:
            data = resp.json()
            sig = str(hash(resp.content))
            if sig != state.last_state_sig:
                state.last_state_sig = sig
                slim_data = slim_values_payload(data) if SSE_SLIM_ENABLED else data
                for frame in state.emitter.frames_for_state(slim_data):
                    wire = _wire_evf_frame(frame)
                    if wire:
                        out.append(wire)
                        if sk:
                            enqueue_wire_text(tid, wire, run_id=rid, session_key=sk)
    except Exception:
        logger.debug("stream_resume langgraph tail state poll failed thread=%s", tid, exc_info=True)

    run_terminal = False
    if state.poll_tick % 3 == 0 or out:
        runs_url = f"{langgraph_base_url.rstrip('/')}/threads/{tid}/runs"
        try:
            rr = await client.get(runs_url, params={"limit": 20})
            if rr.status_code == 200:
                st = _run_status_for_id(_parse_runs_items(rr.json()), rid)
                if st and st not in _ACTIVE_RUN_STATUSES:
                    run_terminal = True
                    for frame in state.emitter.finish_frames():
                        wire = _wire_evf_frame(frame)
                        if wire:
                            out.append(wire)
                            if sk:
                                enqueue_wire_text(tid, wire, run_id=rid, session_key=sk)
                    try:
                        from app.gateway.run_status_reconcile import notify_attach_run_terminal

                        await notify_attach_run_terminal(tid, run_id=rid)
                    except Exception:
                        logger.debug(
                            "stream_resume langgraph tail terminal notify failed thread=%s",
                            tid,
                            exc_info=True,
                        )
        except Exception:
            logger.debug("stream_resume langgraph tail runs poll failed thread=%s", tid, exc_info=True)

    return out, run_terminal


# ---------------------------------------------------------------------------
# Background mirror tail — launched when client SSE disconnects mid-run.
# ---------------------------------------------------------------------------

_active_mirror_tails: set[str] = set()
_MIRROR_TAIL_POLL_S = max(0.25, min(2.0, float(os.getenv("EVOFLOW_MIRROR_TAIL_POLL_S", "0.4") or "0.4")))
_MIRROR_TAIL_STREAM_FORMAT = (os.getenv("EVOFLOW_MIRROR_TAIL_STREAM_FORMAT", "agui") or "agui").strip().lower()


def _enqueue_mirror_wire_frames(
    *,
    thread_id: str,
    run_id: str,
    session_key: str,
    frames: list[str],
    agui_state: Any | None,
) -> Any | None:
    """Write tail frames to mirror using the same wire format as PostStreamUiTransform (default ag-ui)."""
    from app.gateway.streaming.stream_mirror import enqueue_wire_text

    if not frames:
        return agui_state
    fmt = _MIRROR_TAIL_STREAM_FORMAT
    wires: list[str] = []
    if fmt in {"agui", "ag-ui"}:
        from app.gateway.agui_stream_normalizer import AgUiEncoderState, convert_evf_frames_to_agui

        state = agui_state if agui_state is not None else AgUiEncoderState(
            thread_id=thread_id,
            run_id=run_id,
        )
        for frame in frames:
            raw = str(frame or "")
            if not raw.strip():
                continue
            if raw.lstrip().startswith("event: ag-ui") or raw.lstrip().startswith("event:ag-ui"):
                wires.append(raw)
                continue
            payload = raw if raw.endswith("\n\n") else raw + "\n\n"
            for chunk in convert_evf_frames_to_agui([payload.encode("utf-8")], state=state):
                wires.append(chunk.decode("utf-8", errors="ignore"))
        agui_state = state
    else:
        wires = [str(f) for f in frames if str(f or "").strip()]
    for wire in wires:
        w = wire if wire.endswith("\n\n") else wire + "\n\n"
        if w.strip():
            enqueue_wire_text(thread_id, w, run_id=run_id, session_key=session_key)
    return agui_state


async def run_mirror_tail_until_terminal(
    *,
    thread_id: str,
    run_id: str | None = None,
    session_key: str | None = None,
) -> None:
    """Disabled — mirror only from ``StreamMiddleLayer`` POST upstream."""
    return


def launch_mirror_tail_on_disconnect(
    *,
    thread_id: str,
    run_id: str | None = None,
    session_key: str | None = None,
    body: bytes = b"",
    stream_format: str = "agui",
):
    """Disabled — mirror only from ``StreamMiddleLayer`` POST upstream."""
    return None
