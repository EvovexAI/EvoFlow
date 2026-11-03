"""角色矢量绘制。

全部使用 QPainter 手绘，无任何图片资源依赖，任意分辨率下都是清晰的。
设计空间固定为 200x200（左上角原点，宠物脚底 y≈192）。
"""
from __future__ import annotations

import math
import os

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import (
    QBrush,
    QColor,
    QImage,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
    QRadialGradient,
)

D = 200.0


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #
def _rgba(hexcolor: str, alpha: int = 255) -> QColor:
    c = QColor(hexcolor)
    c.setAlpha(alpha)
    return c


def _with_alpha(color, alpha: int = 255) -> QColor:
    """基于已有颜色（QColor 或 #hex）生成带透明度的副本。"""
    c = QColor(color)
    c.setAlpha(alpha)
    return c


def _sparkle(p: QPainter, x: float, y: float, r: float, color: QColor, phase: float) -> None:
    """四角星闪光，phase 控制呼吸般的明暗与大小；外面套一层柔光，浅色桌面上也看得见。"""
    k = 0.5 + 0.5 * math.sin(phase)
    p.save()
    p.setPen(Qt.NoPen)

    glow = QRadialGradient(QPointF(x, y), r * 2.4)
    glow.setColorAt(0.0, _with_alpha(color, int(70 * k + 25)))
    glow.setColorAt(1.0, _with_alpha(color, 0))
    p.setBrush(QBrush(glow))
    p.drawEllipse(QPointF(x, y), r * 2.4, r * 2.4)

    c = QColor(color)
    c.setAlpha(int(255 * (0.35 + 0.65 * k)))
    p.setBrush(c)
    rr = r * (0.7 + 0.3 * k)
    star = QPainterPath()
    star.moveTo(x, y - rr)
    star.quadTo(x + rr * 0.16, y - rr * 0.16, x + rr, y)
    star.quadTo(x + rr * 0.16, y + rr * 0.16, x, y + rr)
    star.quadTo(x - rr * 0.16, y + rr * 0.16, x - rr, y)
    star.quadTo(x - rr * 0.16, y - rr * 0.16, x, y - rr)
    p.drawPath(star)
    p.restore()


def _soft_pen(color: QColor, width: float = 1.6) -> QPen:
    pen = QPen(color, width)
    pen.setCapStyle(Qt.RoundCap)
    pen.setJoinStyle(Qt.RoundJoin)
    return pen


def _leaf(length: float, half_w: float, bend: float = 0.0) -> QPainterPath:
    """一条蓬松的尾巴：根部收窄、末端圆钝，bend 让它卷曲。原点在根部，朝 -y 延伸。"""
    path = QPainterPath()
    path.moveTo(0, 0)
    path.cubicTo(
        half_w * 1.12 + bend * 0.15, -length * 0.24,
        half_w * 0.95 + bend * 0.65, -length * 0.66,
        half_w * 0.58 + bend * 0.95, -length * 0.88,
    )
    path.cubicTo(
        half_w * 0.26 + bend, -length * 1.02,
        -half_w * 0.26 + bend, -length * 1.02,
        -half_w * 0.58 + bend * 0.95, -length * 0.88,
    )
    path.cubicTo(
        -half_w * 0.95 + bend * 0.65, -length * 0.66,
        -half_w * 1.12 + bend * 0.15, -length * 0.24,
        0, 0,
    )
    return path


def _spiral(cx: float, cy: float, r0: float, turns: float = 1.55, steps: int = 40) -> QPainterPath:
    path = QPainterPath()
    for i in range(steps + 1):
        a = -math.pi * 0.5 + turns * 2 * math.pi * (i / steps)
        r = r0 * (1.0 - 0.72 * i / steps)
        x = cx + math.cos(a) * r
        y = cy + math.sin(a) * r
        if i == 0:
            path.moveTo(x, y)
        else:
            path.lineTo(x, y)
    return path


def _smile(cx: float, cy: float, half_w: float, depth: float) -> QPainterPath:
    path = QPainterPath(QPointF(cx - half_w, cy))
    path.quadTo(QPointF(cx, cy + depth * 2), QPointF(cx + half_w, cy))
    return path


def draw_eye(
    p: QPainter,
    x: float,
    y: float,
    rx: float,
    ry: float,
    blink: float,
    look: QPointF,
    iris: QColor,
    dark: QColor,
    happy_closed: bool = False,
) -> None:
    """画一只大眼。blink: 0 全睁 ~ 1 全闭。"""
    if blink > 0.86 or happy_closed:
        p.setBrush(Qt.NoBrush)
        p.setPen(_soft_pen(dark, max(2.4, rx * 0.28)))
        path = QPainterPath(QPointF(x - rx * 0.95, y + ry * 0.10))
        path.quadTo(QPointF(x, y + ry * 0.85), QPointF(x + rx * 0.95, y + ry * 0.10))
        p.drawPath(path)
        return

    hh = ry * (1.0 - 0.93 * blink)
    cy = y + (ry - hh) * 0.35

    # 眼白/眼窝的柔和阴影
    p.setPen(Qt.NoPen)
    p.setBrush(_rgba("#000000", 26))
    p.drawEllipse(QPointF(x, cy + 1.5), rx * 1.02, hh * 1.02)

    # 眼球
    grad = QLinearGradient(x, cy - hh, x, cy + hh)
    grad.setColorAt(0.0, dark)
    grad.setColorAt(0.55, dark)
    grad.setColorAt(1.0, iris)
    p.setBrush(QBrush(grad))
    p.drawEllipse(QPointF(x, cy), rx, hh)

    # 下半部高光（让眼睛有玻璃感）
    p.setBrush(_rgba("#FFFFFF", 70))
    p.setPen(Qt.NoPen)
    p.drawEllipse(QPointF(x, cy + hh * 0.42), rx * 0.62, hh * 0.34)

    if hh > ry * 0.35:
        # 瞳孔
        px = x + look.x() * rx * 0.22
        py = cy + look.y() * hh * 0.18
        p.setBrush(_rgba("#000000", 150))
        p.drawEllipse(QPointF(px, py - hh * 0.10), rx * 0.42, hh * 0.40)
        # 主高光
        p.setBrush(_rgba("#FFFFFF", 240))
        p.drawEllipse(QPointF(x - rx * 0.30, cy - hh * 0.38), rx * 0.34, hh * 0.26)
        # 次高光
        p.setBrush(_rgba("#FFFFFF", 160))
        p.drawEllipse(QPointF(x + rx * 0.36, cy + hh * 0.30), rx * 0.16, hh * 0.13)


def draw_blush(p: QPainter, x: float, y: float, rx: float, ry: float, alpha: int = 90,
               color: str = "#FF7B8A") -> None:
    p.setPen(Qt.NoPen)
    grad = QRadialGradient(QPointF(x, y), rx)
    grad.setColorAt(0.0, _rgba(color, alpha))
    grad.setColorAt(1.0, _rgba(color, 0))
    p.setBrush(QBrush(grad))
    p.drawEllipse(QPointF(x, y), rx, ry)


# --------------------------------------------------------------------------- #
# 角色基类
# --------------------------------------------------------------------------- #
class Character:
    name = "角色"
    desc = ""
    species = "other"   # 用于菜单分组
    # 用于窗口遮罩裁剪的轮廓（设计坐标，多个椭圆），范围覆盖所有动作
    silhouette = [
        (100.0, 152.0, 46.0, 46.0),
        (100.0, 96.0, 60.0, 62.0),
    ]
    ground_y = 192.0

    # 可选：环绕角色的小星光（蓝色系角色用，原色角色留空）
    sparkles = ()          # ((x, y, r, phase), ...)
    sparkle_color = None

    def draw_sparkles(self, p: QPainter, st) -> None:
        if not self.sparkle_color or not self.sparkles:
            return
        for x, y, r, ph in self.sparkles:
            _sparkle(p, x, y + math.sin(st.t * 1.1 + ph) * 2.2, r,
                     self.sparkle_color, st.t * 2.2 + ph)

    def paint(self, p: QPainter, st) -> None:  # pragma: no cover - 子类实现
        raise NotImplementedError


