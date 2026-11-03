"""渲染超大的单帧脸部，用来检查嘴/眼的几何形状。"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtWidgets import QApplication
from PySide6.QtCore import QPointF, QRectF

from pet.characters import CHARACTERS
from pet.state import PetState

S = 1600


def main() -> None:
    app = QApplication(sys.argv)
    ch = CHARACTERS["xiaoxi"]
    mode = sys.argv[1] if len(sys.argv) > 1 else "answering"
    tt = float(sys.argv[2]) if len(sys.argv) > 2 else 3.2

    warm = QImage(16, 16, QImage.Format_ARGB32_Premultiplied)
    warm.fill(QColor("#EEF3FA"))
    t = 0.0
    while t < 3.0:
        t += 0.033
        p = QPainter(warm)
        ch.paint(p, PetState(t=t, mode=mode))
        p.end()

    img = QImage(S, S, QImage.Format_ARGB32_Premultiplied)
    img.fill(QColor("#F2E9DC"))
    p = QPainter(img)
    p.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
    p.scale(S / 200.0, S / 200.0)
    ch.paint(p, PetState(t=tt, mode=mode))
    p.end()

    # 只保留嘴与眼附近：设计坐标 (78..122, 88..120)
    f = S / 200.0
    box = (72 * f, 42 * f, 56 * f, 56 * f)
    crop = img.copy(int(box[0]), int(box[1]), int(box[2]), int(box[3]))
    crop = crop.scaled(1000, 1000)
    crop.save(f"tools/face_big_{mode}.png")
    print(crop.size())


if __name__ == "__main__":
    main()
