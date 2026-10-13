#!/usr/bin/env python3
"""capture.py — screenshot + DOM capture for one server.

Usage:
    capture.py --base http://127.0.0.1:5210 --out verification/screenshots/react

For every page in src/legacy/*.html it:
  * loads <base>/<page>
  * waits for load + network idle + a settle delay (async data)
  * saves a full-page screenshot at a fixed 1280px viewport
  * records normalised markup, visible text, element/tag counts, stylesheet
    hrefs, and every console error / uncaught page error

The recorded values are written to <out>/dom.json so the parity step can prove
the React app renders the same document as the vanilla site.
"""
import argparse
import asyncio
import json
import os
import re
import sys

from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
PAGES = sorted(f for f in os.listdir(os.path.join(APP, "src", "legacy")) if f.endswith(".html"))

CHROME = "/home/it-guy/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
VIEWPORT = {"width": 1280, "height": 900}
SETTLE_MS = 2200

WS = re.compile(r"\s+")


def norm_markup(html):
    return WS.sub(" ", html).strip()


def norm_text(text):
    return WS.sub(" ", "\n".join(text.splitlines())).strip()


PROBE = """() => {
  const all = document.querySelectorAll('*');
  const counts = {};
  for (const el of all) counts[el.tagName.toLowerCase()] = (counts[el.tagName.toLowerCase()] || 0) + 1;
  return {
    markup: document.documentElement.outerHTML,
    text: document.body ? document.body.innerText : '',
    elements: all.length,
    counts,
    title: document.title,
    stylesheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href')),
    scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')),
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || null,
    h1: [...document.querySelectorAll('h1')].map(h => h.textContent.trim()),
  };
}"""


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default=None, help="comma-separated page subset")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    pages = PAGES
    if args.only:
        want = {p.strip() for p in args.only.split(",")}
        pages = [p for p in pages if p in want]

    results = {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            executable_path=CHROME,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
        )
        ctx = await browser.new_context(viewport=VIEWPORT, device_scale_factor=1)
        page = await ctx.new_page()

        holder = {"errors": [], "warnings": []}

        def on_console(m):
            if m.type == "error":
                holder["errors"].append(f"error: {m.text}")
            elif m.type == "warning":
                holder["warnings"].append(m.text)

        def on_pageerror(e):
            holder["errors"].append(f"pageerror: {e}")

        page.on("console", on_console)
        page.on("pageerror", on_pageerror)

        for name in pages:
            url = f"{args.base}/{name}"
            holder["errors"].clear()
            holder["warnings"].clear()
            rec = {"url": url}
            try:
                await page.goto(url, wait_until="load", timeout=45000)
                try:
                    await page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    pass
                await page.wait_for_timeout(SETTLE_MS)
                probe = await page.evaluate(PROBE)
                await page.screenshot(path=os.path.join(out, name.replace(".html", ".png")),
                                      full_page=True)
                rec.update({
                    "ok": True,
                    "title": probe["title"],
                    "elements": probe["elements"],
                    "counts": probe["counts"],
                    "stylesheets": probe["stylesheets"],
                    "scripts": probe["scripts"],
                    "h1": probe["h1"],
                    "markupChars": len(norm_markup(probe["markup"])),
                    "textChars": len(norm_text(probe["text"])),
                    "textHash": __import__("hashlib").sha256(
                        norm_text(probe["text"]).encode()).hexdigest()[:16],
                    "markupHash": __import__("hashlib").sha256(
                        norm_markup(probe["markup"]).encode()).hexdigest()[:16],
                    "text": norm_text(probe["text"])[:4000],
                    "errCount": len(holder["errors"]),
                    "errors": holder["errors"][:12],
                    "warnCount": len(holder["warnings"]),
                })
            except Exception as exc:  # noqa: BLE001
                rec.update({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            results[name] = rec
            status = "ok" if rec.get("ok") else "FAIL"
            print(f"  {name:28} {status:4} elems={rec.get('elements','-'):>5} "
                  f"text={rec.get('textChars','-'):>6} err={rec.get('errCount','-')} "
                  f"title={rec.get('title','')[:34]!r}", flush=True)
        await browser.close()

    json.dump(results, open(os.path.join(out, "dom.json"), "w"), indent=2)
    ok = sum(1 for r in results.values() if r.get("ok"))
    errs = sum(r.get("errCount", 0) for r in results.values())
    print(f"\n{args.base}: {ok}/{len(results)} pages captured | "
          f"{errs} console errors | wrote {out}/dom.json")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
