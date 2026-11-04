"""把洋红底（#FF00FF）立绘抠成透明 PNG。

用法：python key_magenta.py 输入.png 输出.png [--crop x1,y1,x2,y2]
抠法：d = min(R,B) - G 作为"洋红度"，d 越小越像画面内容。
边缘半透明像素做软 alpha，并且只在边缘带里压 R/B 去掉洋红溢色，
避免整图去色把冰蓝压成灰白。
"""
from __future__ import annotations

import sys

import numpy as np
from PIL import Image, ImageFilter


def key(path_in: str, path_out: str, crop=None) -> None:
    im = Image.open(path_in).convert("RGB")
    if crop:
        im = im.crop(tuple(int(v) for v in crop))
    a = np.asarray(im).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]

    d = np.minimum(r, b) - g                       # 洋红度
    alpha = np.clip((48.0 - d) / 48.0, 0.0, 1.0)   # d>=48 判为背景
    alpha = alpha ** 0.85                          # 让半透明发丝别太稀
    soft = (alpha * 255).astype(np.uint8)

    # 边缘带：alpha 在 (0,250) 以及它往外扩 3px
    edge = (soft < 250).astype(np.uint8) * 255
    edge_img = Image.fromarray(edge, "L").filter(ImageFilter.MaxFilter(7))
    band = np.asarray(edge_img).astype(np.float32) > 0

    # 只在边缘带去溢色
    r2 = np.where(band, np.minimum(r, g + 8), r)
    b2 = np.where(band, np.minimum(b, g + 8), b)
    g2 = g
    out = np.dstack([r2, g2, b2]).clip(0, 255).astype(np.uint8)

    # 清掉半透明区里残留的洋红（色相偏洋红的弱像素直接杀掉）
    dd = (np.minimum(r2, b2) - g2)
    kill = dd > 18
    soft = np.where(kill, 0, soft).astype(np.uint8)

    rgba = np.dstack([out, soft])
    img = Image.fromarray(rgba, "RGBA")
    img = img.crop(img.getbbox())
    img.save(path_out)
    print("saved", path_out, img.size)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    c = None
    if "--crop" in sys.argv:
        i = sys.argv.index("--crop")
        c = [int(v) for v in sys.argv[i + 1].split(",")]
    key(sys.argv[1], sys.argv[2], c)
