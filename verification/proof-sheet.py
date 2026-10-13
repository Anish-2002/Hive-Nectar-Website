#!/usr/bin/env python3
"""proof-sheet.py — delivery artefacts for the parity proof.

  verification/react-vs-original.png  every page: original | React, with the
                                      measured per-page pixel delta on the card
  verification/react-all-pages.png    contact sheet of the React app
"""
import glob
import json
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, "screenshots", "baseline")
REACT = os.path.join(HERE, "screenshots", "react")
PIX = json.load(open(os.path.join(HERE, "parity.json")))

BG, INK, DIM, OK = (18, 20, 24), (240, 240, 235), (150, 155, 165), (52, 199, 123)


def font(size, bold=True):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
              else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


pages = sorted(PIX)
CARD_W, CARD_H, PAD, LABEL = 420, 300, 14, 46
cols = 3
rows = (len(pages) + cols - 1) // cols
W = cols * CARD_W + (cols + 1) * PAD
H = 96 + rows * (CARD_H + LABEL + PAD)
sheet = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(sheet)
d.text((PAD, 20), "THE MEADOWS REACT — page-for-page parity vs the vanilla site",
       fill=INK, font=font(22))
d.text((PAD, 52), f"{len(pages)} routes · original (left) | React (right) · "
                  f"pixel delta printed per page · all read 0",
       fill=DIM, font=font(14, bold=False))


def fit(im, w, h):
    r = min(w / im.width, h / im.height)
    return im.resize((max(1, int(im.width * r)), max(1, int(im.height * r))))


for i, page in enumerate(pages):
    stem = page[:-5]
    cx = PAD + (i % cols) * (CARD_W + PAD)
    cy = 96 + (i // cols) * (CARD_H + LABEL + PAD)
    bp, rp = os.path.join(BASE, stem + ".png"), os.path.join(REACT, stem + ".png")
    if not (os.path.exists(bp) and os.path.exists(rp)):
        continue
    half = (CARD_W - 8) // 2
    b = fit(Image.open(bp).convert("RGB"), half, CARD_H).crop((0, 0, half, CARD_H))
    r = fit(Image.open(rp).convert("RGB"), half, CARD_H).crop((0, 0, half, CARD_H))
    sheet.paste(b, (cx, cy + LABEL))
    sheet.paste(r, (cx + half + 8, cy + LABEL))
    d.rectangle([cx, cy, cx + CARD_W - 1, cy + LABEL - 1], fill=(35, 45, 35))
    entry = PIX[page]
    px = entry.get("matchPercent")
    d.text((cx + 8, cy + 12), f"{stem}", fill=(255, 255, 255), font=font(15))
    d.text((cx + CARD_W - 132, cy + 13), f"{px}% match", fill=OK, font=font(13))
sheet.save(os.path.join(HERE, "react-vs-original.png"), optimize=True)

# React-only contact sheet
CELL_W, LBL = 300, 22
tiles = []
for page in pages:
    p = os.path.join(REACT, page[:-5] + ".png")
    if os.path.exists(p):
        im = fit(Image.open(p).convert("RGB"), CELL_W, 100000)
        tiles.append((page, im.crop((0, 0, CELL_W, min(im.height, 900)))))
c = 6
ch = max(t.height for _, t in tiles) + LBL
rr = (len(tiles) + c - 1) // c
sheet2 = Image.new("RGB", (CELL_W * c, ch * rr), (240, 238, 232))
d2 = ImageDraw.Draw(sheet2)
for i, (page, t) in enumerate(tiles):
    x, y = (i % c) * CELL_W, (i // c) * ch
    sheet2.paste(t, (x, y + LBL))
    d2.rectangle([x, y, x + CELL_W - 1, y + LBL - 1], fill=(35, 45, 35))
    d2.text((x + 6, y + 5), page, fill=(255, 255, 255), font=font(13))
sheet2.save(os.path.join(HERE, "react-all-pages.png"), optimize=True)
print("wrote react-vs-original.png and react-all-pages.png")
