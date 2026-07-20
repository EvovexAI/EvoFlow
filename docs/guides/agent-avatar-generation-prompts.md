# 智能体 3D 立绘生成提示词

用于生成「系统默认头像库」与内置智能体 cutout 的参考文档。风格对齐产品经理立绘：软粘土 / 3D 吉祥物、半身、透明底、无文字。

生成工具：Cursor `GenerateImage`（可带 `reference_image_paths` 指向已有立绘以锁风格）。

推荐参考图：

- `backend/packages/harness/evoflow/assets/builtin_agent_avatars/product-manager.png`
- 或 `backend/packages/harness/evoflow/assets/avatar_presets/pm.png`

产出落地：

| 用途 | 目录 |
|------|------|
| 按智能体编码绑定的默认图 | `backend/packages/harness/evoflow/assets/builtin_agent_avatars/{agent_code}.png` |
| 新建智能体可选的系统预设 | `backend/packages/harness/evoflow/assets/avatar_presets/{id}.png` + `manifest.json` |

生成后建议用脚本抠浅色底为透明，并缩放到约 `1024×1024` PNG。

---

## 通用风格约束（建议每条提示词都带上）

```text
3D soft clay stylized character bust avatar cutout matching reference style:
warm studio lighting, transparent background, centered upper-body portrait,
no text, no border, no drop shadow, high quality UI mascot
```

中文理解（写进提示词时仍建议用英文，模型对英文构图更稳）：

- 软粘土 / 3D 卡通角色半身像
- 与参考图同一套造型语言
- 暖色棚拍光、透明背景、居中半身
- 不要文字、描边、投影
- 适合产品 UI 头像的吉祥物质感

`aspect_ratio`：优先 `1:1`。

---

## 产品经理（`product-manager` / preset `pm`）

```text
Product manager AI agent avatar cutout, matching the same style as the reference character portraits:
3D soft clay/plasticine stylized character bust, friendly young professional woman,
short neat dark hair, wearing a soft teal-blue blazer over a white shirt,
holding a small clipboard or sticky notes against chest,
warm soft studio lighting, clean transparent background,
centered upper-body portrait, no text, no border, no shadow,
high quality character mascot for software product UI
```

---

## 系统默认头像库（`avatar_presets`）

下列提示词均在「通用风格约束」之上追加角色描述；实际生成时把通用段与角色段拼在一起，并附上产品经理参考图。

### `engineer` — 工程

```text
3D soft clay stylized character bust avatar cutout matching reference style:
friendly young East Asian man software engineer, short black hair,
wearing dark hoodie with subtle teal accent, holding a small laptop,
warm studio lighting, transparent background, centered upper-body portrait,
no text no border no shadow, high quality UI mascot
```

### `analyst` — 分析

```text
3D soft clay stylized character bust avatar cutout matching reference style:
friendly woman data analyst with round glasses, neat bun hairstyle,
beige cardigan, holding a small chart tablet,
warm soft studio lighting, transparent background, centered upper-body portrait,
no text no border, high quality UI mascot
```

### `designer` — 设计

```text
3D soft clay stylized character bust avatar cutout matching reference style:
creative young woman designer, colorful scarf, soft lavender sweater,
holding a color palette or stylus tablet,
warm studio lighting, transparent background, centered upper-body portrait,
no text no border, high quality UI mascot
```

### `ops` — 运维

```text
3D soft clay stylized character bust avatar cutout matching reference style:
calm middle-aged man DevOps engineer, short salt-and-pepper hair,
olive utility shirt, small headset earpiece,
holding a server rack toy or terminal tablet,
warm studio lighting, transparent background, centered upper-body portrait,
no text no border, high quality UI mascot
```

### `researcher` — 研究

```text
3D soft clay stylized character bust avatar cutout matching reference style:
thoughtful woman researcher, long dark hair with side braid,
navy academic blazer, holding an open book or research notebook,
warm studio lighting, transparent background, centered upper-body portrait,
no text no border, high quality UI mascot
```

### `support` — 支持

```text
3D soft clay stylized character bust avatar cutout matching reference style:
friendly young man customer support, soft smile, short curly hair,
light blue polo shirt, wearing over-ear headset with mic,
warm studio lighting, transparent background, centered upper-body portrait,
no text no border, high quality UI mascot
```

### `lead` — 管理

```text
3D soft clay stylized character bust avatar cutout matching reference style:
confident mature woman team lead executive, silver-streaked short hair,
charcoal blazer, subtle gold pin, holding a closed leather folio,
warm studio lighting, transparent background, centered upper-body portrait,
no text no border, high quality UI mascot
```

### `intern` — 新人

```text
3D soft clay stylized character bust avatar cutout matching reference style:
youthful intern student character, bright smile, messy short hair,
oversized pastel hoodie, backpack strap visible,
holding a coffee cup and sticky notes,
warm studio lighting, transparent background, centered upper-body portrait,
no text no border, high quality UI mascot
```

### `creator` — 创作

```text
3D soft clay stylized character bust avatar cutout matching reference style:
artistic young man creator, wavy auburn hair,
paint-splattered apron over black tee,
holding a paintbrush and small canvas,
warm studio lighting, transparent background, centered upper-body portrait,
no text no border, high quality UI mascot
```

### `guardian` — 安全

```text
3D soft clay stylized character bust avatar cutout matching reference style:
steady woman security guardian, short neat hair,
dark slate jacket with subtle shield badge, calm expression,
holding a small lock icon prop or tablet with shield,
warm studio lighting, transparent background, centered upper-body portrait,
no text no border, high quality UI mascot
```

### `scientist` — 科学

```text
3D soft clay stylized character bust avatar cutout matching reference style:
curious non-binary presenting scientist, short teal-tipped hair,
white lab coat over mint shirt, holding a flask with soft glow liquid,
warm studio lighting, transparent background, centered upper-body portrait,
no text no border, high quality UI mascot
```

---

## 抠透明底（可选后处理）

生成图若带浅灰/白色底，可用 Pillow 对四角采样抠底，例如：

```python
from pathlib import Path
from PIL import Image

def punch_light_bg(src: Path, dest: Path, tol: int = 34) -> None:
    im = Image.open(src).convert("RGBA")
    px = im.load()
    w, h = im.size
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    avg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))

    def near(c, bg, t=tol):
        return all(abs(c[i] - bg[i]) <= t for i in range(3))

    if all(near(c, avg, 45) for c in corners) and avg[0] > 180:
        for y in range(h):
            for x in range(w):
                c = px[x, y]
                if near(c, avg):
                    px[x, y] = (c[0], c[1], c[2], 0)
    if max(w, h) > 1024:
        im.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "PNG", optimize=True)
```

---

## 新增一张系统预设时的检查清单

1. 用上文通用约束 + 新角色描述生成 `1:1` 图，并挂参考图。
2. 抠透明底，保存为 `assets/avatar_presets/{id}.png`。
3. 在 `assets/avatar_presets/manifest.json` 增加 `{ "id", "label", "sort" }`。
4. 重启网关后，新建/编辑智能体「系统默认」网格应出现新项。
5. 前端用 `avatar: "preset:{id}"` 引用，无需复制到 `agents/{code}/`。

按智能体编码播种（如 `quality-inspector`）则放入 `builtin_agent_avatars/`，并在 `_BUILTIN_AGENT_AVATARS` 中登记 `"image"`。
