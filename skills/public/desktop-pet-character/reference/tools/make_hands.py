"""从生成的 sprite sheet 抠出手/臂贴图。

用法：
  python make_hands.py hands <sheet.png>   # 2x2 纯手（hand_open 等）
  python make_hands.py arms  <sheet.png>   # 2x2 带袖整臂（arm_open 等）
输出到 assets/。每张都把切边对齐到图片底边，方便绕腕/肘旋转。
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from key_magenta import key  # noqa: E402

# 2x2 格子；含水印的格子先把底部水印带裁掉
CELLS = {
    "hands": {
        "hand_open":  (0, 0, 512, 512),
        "hand_wave":  (512, 0, 1024, 512),
        "hand_relax": (0, 512, 512, 1024),
        "hand_point": (512, 512, 1024, 942),
    },
    "arms": {
        "arm_open":  (0, 0, 512, 512),
        "arm_wave":  (512, 0, 1024, 512),
        "arm_point": (0, 512, 512, 1024),
        "arm_relax": (512, 512, 1024, 935),
    },
}


def main(kind: str, sheet: str) -> None:
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
    os.makedirs(out_dir, exist_ok=True)
    for name, box in CELLS[kind].items():
        key(sheet, os.path.join(out_dir, f"{name}.png"), list(box))


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in CELLS:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
