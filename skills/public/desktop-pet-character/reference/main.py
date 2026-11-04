"""桌面宠物 —— 入口。

启动：双击「启动桌面宠物.vbs」（无控制台窗口），或在命令行运行 pythonw main.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import traceback
from pathlib import Path

from PySide6.QtCore import QLockFile, QPointF, Qt, QTimer
from PySide6.QtGui import QGuiApplication, QIcon, QImage, QPainter, QPixmap
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

from pet.characters import CHARACTERS
from pet.control import ControlServer
from pet.state import PetState
from pet.window import PetWindow, SpeechBubble, build_menu

APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("APPDATA", str(Path.home()))) / "EvoPet" / "config.json"
LOG_PATH = APP_DIR / "pet.log"

DEFAULT_CFG = {
    "character": "xiaoxi",
    "scale": 1.25,
    "wander": True,
    "ontop": True,
    "autostart": False,
    "seen": False,
    "control_port": 8756,
}


def log(msg: str) -> None:
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(msg.rstrip() + "\n")
    except Exception:
        pass


def load_cfg() -> dict:
    cfg = dict(DEFAULT_CFG)
    try:
        if CONFIG_PATH.exists():
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig")))
    except Exception:
        log("读取配置失败：\n" + traceback.format_exc())
    return cfg


def save_cfg(cfg: dict) -> None:
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(CONFIG_PATH)
    except Exception:
        log("保存配置失败：\n" + traceback.format_exc())


# --------------------------------------------------------------------------- #
# 开机自启
# --------------------------------------------------------------------------- #
def _startup_dir() -> Path:
    return (
        Path(os.environ.get("APPDATA", ""))
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Startup"
    )


def set_autostart(enabled: bool) -> bool:
    lnk = _startup_dir() / "EvoPet.lnk"
    try:
        if not enabled:
            lnk.unlink(missing_ok=True)
            return True
        pyw = Path(sys.executable)
        if pyw.name.lower() != "pythonw.exe":
            cand = pyw.with_name("pythonw.exe")
            if cand.exists():
                pyw = cand
        main_py = APP_DIR / "main.py"
        script = (
            "$ws = New-Object -ComObject WScript.Shell; "
            f"$s = $ws.CreateShortcut('{lnk}'); "
            f"$s.TargetPath = '{pyw}'; "
            f"$s.Arguments = '\"{main_py}\"'; "
            f"$s.WorkingDirectory = '{APP_DIR}'; "
            f"$s.IconLocation = '{pyw},0'; "
            "$s.WindowStyle = 7; "
            "$s.Save()"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            creationflags=0x08000000,
            timeout=25,
            check=False,
        )
        return lnk.exists()
    except Exception:
        log("设置自启失败：\n" + traceback.format_exc())
        return False


# --------------------------------------------------------------------------- #
# 托盘图标
# --------------------------------------------------------------------------- #
def make_icon(char_key: str) -> QIcon:
    size = 128
    img = QImage(size, size, QImage.Format_ARGB32_Premultiplied)
    img.fill(Qt.GlobalColor.transparent)
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    p.scale(size / 200.0, size / 200.0)
    st = PetState(t=0.0, breath=0.3, wag=1.0)
    CHARACTERS[char_key].paint(p, st)
    p.end()
    return QIcon(QPixmap.fromImage(img))


def main() -> int:
    QApplication.setApplicationName("EvoPet")
    QApplication.setQuitOnLastWindowClosed(False)
    app = QApplication(sys.argv)

    lock = QLockFile(str(CONFIG_PATH.parent / "evopet.lock"))
    lock.setStaleLockTime(30000)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not lock.tryLock(100):
        log("已有实例在运行，退出。")
        return 0

    cfg = load_cfg()
    bubble = SpeechBubble()
    pet = PetWindow(cfg, bubble, on_config_change=save_cfg)
    pet.autostart_handler = set_autostart
    pet.show()
    app.aboutToQuit.connect(lambda: save_cfg(pet.cfg))

    # 托盘
    tray = QSystemTrayIcon(make_icon(pet.char_key), app)
    tray.setToolTip("桌面宠物 · 左键显示/隐藏，右键菜单")

    def refresh_tray_menu() -> None:
        m = build_menu(pet)
        m.insertAction(m.actions()[0], _mk_show_hide())
        m.insertSeparator(m.actions()[1])
        tray.setContextMenu(m)

    def _mk_show_hide():
        from PySide6.QtGui import QAction

        act = QAction("显示 / 隐藏", pet)
        act.triggered.connect(lambda: (pet.hide() if pet.isVisible() else pet.show()))
        return act

    refresh_tray_menu()

    def on_tray(reason):
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            if pet.isVisible():
                pet.hide()
            else:
                pet.show()
                pet.say("我在这儿～", 1800)

    tray.activated.connect(on_tray)
    tray.show()

    # 换角色后托盘图标同步
    original_set_character = pet.set_character

    def set_character(key: str) -> None:
        original_set_character(key)
        tray.setIcon(make_icon(key))
        refresh_tray_menu()

    pet.set_character = set_character  # type: ignore[method-assign]

    # 本地控制通道：语音对话系统通过 127.0.0.1:<port> 驱动状态
    control = ControlServer(pet, int(cfg.get("control_port", 8756)), log=log, parent=app)
    control.start()

    def welcome() -> None:
        if cfg.get("seen"):
            pet.say("我回来啦，随时待命～", 2600)
        else:
            pet.say("你好！我是桌面宠物，双击我试试，右键有更多设置。", 5200)
            cfg["seen"] = True
            save_cfg(cfg)

    QTimer.singleShot(1200, welcome)

    log("启动成功")
    return app.exec()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        log("崩溃：\n" + traceback.format_exc())
        raise
