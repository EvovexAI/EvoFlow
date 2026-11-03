"""本地控制通道：让语音对话系统可以驱动桌宠的状态。

只监听 127.0.0.1，按行收发 JSON：

    {"mode": "thinking"}                 切换到"思考中"
    {"mode": "answering", "say": "你好"}  切状态 + 冒气泡
    {"say": "……"}                        只说一句
    {"hide": true} / {"show": true}

也支持直接发纯文本（当作一句话让宠物说出来）。
"""
from __future__ import annotations

import json
import traceback

from PySide6.QtCore import QObject
from PySide6.QtNetwork import QHostAddress, QTcpServer
from PySide6.QtWidgets import QApplication

DEFAULT_PORT = 8756


class ControlServer(QObject):
    def __init__(self, pet, port: int = DEFAULT_PORT, log=None, parent=None):
        super().__init__(parent)
        self.pet = pet
        self.port = port
        self._log = log or (lambda _m: None)
        self._buffers: dict = {}

        self.server = QTcpServer(self)
        self.server.newConnection.connect(self._on_new_connection)

    # ---- 生命周期 ----
    def start(self) -> bool:
        if not self.server.listen(QHostAddress.LocalHost, self.port):
            self._log(f"控制通道启动失败（端口 {self.port}）：{self.server.errorString()}")
            return False
        self._log(f"控制通道已监听 127.0.0.1:{self.port}")
        return True

    def stop(self) -> None:
        self.server.close()

    # ---- 连接 ----
    def _on_new_connection(self) -> None:
        while self.server.hasPendingConnections():
            sock = self.server.nextPendingConnection()
            self._buffers[sock] = b""
            sock.readyRead.connect(lambda s=sock: self._on_ready(s))
            sock.disconnected.connect(lambda s=sock: self._on_gone(s))

    def _on_gone(self, sock) -> None:
        self._buffers.pop(sock, None)
        sock.deleteLater()

    def _on_ready(self, sock) -> None:
        buf = self._buffers.get(sock, b"") + bytes(sock.readAll())
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if line.strip():
                self._handle(sock, line)
        self._buffers[sock] = buf

    # ---- 指令 ----
    def _handle(self, sock, raw: bytes) -> None:
        text = raw.decode("utf-8", "ignore").strip()
        try:
            cmd = json.loads(text)
            if not isinstance(cmd, dict):
                cmd = {"say": str(cmd)}
        except Exception:
            cmd = {"say": text}

        try:
            resp = {"ok": True}
            if cmd.get("mode"):
                self.pet.set_mode(str(cmd["mode"]))
            if cmd.get("say"):
                self.pet.say(str(cmd["say"]), int(cmd.get("msec", 3600)))
            if cmd.get("hide"):
                self.pet.hide()
            if cmd.get("show"):
                self.pet.show()
            if cmd.get("shot"):
                path = str(cmd["shot"])
                # 推迟一帧再抓，否则拿到的是切换前的画面
                from PySide6.QtCore import QTimer
                QTimer.singleShot(260, lambda p=path: self.pet.grab().save(p))
                resp["shot"] = path
            resp["mode"] = getattr(self.pet, "mode", "idle")
        except Exception:
            resp = {"ok": False, "error": traceback.format_exc(limit=2)}

        try:
            sock.write((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
            sock.flush()
        except Exception:
            pass
