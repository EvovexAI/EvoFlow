"""按真实窗口尺寸（250px）渲染单帧，检查小尺寸下的可读性。"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtWidgets import QApplication

from pet.characters import CHARACTERS
from pet.state import PetState

SIZE = 250
MODES = [("idle", 3.0), ("answering", 3.15), ("listening", 3.0),
         ("thinking", 3.0), ("coding", 3.2)]


def main() -> None:
    app = QApplication(sys.argv)
    ch = CHARACTERS["xiaoxi"]
    warm = QImage(16, 16, QImage.Format_ARGB32_Premultiplied)
    warm.fill(QColor("#EEF3FA"))
    out = QImage(SIZE * len(MODES), SIZE, QImage.Format_RGB32)
    out.fill(QColor("#F2E9DC"))
    op = QPainter(out)
    for i, (mode, t) in enumerate(MODES):
        # 先把交叉淡入推到位，否则会拍到上一个状态的残影
        tt = 0.0
        while tt < 3.0:
            tt += 0.033
            wp = QPainter(warm)
            ch.paint(wp, PetState(t=tt, mode=mode))
            wp.end()
        img = QImage(SIZE, SIZE, QImage.Format_ARGB32_Premultiplied)
        img.fill(QColor("#F2E9DC"))
        p = QPainter(img)
        p.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
        p.scale(SIZE / 200.0, SIZE / 200.0)
        ch.paint(p, PetState(t=t, mode=mode))
        p.end()
        op.drawImage(i * SIZE, 0, img)
    op.end()
    out.save("tools/real_states.png")
    print("ok")


if __name__ == "__main__":
    main()
