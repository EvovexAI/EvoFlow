"""把脸部区域放大拼图，用来检查嘴型与表情。"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtWidgets import QApplication

from pet.characters import CHARACTERS
from pet.state import PetState


def warm(ch, mode, upto=3.0):
    w = QImage(16, 16, QImage.Format_ARGB32_Premultiplied)
    w.fill(QColor("#EEF3FA"))
    t = 0.0
    while t < upto:
        t += 0.033
        p = QPainter(w)
        ch.paint(p, PetState(t=t, mode=mode))
        p.end()
    return t


def face(ch, mode, t, size=520, desk=False):
    img = QImage(size, size, QImage.Format_ARGB32_Premultiplied)
    img.fill(QColor("#F2E9DC"))
    p = QPainter(img)
    p.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
    p.scale(size / 200.0, size / 200.0)
    ch.paint(p, PetState(t=t, mode=mode))
    p.end()
    f = size / 200.0
    if desk:
        box = (62, 52, 76, 62)
    else:
        box = (68, 62, 64, 58)
    return img.copy(int(box[0] * f), int(box[1] * f),
                    int(box[2] * f), int(box[3] * f)).scaled(300, 300)


def main():
    app = QApplication(sys.argv)
    ch = CHARACTERS["xiaoxi"]
    rows = []
    for mode in ("idle", "answering"):
        t = warm(ch, mode)
        row = [face(ch, mode, t + i * 0.05) for i in range(6)]
        rows.append(row)
    W = 300 * 6
    out = QImage(W, 300 * len(rows), QImage.Format_RGB32)
    out.fill(QColor("#F2E9DC"))
    op = QPainter(out)
    for r, row in enumerate(rows):
        for i, c in enumerate(row):
            op.drawImage(i * 300, r * 300, c)
    op.end()
    out.save("tools/zoom_face.png")
    print("ok")


if __name__ == "__main__":
    main()