# --------------------------------------------------------------------------- #
# 小九 —— 迷你九尾狐
# --------------------------------------------------------------------------- #
class Fox(Character):
    species = "fox"
    name = "小九"
    desc = "一只还没长出第九条尾巴的小九尾狐，脾气很好，喜欢被拖着走。"
    ground_y = 192.0
    silhouette = [
        (100.0, 152.0, 46.0, 48.0),
        (100.0, 100.0, 54.0, 56.0),
        (46.0, 120.0, 34.0, 76.0),
        (154.0, 120.0, 34.0, 76.0),
    ]

    FUR_DARK = QColor("#E2582F")
    FUR = QColor("#FB8B4F")
    FUR_HI = QColor("#FFBE8A")
    CREAM = QColor("#FFF3E3")
    EAR_IN = QColor("#FFB3A1")
    INK = QColor("#4A2A18")
    IRIS = QColor("#F2A03C")
    EDGE = QColor("#8A3A18")        # 统一描边色
    NOSE = QColor("#C4573A")
    SHADOW = QColor("#3A1A0A")
    BLUSH = QColor("#FF7B8A")

    # ---- 组件 ----
    def _tail(self, p: QPainter, base: QPointF, angle: float, length: float,
              half_w: float, bend: float = 0.0) -> None:
        p.save()
        p.translate(base)
        p.rotate(angle)
        path = _leaf(length, half_w, bend)
        grad = QLinearGradient(0, 0, 0, -length)
        grad.setColorAt(0.0, self.FUR_DARK)
        grad.setColorAt(0.55, self.FUR)
        grad.setColorAt(1.0, self.FUR_HI)
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 55), 1.4))
        p.setBrush(QBrush(grad))
        p.drawPath(path)

        # 尾巴尖的奶白色
        p.save()
        p.setClipPath(path)
        p.setPen(Qt.NoPen)
        p.setBrush(self.CREAM)
        p.drawEllipse(QPointF(bend * 0.97, -length * 0.92), half_w * 0.56, half_w * 0.60)
        p.restore()

        # 尾巴内侧高光
        p.save()
        p.setClipPath(path)
        p.setPen(Qt.NoPen)
        p.setBrush(_rgba("#FFFFFF", 40))
        p.drawEllipse(QPointF(-half_w * 0.30 + bend * 0.3, -length * 0.45), half_w * 0.40, length * 0.30)
        p.restore()
        p.restore()

    def paint(self, p: QPainter, st) -> None:
        breath = st.breath          # -1..1
        blink = max(st.blink, st.blink_lid)
        look = st.look
        wag = st.wag                # 弧度摆动

        body_lift = breath * 1.6
        head_lift = breath * 2.2
        squash = 1.0 + breath * 0.012

        # ---------- 尾巴（身后，围着身体卷起来）----------
        for bx, by, base_ang, ln, hw, bend, ph in [
            (86, 182, -64, 86, 17.0, 18, 0.0),
            (96, 186, -36, 94, 17.0, 12, 0.7),
            (106, 186, 32, 94, 17.0, -12, 1.4),
            (114, 182, 60, 86, 17.0, -18, 2.1),
        ]:
            ang = base_ang + math.sin(wag + ph) * 5.0
            self._tail(p, QPointF(bx, by + body_lift), ang, ln, hw, bend)

        # ---------- 影子 ----------
        p.setPen(Qt.NoPen)
        shadow = QRadialGradient(QPointF(100, 190), 46)
        shadow.setColorAt(0.0, _with_alpha(self.SHADOW, 70))
        shadow.setColorAt(1.0, _with_alpha(self.SHADOW, 0))
        p.setBrush(QBrush(shadow))
        p.drawEllipse(QPointF(100, 190), 46, 12)

        # ---------- 身体 ----------
        p.save()
        p.translate(100, 158 + body_lift)
        p.scale(1.0, squash)
        p.translate(-100, -(158 + body_lift))

        body = QRectF(66, 122, 68, 66)
        grad = QLinearGradient(66, 120, 134, 190)
        grad.setColorAt(0.0, self.FUR_HI)
        grad.setColorAt(0.45, self.FUR)
        grad.setColorAt(1.0, self.FUR_DARK)
        p.setBrush(QBrush(grad))
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 60), 1.5))
        p.drawEllipse(body)

        # 肚皮
        p.setPen(Qt.NoPen)
        p.setBrush(self.CREAM)
        p.drawEllipse(QRectF(80, 140, 40, 46))

        # 前爪
        for fx in (80, 120):
            p.setBrush(self.CREAM)
            p.setPen(_soft_pen(_with_alpha(self.EDGE, 45), 1.2))
            p.drawEllipse(QPointF(fx, 182), 15, 9.5)
            p.setPen(_soft_pen(_with_alpha(self.EDGE, 40), 1.2))
            for k in (-4, 4):
                p.drawLine(QPointF(fx + k, 177), QPointF(fx + k, 184))
        p.restore()

        # ---------- 手臂 ----------
        wave = st.wave  # 0..1
        left_arm_ang = -18 - wave * 105
        p.save()
        p.translate(68, 148 + body_lift)
        p.rotate(left_arm_ang)
        p.setBrush(self.FUR_DARK)
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 95), 1.4))
        p.drawRoundedRect(QRectF(-9, -5, 21, 16), 8, 8)
        p.setBrush(self.CREAM)
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 60), 1.1))
        p.drawEllipse(QPointF(9, 3), 7.2, 6.8)
        p.restore()

        p.save()
        p.translate(132, 148 + body_lift)
        p.rotate(16)
        p.setBrush(self.FUR_DARK)
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 95), 1.4))
        p.drawRoundedRect(QRectF(-12, -5, 21, 16), 8, 8)
        p.setBrush(self.CREAM)
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 60), 1.1))
        p.drawEllipse(QPointF(-9, 3), 7.2, 6.8)
        p.restore()

        # ---------- 头 ----------
        hcx, hcy = 100, 100 + head_lift
        head_r = 47.0

        # 耳朵
        for side in (-1, 1):
            p.save()
            p.translate(hcx + side * 30, hcy - 32)
            p.rotate(side * (10 + st.ear * 6))
            ear = QPainterPath()
            ear.moveTo(-15, 12)
            ear.cubicTo(-13, -20, -4, -40, 4 * side, -46)
            ear.cubicTo(10, -30, 18, -4, 16, 12)
            ear.closeSubpath()
            grad = QLinearGradient(0, 12, 0, -44)
            grad.setColorAt(0.0, self.FUR)
            grad.setColorAt(1.0, self.FUR_DARK)
            p.setBrush(QBrush(grad))
            p.setPen(_soft_pen(_with_alpha(self.EDGE, 70), 1.6))
            p.drawPath(ear)
            inner = QPainterPath()
            inner.moveTo(-7, 8)
            inner.cubicTo(-6, -10, -1, -26, 3 * side, -32)
            inner.cubicTo(7, -18, 11, 0, 9, 8)
            inner.closeSubpath()
            p.setPen(Qt.NoPen)
            p.setBrush(self.EAR_IN)
            p.drawPath(inner)
            p.restore()

        # 头
        head_grad = QRadialGradient(QPointF(hcx - 16, hcy - 20), head_r * 1.7)
        head_grad.setColorAt(0.0, self.FUR_HI)
        head_grad.setColorAt(0.55, self.FUR)
        head_grad.setColorAt(1.0, self.FUR_DARK)
        p.setBrush(QBrush(head_grad))
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 65), 1.7))
        p.drawEllipse(QPointF(hcx, hcy), head_r, head_r * 0.98)

        # 头顶呆毛
        p.setPen(Qt.NoPen)
        p.setBrush(self.FUR)
        tuft = QPainterPath()
        tuft.moveTo(hcx - 11, hcy - head_r * 0.94)
        tuft.cubicTo(hcx - 17, hcy - 60, hcx - 4, hcy - 58, hcx + 2, hcy - 68)
        tuft.cubicTo(hcx + 10, hcy - 58, hcx + 12, hcy - 52, hcx + 9, hcy - head_r * 0.92)
        tuft.closeSubpath()
        p.drawPath(tuft)

        # 面部的奶油色区域
        face = QPainterPath()
        face.moveTo(hcx - 34, hcy + 6)
        face.cubicTo(hcx - 32, hcy + 40, hcx + 32, hcy + 40, hcx + 34, hcy + 6)
        face.cubicTo(hcx + 28, hcy + 18, hcx - 28, hcy + 18, hcx - 34, hcy + 6)
        p.setBrush(_with_alpha(self.CREAM, 220))
        p.drawPath(face)

        # 腮红
        draw_blush(p, hcx - 33, hcy + 17, 13, 8, 95, self.BLUSH)
        draw_blush(p, hcx + 33, hcy + 17, 13, 8, 95, self.BLUSH)

        # 眼睛
        draw_eye(p, hcx - 20, hcy + 4, 11.5, 13.0, blink, look, self.IRIS, self.INK,
                 happy_closed=st.happy > 0.6)
        draw_eye(p, hcx + 20, hcy + 4, 11.5, 13.0, blink, look, self.IRIS, self.INK,
                 happy_closed=st.happy > 0.6)

        # 鼻子 + 嘴
        p.setPen(Qt.NoPen)
        nose = QPainterPath()
        nose.moveTo(hcx - 4.5, hcy + 25)
        nose.quadTo(hcx, hcy + 22, hcx + 4.5, hcy + 25)
        nose.quadTo(hcx, hcy + 31, hcx - 4.5, hcy + 25)
        p.setBrush(self.NOSE)
        p.drawPath(nose)

        p.setBrush(Qt.NoBrush)
        p.setPen(_soft_pen(self.INK, 2.0))
        if st.asleep:
            p.drawEllipse(QPointF(hcx, hcy + 34), 4.0, 3.0)
        else:
            mouth = QPainterPath(QPointF(hcx - 7, hcy + 30))
            mouth.quadTo(QPointF(hcx - 3.5, hcy + 35), QPointF(hcx, hcy + 30))
            mouth.quadTo(QPointF(hcx + 3.5, hcy + 35), QPointF(hcx + 7, hcy + 30))
            p.drawPath(mouth)

        # 胡须
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 110), 1.4))
        for side in (-1, 1):
            for k, (dy, ln) in enumerate([(-2, 13), (3, 12)]):
                sx = hcx + side * 26
                p.drawLine(QPointF(sx, hcy + 16 + dy), QPointF(sx + side * ln, hcy + 12 + dy * 1.6))

        self.draw_sparkles(p, st)


# --------------------------------------------------------------------------- #
# 小鸣 —— 火影风格Q版忍者
# --------------------------------------------------------------------------- #
class Ninja(Character):
    species = "ninja"
    name = "小鸣"
    desc = "戴护额的Q版忍者，梦想是当上火影，但现在是你的桌面挂件。"
    ground_y = 192.0
    silhouette = [
        (100.0, 154.0, 44.0, 46.0),
        (100.0, 100.0, 54.0, 56.0),
    ]

    SKIN = QColor("#FFE0C2")
    SKIN_D = QColor("#F0BE97")
    HAIR = QColor("#F7C63F")
    HAIR_D = QColor("#DFA520")
    SUIT = QColor("#F97316")
    SUIT_D = QColor("#D65A0C")
    NAVY = QColor("#2C3B66")
    METAL = QColor("#CDD3DC")
    INK = QColor("#2A2A33")
    IRIS = QColor("#4A90E2")
    EDGE = QColor("#7A2E05")        # 外套描边
    SHADOW = QColor("#1A1A2A")
    COLLAR = QColor("#F3F5F8")      # 领口白
    SKIN_HI = QColor("#FFF0DC")     # 皮肤高光
    EDGE_SKIN = QColor("#8A5A35")   # 脸部描边
    METAL_HI = QColor("#F0F3F7")
    METAL_LO = QColor("#AEB6C0")
    METAL_EDGE = QColor("#5B6470")
    WHISKER = QColor("#C98A5E")
    BLUSH = QColor("#FF7B8A")

    def paint(self, p: QPainter, st) -> None:
        breath = st.breath
        blink = max(st.blink, st.blink_lid)
        look = st.look
        body_lift = breath * 1.5
        head_lift = breath * 2.0

        # 影子
        p.setPen(Qt.NoPen)
        shadow = QRadialGradient(QPointF(100, 190), 44)
        shadow.setColorAt(0.0, _with_alpha(self.SHADOW, 70))
        shadow.setColorAt(1.0, _with_alpha(self.SHADOW, 0))
        p.setBrush(QBrush(shadow))
        p.drawEllipse(QPointF(100, 190), 44, 11)

        # 身体（外套）
        body = QPainterPath()
        body.moveTo(70, 132)
        body.cubicTo(66, 168, 74, 186, 100, 186)
        body.cubicTo(126, 186, 134, 168, 130, 132)
        body.cubicTo(120, 124, 80, 124, 70, 132)
        grad = QLinearGradient(70, 120, 130, 190)
        grad.setColorAt(0.0, self.SUIT)
        grad.setColorAt(1.0, self.SUIT_D)
        p.setBrush(QBrush(grad))
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 70), 1.5))
        p.drawPath(body)

        # 拉链
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 90), 1.6))
        p.drawLine(QPointF(100, 128), QPointF(100, 184))

        # 衣领（在头部下方露出来）
        p.setBrush(self.NAVY)
        p.setPen(Qt.NoPen)
        collar = QPainterPath()
        collar.moveTo(78, 144)
        collar.cubicTo(88, 161, 112, 161, 122, 144)
        collar.cubicTo(112, 138, 88, 138, 78, 144)
        p.drawPath(collar)

        # 肩部深色拼接（贴着外套轮廓裁切）
        p.save()
        p.setClipPath(body)
        p.setBrush(self.NAVY)
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(66, 146), 20, 16)
        p.drawEllipse(QPointF(134, 146), 20, 16)
        p.restore()

        # 白色领口
        p.setBrush(self.COLLAR)
        p.setPen(Qt.NoPen)
        vee = QPainterPath()
        vee.moveTo(90, 145)
        vee.lineTo(100, 161)
        vee.lineTo(110, 145)
        vee.cubicTo(104, 152, 96, 152, 90, 145)
        p.drawPath(vee)

        # 腿/脚
        for fx in (84, 116):
            p.setBrush(self.NAVY)
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(fx, 182), 14, 7.5)

        # 手臂
        wave = st.wave
        p.save()
        p.translate(69, 140 + body_lift)
        p.rotate(-16 - wave * 108)
        p.setBrush(self.SUIT)
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 60), 1.3))
        p.drawRoundedRect(QRectF(-8, -6, 18, 34), 8, 8)
        p.setBrush(self.SKIN)
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(1, 28), 7.5, 7.0)
        p.restore()

        p.save()
        p.translate(131, 140 + body_lift)
        p.rotate(14)
        p.setBrush(self.SUIT)
        p.setPen(_soft_pen(_with_alpha(self.EDGE, 60), 1.3))
        p.drawRoundedRect(QRectF(-10, -6, 18, 34), 8, 8)
        p.setBrush(self.SKIN)
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(-1, 28), 7.5, 7.0)
        p.restore()

        # 护额飘带（画在头后面，两条垂在右后方）
        hcx, hcy = 100, 98 + head_lift
        r = 44.0
        p.setPen(Qt.NoPen)
        for x0, y0, ln, wd, alpha in [
            (hcx + 36, hcy - 20, 46, 8.5, 255),
            (hcx + 30, hcy - 14, 36, 6.5, 205),
        ]:
            p.setBrush(_with_alpha(self.NAVY, alpha))
            ribbon = QPainterPath()
            ribbon.moveTo(x0, y0 - wd * 0.5)
            ribbon.cubicTo(x0 + 20, y0 + 4, x0 + 26, y0 + ln * 0.7, x0 + 18, y0 + ln)
            ribbon.cubicTo(x0 + 14, y0 + ln * 0.55, x0 + 8, y0 + wd * 0.9, x0, y0 + wd * 0.5)
            ribbon.closeSubpath()
            p.drawPath(ribbon)

        # 后脑的头发底
        p.setPen(Qt.NoPen)
        p.setBrush(self.HAIR_D)
        p.drawEllipse(QPointF(hcx, hcy - 4), r * 1.04, r * 1.04)

        # 头
        skin_grad = QRadialGradient(QPointF(hcx - 14, hcy - 18), r * 1.7)
        skin_grad.setColorAt(0.0, self.SKIN_HI)
        skin_grad.setColorAt(0.6, self.SKIN)
        skin_grad.setColorAt(1.0, self.SKIN_D)
        p.setBrush(QBrush(skin_grad))
        p.setPen(_soft_pen(_with_alpha(self.EDGE_SKIN, 55), 1.5))
        p.drawEllipse(QPointF(hcx, hcy), r, r * 0.99)

        # 头发：顶部覆盖 + 尖刺
        p.save()
        p.setPen(Qt.NoPen)
        p.setBrush(self.HAIR)
        cap = QPainterPath()
        cap.moveTo(hcx - r * 1.02, hcy + 10)
        cap.cubicTo(hcx - r * 1.10, hcy - 40, hcx - 22, hcy - 40, hcx, hcy - 40)
        cap.cubicTo(hcx + 24, hcy - 40, hcx + r * 1.10, hcy - 42, hcx + r * 1.02, hcy + 8)
        cap.cubicTo(hcx + 36, hcy - 14, hcx + 14, hcy - 24, hcx, hcy - 22)
        cap.cubicTo(hcx - 16, hcy - 24, hcx - 36, hcy - 14, hcx - r * 1.02, hcy + 10)
        cap.closeSubpath()
        p.drawPath(cap)

        # 不规则的发尖（左中右长度错落，避免放射状"太阳"感）
        for ang_deg, ln, spread, skew in [
            (-166, 14, 13, -4), (-146, 26, 15, -6), (-124, 18, 14, -2),
            (-104, 30, 15, 3), (-84, 20, 14, 5), (-62, 27, 15, 6),
            (-40, 16, 13, 5), (-22, 11, 11, 4),
        ]:
            a = math.radians(ang_deg)
            bx = hcx + math.cos(a) * r * 0.96
            by = hcy - 4 + math.sin(a) * r * 0.96
            tipx = hcx + math.cos(a) * (r + ln) + skew
            tipy = hcy - 4 + math.sin(a) * (r + ln)
            nx = -math.sin(a)
            ny = math.cos(a)
            spike = QPainterPath()
            spike.moveTo(bx + nx * spread, by + ny * spread)
            spike.quadTo(tipx - nx * 1.5, tipy - ny * 1.5, tipx, tipy)
            spike.quadTo(tipx + nx * 1.5, tipy + ny * 1.5, bx - nx * spread, by - ny * spread)
            spike.closeSubpath()
            p.drawPath(spike)
        p.restore()

        # 护额
        band = QPainterPath()
        band.moveTo(hcx - r * 0.99, hcy - 26)
        band.cubicTo(hcx - 20, hcy - 34, hcx + 20, hcy - 34, hcx + r * 0.99, hcy - 26)
        band.lineTo(hcx + r * 0.99, hcy - 8)
        band.cubicTo(hcx + 20, hcy - 16, hcx - 20, hcy - 16, hcx - r * 0.99, hcy - 8)
        band.closeSubpath()
        p.setPen(Qt.NoPen)
        p.setBrush(self.NAVY)
        p.drawPath(band)

        # 金属板
        plate = QPainterPath()
        plate.moveTo(hcx - 22, hcy - 28)
        plate.cubicTo(hcx - 10, hcy - 32, hcx + 10, hcy - 32, hcx + 22, hcy - 28)
        plate.lineTo(hcx + 22, hcy - 10)
        plate.cubicTo(hcx + 10, hcy - 14, hcx - 10, hcy - 14, hcx - 22, hcy - 10)
        plate.closeSubpath()
        mgrad = QLinearGradient(0, hcy - 32, 0, hcy - 10)
        mgrad.setColorAt(0.0, self.METAL_HI)
        mgrad.setColorAt(1.0, self.METAL_LO)
        p.setBrush(QBrush(mgrad))
        p.setPen(_soft_pen(_with_alpha(self.METAL_EDGE, 120), 1.1))
        p.drawPath(plate)

        # 木叶漩涡
        p.setBrush(Qt.NoBrush)
        p.setPen(_soft_pen(self.METAL_EDGE, 1.6))
        p.drawPath(_spiral(hcx, hcy - 19, 8.0, 1.5, 34))
        p.drawLine(QPointF(hcx + 1, hcy - 12), QPointF(hcx - 2, hcy - 8))

        # 腮红 + 胡须纹
        draw_blush(p, hcx - 28, hcy + 20, 12, 7, 70, self.BLUSH)
        draw_blush(p, hcx + 28, hcy + 20, 12, 7, 70, self.BLUSH)
        p.setPen(_soft_pen(_with_alpha(self.WHISKER, 170), 1.7))
        for side in (-1, 1):
            for dy in (-3, 2, 7):
                sx = hcx + side * 24
                p.drawLine(QPointF(sx, hcy + 14 + dy), QPointF(sx + side * 9, hcy + 12 + dy))

        # 眼睛
        draw_eye(p, hcx - 17, hcy + 8, 10.5, 12.5, blink, look, self.IRIS, self.INK,
                 happy_closed=st.happy > 0.6)
        draw_eye(p, hcx + 17, hcy + 8, 10.5, 12.5, blink, look, self.IRIS, self.INK,
                 happy_closed=st.happy > 0.6)

        # 嘴
        p.setBrush(Qt.NoBrush)
        p.setPen(_soft_pen(self.INK, 1.9))
        if st.asleep:
            p.drawEllipse(QPointF(hcx, hcy + 32), 3.6, 2.6)
        elif st.happy > 0.5:
            smile = QPainterPath(QPointF(hcx - 8, hcy + 28))
            smile.cubicTo(hcx - 4, hcy + 37, hcx + 4, hcy + 37, hcx + 8, hcy + 28)
            p.drawPath(smile)
        else:
            p.drawPath(_smile(hcx, hcy + 28, 8, 4.5))

        self.draw_sparkles(p, st)


