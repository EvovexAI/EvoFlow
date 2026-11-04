"""从生成的 2x2 手部 sprite sheet 抠出 4 个手贴图。

用法：python make_hands.py <sprite_sheet.png>
输出：assets/hand_open.png   张开掌（掌心向前，指尖朝上）
      assets/hand_wave.png   侧倾挥动掌
      assets/hand_relax.png  放松微曲
      assets/hand_point.png  食指朝上（讲解指物）
每张都把腕口对齐到图片底边中央附近，方便绕腕旋转。
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from key_magenta import key  # noqa: E402

# 2x2 格子；右下格裁掉底部水印带（水印 y>=945）
CELLS = {
    "hand_open":  (0, 0, 512, 512),
    "hand_wave":  (512, 0, 1024, 512),
    "hand_relax": (0, 512, 512, 1024),
    "hand_point": (512, 512, 1024, 942),
}


def main(sheet: str) -> None:
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
    os.makedirs(out_dir, exist_ok=True)
    for name, box in CELLS.items():
        key(sheet, os.path.join(out_dir, f"{name}.png"), list(box))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
