"""宠物动画状态。绘制层只读取这个对象。"""
from __future__ import annotations

from dataclasses import dataclass, field

from PySide6.QtCore import QPointF


@dataclass
class PetState:
    t: float = 0.0            # 全局时间（秒）
    breath: float = 0.0       # -1..1 呼吸
    blink: float = 0.0        # 0 睁眼 .. 1 闭眼
    blink_lid: float = 0.0    # 缓慢的困倦眨眼
    look: QPointF = field(default_factory=lambda: QPointF(0.0, 0.0))  # -1..1 视线
    wag: float = 0.0          # 尾巴摆动相位
    wave: float = 0.0         # 0..1 抬手
    ear: float = 0.0          # 0..1 耳朵抖动
    happy: float = 0.0        # 0..1 眯眼笑
    asleep: bool = False
    squash: float = 0.0       # 落地压扁
    mode: str = "idle"        # 对话状态：idle/thinking/coding/listening/answering