# --------------------------------------------------------------------------- #
# 蓝色系角色
# --------------------------------------------------------------------------- #
class FoxFrost(Fox):
    """小霜 —— 冰蓝九尾狐。"""
    name = "小霜"
    desc = "从雪原跑来的小狐狸，毛是冰蓝色的，呼出来的气都带着霜。"

    FUR_DARK = QColor("#2A5F9E")
    FUR = QColor("#5AA7E8")
    FUR_HI = QColor("#ACDCFA")
    CREAM = QColor("#F4FBFF")
    EAR_IN = QColor("#BFE4FA")
    INK = QColor("#17324F")
    IRIS = QColor("#FFC95C")
    EDGE = QColor("#1B4B76")
    NOSE = QColor("#22557F")
    SHADOW = QColor("#123049")
    BLUSH = QColor("#FFA2BE")

    sparkle_color = QColor("#7FC7F5")
    sparkles = (
        (50, 68, 6.0, 0.0),
        (150, 60, 4.6, 1.7),
        (34, 132, 4.0, 3.1),
        (166, 120, 3.4, 4.4),
    )


class FoxNight(Fox):
    """小夜 —— 夜空蓝九尾狐。"""
    name = "小夜"
    desc = "只在深夜出没的小狐狸，皮毛是星空蓝，眼睛里有没睡着的星星。"

    FUR_DARK = QColor("#232F5E")
    FUR = QColor("#43569B")
    FUR_HI = QColor("#879BD6")
    CREAM = QColor("#E9EEFF")
    EAR_IN = QColor("#9C8FD0")
    INK = QColor("#0D1329")
    IRIS = QColor("#FFD86B")
    EDGE = QColor("#141C3A")
    NOSE = QColor("#2A3358")
    SHADOW = QColor("#0A0F1F")
    BLUSH = QColor("#C48ACB")

    sparkle_color = QColor("#FFF3B8")
    sparkles = (
        (46, 72, 5.4, 0.6),
        (154, 66, 6.2, 2.2),
        (30, 126, 3.6, 3.6),
        (170, 138, 4.2, 5.0),
        (100, 44, 3.8, 1.1),
    )


class NinjaBlue(Ninja):
    """小岚 —— 水影风蓝忍者。"""
    name = "小岚"
    desc = "水之国来的忍者，一身靛蓝，擅长水遁，也擅长在你屏幕上偷懒。"

    SKIN = QColor("#FFE3CA")
    SKIN_D = QColor("#F0C29C")
    SKIN_HI = QColor("#FFF4E6")
    HAIR = QColor("#8FD3F4")
    HAIR_D = QColor("#5BA6D4")
    SUIT = QColor("#3E86D6")
    SUIT_D = QColor("#245FA0")
    NAVY = QColor("#17253F")
    INK = QColor("#1B2438")
    IRIS = QColor("#FFB43C")
    EDGE = QColor("#1E4C7A")
    SHADOW = QColor("#0F1A2E")
    COLLAR = QColor("#EEF5FB")
    EDGE_SKIN = QColor("#7A5A45")
    METAL_HI = QColor("#EDF2F8")
    METAL_LO = QColor("#A9B7C6")
    METAL_EDGE = QColor("#516A84")
    WHISKER = QColor("#B98A6A")
    BLUSH = QColor("#FFA2B4")

    sparkle_color = QColor("#86C9F0")
    sparkles = (
        (52, 74, 5.6, 0.4),
        (150, 62, 4.4, 2.0),
        (44, 150, 3.8, 3.4),
        (158, 146, 3.2, 4.8),
    )
