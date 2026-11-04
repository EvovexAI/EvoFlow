"""渲染睡觉状态的整身 + 脸部特写，验收睡眼。"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtWidgets import QApplication

from pet.characters import CHARACTERS
from pet.state import PetState

S = 1600


def main() -> None:
    app = QApplication(sys.argv)
    ch = CHARACTERS["xiaoxi"]

    def state(tt: float) -> PetState:
        return PetState(t=tt, mode="idle", asleep=True, blink_lid=1.0)

    # 预热（加载立绘、淡入）
    warm = QImage(16, 16, QImage.Format_ARGB32_Premultiplied)
    warm.fill(QColor("#EEF3FA"))
    t = 0.0
    while t < 3.0:
        t += 0.033
        p = QPainter(warm)
        ch.paint(p, state(t))
        p.end()

    # 整身
    img = QImage(S, S, QImage.Format_ARGB32_Premultiplied)
    img.fill(QColor("#F2E9DC"))
    p = QPainter(img)
    p.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
    p.scale(S / 200.0, S / 200.0)
    ch.paint(p, state(3.2))
    p.end()
    img.copy(0, 0, S, S).save("tools/sleep_full.png")

    # 脸部特写
    f = S / 200.0
    box = (72 * f, 42 * f, 56 * f, 56 * f)
    crop = img.copy(int(box[0]), int(box[1]), int(box[2]), int(box[3]))
    crop = crop.scaled(1000, 1000)
    crop.save("tools/sleep_face.png")
    print("saved tools/sleep_full.png tools/sleep_face.png")


if __name__ == "__main__":
    main()
