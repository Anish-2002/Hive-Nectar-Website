#!/usr/bin/env python3
"""Build the profile PWA icons from the site logo (public/newlogo.png).

The source logo is the gold mark (hexagon + drop + leaf) with a "HIVE NECTAR"
wordmark underneath. At 192 px the wordmark is unreadable and gold-on-cream is
low contrast, so the icons are the mark alone, recoloured cream on the brand
green that the app already uses for theme_color. The maskable variant keeps the
mark inside the 80% safe circle so Android can crop it to any shape.

Run from the repo root:  python3 scripts/make-pwa-icons.py
"""
from PIL import Image

SRC = "public/newlogo.png"
OUT = "public/icons"
BG = (63, 107, 79)      # brand green, matches manifest theme_color
MARK = (255, 249, 240)  # cream, matches the page background

SCALE_ANY = 0.80
SCALE_MASKABLE = 0.58


def load_mark():
    lg = Image.open(SRC).convert("RGBA")
    w, h = lg.size
    keep_h = int(h * 0.86)  # drop the wordmark band under the mark
    mark = lg.crop((0, 0, w, keep_h))
    bbox = mark.split()[-1].getbbox()
    if not bbox:
        raise SystemExit("logo has no opaque pixels")
    return mark.crop(bbox)


def build(mark, side, fraction):
    canvas = Image.new("RGBA", (side, side), BG + (255,))
    mw, mh = mark.size
    k = (side * fraction) / max(mw, mh)
    resized = mark.resize((max(1, round(mw * k)), max(1, round(mh * k))), Image.LANCZOS)
    tinted = Image.new("RGBA", resized.size, MARK + (255,))
    tinted.putalpha(resized.split()[-1])  # keep the logo's own anti-aliased edge
    canvas.alpha_composite(tinted, ((side - resized.width) // 2, (side - resized.height) // 2))
    return canvas.convert("RGB")


def main():
    mark = load_mark()
    jobs = [
        ("icon-192.png", 192, SCALE_ANY),
        ("icon-512.png", 512, SCALE_ANY),
        ("maskable-512.png", 512, SCALE_MASKABLE),
        ("apple-touch-icon.png", 180, SCALE_ANY),
    ]
    for name, side, frac in jobs:
        build(mark, side, frac).save(f"{OUT}/{name}", "PNG", optimize=True)
        print(f"wrote {OUT}/{name} {side}x{side} mark={round(side * frac)}px")


if __name__ == "__main__":
    main()
