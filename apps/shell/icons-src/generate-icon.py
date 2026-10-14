"""Generate the app icon source (1024x1024) with Pillow.

ASCII-only on purpose: keeps the file readable by any toolchain.
Design: dark slate background + a warm lantern (glow, frame, flame).
"""

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
BG = (15, 17, 21, 255)
FRAME = (42, 47, 58, 255)
BRASS = (198, 152, 74, 255)
GLOW = (255, 179, 71, 255)
FLAME = (255, 226, 160, 255)


def radial_glow(size: int, center, radius: int, color, strength: float) -> Image.Image:
    """Cheap radial gradient: draw concentric circles with decreasing alpha."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    steps = 90
    for index in range(steps, 0, -1):
        ratio = index / steps
        alpha = int(255 * strength * (1.0 - ratio) ** 1.8)
        if alpha <= 0:
            continue
        r = radius * ratio
        box = [center[0] - r, center[1] - r, center[0] + r, center[1] + r]
        draw.ellipse(box, fill=(color[0], color[1], color[2], alpha))
    return layer.filter(ImageFilter.GaussianBlur(6))


def main() -> None:
    image = Image.new("RGBA", (SIZE, SIZE), BG)
    draw = ImageDraw.Draw(image)

    # soft warm glow behind the lantern
    image.alpha_composite(radial_glow(SIZE, (SIZE // 2, 560), 430, GLOW, 0.55))

    # lantern body: rounded rectangle
    body = [332, 372, 692, 812]
    draw.rounded_rectangle(body, radius=64, fill=FRAME, outline=BRASS, width=12)

    # glass panel with warm light
    panel = [378, 420, 646, 764]
    draw.rounded_rectangle(panel, radius=42, fill=(28, 26, 24, 255), outline=BRASS, width=8)
    image.alpha_composite(radial_glow(SIZE, ((panel[0] + panel[2]) // 2, (panel[1] + panel[3]) // 2), 190, GLOW, 0.95))

    # flame
    draw.polygon(
        [(512, 560), (566, 660), (548, 716), (476, 716), (458, 660)],
        fill=FLAME,
    )
    draw.polygon([(512, 604), (540, 664), (524, 700), (500, 700), (484, 664)], fill=(255, 255, 255, 190))

    # top cap and handle
    draw.rounded_rectangle([430, 322, 594, 378], radius=26, fill=FRAME, outline=BRASS, width=10)
    draw.arc([430, 214, 594, 372], start=180, end=360, fill=BRASS, width=22)

    # base
    draw.rounded_rectangle([392, 806, 632, 858], radius=24, fill=FRAME, outline=BRASS, width=10)

    image.convert("RGB").save("source.png")
    print("wrote source.png", image.size)


if __name__ == "__main__":
    main()
