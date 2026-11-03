"""渲染小汐的五种对话状态，用于美术迭代。"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtWidgets import QApplication

from pet.characters import CHARACTERS
from pet.state import PetState

CELL = 340
MODES = [
    ("idle", "待机"),
    ("thinking", "思考"),
    ("coding", "敲代码"),
    ("listening", "聆听"),
    ("answering", "回答"),
]


def render(st, size=CELL) -> QImage:
    img = QImage(size, size, QImage.Format_ARGB32_Premultiplied)
    img.fill(Qt.transparent)
    p = QPainter(img)
    p.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
    p.scale(size / 200.0, size / 200.0)
    CHARACTERS["xiaoxi"].paint(p, st)
    p.end()
    return img


def main() -> None:
    app = QApplication(sys.argv)
    dark = "--dark" in sys.argv
    bg = QColor("#1C2230") if dark else QColor("#F3F6FB")

    out = QImage(CELL * len(MODES), CELL, QImage.Format_ARGB32_Premultiplied)
    out.fill(bg)
    p = QPainter(out)
    ch = CHARACTERS["xiaoxi"]
    warm = QImage(16, 16, QImage.Format_ARGB32_Premultiplied)
    for i, (mode, label) in enumerate(MODES):
        # 先把场景过渡跑完，否则会拍到上一套立绘的残影
        t = 0.0
        while t < 3.0:
            t += 0.033
            wp = QPainter(warm)
            ch.paint(wp, PetState(t=t, mode=mode))
            wp.end()
        st = PetState(t=t, breath=0.35, mode=mode, look=QPointF(0, 0), wag=1.0)
        p.drawImage(i * CELL, 0, render(st))
        p.setPen(QColor("#8FA3BF") if dark else QColor("#7A8CA8"))
        p.drawText(QRectF(i * CELL, CELL - 26, CELL, 22), Qt.AlignHCenter, label)
    p.end()

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "states_dark.png" if dark else "states.png")
    out.save(path)
    print(path)


if __name__ == "__main__":
    main()
