"""
YouSum 图标生成脚本

生成 16 / 48 / 128 三种尺寸的 PNG 图标。
图形：深色圆角底 + YouTube 红三角播放键 + 白色摘要线条。

用法：
    python tools/make_icons.py
"""

import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICON_DIR = os.path.join(ROOT, "icons")

BG = (15, 23, 42)          # slate-900
ACCENT = (239, 68, 68)      # red-500
WHITE = (255, 255, 255)
DIM = (148, 163, 184)      # slate-400


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_icon(size):
    """在 4 倍画布上绘制再缩放，保证小尺寸下边缘平滑"""
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(s * 0.22)

    # 背景圆角方块
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG + (255,))

    # 左上角柔光（低透明度，避免出现硬边弧线）
    glow = Image.new("L", (s, s), 0)
    ImageDraw.Draw(glow).ellipse([-s * 0.30, -s * 0.60, s * 0.60, s * 0.30], fill=30)
    glow = glow.filter(ImageFilter.GaussianBlur(radius=s * 0.12))
    img = Image.composite(Image.new("RGBA", (s, s), DIM + (255,)), img, glow)
    d = ImageDraw.Draw(img)

    # 播放三角（红色），略偏左上，给下方文字留位置
    tri_cx = s * 0.46
    tri_cy = s * 0.37
    tri_r = s * 0.185
    d.ellipse(
        [tri_cx - tri_r * 1.32, tri_cy - tri_r * 1.32, tri_cx + tri_r * 1.32, tri_cy + tri_r * 1.32],
        fill=(30, 41, 59, 255),
    )
    d.polygon(
        [
            (tri_cx - tri_r * 0.40, tri_cy - tri_r * 0.76),
            (tri_cx - tri_r * 0.40, tri_cy + tri_r * 0.76),
            (tri_cx + tri_r * 0.90, tri_cy),
        ],
        fill=ACCENT + (255,),
    )

    # 下方摘要线条：长短交替，代表"提炼要点"
    line_x0 = s * 0.24
    line_x1 = s * 0.76
    widths = [0.52, 0.38, 0.46]
    line_h = max(2, int(s * 0.055))
    gap = s * 0.115
    start_y = s * 0.655

    for i, ratio in enumerate(widths):
        y = start_y + i * gap
        x_end = line_x0 + (line_x1 - line_x0) * ratio
        color = WHITE + (255,) if i == 0 else DIM + (255,)
        d.rounded_rectangle(
            [line_x0, y, x_end, y + line_h],
            radius=line_h / 2,
            fill=color,
        )

    # 应用圆角遮罩到四角
    mask = rounded_mask(s, radius)
    img.putalpha(Image.composite(img.getchannel("A"), Image.new("L", (s, s), 0), mask))

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(ICON_DIR, f"icon{size}.png")
        draw_icon(size).save(path, "PNG", optimize=True)
        print(f"generated {path}")


if __name__ == "__main__":
    main()