# --------------------------------------------------------------------------- #
# 小汐 —— 语音对话形态（人物角色）
# --------------------------------------------------------------------------- #
class Girl(Character):
    """Q 版小女孩：大脑袋 + 小身体，冰蓝色长直发 + 一袭素色长裙。四种对话状态靠姿势与表情区分。"""

    name = "小汐"
    desc = "桌面语音小助手，会思考、会敲代码、会听你说话。"
    species = "human"
    ground_y = 188.0
    silhouette = [
        (100.0, 146.0, 40.0, 44.0),
        (100.0, 76.0, 50.0, 52.0),
    ]

    # 头发
    HAIR = QColor("#87AEE4")
    HAIR_HI = QColor("#C2DBF7")
    HAIR_D = QColor("#5480C2")
    HAIR_SHADOW = QColor("#436AA6")
    # 皮肤
    SKIN = QColor("#FFEBE0")
    SKIN_D = QColor("#F5CBB8")
    SKIN_LINE = QColor("#CE9484")
    # 衣服
    CLOTH = QColor("#F8FBFF")
    CLOTH_D = QColor("#D8E6F6")
    TRIM = QColor("#7FB2E2")
    SKIRT = QColor("#AFCBE9")
    SKIRT_D = QColor("#83A8D2")
    DRESS_HEM = QColor("#B7D2EE")
    # 五官
    INK = QColor("#26334D")
    IRIS = QColor("#4B8FE0")
    LIP = QColor("#E4808F")
    LINE = QColor("#55688C")

    sparkle_color = QColor("#93D2F8")
    sparkles = (
        (56, 64, 5.0, 0.0),
        (145, 60, 4.0, 1.6),
        (49, 133, 3.4, 3.0),
        (152, 148, 3.0, 4.4),
    )

    # ---- 部件 ----
    def _sleeve(self, p: QPainter, x0: float, y0: float, x1: float, y1: float,
                w: float = 12.5, bend: float = 0.0) -> None:
        path = QPainterPath(QPointF(x0, y0))
        path.quadTo(QPointF((x0 + x1) * 0.5 + bend, (y0 + y1) * 0.5), QPointF(x1, y1))
        p.setBrush(Qt.NoBrush)
        p.setPen(QPen(self.CLOTH_D, w, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
        p.drawPath(path)
        p.setPen(QPen(QColor("#EAF3FE"), w - 2.2, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
        p.drawPath(path)
        p.setPen(_soft_pen(_with_alpha(self.LINE, 75), 0.9))
        p.drawPath(path)

    def _hand(self, p: QPainter, x: float, y: float, r: float = 4.2) -> None:
        p.setBrush(self.SKIN)
        p.setPen(_soft_pen(_with_alpha(self.SKIN_LINE, 125), 1.0))
        p.drawEllipse(QPointF(x, y), r, r * 0.94)

    def _eye(self, p: QPainter, x: float, y: float, rx: float, ry: float,
             blink: float, look: QPointF, happy: bool = False) -> None:
        if blink > 0.86 or happy:
            p.setBrush(Qt.NoBrush)
            p.setPen(_soft_pen(self.INK, 2.5))
            arc = QPainterPath(QPointF(x - rx * 0.94, y + ry * 0.18))
            arc.quadTo(QPointF(x, y + ry * 0.92), QPointF(x + rx * 0.94, y + ry * 0.18))
            p.drawPath(arc)
            return

        hh = ry * (1.0 - 0.90 * blink)
        cy = y + (ry - hh) * 0.30

        shape = QPainterPath()
        shape.moveTo(x - rx, cy - hh * 0.02)
        shape.cubicTo(x - rx * 0.94, cy - hh * 1.08, x + rx * 0.94, cy - hh * 1.08,
                      x + rx, cy - hh * 0.02)
        shape.cubicTo(x + rx * 0.92, cy + hh * 1.04, x - rx * 0.92, cy + hh * 1.04,
                      x - rx, cy - hh * 0.02)

        p.setBrush(_rgba("#FDFEFF", 246))
        p.setPen(_soft_pen(_with_alpha(self.INK, 75), 0.9))
        p.drawPath(shape)

        p.save()
        p.setClipPath(shape)
        grad = QLinearGradient(x, cy - hh, x, cy + hh)
        grad.setColorAt(0.0, QColor("#2C5CA6"))
        grad.setColorAt(0.52, self.IRIS)
        grad.setColorAt(1.0, QColor("#AAD8FF"))
        p.setBrush(QBrush(grad))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(x + look.x() * rx * 0.13, cy + look.y() * hh * 0.11),
                      rx * 0.90, hh * 0.96)
        p.setBrush(_rgba("#12203A", 208))
        p.drawEllipse(QPointF(x + look.x() * rx * 0.17, cy + look.y() * hh * 0.13 - hh * 0.05),
                      rx * 0.38, hh * 0.42)
        p.setBrush(_rgba("#CFEBFF", 118))
        p.drawEllipse(QPointF(x, cy + hh * 0.58), rx * 0.56, hh * 0.26)
        p.restore()

        lash = QPainterPath(QPointF(x - rx * 1.02, cy + hh * 0.02))
        lash.cubicTo(x - rx * 0.92, cy - hh * 1.14, x + rx * 0.90, cy - hh * 1.14,
                     x + rx * 1.08, cy - hh * 0.10)
        p.setBrush(Qt.NoBrush)
        p.setPen(_soft_pen(_with_alpha(self.INK, 240), 2.6))
        p.drawPath(lash)

        p.setPen(Qt.NoPen)
        p.setBrush(_rgba("#FFFFFF", 248))
        p.drawEllipse(QPointF(x - rx * 0.33, cy - hh * 0.34), rx * 0.30, hh * 0.24)
        p.setBrush(_rgba("#FFFFFF", 180))
        p.drawEllipse(QPointF(x + rx * 0.36, cy + hh * 0.34), rx * 0.14, hh * 0.11)

    def _arcs(self, p: QPainter, cx: float, cy: float, phase: float, color: QColor,
              count: int = 3, r0: float = 9.0, gap: float = 6.4, span: float = 66.0) -> None:
        for i in range(count):
            k = (math.sin(phase * 2.4 - i * 0.9) + 1) * 0.5
            r = r0 + i * gap
            pen = QPen(_with_alpha(color, int(45 + 155 * k * (1.0 - i * 0.15))), 2.2)
            pen.setCapStyle(Qt.RoundCap)
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)
            p.drawArc(QRectF(cx - r, cy - r, r * 2, r * 2),
                      int(-span / 2 * 16), int(span * 16))

    def _thinking_dots(self, p: QPainter, phase: float) -> None:
        for i, (x, y, r) in enumerate([(127, 55, 4.6), (135, 48, 3.5), (142, 42, 2.5)]):
            k = (math.sin(phase * 2.6 - i * 0.8) + 1) * 0.5
            p.setPen(Qt.NoPen)
            glow = QRadialGradient(QPointF(x, y), r * 2.8)
            glow.setColorAt(0.0, _with_alpha("#8FC8FF", int(26 + 58 * k)))
            glow.setColorAt(1.0, _with_alpha("#8FC8FF", 0))
            p.setBrush(QBrush(glow))
            p.drawEllipse(QPointF(x, y), r * 2.8, r * 2.8)
            p.setBrush(_with_alpha("#F0F7FF", int(140 + 105 * k)))
            p.drawEllipse(QPointF(x, y), r * (0.9 + 0.1 * k), r * (0.9 + 0.1 * k))

    def _laptop(self, p: QPainter, lift: float, phase: float) -> None:
        base_y = 157.0 + lift

        # 地面阴影
        p.setPen(Qt.NoPen)
        p.setBrush(_with_alpha("#3A4A66", 32))
        p.drawEllipse(QPointF(100, base_y + 12), 26, 4.5)

        # 屏幕背面（立着，稍微前倾）
        lid = QPainterPath()
        lid.moveTo(81, base_y + 1)
        lid.lineTo(83, base_y - 15)
        lid.cubicTo(90, base_y - 17, 110, base_y - 17, 117, base_y - 15)
        lid.lineTo(119, base_y + 1)
        lid.closeSubpath()
        grad = QLinearGradient(0, base_y - 17, 0, base_y + 1)
        grad.setColorAt(0.0, QColor("#EAF4FF"))
        grad.setColorAt(1.0, QColor("#C0D5EF"))
        p.setBrush(QBrush(grad))
        p.setPen(_soft_pen(_with_alpha(self.LINE, 100), 1.0))
        p.drawPath(lid)

        # 背面的呼吸灯
        k = (math.sin(phase * 2.2) + 1) * 0.5
        glow = QRadialGradient(QPointF(100, base_y - 8), 9)
        glow.setColorAt(0.0, _with_alpha("#7FC4FF", int(70 + 70 * k)))
        glow.setColorAt(1.0, _with_alpha("#7FC4FF", 0))
        p.setBrush(QBrush(glow))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(100, base_y - 8), 9, 9)
        p.setBrush(_with_alpha("#BFE4FF", 235))
        p.drawEllipse(QPointF(100, base_y - 8), 2.2, 2.2)

        # 键盘底座（前宽后窄，有厚度）
        deck = QPainterPath()
        deck.moveTo(80, base_y + 1)
        deck.lineTo(120, base_y + 1)
        deck.lineTo(124, base_y + 8)
        deck.lineTo(76, base_y + 8)
        deck.closeSubpath()
        dgrad = QLinearGradient(0, base_y + 1, 0, base_y + 8)
        dgrad.setColorAt(0.0, QColor("#E4EFFC"))
        dgrad.setColorAt(1.0, QColor("#CBDDF5"))
        p.setBrush(QBrush(dgrad))
        p.setPen(_soft_pen(_with_alpha(self.LINE, 95), 1.0))
        p.drawPath(deck)

        # 键帽
        p.setPen(QPen(_with_alpha(self.LINE, 55), 1.1))
        for row in range(3):
            for i in range(11):
                kx = 82 + i * 3.6 + row * 0.6
                ky = base_y + 2.6 + row * 1.9
                p.drawLine(QPointF(kx, ky), QPointF(kx + 2.0, ky))

    def _head(self, p: QPainter, st, mode: str, look: QPointF, blink: float,
              lift: float, tilt: float) -> None:
        hcx, hcy = 100.0, 76.0 + lift
        rx, ry = 32.4, 33.4

        p.save()
        p.translate(hcx, hcy + ry * 0.95)
        p.rotate(tilt)
        p.translate(-hcx, -(hcy + ry * 0.95))

        # 脖子
        p.setBrush(self.SKIN)
        p.setPen(_soft_pen(_with_alpha(self.SKIN_LINE, 50), 0.9))
        p.drawRoundedRect(QRectF(hcx - 5.4, hcy + ry * 0.58, 10.8, 19), 4.6, 4.6)
        p.setPen(Qt.NoPen)
        p.setBrush(_with_alpha(self.SKIN_D, 95))
        p.drawRoundedRect(QRectF(hcx - 5.4, hcy + ry * 0.58 + 10, 10.8, 9), 4.5, 4.5)

        # 脸
        face = QPainterPath()
        face.moveTo(hcx - rx, hcy - 3)
        face.cubicTo(hcx - rx, hcy - ry * 1.10, hcx + rx, hcy - ry * 1.10,
                     hcx + rx, hcy - 3)
        face.cubicTo(hcx + rx * 0.97, hcy + ry * 0.56, hcx + rx * 0.62, hcy + ry * 0.92,
                     hcx, hcy + ry)
        face.cubicTo(hcx - rx * 0.62, hcy + ry * 0.92, hcx - rx * 0.97, hcy + ry * 0.56,
                     hcx - rx, hcy - 3)
        face.closeSubpath()
        grad = QRadialGradient(QPointF(hcx - 10, hcy - 12), rx * 1.9)
        grad.setColorAt(0.0, QColor("#FFF8F3"))
        grad.setColorAt(0.60, self.SKIN)
        grad.setColorAt(1.0, self.SKIN_D)
        p.setBrush(QBrush(grad))
        p.setPen(_soft_pen(_with_alpha(self.SKIN_LINE, 70), 1.0))
        p.drawPath(face)

        # 下颌阴影
        p.setBrush(Qt.NoBrush)
        p.setPen(QPen(_with_alpha(self.SKIN_D, 120), 2.0, Qt.SolidLine, Qt.RoundCap))
        jaw = QPainterPath(QPointF(hcx - rx * 0.66, hcy + ry * 0.78))
        jaw.cubicTo(hcx - rx * 0.30, hcy + ry * 0.94, hcx + rx * 0.30, hcy + ry * 0.94,
                    hcx + rx * 0.66, hcy + ry * 0.78)
        p.drawPath(jaw)

        # 腮红
        alpha = 100 if mode == "answering" else 76
        draw_blush(p, hcx - 19.2, hcy + 13.8, 8.2, 4.5, alpha, "#FF8FA8")
        draw_blush(p, hcx + 19.2, hcy + 13.8, 8.2, 4.5, alpha, "#FF8FA8")

        # 眼睛
        happy = st.happy > 0.6
        self._eye(p, hcx - 12.6, hcy + 6.2, 7.2, 8.4, blink, look, happy)
        self._eye(p, hcx + 12.6, hcy + 6.2, 7.2, 8.4, blink, look, happy)

        # 眉毛
        brow_y = hcy - 11.5
        for side in (-1, 1):
            bx = hcx + side * 12.6
            lift_b = -1.6 if (mode == "thinking" and side > 0) else 0.0
            path = QPainterPath(QPointF(bx - 5.4, brow_y + 1.6 + lift_b))
            path.quadTo(QPointF(bx, brow_y - 1.0 + lift_b),
                        QPointF(bx + 5.4, brow_y + 0.9 + lift_b))
            p.setBrush(Qt.NoBrush)
            p.setPen(_soft_pen(_with_alpha(self.HAIR_SHADOW, 195), 1.8))
            p.drawPath(path)

        # 鼻子
        p.setPen(Qt.NoPen)
        p.setBrush(_with_alpha(self.SKIN_LINE, 72))
        p.drawEllipse(QPointF(hcx + 0.5, hcy + 14.2), 1.3, 1.0)
        p.setBrush(_with_alpha("#FFFFFF", 120))
        p.drawEllipse(QPointF(hcx - 1.4, hcy + 8.5), 1.6, 3.2)

        # 嘴
        my = hcy + 21.0
        p.setBrush(Qt.NoBrush)
        if mode == "answering":
            h = 1.2 + 2.0 * abs(math.sin(st.t * 7.0))
            p.setBrush(_with_alpha("#C9606D", 225))
            p.setPen(Qt.NoPen)
            p.drawRoundedRect(QRectF(hcx - 1.9, my - 0.2, 3.8, h), 1.6, 1.6)
        elif mode == "thinking":
            p.setPen(_soft_pen(self.INK, 1.6))
            p.drawLine(QPointF(hcx - 2.6, my), QPointF(hcx + 1.5, my - 1.1))
        elif mode == "coding":
            p.setPen(_soft_pen(self.INK, 1.55))
            p.drawPath(_smile(hcx, my - 1.0, 3.8, 1.5))
        elif mode == "listening":
            p.setPen(_soft_pen(self.INK, 1.6))
            p.drawPath(_smile(hcx, my - 1.2, 3.8, 2.0))
        else:
            p.setPen(_soft_pen(self.INK, 1.6))
            p.drawPath(_smile(hcx, my - 1.0, 4.4, 1.9))

        # ---- 前发：覆盖额头的柔和刘海（实心发片）----
        fringe = QPainterPath()
        fringe.moveTo(67, 94)
        fringe.cubicTo(63, 66, 74, 39, 100, 38)
        fringe.cubicTo(126, 39, 137, 66, 133, 94)
        fringe.cubicTo(131, 78, 128, 68, 123, 64)
        fringe.quadTo(119, 57, 114, 61)
        fringe.quadTo(107, 55, 100, 60)
        fringe.quadTo(93, 55, 86, 61)
        fringe.quadTo(81, 57, 77, 64)
        fringe.cubicTo(72, 68, 69, 78, 67, 94)
        fringe.closeSubpath()
        fg = QLinearGradient(hcx, 38, hcx, 98)
        fg.setColorAt(0.0, QColor("#AAC9EF"))
        fg.setColorAt(0.34, QColor("#7FA6DC"))
        fg.setColorAt(1.0, QColor("#5E8AC8"))
        p.setBrush(QBrush(fg))
        p.setPen(Qt.NoPen)
        p.drawPath(fringe)

        # 刘海下缘的厚度阴影
        p.setBrush(Qt.NoBrush)
        p.setPen(QPen(_with_alpha(self.HAIR_SHADOW, 78), 2.0, Qt.SolidLine, Qt.RoundCap))
        edge = QPainterPath(QPointF(77, 64))
        edge.quadTo(81, 57, 86, 61)
        edge.quadTo(93, 55, 100, 60)
        edge.quadTo(107, 55, 114, 61)
        edge.quadTo(119, 57, 123, 64)
        p.drawPath(edge)

        # 刘海投在额头上的柔影
        p.setBrush(Qt.NoBrush)
        for i, (w, a) in enumerate(((4.6, 26), (2.6, 40), (1.2, 54))):
            shade = QPainterPath(QPointF(77, 64 + w * 0.35))
            shade.quadTo(81, 57 + w, 86, 61 + w * 0.7)
            shade.quadTo(93, 55 + w, 100, 60 + w * 0.6)
            shade.quadTo(107, 55 + w, 114, 61 + w * 0.7)
            shade.quadTo(119, 57 + w, 123, 64 + w * 0.35)
            p.setPen(QPen(_with_alpha(self.SKIN_D, a), w, Qt.SolidLine, Qt.RoundCap))
            p.drawPath(shade)

        # 头顶高光
        p.setPen(QPen(_with_alpha("#FFFFFF", 92), 1.8, Qt.SolidLine, Qt.RoundCap))
        for ox, oy, ex, ey in ((-19, -22, -10, -29), (-4, -31, 9, -29), (12, -27, 20, -21)):
            hl = QPainterPath(QPointF(hcx + ox, hcy + oy))
            hl.quadTo(QPointF(hcx + (ox + ex) / 2, hcy + (oy + ey) / 2 - 2.4),
                      QPointF(hcx + ex, hcy + ey))
            p.drawPath(hl)

        # 发饰：三颗小珍珠，斜斜别在右侧
        for px, py, pr in ((117, 48, 1.9), (124, 53, 2.3), (131, 60, 1.7)):
            p.setPen(Qt.NoPen)
            p.setBrush(_rgba("#F4FAFF", 246))
            p.drawEllipse(QPointF(px, py), pr, pr)
            p.setBrush(_rgba("#FFFFFF", 250))
            p.drawEllipse(QPointF(px - pr * 0.3, py - pr * 0.35), pr * 0.42, pr * 0.42)

        p.restore()

    def paint(self, p: QPainter, st) -> None:
        mode = getattr(st, "mode", "idle") or "idle"
        breath = st.breath
        blink = max(st.blink, st.blink_lid)
        body_lift = breath * 1.2
        head_lift = breath * 1.5

        look = QPointF(st.look)
        if mode == "thinking":
            look = QPointF(0.55, -0.85)
        elif mode == "coding":
            look = QPointF(0.1, 0.8)
        elif mode == "listening":
            look = QPointF(0.7, -0.15)
        elif mode == "answering":
            look = QPointF(0.0, -0.05)

        tilt = {"thinking": -4.0, "listening": 5.0, "answering": -1.5, "coding": 2.0}.get(mode, 0.0)

        # 影子
        p.setPen(Qt.NoPen)
        shadow = QRadialGradient(QPointF(100, 189), 34)
        shadow.setColorAt(0.0, _with_alpha("#3A4A66", 62))
        shadow.setColorAt(1.0, _with_alpha("#3A4A66", 0))
        p.setBrush(QBrush(shadow))
        p.drawEllipse(QPointF(100, 189), 34, 9)

        # ---- 小腿 + 小圆头鞋（裙摆下露出一小截）----
        for x in (94, 106):
            p.setBrush(self.SKIN)
            p.setPen(_soft_pen(_with_alpha(self.SKIN_LINE, 65), 0.9))
            p.drawRoundedRect(QRectF(x - 4.4, 150 + body_lift, 8.8, 22), 4.4, 4.4)
            p.setBrush(QColor("#CFE1F5"))
            p.setPen(_soft_pen(_with_alpha(self.LINE, 95), 0.9))
            p.drawEllipse(QPointF(x, 175.6 + body_lift), 6.2, 4.4)
            p.setBrush(QColor("#B6CFEA"))
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(x - 1.4, 174.2 + body_lift), 2.8, 1.7)

        # ---- 长裙：修身 A 字，垂到脚踝 ----
        p.save()
        p.translate(0, body_lift)
        dress = QPainterPath()
        dress.moveTo(86, 111)
        dress.cubicTo(83, 120, 83.5, 130, 87, 141)
        dress.cubicTo(82, 146, 80.5, 155, 80, 162)
        dress.cubicTo(89, 165.5, 111, 165.5, 120, 162)
        dress.cubicTo(119.5, 155, 118, 146, 113, 141)
        dress.cubicTo(116.5, 130, 117, 120, 114, 111)
        dress.cubicTo(107, 116, 93, 116, 86, 111)
        dress.closeSubpath()
        dg = QLinearGradient(0, 110, 0, 168)
        dg.setColorAt(0.0, QColor("#F4F9FF"))
        dg.setColorAt(0.38, QColor("#E6F0FC"))
        dg.setColorAt(0.72, self.SKIRT)
        dg.setColorAt(1.0, self.DRESS_HEM)
        p.setBrush(QBrush(dg))
        p.setPen(_soft_pen(_with_alpha(self.LINE, 58), 1.0))
        p.drawPath(dress)

        # 两条极淡的裙褶
        p.setBrush(Qt.NoBrush)
        for fx, bend in ((91, -2.0), (109, 2.0)):
            fold = QPainterPath(QPointF(fx, 143))
            fold.cubicTo(fx + bend * 0.6, 150, fx + bend, 156, fx + bend * 1.2, 163)
            p.setPen(QPen(_with_alpha("#FFFFFF", 80), 2.0, Qt.SolidLine, Qt.RoundCap))
            p.drawPath(fold)
        p.setPen(QPen(_with_alpha(self.SKIRT_D, 55), 1.4, Qt.SolidLine, Qt.RoundCap))
        hem = QPainterPath(QPointF(81, 161.4))
        hem.cubicTo(90, 165.2, 110, 165.2, 119, 161.4)
        p.drawPath(hem)

        # 腰带
        belt = QPainterPath(QPointF(87, 140.4))
        belt.cubicTo(93, 142.0, 107, 142.0, 113, 140.4)
        p.setPen(QPen(_with_alpha(self.TRIM, 195), 2.8, Qt.SolidLine, Qt.RoundCap))
        p.drawPath(belt)
        p.setPen(Qt.NoPen)
        p.setBrush(_rgba("#EDF6FF", 235))
        p.drawEllipse(QPointF(100, 142.0), 2.0, 2.0)

        # 小圆领
        p.setBrush(Qt.NoBrush)
        p.setPen(QPen(_with_alpha(self.CLOTH_D, 235), 2.6, Qt.SolidLine, Qt.RoundCap))
        rim = QPainterPath(QPointF(86, 111))
        rim.cubicTo(89, 116.4, 94, 117.6, 100, 117.6)
        rim.cubicTo(106, 117.6, 111, 116.4, 114, 111)
        p.drawPath(rim)
        p.setPen(QPen(_with_alpha(self.LINE, 50), 0.9, Qt.SolidLine, Qt.RoundCap))
        p.drawPath(rim)
        p.restore()

        # ---- 后发：贴合头形，垂到肩下 ----
        back = QPainterPath()
        back.moveTo(66, 82)
        back.cubicTo(61, 48, 78, 38, 100, 38)
        back.cubicTo(122, 38, 139, 48, 134, 82)
        back.cubicTo(139, 108, 138, 128, 133, 144)
        back.cubicTo(132, 151, 125, 155, 122, 149)
        back.cubicTo(121, 142, 121, 134, 120, 116)
        back.lineTo(80, 116)
        back.cubicTo(79, 134, 79, 142, 78, 149)
        back.cubicTo(75, 155, 68, 151, 67, 144)
        back.cubicTo(62, 128, 62, 106, 66, 82)
        back.closeSubpath()
        bg = QLinearGradient(0, 38, 0, 145)
        bg.setColorAt(0.0, QColor("#A8C8EE"))
        bg.setColorAt(0.46, QColor("#7FA6DC"))
        bg.setColorAt(1.0, QColor("#5A85C2"))
        p.setBrush(QBrush(bg))
        p.setPen(Qt.NoPen)
        p.drawPath(back)
        # 只描外缘，内缘留在裙子上一道淡影
        p.setBrush(Qt.NoBrush)
        p.setPen(_soft_pen(_with_alpha(self.HAIR_SHADOW, 90), 1.0))
        outer = QPainterPath(QPointF(66, 82))
        outer.cubicTo(62, 106, 62, 130, 67, 148)
        p.drawPath(outer)
        outer2 = QPainterPath(QPointF(134, 82))
        outer2.cubicTo(139, 108, 138, 130, 133, 146)
        p.drawPath(outer2)

        # 后发的几缕走向
        p.setBrush(Qt.NoBrush)
        for side in (-1, 1):
            # 深色分隔线，把发片分成几缕
            for k, off in enumerate((2.0, 8.0, 14.0)):
                x0 = 100 + side * (28 - off)
                strand = QPainterPath(QPointF(x0, 92))
                strand.cubicTo(x0 + side * 2.6, 112, x0 + side * 1.0, 130,
                               x0 - side * 1.8, 145)
                p.setPen(QPen(_with_alpha("#4C74AE", 58 - k * 14),
                              1.4, Qt.SolidLine, Qt.RoundCap))
                p.drawPath(strand)
            # 一缕亮边，做圆柱高光
            x0 = 100 + side * 22.0
            shine = QPainterPath(QPointF(x0, 96))
            shine.cubicTo(x0 + side * 2.0, 116, x0 + side * 0.6, 132,
                          x0 - side * 1.4, 144)
            p.setPen(QPen(_with_alpha("#B6D4F3", 120), 3.2, Qt.SolidLine, Qt.RoundCap))
            p.drawPath(shine)

        # 手臂
        hands = {
            "idle": ((82, 140), (118, 140)),
            "thinking": ((83, 142), (112, 105)),
            "coding": ((88, 158), (112, 158)),
            "listening": ((83, 142), (124, 90)),
            "answering": ((83, 141), (117, 118)),
        }.get(mode, ((77, 143), (123, 143)))

        # 只在有手势的状态画手臂，idle 只手贴着裙侧
        arm_sides = {"thinking": (1,), "coding": (0, 1), "listening": (1,),
                     "answering": (1,)}.get(mode, ())
        for side in arm_sides:
            sx = 87.0 if side == 0 else 113.0
            self._sleeve(p, sx, 117 + body_lift, hands[side][0],
                         hands[side][1] + body_lift, 8.6, -3 if side == 0 else 3)

        # 笔记本
        if mode == "coding":
            self._laptop(p, body_lift, st.t)

        # 头
        self._head(p, st, mode, look, blink, head_lift, tilt)

        # 手
        for i, (hx, hy) in enumerate(hands):
            dy = body_lift
            if mode == "coding":
                dy += math.sin(st.t * 11 + i * 1.6) * 1.4
            self._hand(p, hx, hy + dy)

        # ---- 状态特效 ----
        if mode == "thinking":
            self._thinking_dots(p, st.t)
        elif mode == "listening":
            self._arcs(p, 137, 80, st.t, QColor("#8FD0FF"), 3, 8.5, 6.2, 74)
        elif mode == "answering":
            self._arcs(p, 112, 97, st.t, QColor("#A6DCFF"), 3, 6.8, 5.6, 56)

        if mode == "coding":
            glow = QRadialGradient(QPointF(100, 148), 44)
            glow.setColorAt(0.0, _with_alpha("#8FC9FF", 44))
            glow.setColorAt(1.0, _with_alpha("#8FC9FF", 0))
            p.setBrush(QBrush(glow))
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(100, 148), 44, 44)

        self.draw_sparkles(p, st)

