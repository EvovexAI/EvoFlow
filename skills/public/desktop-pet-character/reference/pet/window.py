"""桌面宠物主窗口：透明置顶、可拖拽、带行为状态机。"""
from __future__ import annotations

import math
import os
import random

from PySide6.QtCore import QPoint, QPointF, QRect, QRectF, Qt, QTimer
from PySide6.QtGui import (
    QCursor,
    QColor,
    QFont,
    QFontMetrics,
    QGuiApplication,
    QImage,
    QPainter,
    QPainterPath,
    QPen,
    QRegion,
)
from PySide6.QtWidgets import QWidget

from .characters import CHARACTERS
from .state import PetState

DESIGN = 200.0  # 设计空间

_TRACE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pet.log")


def _trace(msg: str) -> None:
    if not os.environ.get("PET_TRACE"):
        return
    import time

    try:
        with open(_TRACE_PATH, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except Exception:
        pass

LINES = {
    "fox": [
        "我是小九，尾巴还在长，别嫌少～",
        "桌面好安静，要不要一起发会儿呆？",
        "拖我一下试试？我不会咬人的。",
        "你已经坐很久啦，站起来动一动嘛。",
        "听说双击我会有惊喜。",
        "等九条尾巴长齐，我就厉害了！",
        "摸头收到，好感度 +1。",
    ],
    "ninja": [
        "我可是要成为火影的人！",
        "今天的修行任务：陪你写代码。",
        "这行代码……让影分身来写也行吧？",
        "先别急，吃碗拉面再说。",
        "护额歪了？帮我扶一下。",
        "每次编译通过，我都会变强一点。",
        "卷轴里记着：不要熬夜。",
    ],
    "xiaoxi": [
        "我在呢，慢慢说，不着急。",
        "刚写完一段，要不要一起看看？",
        "窗外的光好好，今天也一起加油吧。",
        "你说的每个字我都听着呢。",
        "累了就靠一会儿，我不吵你。",
        "代码会写完的，先喝口水。",
    ],
    "frost": [
        "我呼出来的气会结霜哦，要看看吗？",
        "雪原太安静了，我就跑来你桌面了。",
        "你的手好暖……借我趴一会儿。",
        "尾巴冻得有点硬，搓一搓就软了。",
        "别担心，我不怕冷，只怕没人理。",
        "今天的桌面，比雪原热闹多了。",
    ],
    "night": [
        "灯关掉以后，我的毛会亮一点点。",
        "你也没睡？那我们正好作伴。",
        "眼睛里的星星？一直都有啊。",
        "深夜的键盘声，听着很安心。",
        "再写十分钟就睡，说好了。",
        "我数过了，你今晚打了六千多次字。",
    ],
    "ninja_blue": [
        "水遁·桌面清理之术！",
        "水之国的忍者，也怕代码里的分号。",
        "这杯水……泼在 bug 上会不会好？",
        "别慌，浪再大也会退。",
        "我的护额是靛蓝的，认准了。",
        "水下憋气我能撑三分钟，你信吗？",
    ],
}

MODES = ("idle", "thinking", "coding", "listening", "answering")
MODE_LABELS = {
    "idle": "待机",
    "thinking": "思考中",
    "coding": "敲代码",
    "listening": "聆听中",
    "answering": "回答中",
}

_FALLBACK_LINES = LINES["fox"]
_FALLBACK_IDLE = "……（在发呆）"

IDLE_BUBBLE = {
    "fox": "……（在发呆）",
    "ninja": "……（在冥想修行）",
    "frost": "……（在接雪花）",
    "night": "……（在数星星）",
    "ninja_blue": "……（在水遁修行）",
}


def _region_from_alpha(img: QImage, step: int = 3, thresh: int = 10) -> QRegion:
    """把带 alpha 的画面转成逐块区域，用于窗口遮罩（透明处不挡鼠标）。"""
    a = img.convertToFormat(QImage.Format_Alpha8)
    w, h = a.width(), a.height()
    bpl = a.bytesPerLine()
    buf = bytes(a.constBits())
    reg = QRegion()
    for y0 in range(0, h, step):
        y1 = min(y0 + step, h)
        run_start = -1
        for x0 in range(0, w, step):
            x1 = min(x0 + step, w)
            hit = False
            for y in range(y0, y1):
                base = y * bpl
                if max(buf[base + x0: base + x1]) > thresh:
                    hit = True
                    break
            if hit and run_start < 0:
                run_start = x0
            elif not hit and run_start >= 0:
                reg = reg.united(QRegion(run_start, y0, x0 - run_start, y1 - y0))
                run_start = -1
        if run_start >= 0:
            reg = reg.united(QRegion(run_start, y0, w - run_start, y1 - y0))
    return reg


class PetWindow(QWidget):
    def __init__(self, config: dict, bubble: "SpeechBubble", on_config_change=None):
        super().__init__(None)
        self.cfg = config
        self.bubble = bubble
        self.on_config_change = on_config_change

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.OpenHandCursor)

        self.char_key = config.get("character", "fox")
        self.character = CHARACTERS[self.char_key]
        self.scale = float(config.get("scale", 1.25))

        self.st = PetState()
        self.t = 0.0
        self.breath_t = 0.0
        self.wag_t = 0.0
        # 对话状态：idle / thinking / coding / listening / answering
        self.mode = "idle"
        self.mode_since = 0.0

        # 眨眼
        self.blink_progress = -1.0
        self.next_blink = 2.0
        # 视线
        self.look_cur = QPointF(0, 0)
        self.look_target = QPointF(0, 0)
        self.next_glance = 3.0
        # 抬手 / 开心
        self.wave_until = -1.0
        self.happy_until = -1.0
        # 耳朵
        self.ear_until = -1.0
        # 拖拽 & 物理
        self.dragging = False
        self.drag_offset = QPoint(0, 0)
        self.press_pos = QPoint(0, 0)
        self.vy = 0.0
        self.falling = False
        # 巡逻
        self.walk_target_x: float | None = None
        self.next_action = 5.0
        self.last_interaction = 0.0
        self.asleep = False
        # 遮罩
        self._mask_cache: QRegion | None = None
        self._mask_t = 0.0
        self._frame = QImage()

        self._apply_size()

        self.timer = QTimer(self)
        self.timer.timeout.connect(self._tick)
        self.timer.start(30)

        self._restore_position()

    # ------------------------------------------------------------------ #
    # 尺寸 / 位置
    # ------------------------------------------------------------------ #
    def _apply_size(self) -> None:
        size = max(80, int(DESIGN * self.scale))
        self.resize(size, size)
        self._mask_cache = None
        self._frame = QImage()

    def _ground_y(self) -> int:
        scr = self.screen() or QGuiApplication.primaryScreen()
        return scr.availableGeometry().bottom() - self.height() + 1

    def _screen_rect(self) -> QRect:
        scr = self.screen() or QGuiApplication.primaryScreen()
        return scr.availableGeometry()

    def _restore_position(self) -> None:
        geo = self._screen_rect()
        pos = self.cfg.get("pos")
        x = pos[0] if pos else geo.center().x() - self.width() // 2
        y = pos[1] if pos else self._ground_y()
        self._clamp_to_screen(QPoint(int(x), int(y)))
        self.move(self._clamped)
        self.last_interaction = self.t

    def _clamp_to_screen(self, p: QPoint) -> None:
        geo = self._screen_rect()
        x = min(max(p.x(), geo.left() - 10), geo.right() - self.width() + 10)
        y = min(max(p.y(), geo.top()), geo.bottom() - self.height() + 10)
        self._clamped = QPoint(x, y)

    def moveEvent(self, ev):
        super().moveEvent(ev)
        if self.bubble.isVisible():
            self.bubble.follow(self)

    # ------------------------------------------------------------------ #
    # 每帧
    # ------------------------------------------------------------------ #
    def _tick(self) -> None:
        dt = 0.03
        self.t += dt
        st = self.st
        st.t = self.t          # 角色动画全靠它，漏了这一句所有动作都会卡在第 0 秒
        idle_for = self.t - self.last_interaction

        if self.asleep and idle_for > 0 and random.random() < 0.004:
            pass

        # 呼吸
        speed = 1.0 if not self.asleep else 0.45
        self.breath_t += dt * speed
        st.breath = math.sin(self.breath_t * 1.75)

        # 尾巴
        self.wag_t += dt * (3.4 if (self.happy_until > self.t) else 2.1)
        st.wag = self.wag_t

        # 眨眼
        if self.blink_progress < 0 and self.t >= self.next_blink and not self.asleep:
            self.blink_progress = 0.0
        if self.blink_progress >= 0:
            self.blink_progress += dt / 0.15
            p = self.blink_progress
            if p >= 1.0:
                self.blink_progress = -1.0
                st.blink = 0.0
                self.next_blink = self.t + random.uniform(2.2, 6.5)
            else:
                st.blink = 1.0 - abs(p * 2 - 1)

        # 视线：鼠标靠近时看着鼠标，否则随机张望
        cursor_near = False
        if self.isVisible() and not self.dragging:
            cur = QCursor.pos()
            center = self.mapToGlobal(QPoint(self.width() // 2, int(self.height() * 0.55)))
            dx = cur.x() - center.x()
            dy = cur.y() - center.y()
            if abs(dx) < 620 and abs(dy) < 520:
                cursor_near = True
                self.look_target = QPointF(
                    max(-1.0, min(1.0, dx / 320.0)),
                    max(-1.0, min(1.0, dy / 300.0)),
                )
        if self.t >= self.next_glance:
            self.next_glance = self.t + random.uniform(1.6, 4.5)
            if cursor_near:
                pass
            elif random.random() < 0.75:
                self.look_target = QPointF(random.uniform(-1, 1), random.uniform(-0.6, 0.6))
            else:
                self.look_target = QPointF(0, 0)
        self.look_cur = QPointF(
            self.look_cur.x() + (self.look_target.x() - self.look_cur.x()) * 0.12,
            self.look_cur.y() + (self.look_target.y() - self.look_cur.y()) * 0.12,
        )
        st.look = self.look_cur

        # 抬手 / 开心 / 耳朵
        st.wave = 0.75 if (self.wave_until > self.t or self.dragging) else 0.0
        st.happy = 1.0 if self.happy_until > self.t else 0.0
        st.ear = 1.0 if self.ear_until > self.t else 0.0

        # 困倦
        drowsy = idle_for > 100 and not self.dragging and self.mode == "idle"
        if drowsy and not self.asleep:
            self.asleep = True
        if not drowsy and self.asleep:
            self.asleep = False
        st.asleep = self.asleep
        st.blink_lid = 1.0 if self.asleep else 0.0
        st.mode = self.mode

        # 物理
        if self.falling:
            self.vy += 2600 * dt
            p = self.pos()
            ny = p.y() + self.vy * dt
            ground = self._ground_y()
            if ny >= ground:
                ny = ground
                if abs(self.vy) > 420:
                    self.vy = -self.vy * 0.32
                else:
                    self.vy = 0.0
                    self.falling = False
            self.move(p.x(), int(ny))
        elif not self.dragging and self.mode == "idle":
            self._patrol(dt)

        # 空闲行为
        if (not self.dragging and not self.falling and self.mode == "idle"
                and self.t >= self.next_action):
            self.next_action = self.t + random.uniform(6.0, 14.0)
            self._random_action()

        self.update()

        # 遮罩（透明区域不拦截鼠标）
        if self.t - self._mask_t > 0.15:
            self._mask_t = self.t
            self._sync_mask()

    def _patrol(self, dt: float) -> None:
        if self.walk_target_x is None:
            return
        x = self.pos().x()
        target = self.walk_target_x
        d = target - x
        if abs(d) < 2:
            self.walk_target_x = None
            return
        step = max(-120 * dt, min(120 * dt, d))
        nx = int(x + step)
        hop = abs(math.sin(self.t * 11)) * 3.5
        ground = self._ground_y()
        self.move(nx, int(ground - hop))
        if random.random() < 0.01:
            self.bubble.follow(self)

    def _random_action(self) -> None:
        if self.asleep:
            return
        r = random.random()
        if r < 0.22:
            self.say(random.choice(LINES.get(self.char_key, _FALLBACK_LINES)))
            self.happy_until = self.t + 1.2
        elif r < 0.40:
            self.wave_until = self.t + 1.1
        elif r < 0.55:
            self.ear_until = self.t + 0.6
        elif r < 0.75 and self.cfg.get("wander", True):
            geo = self._screen_rect()
            self.walk_target_x = random.randint(geo.left(), max(geo.left(), geo.right() - self.width()))
            self.bubble.hide()
        elif r < 0.85:
            self.say(IDLE_BUBBLE.get(self.char_key, _FALLBACK_IDLE), 2200)

    # ------------------------------------------------------------------ #
    # 绘制
    # ------------------------------------------------------------------ #
    def _render_frame(self) -> QImage:
        dpr = self.devicePixelRatioF()
        w, h = self.width(), self.height()
        iw, ih = int(w * dpr), int(h * dpr)
        if self._frame.width() != iw or self._frame.height() != ih:
            self._frame = QImage(iw, ih, QImage.Format_ARGB32_Premultiplied)
        self._frame.fill(Qt.GlobalColor.transparent)
        p = QPainter(self._frame)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        p.scale(iw / DESIGN, ih / DESIGN)
        self.character.paint(p, self.st)
        p.end()
        return self._frame

    def paintEvent(self, ev):
        img = self._render_frame()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        p.drawImage(QRectF(0, 0, self.width(), self.height()), img)
        p.end()

    def _sync_mask(self) -> None:
        if self._frame.isNull():
            return
        dpr = self.devicePixelRatioF()
        src = self._frame
        if abs(dpr - 1.0) > 0.01:
            src = src.scaled(
                int(self.width()),
                int(self.height()),
                Qt.AspectRatioMode.IgnoreAspectRatio,
                Qt.TransformationMode.FastTransformation,
            )
        reg = _region_from_alpha(src, step=3, thresh=10)
        if reg.isEmpty():
            return
        if reg == self._mask_cache:
            return
        self._mask_cache = reg
        self.setMask(reg)

    # ------------------------------------------------------------------ #
    # 交互
    # ------------------------------------------------------------------ #
    def _poke(self) -> None:
        self.last_interaction = self.t
        self.asleep = False
        self.happy_until = self.t + 1.4
        self.wave_until = self.t + 0.9
        self.say(random.choice(LINES.get(self.char_key, _FALLBACK_LINES)))
        self.next_action = self.t + random.uniform(8, 15)

    def hideEvent(self, ev):
        if self.bubble:
            self.bubble.hide()
        super().hideEvent(ev)

    def mousePressEvent(self, ev):
        if ev.button() == Qt.MouseButton.LeftButton:
            self.dragging = True
            self.falling = False
            self.vy = 0.0
            self.walk_target_x = None
            self.asleep = False
            self.last_interaction = self.t
            self.drag_offset = ev.globalPosition().toPoint() - self.pos()
            self.press_pos = ev.globalPosition().toPoint()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            if self.bubble.isVisible():
                self.bubble.hide()
            ev.accept()

    def mouseMoveEvent(self, ev):
        if self.dragging:
            self.move(ev.globalPosition().toPoint() - self.drag_offset)
            ev.accept()

    def mouseReleaseEvent(self, ev):
        if self.dragging:
            self.dragging = False
            self.setCursor(Qt.CursorShape.OpenHandCursor)
            moved = (ev.globalPosition().toPoint() - self.press_pos).manhattanLength()
            if moved < 5:
                self._poke()
            else:
                self.last_interaction = self.t
                self.falling = True
                self.vy = 0.0
                self._clamp_to_screen(self.pos())
                self._save_pos()
            ev.accept()

    def mouseDoubleClickEvent(self, ev):
        self._poke()
        self.happy_until = self.t + 2.0
        ev.accept()

    def wheelEvent(self, ev):
        delta = 0.12 if ev.angleDelta().y() > 0 else -0.12
        self.set_scale(self.scale + delta)
        ev.accept()

    def enterEvent(self, ev):
        self.setCursor(Qt.CursorShape.OpenHandCursor)

    def contextMenuEvent(self, ev):
        self.last_interaction = self.t
        menu = build_menu(self)
        menu.exec(ev.globalPos())

    # ------------------------------------------------------------------ #
    # 对外操作
    # ------------------------------------------------------------------ #
    def say(self, text: str, msec: int = 3600) -> None:
        self.bubble.say(text, msec)
        self.bubble.follow(self)
        # 说话时嘴巴要一直动，说完就闭嘴回待机（不然会对着空气一直张合）
        if self.mode == "answering":
            if getattr(self, "_say_timer", None) is not None:
                self._say_timer.stop()
            self._say_timer = QTimer(self)
            self._say_timer.setSingleShot(True)
            self._say_timer.timeout.connect(self._end_speaking)
            self._say_timer.start(max(600, int(msec)))

    def _end_speaking(self) -> None:
        if self.mode in ("answering", "listening"):
            self.set_mode("idle")

    def set_character(self, key: str) -> None:
        if key not in CHARACTERS:
            return
        self.char_key = key
        self.character = CHARACTERS[key]
        self.cfg["character"] = key
        self._mask_cache = None
        self._frame = QImage()
        self.update()
        self._changed()
        self.say(f"我是{self.character.name}，请多关照～", 2200)

    def set_mode(self, mode: str, text: str | None = None, msec: int = 3600) -> None:
        """切换对话状态。语音链路可以直接调用它驱动形象。"""
        if mode not in MODES:
            return
        changed = mode != self.mode
        self.mode = mode
        self.mode_since = self.t
        if mode != "idle":
            self.last_interaction = self.t
            self.asleep = False
            self.walk_target_x = None
            self.blink_progress = -1.0
        if text:
            self.say(text, msec)
        if changed:
            self.update()

    def set_scale(self, scale: float) -> None:
        scale = max(0.7, min(3.0, round(scale, 2)))
        if abs(scale - self.scale) < 0.01:
            return
        bottom = self.pos().y() + self.height()
        self.scale = scale
        self.cfg["scale"] = scale
        self._apply_size()
        self.move(self.pos().x(), bottom - self.height())
        self._save_pos()
        self._changed()

    def set_on_top(self, on: bool) -> None:
        self.cfg["ontop"] = on
        flags = self.windowFlags()
        if on:
            flags |= Qt.WindowType.WindowStaysOnTopHint
        else:
            flags &= ~Qt.WindowType.WindowStaysOnTopHint
        self.setWindowFlags(flags)
        self.show()
        self._changed()

    def toggle_sleep(self) -> None:
        self.asleep = not self.asleep
        self.st.asleep = self.asleep
        self.st.blink_lid = 1.0 if self.asleep else 0.0
        self.last_interaction = self.t if not self.asleep else self.t - 110
        self.say("那我睡一会儿……" if self.asleep else "醒了！继续干活。", 2200)

    def recenter(self) -> None:
        geo = self._screen_rect()
        self.move(geo.center().x() - self.width() // 2, self._ground_y())
        self._save_pos()

    def _save_pos(self) -> None:
        self.cfg["pos"] = [self.pos().x(), self.pos().y()]
        self._changed()

    def _changed(self) -> None:
        if self.on_config_change:
            self.on_config_change(self.cfg)


class SpeechBubble(QWidget):
    """独立的气泡窗口，不抢焦点、点击穿透。"""

    def __init__(self):
        super().__init__(None)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
            | Qt.WindowType.WindowDoesNotAcceptFocus
            | Qt.WindowType.WindowTransparentForInput
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.text = ""
        self.font = QFont("Microsoft YaHei UI", 10)
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(self.hide)

    def say(self, text: str, msec: int = 3600) -> None:
        self.text = text
        self._resize_for_text()
        self.show()
        self.raise_()
        self.timer.start(msec)
        self.update()
        _trace(f"bubble.show text={text[:12]!r} vis={self.isVisible()} pos={self.x()},{self.y()} size={self.width()}x{self.height()} msec={msec}")

    def hideEvent(self, ev):
        _trace("bubble.hideEvent")
        super().hideEvent(ev)

    def _resize_for_text(self) -> None:
        fm = QFontMetrics(self.font)
        max_text_w = 232
        natural = fm.horizontalAdvance(self.text)
        if natural <= max_text_w:
            w = natural
            h = fm.height()
        else:
            rect = fm.boundingRect(
                QRect(0, 0, max_text_w, 2000),
                int(Qt.TextFlag.TextWordWrap),
                self.text,
            )
            w = max_text_w
            h = rect.height()
        self.resize(w + 30, h + 26 + 10)

    def follow(self, pet: QWidget) -> None:
        if not self.isVisible():
            return
        geo = (pet.screen() or QGuiApplication.primaryScreen()).availableGeometry()
        x = pet.pos().x() + pet.width() // 2 - self.width() // 2
        y = pet.pos().y() - self.height() + 8
        x = min(max(x, geo.left() + 4), geo.right() - self.width() - 4)
        if y < geo.top() + 4:
            y = pet.pos().y() + pet.height() - 6
        self.move(x, y)

    def paintEvent(self, ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        w, h = self.width(), self.height()
        body = QRectF(1, 1, w - 2, h - 12)

        # 柔和投影
        p.setPen(Qt.PenStyle.NoPen)
        for i, alpha in enumerate((16, 12, 8)):
            p.setBrush(QColor(20, 30, 50, alpha))
            p.drawRoundedRect(body.adjusted(-i, -i + 2, i, i + 2), 10 + i, 10 + i)

        path = QPainterPath()
        path.addRoundedRect(body, 10, 10)
        tail = QPainterPath()
        cx = w / 2
        tail.moveTo(cx - 6, body.bottom() - 1)
        tail.lineTo(cx + 1, h - 1)
        tail.lineTo(cx + 7, body.bottom() - 1)
        tail.closeSubpath()
        path = path.united(tail)

        p.setBrush(QColor(252, 253, 255, 246))
        p.setPen(QPen(QColor(120, 140, 170, 90), 1.2))
        p.drawPath(path)

        p.setPen(QColor(38, 46, 60))
        p.setFont(self.font)
        p.drawText(
            body.adjusted(13, 12, -13, -8),
            int(Qt.TextFlag.TextWordWrap | Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter),
            self.text,
        )
        p.end()


def _toggle_autostart(pet: PetWindow, enabled: bool) -> None:
    pet.cfg["autostart"] = enabled
    handler = getattr(pet, "autostart_handler", None)
    if handler:
        ok = handler(enabled)
        pet.say("已设置为开机自启" if ok else "开机自启设置失败（可手动放快捷方式）", 2600)
    pet._changed()


def build_menu(pet: PetWindow):
    from PySide6.QtGui import QAction
    from PySide6.QtWidgets import QMenu

    cfg = pet.cfg
    menu = QMenu()

    sub = menu.addMenu("换个角色")
    groups = [("狐狸", "fox"), ("忍者", "ninja")]
    for label, species in groups:
        g = sub.addMenu(label)
        for key, ch in CHARACTERS.items():
            if ch.species != species:
                continue
            act = QAction(ch.name, g)
            act.setCheckable(True)
            act.setChecked(pet.char_key == key)
            act.setToolTip(ch.desc)
            act.triggered.connect(lambda _=False, k=key: pet.set_character(k))
            g.addAction(act)
    sub.addSeparator()
    for key, ch in CHARACTERS.items():
        if ch.species in ("fox", "ninja"):
            continue
        act = QAction(ch.name, sub)
        act.setCheckable(True)
        act.setChecked(pet.char_key == key)
        act.triggered.connect(lambda _=False, k=key: pet.set_character(k))
        sub.addAction(act)

    sub_m = menu.addMenu("对话状态")
    for key in ("thinking", "coding", "listening", "answering", "idle"):
        act = QAction(MODE_LABELS[key], sub_m)
        act.setCheckable(True)
        act.setChecked(getattr(pet, "mode", "idle") == key)
        act.triggered.connect(lambda _=False, k=key: pet.set_mode(k))
        sub_m.addAction(act)

    sub2 = menu.addMenu("大小")
    for label, val in [("迷你", 0.9), ("适中", 1.25), ("较大", 1.7), ("超大", 2.2)]:
        act = QAction(label, sub2)
        act.setCheckable(True)
        act.setChecked(abs(pet.scale - val) < 0.06)
        act.triggered.connect(lambda _=False, v=val: pet.set_scale(v))
        sub2.addAction(act)

    menu.addSeparator()
    act = QAction("说句话", menu)
    act.triggered.connect(lambda: pet._poke())
    menu.addAction(act)

    act = QAction("叫醒 / 哄睡", menu)
    act.triggered.connect(pet.toggle_sleep)
    menu.addAction(act)

    act = QAction("走过来", menu)
    act.triggered.connect(lambda: pet.recenter())
    menu.addAction(act)

    menu.addSeparator()
    act = QAction("随意走动", menu)
    act.setCheckable(True)
    act.setChecked(bool(cfg.get("wander", True)))
    act.triggered.connect(lambda c: (cfg.__setitem__("wander", c), pet._changed()))
    menu.addAction(act)

    act = QAction("始终置顶", menu)
    act.setCheckable(True)
    act.setChecked(bool(cfg.get("ontop", True)))
    act.triggered.connect(lambda c: pet.set_on_top(c))
    menu.addAction(act)

    act = QAction("开机自启", menu)
    act.setCheckable(True)
    act.setChecked(bool(cfg.get("autostart", False)))
    act.triggered.connect(lambda c: _toggle_autostart(pet, c))
    menu.addAction(act)

    menu.addSeparator()
    act = QAction("隐藏（托盘里找我）", menu)
    act.triggered.connect(pet.hide)
    menu.addAction(act)

    act = QAction("退出", menu)
    act.triggered.connect(lambda: QGuiApplication.quit())
    menu.addAction(act)
    return menu
