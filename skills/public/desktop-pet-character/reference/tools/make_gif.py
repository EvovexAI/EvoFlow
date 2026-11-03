"""把小汐的三段动效（待机眨眼 → 说话 → 坐下敲键盘）渲染成 GIF，用来验收动作。

用法：python make_gif.py [--size 240] [--fps 20]
"""
from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtWidgets import QApplication

from pet.characters import CHARACTERS
from pet.state import PetState

SIZE = 240
FPS = 20
BG = QColor("#E9EFF7")

SEGMENTS = [
    ("idle", 1.6),
    ("answering", 1.8),
    ("coding", 2.4),
]


def blink_at(t: float) -> float:
    ph = (t % 2.6) / 0.16
    return 1.0 - abs(min(1.0, ph) * 2 - 1) if ph < 1.0 else 0.0


def to_pil(img: QImage) -> Image.Image:
    conv = img.convertToFormat(QImage.Format_RGB888)
    w, h, stride = conv.width(), conv.height(), conv.bytesPerLine()
    buf = bytes(conv.constBits())
    rows = [buf[y * stride:y * stride + w * 3] for y in range(h)]
    return Image.frombytes("RGB", (w, h), b"".join(rows))


def main() -> None:
    sys.argv += []
    app = QApplication(sys.argv[:1])
    ch = CHARACTERS["xiaoxi"]

    frames = []
    img = QImage(SIZE, SIZE, QImage.Format_ARGB32_Premultiplied)

    t = 0.0
    for mode, dur in SEGMENTS:
        n = int(round(dur * FPS))
        for _ in range(n):
            img.fill(BG)
            p = QPainter(img)
            p.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
            p.scale(SIZE / 200.0, SIZE / 200.0)
            ch.paint(p, PetState(t=t, mode=mode, blink=blink_at(t) if mode == "idle" else 0.0))
            p.end()
            frames.append(to_pil(img))
            t += 1.0 / FPS

    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "assets", "xiaoxi_anim.gif")
    frames[0].save(out, save_all=True, append_images=frames[1:],
                   duration=int(1000 / FPS), loop=0, optimize=True)
    print(out, len(frames), "frames")


if __name__ == "__main__":
    main()
