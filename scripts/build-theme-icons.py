#!/usr/bin/env python3
"""Build the round theme-chip icons used by the profile Stories rail.

Source of truth: public.themes.visual_symbol_icon_idea, which points at a PNG in the
Supabase Storage bucket "Theme image" (public read). Those originals are ~1.6 MB and
1408x768 with a lot of transparent padding, so they are unusable in a 56px chip.

This script downloads each original, alpha-trims it, pads it onto a square canvas and
writes assets/theme-icons/<key>.{webp,png} (9-18 KB each).

Usage:
    python3 scripts/build-theme-icons.py [--check]

--check only verifies the shipped files exist and are non-empty.

To refresh the mapping after a theme image changes, run in the Supabase SQL editor
(anon cannot read themes, so a signed-in session is needed):

    select theme_name, visual_symbol_icon_idea from public.themes order by theme_id;

...then update SOURCES below with the bucket-relative path (the part after
"/storage/v1/object/public/Theme%20image/").
"""
import argparse
import io
import os
import sys
import urllib.request

PROJECT = "https://gxboojbfmpejbjolfmjq.supabase.co"
BUCKET = "Theme%20image"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "theme-icons")
SIZE = 224        # 2x the 56px chip inner circle
MARGIN = 0.06     # 6% breathing room so the art never touches the chip ring

# key -> object path inside the "Theme image" bucket (from themes.visual_symbol_icon_idea)
SOURCES = {
    "connecting": "Roots_Connecting_token.png",
    "creating": "Forge_Creating_Token.png",
    "innovating": "Shift_Innovating_Token.png",
    "reflecting": "Echo_Token.png",
    "acting": "Rhythm_Token.png",
}


def fetch(path):
    url = f"{PROJECT}/storage/v1/object/public/{BUCKET}/{path}"
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def build(key, path, out_dir):
    from PIL import Image  # imported late so --check works without Pillow

    im = Image.open(io.BytesIO(fetch(path))).convert("RGBA")
    bbox = im.getbbox()  # alpha-aware
    if not bbox:
        raise SystemExit(f"{key}: source has no opaque pixels")
    art = im.crop(bbox)

    inner = int(SIZE * (1 - 2 * MARGIN))
    scale = min(inner / art.width, inner / art.height)
    if scale <= 0:
        raise SystemExit(f"{key}: degenerate aspect ratio")
    art = art.resize((max(1, int(art.width * scale)), max(1, int(art.height * scale))), Image.LANCZOS)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(art, ((SIZE - art.width) // 2, (SIZE - art.height) // 2))

    webp = os.path.join(out_dir, key + ".webp")
    png = os.path.join(out_dir, key + ".png")
    canvas.save(webp, "WEBP", quality=90, method=6)
    canvas.save(png, "PNG", optimize=True)
    return os.path.getsize(webp), os.path.getsize(png)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify shipped icons only")
    args = ap.parse_args()

    out_dir = os.path.normpath(OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)

    if args.check:
        bad = []
        for key in SOURCES:
            for ext in ("webp", "png"):
                p = os.path.join(out_dir, f"{key}.{ext}")
                if not os.path.isfile(p) or os.path.getsize(p) == 0:
                    bad.append(p)
        print(f"{len(SOURCES) * 2 - len(bad)}/{len(SOURCES) * 2} icons present")
        return 1 if bad else 0

    total = 0
    for key, path in SOURCES.items():
        w, p = build(key, path, out_dir)
        total += w
        print(f"{key:12s} webp {w // 1024:4d}K   png {p // 1024:4d}K")
    print(f"total webp: {total // 1024}K -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
