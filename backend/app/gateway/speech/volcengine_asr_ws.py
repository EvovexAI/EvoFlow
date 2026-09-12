from __future__ import annotations

import gzip
import json
import struct
import time
import uuid
import wave
from io import BytesIO

# ASR V3 binary protocol (Volcengine streaming / nostream)
_VERSION = 0b0001
_MSG_CLIENT_FULL = 0b0001
_MSG_CLIENT_AUDIO = 0b0010
_MSG_SERVER_FULL = 0b1001
_MSG_SERVER_ERROR = 0b1111
_FLAG_POS_SEQ = 0b0001
_FLAG_NEG_WITH_SEQ = 0b0011
_SER_JSON = 0b0001
_SER_NONE = 0b0000
_CMP_GZIP = 0b0001
_CMP_NONE = 0b0000


def _build_header(message_type: int, flags: int, serialization: int, compression: int) -> bytes:
    return bytes(
        [
            (_VERSION << 4) | 0b0001,
            (message_type << 4) | flags,
            (serialization << 4) | compression,
            0x00,
        ]
    )


def _build_full_client_request(seq: int, payload: dict) -> bytes:
    body = gzip.compress(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    return b"".join(
        [
            _build_header(_MSG_CLIENT_FULL, _FLAG_POS_SEQ, _SER_JSON, _CMP_GZIP),
            struct.pack(">i", seq),
            struct.pack(">I", len(body)),
            body,
        ]
    )


def _build_audio_only_request(seq: int, audio_chunk: bytes, *, is_last: bool) -> bytes:
    actual_seq = -seq if is_last else seq
    flags = _FLAG_NEG_WITH_SEQ if is_last else _FLAG_POS_SEQ
    if audio_chunk:
        body = gzip.compress(audio_chunk)
        compression = _CMP_GZIP
    else:
        body = b""
        compression = _CMP_NONE
    return b"".join(
        [
            _build_header(_MSG_CLIENT_AUDIO, flags, _SER_NONE, compression),
            struct.pack(">i", actual_seq),
            struct.pack(">I", len(body)),
            body,
        ]
    )


def _decode_payload(serialization: int, compression: int, payload: bytes):
    data = payload
    if compression == _CMP_GZIP and data:
        data = gzip.decompress(data)
    if serialization == _SER_JSON and data:
        text = data.decode("utf-8", errors="replace").strip()
        if not text:
            return None
        return json.loads(text)
    return data if data else None


def _parse_server_frame(frame: bytes) -> dict:
    if len(frame) < 4:
        raise RuntimeError("ASR invalid frame")
    header_size = frame[0] & 0x0F
    message_type = frame[1] >> 4
    flags = frame[1] & 0x0F
    serialization = frame[2] >> 4
    compression = frame[2] & 0x0F
    offset = header_size * 4
    is_last = bool(flags & 0x02)
    if flags & 0x01:
        offset += 4
    if message_type == _MSG_SERVER_FULL:
        payload_size = struct.unpack(">I", frame[offset : offset + 4])[0]
        offset += 4
        payload = _decode_payload(serialization, compression, frame[offset : offset + payload_size])
        return {"message_type": message_type, "is_last": is_last, "payload": payload}
    if message_type == _MSG_SERVER_ERROR:
        error_code = struct.unpack(">I", frame[offset : offset + 4])[0]
        offset += 4
        payload_size = struct.unpack(">I", frame[offset : offset + 4])[0]
        offset += 4
        detail = _decode_payload(serialization, compression, frame[offset : offset + payload_size])
        return {"message_type": message_type, "error_code": error_code, "detail": detail}
    return {"message_type": message_type, "is_last": is_last, "payload": None}


def _extract_text(payload) -> str:
    if not isinstance(payload, dict):
        return ""
    result = payload.get("result")
    if isinstance(result, dict):
        text = str(result.get("text") or "").strip()
        if text:
            return text
    return str(payload.get("text") or "").strip()


def _extract_utterances(payload) -> list[dict]:
    """Extract utterances with seg identifiers for dedup.

    Volcengine streaming ASR returns *cumulative* results: each frame
    re-sends all utterances from the start.  We use the utterance index
    as ``seg`` so the frontend can replace (not append) repeated frames
    for the same sentence — matching the legacy voice module's ``emitVolcTranscripts``.

    Returns a list of ``{text, is_final, seg}`` dicts.  When the payload
    has no ``utterances`` field, falls back to a single entry from
    ``_extract_text`` with ``seg=None``.
    """
    if not isinstance(payload, dict):
        return []

    results = payload.get("result")
    if isinstance(results, dict):
        results = [results]
    elif not isinstance(results, list):
        results = []

    utterances: list[dict] = []
    for r in results:
        if not isinstance(r, dict):
            continue
        u_list = r.get("utterances")
        if isinstance(u_list, list):
            for i, u in enumerate(u_list):
                if not isinstance(u, dict):
                    continue
                text = str(u.get("text") or "").strip()
                if not text:
                    continue
                definite = bool(u.get("definite"))
                utterances.append({"text": text, "is_final": definite, "seg": f"v{i}"})

    if not utterances:
        text = _extract_text(payload)
        if text:
            utterances.append({"text": text, "is_final": False, "seg": None})

    return utterances


def _wav_to_pcm(audio_bytes: bytes) -> tuple[bytes, int]:
    with wave.open(BytesIO(audio_bytes), "rb") as wf:
        if wf.getnchannels() != 1:
            raise ValueError("ASR expects mono audio")
        if wf.getsampwidth() != 2:
            raise ValueError("ASR expects 16-bit PCM")
        rate = wf.getframerate()
        return wf.readframes(wf.getnframes()), rate


def transcribe_audio_nostream_ws(
    *,
    audio_bytes: bytes,
    api_key: str,
    resource_id: str,
    ws_url: str,
    segment_ms: int = 200,
    timeout_s: float = 90.0,
) -> str:
    try:
        pcm, sample_rate = _wav_to_pcm(audio_bytes)
    except Exception as e:
        raise ValueError(f"Invalid WAV audio: {e}") from e
    if sample_rate != 16000:
        raise ValueError(f"ASR expects 16kHz audio, got {sample_rate}Hz")

    connect_id = str(uuid.uuid4())
    headers = {
        "X-Api-Key": api_key,
        "X-Api-Resource-Id": resource_id,
        "X-Api-Connect-Id": connect_id,
    }
    full_payload = {
        "user": {"uid": "evoflow-chat"},
        "audio": {
            "format": "pcm",
            "codec": "raw",
            "rate": 16000,
            "bits": 16,
            "channel": 1,
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
            "result_type": "full",
        },
    }

    bytes_per_ms = 16000 * 2 / 1000
    segment_size = max(1, int(bytes_per_ms * segment_ms))
    chunks = [pcm[i : i + segment_size] for i in range(0, len(pcm), segment_size)] or [b""]

    try:
        from websockets.sync.client import connect
    except ImportError as e:
        raise RuntimeError("websockets package required for Agent Plan streaming ASR") from e

    final_text = ""
    deadline = time.monotonic() + timeout_s
    with connect(ws_url, additional_headers=headers, open_timeout=15.0) as ws:
        seq = 1
        ws.send(_build_full_client_request(seq, full_payload))
        seq += 1
        for idx, chunk in enumerate(chunks):
            is_last = idx == len(chunks) - 1
            ws.send(_build_audio_only_request(seq, chunk, is_last=is_last))
            if not is_last:
                seq += 1
        while time.monotonic() < deadline:
            try:
                frame = ws.recv(timeout=max(0.1, deadline - time.monotonic()))
            except TimeoutError:
                continue
            if isinstance(frame, str):
                continue
            parsed = _parse_server_frame(frame)
            if parsed.get("message_type") == _MSG_SERVER_ERROR:
                detail = parsed.get("detail")
                raise RuntimeError(f"ASR protocol error ({parsed.get('error_code')}): {detail}")
            text = _extract_text(parsed.get("payload"))
            if text:
                final_text = text
            if parsed.get("is_last"):
                break
        else:
            raise RuntimeError("ASR timed out waiting for final transcript")

    if not final_text:
        raise RuntimeError("ASR returned empty transcript")
    return final_text