class GirlArt(Girl):
    """小汐（插画版）：两套立绘场景。

    · 站姿（idle / thinking / listening / answering）—— 拆头/身两层，呼吸、摆头、眨眼、连续说话口型
    · 坐姿（coding）—— 坐在桌前敲键盘：键光连闪、双手快速点按、脑袋跟着节奏一顿一顿
    两套场景按 mode 交叉淡入，读起来像"她凑到桌前坐下了"。
    """

    name = "小汐"
    desc = "桌面语音小助手，会思考、会敲代码、会听你说话。"
    species = "human"
    ground_y = 189.0

    # ---------------- 站姿立绘（assets/girl.png，840x1333） ----------------
    BODY_H = 156.0        # 立绘在 200 设计空间里的高度
    WIDE = 1.07           # 横向略放宽
    FOOT_Y = 188.0
    IMG_W, IMG_H = 840, 1333
    NECK_Y = 560          # 头/身分层线
    OVERLAP = 110         # 两层重叠，避免旋转时露缝
    EYES = ((306, 371), (485, 368))
    EYE_HALF = (35, 46)
    MOUTH = (397, 450)
    MOUTH_HALF = (24, 13)
    BLUSH = ((310, 418), (486, 415))
    BLUSH_HALF = (32, 22)

    # ---------------- 坐姿立绘（assets/girl_desk.png，1024x852） ----------------
    D_IMG_W, D_IMG_H = 1024, 852
    D_WIDTH = 196.0       # 整张坐姿图在 200 设计空间里的宽度
    D_BOTTOM = 197.0      # 图底边落点（桌面压到画面外）
    D_NECK_Y = 492
    D_OVERLAP = 120
    D_EYES = ((430, 330), (600, 325))
    D_EYE_HALF = (56, 38)
    D_MOUTH = (505, 426)
    D_MOUTH_HALF = (17, 12)
    D_BLUSH = ((430, 396), (601, 392))
    D_BLUSH_HALF = (32, 22)
    D_HANDS = ((380, 700), (585, 694))
    D_HAND_HALF = (52, 40)
    D_KB = (467, 748, 386, 84)   # 键盘 中心x, 中心y, 宽, 高

    # ---------------- 配色（肤色按两张立绘各自取样） ----------------
    SKIN_HI = QColor("#F2E0E0")
    SKIN_LO = QColor("#EFD9D8")
    D_SKIN_HI = QColor("#E8E0E3")
    D_SKIN_LO = QColor("#E1D8DC")
    LIP = QColor("#C2707F")
    LIP_IN = QColor("#8E4756")
    GLOW = QColor("#7FC8FF")

    _pm = None
    _head = None
    _body = None
    _dpm = None
    _dhead = None
    _dbody = None
    _hp = {}
    _mix = 0.0
    _pt = -1.0

    # ------------------------------------------------------------------ #
    # 素材
    # ------------------------------------------------------------------ #
    @classmethod
    def _load(cls, name: str):
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return QPixmap(os.path.join(base, "assets", name))

    @classmethod
    def art(cls) -> QPixmap:
        if cls._pm is None or cls._pm.isNull():
            cls._pm = cls._load("girl.png")
        return cls._pm

    @classmethod
    def desk_art(cls) -> QPixmap:
        if cls._dpm is None or cls._dpm.isNull():
            cls._dpm = cls._load("girl_desk.png")
        return cls._dpm

    @classmethod
    def _layers(cls):
        pm = cls.art()
        if pm.isNull():
            return None, None
        if cls._head is None:
            hb = cls.NECK_Y + cls.OVERLAP
            cls._head = pm.copy(0, 0, pm.width(), hb)
            t0 = cls.NECK_Y - cls.OVERLAP
            cls._body = pm.copy(0, t0, pm.width(), pm.height() - t0)
        return cls._head, cls._body

    @classmethod
    def _desk_layers(cls):
        pm = cls.desk_art()
        if pm.isNull():
            return None, None
        if cls._dhead is None:
            hb = cls.D_NECK_Y + cls.D_OVERLAP
            cls._dhead = pm.copy(0, 0, pm.width(), hb)
            t0 = cls.D_NECK_Y - cls.D_OVERLAP
            cls._dbody = pm.copy(0, t0, pm.width(), pm.height() - t0)
        return cls._dhead, cls._dbody

    @classmethod
    def _hand_patch(cls, i: int) -> QPixmap:
        """从坐姿立绘里抠出单只手，边缘做羽化，用来叠"敲键盘"的残影。"""
        if i in cls._hp:
            return cls._hp[i]
        art = cls.desk_art()
        hw, hh = cls.D_HAND_HALF
        hx, hy = cls.D_HANDS[i]
        w, h = int(hw * 2), int(hh * 2)
        img = art.copy(int(hx - hw), int(hy - hh), w, h).toImage()
        img = img.convertToFormat(QImage.Format_ARGB32_Premultiplied)

        mask = QImage(w, h, QImage.Format_ARGB32_Premultiplied)
        mask.fill(0)
        mp = QPainter(mask)
        mp.setRenderHint(QPainter.Antialiasing, True)
        g = QRadialGradient(QPointF(w / 2.0, h / 2.0), w * 0.52)
        g.setColorAt(0.0, QColor(255, 255, 255, 255))
        g.setColorAt(0.55, QColor(255, 255, 255, 245))
        g.setColorAt(1.0, QColor(255, 255, 255, 0))
        mp.setPen(Qt.NoPen)
        mp.setBrush(QBrush(g))
        mp.drawEllipse(QRectF(0, 0, w, h))
        mp.end()

        p2 = QPainter(img)
        p2.setCompositionMode(QPainter.CompositionMode_DestinationIn)
        p2.drawImage(0, 0, mask)
        p2.end()
        cls._hp[i] = QPixmap.fromImage(img)
        return cls._hp[i]

    # ------------------------------------------------------------------ #
    # 几何
    # ------------------------------------------------------------------ #
    def _geo(self):
        sy = self.BODY_H / float(self.IMG_H)
        sx = sy * self.WIDE
        w = self.IMG_W * sx
        return sx, sy, w, 100.0 - w / 2.0, self.FOOT_Y - self.IMG_H * sy

    def _desk_geo(self):
        s = self.D_WIDTH / float(self.D_IMG_W)
        return s, self.D_WIDTH, 100.0 - self.D_WIDTH / 2.0, self.D_BOTTOM - self.D_IMG_H * s

    # ------------------------------------------------------------------ #
    # 部件：眨眼 / 嘴 / 敲击节奏
    # ------------------------------------------------------------------ #
    def _eyes(self, p: QPainter, art: QPixmap, sx: float, sy: float, left: float,
              top: float, eyes, half, st, hi: QColor, lo: QColor,
              smile: float = 0.0) -> None:
        asleep = getattr(st, "blink_lid", 0.0) >= 0.9
        blink = 1.0 if asleep else max(getattr(st, "blink", 0.0),
                                       getattr(st, "blink_lid", 0.0) * 0.92)
        if blink < 0.03 and smile < 0.12:
            return
        hw, hh = half
        k = min(1.0, blink)
        p.setRenderHint(QPainter.SmoothPixmapTransform, True)
        for idx, (ex, ey) in enumerate(eyes):
            cx = left + ex * sx
            cy = top + ey * sy
            rx, ry = hw * sx * 1.06, hh * sy * 1.12

            if k >= 0.03:
                p.setPen(Qt.NoPen)
                g = QLinearGradient(0, cy - ry, 0, cy + ry)
                g.setColorAt(0.0, hi)
                g.setColorAt(1.0, lo)
                p.setBrush(QBrush(g))
                p.drawEllipse(QPointF(cx, cy), rx, ry)

                if asleep:
                    # 熟睡：眼皮完全合上。弧线贴着原立绘上睫毛带的位置画——
                    # 像睫毛垂下来，而不是凭空一条线；细一点才不会像涂鸦。
                    p.setBrush(Qt.NoBrush)
                    p.setPen(QPen(_rgba("#7A6472", 200), max(0.8, ry * 0.18),
                                  Qt.SolidLine, Qt.RoundCap))
                    lid = QPainterPath(QPointF(cx - rx * 0.95, cy - ry * 0.38))
                    lid.quadTo(QPointF(cx, cy + ry * 0.10),
                               QPointF(cx + rx * 0.95, cy - ry * 0.38))
                    p.drawPath(lid)
                    # 眼尾一根向上挑的小睫毛（外侧），别画成一坨
                    sgn = -1.0 if idx == 0 else 1.0
                    p.setPen(QPen(_rgba("#7A6472", 170), max(0.6, ry * 0.14),
                                  Qt.SolidLine, Qt.RoundCap))
                    lash = QPainterPath(
                        QPointF(cx + sgn * rx * 0.95, cy - ry * 0.38))
                    lash.quadTo(
                        QPointF(cx + sgn * rx * 1.14, cy - ry * 0.48),
                        QPointF(cx + sgn * rx * 1.22, cy - ry * 0.72))
                    p.drawPath(lash)
                    continue

                h_now = ry * 2.0 * max(0.06, 1.0 - 0.94 * k)
                p.drawPixmap(QRectF(cx - rx, cy - h_now / 2, rx * 2, h_now), art,
                             QRectF(ex - hw, ey - hh, hw * 2, hh * 2))
                if k > 0.55:
                    a = int((k - 0.55) / 0.45 * 235)
                    p.setBrush(Qt.NoBrush)
                    lid = QPainterPath(QPointF(cx - rx * 0.92, cy - ry * 0.10))
                    lid.quadTo(QPointF(cx, cy + ry * 0.42), QPointF(cx + rx * 0.92, cy - ry * 0.10))
                    p.setPen(QPen(_rgba("#6E7FA0", a), max(0.7, ry * 0.26),
                                  Qt.SolidLine, Qt.RoundCap))
                    p.drawPath(lid)

            # 笑眼：眼尾一道极淡的上挑，只给一点点"眼睛在笑"的暗示
            if smile > 0.40 and not asleep:
                a = int(90 * min(1.0, (smile - 0.40) / 0.45))
                p.setBrush(Qt.NoBrush)
                p.setPen(QPen(_rgba("#D98E96", a), max(0.45, ry * 0.13),
                              Qt.SolidLine, Qt.RoundCap))
                for sgn in (-1, 1):
                    bag = QPainterPath(QPointF(cx + sgn * rx * 0.78, cy + ry * 1.02))
                    bag.lineTo(QPointF(cx + sgn * rx * 0.56, cy + ry * 1.24))
                    p.drawPath(bag)

    def _blush(self, p: QPainter, cx: float, cy: float, hw: float, hh: float,
               k: float) -> None:
        """腮红：角色本来有淡腮红，这里只在情绪浓时再浮一层暖光。"""
        if k <= 0.02:
            return
        p.save()
        p.setPen(Qt.NoPen)
        g = QRadialGradient(QPointF(cx, cy), max(hw * 1.35, hh * 1.30))
        g.setColorAt(0.0, _with_alpha("#F58B84", int(50 * min(1.0, k))))
        g.setColorAt(0.45, _with_alpha("#F58B84", int(30 * min(1.0, k))))
        g.setColorAt(1.0, _with_alpha("#F58B84", 0))
        p.setBrush(QBrush(g))
        p.drawEllipse(QPointF(cx, cy), hw * 1.35, hh * 1.30)
        p.restore()

    @staticmethod
    def _syllable(t: float) -> float:
        """说话音节包络：三层不同频率叠加 + 换气时的短暂闭口。"""
        a = abs(math.sin(t * 12.6))
        b = abs(math.sin(t * 5.1 + 1.2))
        c = abs(math.sin(t * 21.3 + 0.4))
        env = 0.50 * a + 0.32 * b + 0.18 * c
        slow = 0.5 + 0.5 * math.sin(t * 1.9)
        v = env * (0.68 + 0.54 * slow)
        gap = max(0.0, math.sin(t * 1.15 + 2.2)) ** 8    # 换气：每隔几秒合一下嘴
        return max(0.0, min(1.0, v * (1.0 - 0.85 * gap)))

    def _expr(self, mode: str, t: float):
        """每种模式一套表情参数：(笑意, 张口度, 腮红)。"""
        if mode == "answering":
            return 0.72, self._syllable(t), 0.50 + 0.14 * math.sin(t * 3.1)
        if mode == "listening":
            return 0.82 + 0.07 * math.sin(t * 2.1), 0.03, 0.30
        if mode == "thinking":
            return 0.22, 0.05 + 0.04 * abs(math.sin(t * 1.4)), 0.10
        if mode == "coding_mumble":
            return 0.34, 0.62 * self._syllable(t * 0.55), 0.26
        sm = 0.46 + 0.09 * math.sin(t * 0.62) + 0.05 * math.sin(t * 1.7)
        return sm, 0.0, 0.20 + 0.06 * math.sin(t * 0.62)

    def _mouth(self, p: QPainter, cx: float, cy: float, hw: float, hh: float,
               mode: str, t: float, hi: QColor, lo: QColor) -> None:
        smile, opn, _ = self._expr(mode, t)
        smile = max(0.0, min(1.0, smile))
        opn = max(0.0, min(1.0, opn))

        # 用肤色径向渐变盖掉立绘自带的抿嘴 —— 范围刚好盖住原来那张小嘴，别糊到脸上
        p.setPen(Qt.NoPen)
        cov = QRadialGradient(QPointF(cx, cy - hh * 0.05), hw * 1.08)
        cov.setColorAt(0.0, hi)
        cov.setColorAt(0.55, _with_alpha(hi, 240))
        cov.setColorAt(0.85, _with_alpha(hi, 90))
        cov.setColorAt(1.0, _with_alpha(lo, 0))
        p.setBrush(QBrush(cov))
        p.drawEllipse(QPointF(cx, cy - hh * 0.05), hw * 1.08, hh * 1.10)

        lift = hh * (0.30 + 0.78 * smile)     # 嘴角上扬量 —— 表情的"笑"全在这里
        w2 = hw * (1.00 + 0.10 * smile)       # 半宽

        if opn < 0.14:
            # ---------------- 闭口：一条清楚的笑弧 ----------------
            line = QPainterPath(QPointF(cx - w2, cy - lift))
            line.quadTo(QPointF(cx - w2 * 0.35, cy + hh * 0.16), QPointF(cx, cy + hh * 0.24))
            line.quadTo(QPointF(cx + w2 * 0.35, cy + hh * 0.16), QPointF(cx + w2, cy - lift))
            p.setBrush(Qt.NoBrush)
            p.setPen(QPen(_rgba("#C46E7A", 190), max(0.70, hh * 0.26),
                          Qt.SolidLine, Qt.RoundCap))
            p.drawPath(line)
            # 下唇一点柔光，别像一道划痕
            p.setPen(QPen(_rgba("#F1BDBB", 100), max(0.40, hh * 0.15),
                          Qt.SolidLine, Qt.RoundCap))
            low = QPainterPath(QPointF(cx - w2 * 0.46, cy + hh * 0.44))
            low.quadTo(QPointF(cx, cy + hh * 0.66), QPointF(cx + w2 * 0.46, cy + hh * 0.44))
            p.drawPath(low)
            return

        # ---------------- 开口说话 ----------------
        oh = hh * (0.48 + 3.10 * opn)          # 开口高度（比原来大一倍多）
        # 宽度单独走一条包络：有的音节是"啊"（竖），有的是"咿"（横）
        shape = 0.86 + 0.30 * abs(math.sin(t * 9.1 + 1.1)) if mode == "answering" else 1.0
        w2 = hw * (1.14 + 0.30 * opn) * shape
        corner_x = w2 * 1.06
        vy = cy - oh * 0.22                    # 张大时视觉重心上移，别把下巴吃光
        corner = vy - lift                     # 嘴角：永远高于上唇中线
        top_y = corner + oh * 0.34             # 上唇中线比嘴角低 = 笑口（几何永远成立）

        cavity = QPainterPath()
        cavity.moveTo(cx - corner_x, corner)
        cavity.quadTo(QPointF(cx - w2 * 0.52, top_y - hh * 0.03), QPointF(cx, top_y))
        cavity.quadTo(QPointF(cx + w2 * 0.52, top_y - hh * 0.03), QPointF(cx + corner_x, corner))
        cavity.quadTo(QPointF(cx + corner_x * 0.64, vy + oh * 0.88), QPointF(cx, vy + oh * 0.99))
        cavity.quadTo(QPointF(cx - corner_x * 0.64, vy + oh * 0.88), QPointF(cx - corner_x, corner))
        cavity.closeSubpath()

        cg = QLinearGradient(0, top_y, 0, vy + oh)
        cg.setColorAt(0.0, _rgba("#7E3A48", 255))
        cg.setColorAt(0.42, _rgba("#A95665", 255))
        cg.setColorAt(1.0, _rgba("#C87B85", 255))
        p.setBrush(QBrush(cg))
        p.setPen(QPen(_rgba("#B2606D", 210), max(0.50, hh * 0.17)))
        p.drawPath(cavity)

        # 口腔深处的阴影（上唇内侧）
        p.setPen(Qt.NoPen)
        deep = QRadialGradient(QPointF(cx, top_y + oh * 0.10), w2 * 1.05)
        deep.setColorAt(0.0, _rgba("#6E2F3C", 150))
        deep.setColorAt(1.0, _rgba("#6E2F3C", 0))
        p.setBrush(QBrush(deep))
        p.drawEllipse(QPointF(cx, top_y + oh * 0.16), w2 * 0.98, oh * 0.52)

        # 上排牙齿：裁在口腔里，紧贴上唇内缘，两端留点暗色才不像假牙
        if opn > 0.20:
            ta = int(95 + 70 * min(1.0, (opn - 0.20) / 0.5))
            p.save()
            p.setClipPath(cavity)
            p.setPen(Qt.NoPen)
            p.setBrush(_rgba("#FCEBE7", ta))
            p.drawRect(QRectF(cx - w2 * 0.62, top_y - hh * 0.06, w2 * 1.24, oh * 0.15))
            p.restore()

        # 舌头（扁一点，别像含了颗糖）
        if opn > 0.34:
            p.setPen(Qt.NoPen)
            p.setBrush(_rgba("#CE7A85", 150))
            p.drawEllipse(QPointF(cx, vy + oh * 0.72), w2 * 0.40, oh * 0.12)

        # 下唇外缘一道柔光，紧紧贴着下唇，别飘成第二层唇
        p.setBrush(Qt.NoBrush)
        p.setPen(QPen(_rgba("#EFB2B8", 120), max(0.40, hh * 0.15),
                      Qt.SolidLine, Qt.RoundCap))
        low = QPainterPath(QPointF(cx - corner_x * 0.58, vy + oh * 0.98))
        low.quadTo(QPointF(cx, vy + oh * 1.10), QPointF(cx + corner_x * 0.58, vy + oh * 0.98))
        p.drawPath(low)

        # 嘴角笑纹：一道短促的上挑，把"在笑"这件事说清楚
        if smile > 0.25:
            a = int(200 * min(1.0, (smile - 0.25) / 0.45))
            p.setPen(QPen(_rgba("#C0707C", a), max(0.45, hh * 0.15),
                          Qt.SolidLine, Qt.RoundCap))
            for sgn in (-1, 1):
                q = QPainterPath(QPointF(cx + sgn * corner_x * 0.98, corner + hh * 0.22))
                q.quadTo(QPointF(cx + sgn * corner_x * 1.16, corner - hh * 0.16),
                         QPointF(cx + sgn * corner_x * 1.06, corner - hh * 0.72))
                p.drawPath(q)

    # ------------------------------------------------------------------ #
    # 坐姿场景：键光 + 连点的手
    # ------------------------------------------------------------------ #
    def _tap_energy(self, t: float) -> float:
        """两只手合成一个 0~1 的"正在敲"的强度，喂给键光和身体起伏。"""
        e = 0.0
        for i in range(2):
            e = max(e, max(0.0, math.sin(t * 34.5 + i * 1.9)) ** 2)
        return e

    def _kb_lights(self, p: QPainter, s: float, left: float, top: float, t: float,
                   energy: float = 0.5) -> None:
        kx, ky, kw, kh = self.D_KB
        cx = left + kx * s
        cy = top + ky * s
        w, h = kw * s, kh * s
        rows, cols = 4, 15

        def key_pos(r: int, c: int):
            yy = cy - h * 0.26 + r * h * 0.175
            inset = w * (0.052 + 0.020 * r)
            span = w - inset * 2
            return cx - w / 2 + inset + span * (c + 0.5) / cols, yy, span / cols

        p.save()
        p.setPen(Qt.NoPen)

        # 键盘压在桌面上的暗部，把它从浅色桌面上"托"起来
        ao = QRadialGradient(QPointF(cx, cy + h * 0.40), w * 0.50)
        ao.setColorAt(0.0, _with_alpha("#2F4A66", 58))
        ao.setColorAt(1.0, _with_alpha("#2F4A66", 0))
        p.setBrush(QBrush(ao))
        p.drawEllipse(QPointF(cx, cy + h * 0.42), w * 0.50, h * 0.34)

        # ---- 1. 混色层：饱和度直接压上去（白色键帽上加光只会更白，必须用 Normal）----
        # 键帽常亮背光：整块键区罩一层冷蓝，键帽本身变"暗场"，后面的光才看得见
        back = QLinearGradient(0, cy - h * 0.42, 0, cy + h * 0.46)
        back.setColorAt(0.0, _with_alpha("#2E5E8C", 96))
        back.setColorAt(0.55, _with_alpha("#2A5C8A", 74))
        back.setColorAt(1.0, _with_alpha("#20486E", 96))
        p.setBrush(QBrush(back))
        p.drawRoundedRect(QRectF(cx - w * 0.455, cy - h * 0.36, w * 0.91, h * 0.80),
                          h * 0.12, h * 0.12)

        # 前缘灯条：一道实打实的青色亮边，随敲击节奏一明一暗
        strip = QLinearGradient(0, cy + h * 0.22, 0, cy + h * 0.50)
        strip.setColorAt(0.0, _with_alpha("#7FE4FF", 0))
        strip.setColorAt(0.30, _with_alpha("#5FDAFF", int(140 + 110 * energy)))
        strip.setColorAt(0.62, _with_alpha("#22B6F0", int(80 + 80 * energy)))
        strip.setColorAt(1.0, _with_alpha("#1272A8", 0))
        p.setBrush(QBrush(strip))
        p.drawRect(QRectF(cx - w * 0.43, cy + h * 0.22, w * 0.86, h * 0.30))

        # ---- 2. 被按下的键：每只手在自己掌下点亮，先混色后加光 ----
        hits = []
        for i, (hx, _hy) in enumerate(self.D_HANDS):
            base_c = ((left + hx * s) - (cx - w / 2)) / w * cols
            for j in range(3):
                tick = t * 9.5 + i * 1.7 + j * 0.33
                k = int(tick)
                frac = tick - k
                if frac > 0.72:
                    continue
                c = max(0, min(cols - 1, int(base_c + ((k * 5 + j * 7 + i * 3) % 5) - 2)))
                r = (k * 3 + j * 2 + i) % rows
                hits.append((key_pos(r, c), (1.0 - frac / 0.72) ** 1.4))

        for (x, y, cell), a in hits:
            p.setBrush(_with_alpha("#8FEBFF", int(60 + 175 * a)))
            p.drawRoundedRect(QRectF(x - cell * 0.34, y, cell * 0.68, h * 0.09),
                              h * 0.030, h * 0.030)

        # ---- 3. 加色层：只留一点晕光 ----
        p.setCompositionMode(QPainter.CompositionMode_Plus)
        for (x, y, cell), a in hits:
            gl = QRadialGradient(QPointF(x, y + h * 0.04), cell * 1.35)
            gl.setColorAt(0.0, _with_alpha("#6FE0FF", int(120 * a)))
            gl.setColorAt(0.40, _with_alpha("#35A8FF", int(56 * a)))
            gl.setColorAt(1.0, _with_alpha("#35A8FF", 0))
            p.setBrush(QBrush(gl))
            p.drawEllipse(QPointF(x, y + h * 0.04), cell * 1.35, h * 0.17)

        # 灯条外扩的柔光
        bloom = QLinearGradient(0, cy + h * 0.10, 0, cy + h * 0.66)
        bloom.setColorAt(0.0, _with_alpha("#38B8FF", 0))
        bloom.setColorAt(0.34, _with_alpha("#38B8FF", int(46 + 84 * energy)))
        bloom.setColorAt(1.0, _with_alpha("#38B8FF", 0))
        p.setBrush(QBrush(bloom))
        p.drawRect(QRectF(cx - w * 0.48, cy + h * 0.10, w * 0.96, h * 0.56))
        p.restore()


    def _typing_hands(self, p: QPainter, s: float, left: float, top: float,
                      t: float, alpha: float, lift: float) -> None:
        hw, hh = self.D_HAND_HALF
        p.setRenderHint(QPainter.SmoothPixmapTransform, True)
        for i, (hx, hy) in enumerate(self.D_HANDS):
            patch = self._hand_patch(i)
            base = QRectF(left + (hx - hw) * s, top + (hy - hh) * s, hw * 2 * s, hh * 2 * s)

            # 1) 先画上一层"上一毫秒的手"：随节奏收放的拖影（约 5.5 次/秒）
            ph = t * 34.5 + i * 1.9
            hit = max(0.0, math.sin(ph)) ** 2
            tap = max(0.0, math.sin(ph * 0.5 + 0.7)) ** 2
            k = min(1.0, hit * 0.72 + tap * 0.28)
            dy = -k * lift * 0.55
            h_ = hh * 2 * s * (1.0 - 0.07 * k)      # 以手腕为轴收一下 = 手指抬起
            dx = math.sin(t * 17.3 + i * 2.4) * s * 2.0
            dst = QRectF(base.x() + dx, base.y() + dy, hw * 2 * s, h_)
            p.setOpacity(alpha * (0.04 + 0.40 * k))
            p.drawPixmap(dst, patch, QRectF(patch.rect()))

            # 2) 再把清晰的手盖回去（从左到右都是"实手 + 身后拖影"，不会变成两只手）
            p.setOpacity(alpha * 0.97)
            p.drawPixmap(base, patch, QRectF(patch.rect()))
        p.setOpacity(alpha)
        p.setOpacity(alpha)

    # ------------------------------------------------------------------ #
    # 站姿场景
    # ------------------------------------------------------------------ #
    def _standing(self, p: QPainter, st, alpha: float) -> None:
        mode = getattr(st, "mode", "idle") or "idle"
        if mode == "coding":
            mode = "idle"
        pm = self.art()
        if pm.isNull():
            return
        head, body = self._layers()
        sx, sy, w, left, top = self._geo()
        t = st.t
        bob = math.sin(t * 1.55) * 2.1

        p.save()
        p.setOpacity(alpha)
        p.setPen(Qt.NoPen)
        sw = 40 - bob * 0.8
        shadow = QRadialGradient(QPointF(100, 191), max(24.0, sw))
        shadow.setColorAt(0.0, _with_alpha("#33425C", 64))
        shadow.setColorAt(1.0, _with_alpha("#33425C", 0))
        p.setBrush(QBrush(shadow))
        p.drawEllipse(QPointF(100, 191), max(24.0, sw), 9.0)

        if body is not None:
            by = top + (self.NECK_Y - self.OVERLAP) * sy + bob * 0.55
            p.setRenderHint(QPainter.SmoothPixmapTransform, True)
            p.drawPixmap(QRectF(left, by, w, body.height() * sy), body, QRectF(body.rect()))

        base = {"thinking": -4.2, "listening": 5.2, "answering": -1.4}.get(mode, 0.0)
        sway = math.sin(t * 0.9) * 1.7 if mode == "idle" else math.sin(t * 1.6) * 0.9
        nod = 0.0
        if mode == "answering":
            nod = math.sin(t * 9.7) * 1.9 + math.sin(t * 3.4) * 1.1
        elif mode == "thinking":
            nod = -math.sin(t * 1.2) * 1.0
        rot = base + sway + nod

        neck = top + self.NECK_Y * sy + bob
        p.save()
        p.translate(100, neck)
        p.rotate(rot)
        p.translate(-100, -neck)

        hy = top + bob * 0.85
        if mode == "answering":
            # 说话时脑袋跟着音节轻轻上下点，整张脸才不是"贴"在那
            hy -= self._syllable(t) * 1.3
        if head is not None:
            p.setRenderHint(QPainter.SmoothPixmapTransform, True)
            p.drawPixmap(QRectF(left, hy, w, head.height() * sy), head, QRectF(head.rect()))
            smile, _open, blush = self._expr(mode, t)
            for bx, by in self.BLUSH:
                self._blush(p, left + bx * sx, hy + by * sy,
                            self.BLUSH_HALF[0] * sx, self.BLUSH_HALF[1] * sy, blush)
            self._eyes(p, pm, sx, sy, left, hy, self.EYES, self.EYE_HALF, st,
                       self.SKIN_HI, self.SKIN_LO, smile=smile)
            mx, my = self.MOUTH
            self._mouth(p, left + mx * sx, hy + my * sy,
                        self.MOUTH_HALF[0] * sx, self.MOUTH_HALF[1] * sy,
                        mode, t, self.SKIN_HI, self.SKIN_LO)
        p.restore()

        if mode == "thinking":
            self._dots(p, t)
        elif mode == "listening":
            self._arcs(p, 150, 74, t, QColor("#7FC8FF"), 3, 8.0, 6.4, 72)
        elif mode == "answering":
            self._arcs(p, 126, 96, t, QColor("#A6DCFF"), 3, 6.4, 5.4, 54)

        self.draw_sparkles(p, st)
        p.restore()

    # ------------------------------------------------------------------ #
    # 坐姿场景
    # ------------------------------------------------------------------ #
    def _desk(self, p: QPainter, st, alpha: float) -> None:
        head, body = self._desk_layers()
        pm = self.desk_art()
        if pm.isNull() or head is None:
            return
        s, w, left, top = self._desk_geo()
        t = st.t

        p.save()
        p.setOpacity(alpha)

        # 桌面落地的影子
        p.setPen(Qt.NoPen)
        sh = QRadialGradient(QPointF(100, 195), 96)
        sh.setColorAt(0.0, _with_alpha("#2E3B52", 60))
        sh.setColorAt(1.0, _with_alpha("#2E3B52", 0))
        p.setBrush(QBrush(sh))
        p.drawEllipse(QPointF(100, 195), 96, 9.0)

        # 敲击的节奏：肩背跟着键点一顿一顿（键盘在身体层里，所以一起走）
        tap = self._tap_energy(t)
        body_dy = -tap * 1.5
        by = top + (self.D_NECK_Y - self.D_OVERLAP) * s + body_dy
        p.setRenderHint(QPainter.SmoothPixmapTransform, True)
        p.drawPixmap(QRectF(left, by, w, body.height() * s), body, QRectF(body.rect()))

        # 键盘光 + 双手拖影
        self._kb_lights(p, s, left, top + body_dy, t, tap)
        self._typing_hands(p, s, left, top + body_dy, t, alpha, lift=20.0 * s)

        # 头部：跟着按键轻点，眼睛半垂（盯着键盘/屏幕）
        nod = math.sin(t * 6.3) * 1.5 + math.sin(t * 2.2) * 0.8
        neck = top + self.D_NECK_Y * s + body_dy
        p.save()
        p.translate(100, neck)
        p.rotate(-1.2 + nod * 0.55)
        p.translate(-100, -neck)

        hy = top + body_dy * 1.05
        p.drawPixmap(QRectF(left, hy, w, head.height() * s), head, QRectF(head.rect()))
        smile, _open, blush = self._expr("coding_mumble", t)
        for bx, by in self.D_BLUSH:
            self._blush(p, left + bx * s, hy + by * s,
                        self.D_BLUSH_HALF[0] * s, self.D_BLUSH_HALF[1] * s, blush * 1.05)
        self._eyes(p, pm, s, s, left, hy, self.D_EYES, self.D_EYE_HALF, st,
                   self.D_SKIN_HI, self.D_SKIN_LO, smile=smile)
        mx, my = self.D_MOUTH
        self._mouth(p, left + mx * s, hy + my * s,
                    self.D_MOUTH_HALF[0] * s, self.D_MOUTH_HALF[1] * s,
                    "coding_mumble", t, self.D_SKIN_HI, self.D_SKIN_LO)
        p.restore()

        # 屏幕反光：从键盘方向打上来的一点冷光
        p.save()
        p.setCompositionMode(QPainter.CompositionMode_Plus)
        p.setPen(Qt.NoPen)
        kx, ky, kw, kh = self.D_KB
        gl = QRadialGradient(QPointF(left + kx * s, top + (ky - 190) * s), w * 0.44)
        gl.setColorAt(0.0, _with_alpha("#5FB4FF", 22))
        gl.setColorAt(1.0, _with_alpha("#5FB4FF", 0))
        p.setBrush(QBrush(gl))
        p.drawEllipse(QPointF(left + (kx - 20) * s, top + (ky - 200) * s), w * 0.44, w * 0.30)
        p.restore()

        self.draw_sparkles(p, st)
        p.restore()

    # ------------------------------------------------------------------ #
    # 入口
    # ------------------------------------------------------------------ #
    def paint(self, p: QPainter, st) -> None:
        mode = getattr(st, "mode", "idle") or "idle"
        target = 1.0 if (mode == "coding" and not self.desk_art().isNull()) else 0.0

        t = getattr(st, "t", 0.0)
        dt = t - self._pt if self._pt >= 0 else 0.033
        self._pt = t
        dt = min(max(dt, 0.0), 0.12)
        self._mix += (target - self._mix) * min(1.0, dt * 7.5)
        if self._mix < 0.004:
            self._mix = 0.0
        if self._mix > 0.996:
            self._mix = 1.0

        if self._mix < 1.0:
            self._standing(p, st, 1.0 - self._mix)
        if self._mix > 0.0:
            self._desk(p, st, self._mix)
        p.setOpacity(1.0)

    def _dots(self, p: QPainter, phase: float) -> None:
        for i, (x, y, r) in enumerate([(133, 32, 4.2), (141, 24, 3.2), (148, 17, 2.3)]):
            k = (math.sin(phase * 2.6 - i * 0.8) + 1) * 0.5
            p.setPen(Qt.NoPen)
            glow = QRadialGradient(QPointF(x, y), r * 2.8)
            glow.setColorAt(0.0, _with_alpha("#8FC8FF", int(26 + 58 * k)))
            glow.setColorAt(1.0, _with_alpha("#8FC8FF", 0))
            p.setBrush(QBrush(glow))
            p.drawEllipse(QPointF(x, y), r * 2.8, r * 2.8)
            p.setBrush(_with_alpha("#F2F8FF", int(150 + 100 * k)))
            p.drawEllipse(QPointF(x, y), r * (0.9 + 0.1 * k), r * (0.9 + 0.1 * k))


CHARACTERS = {
    "xiaoxi": GirlArt(),
    "fox": Fox(),
    "frost": FoxFrost(),
    "night": FoxNight(),
    "ninja": Ninja(),
    "ninja_blue": NinjaBlue(),
}
