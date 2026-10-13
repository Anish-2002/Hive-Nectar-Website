#!/usr/bin/env python3
"""wiring-diff.py — explain the residual element-census delta.

The screenshots are pixel-identical, so the remaining +3 script / +1 style /
-1 link delta must be HOW the same assets are attached, not WHAT is attached.
This prints, per page, the script and stylesheet URLs on both sides so the
difference can be read directly.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
b = json.load(open(os.path.join(HERE, "screenshots", "baseline", "dom.json")))
r = json.load(open(os.path.join(HERE, "screenshots", "react", "dom.json")))

seen = set()
for name in sorted(set(b) & set(r)):
    bs, rs = b[name].get("scripts") or [], r[name].get("scripts") or []
    bl, rl = b[name].get("stylesheets") or [], r[name].get("stylesheets") or []
    sig = (tuple(bs), tuple(rs), tuple(bl), tuple(rl))
    if sig in seen:
        continue
    seen.add(sig)
    print(f"=== {name} ===")
    print("  base scripts:", bs)
    print("  react scripts:", rs)
    print("  only-base:", [s for s in bs if s not in rs])
    print("  only-react:", [s for s in rs if s not in bs])
    print("  base sheets:", bl)
    print("  react sheets:", rl)
    print("  only-base sheets:", [s for s in bl if s not in rl])
    print("  only-react sheets:", [s for s in rl if s not in bl])
    print()

# aggregate: is any baseline script missing from the react side anywhere?
missing_scripts, missing_sheets = {}, {}
for name in sorted(set(b) & set(r)):
    bs, rs = set(b[name].get("scripts") or []), set(r[name].get("scripts") or [])
    bl, rl = set(b[name].get("stylesheets") or []), set(r[name].get("stylesheets") or [])
    if bs - rs:
        missing_scripts[name] = sorted(bs - rs)
    if bl - rl:
        missing_sheets[name] = sorted(bl - rl)
print("pages where a baseline <script src> is absent on the React side:", len(missing_scripts) or "NONE")
for k, v in missing_scripts.items():
    print("   ", k, v)
print("pages where a baseline <link rel=stylesheet> is absent on the React side:", len(missing_sheets) or "NONE")
for k, v in missing_sheets.items():
    print("   ", k, v)
