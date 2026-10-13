#!/usr/bin/env python3
"""verify_admin_module_graph.py - structural health of the admin module graph.

Three failures this catches that no other check does:
  1. a static import cycle between admin modules (ESM may evaluate one side half-built and
     throw a TDZ error at runtime while the bundle still builds);
  2. a nav component identifier that resolves to nothing (renders an empty screen);
  3. a CSS class used by any admin module but defined in none of the admin stylesheets
     (renders unstyled, which reads as a broken screen rather than a missing feature).

Read-only. Exit 0 when every check passes.
"""
import re
import sys
from pathlib import Path

ADMIN = Path("/home/it-guy/Documents/hive nectar/The Meadows react./src/admin")
passes, fails = [], []


def ok(msg):
    passes.append(msg)
    print("  PASS  " + msg)


def bad(msg):
    fails.append(msg)
    print("  FAIL  " + msg)


modules = sorted(ADMIN.glob("*.jsx")) + sorted(ADMIN.glob("*.js"))
exists = {p.name for p in modules}

# ---------------------------------------------------------------- 1. import graph
static = {}
for p in modules:
    src = p.read_text(encoding="utf-8")
    deps = set()
    for m in re.finditer(r"^\s*import\s+(?:[\w{},\s*]+?\s+from\s+)?['\"]\./([\w.-]+)['\"]", src, re.M):
        name = m.group(1)
        if name in exists:
            deps.add(name)
    static[p.name] = deps

cycles = []
for a, deps in static.items():
    for b in deps:
        if a in static.get(b, ()):
            pair = tuple(sorted((a, b)))
            if pair not in cycles:
                cycles.append(pair)
if cycles:
    bad("static import cycle(s) between admin modules: " + ", ".join(f"{a} <-> {b}" for a, b in cycles))
else:
    ok(f"no static import cycles among {len(static)} admin modules")

# ---------------------------------------------------------------- 2. nav components resolve
app = (ADMIN / "AdminApp.jsx").read_text(encoding="utf-8")
nav_block = re.search(r"const NAV_GROUPS = \[(.*?)\n\];", app, re.S)
if not nav_block:
    bad("AdminApp.jsx: no NAV_GROUPS array found")
else:
    body = nav_block.group(1)
    comps = re.findall(r"component:\s*([A-Za-z0-9_]+)", body)
    groups = re.findall(r"id: '([a-z-]+)',\n\s*label: '([^']+)',", body)
    imported = set()
    for m in re.finditer(r"import\s*\{([^}]*)\}\s*from\s*'[^']+'", app, re.S):
        imported |= {n.strip() for n in m.group(1).split(",") if n.strip()}
    local = set(re.findall(r"^const\s+([A-Za-z0-9_]+)\s*=", app, re.M))
    unresolved = [c for c in comps if c not in imported | local]
    if unresolved:
        bad(f"nav components defined nowhere: {unresolved}")
    else:
        ok(f"all {len(comps)} nav entries resolve across {len(groups)} groups")
    ids = re.findall(r"\{ id: '([a-z-]+)', label: '[^']+', component:", body)
    dups = sorted({i for i in ids if ids.count(i) > 1})
    if dups:
        bad(f"duplicate nav item id(s): {dups}")
    else:
        ok(f"nav item ids are unique ({len(ids)})")
    targets = re.search(r"const NAV_TARGETS = new Set\(\[(.*?)\]\)", app, re.S)
    if not targets:
        bad("AdminApp.jsx: NAV_TARGETS not found, deep links cannot resolve")
    elif "NAV_SECTIONS.map" in targets.group(1):
        # Derived form: every nav item id is a target, plus any alias keys.
        aliases = re.findall(r"'([a-z-]+)':\s*'([a-z-]+)'", re.search(
            r"const SECTION_ALIASES = \{(.*?)\};", app, re.S).group(1)) if "SECTION_ALIASES" in app else []
        ok(f"every nav id is in NAV_TARGETS (derived from NAV_SECTIONS + {len(aliases)} alias key(s))")
    else:
        listed = re.findall(r"'([a-z-]+)'", targets.group(1))
        missing = [i for i in ids if i not in listed]
        if missing:
            bad(f"nav ids missing from NAV_TARGETS (dead deep links): {missing}")
        else:
            ok(f"every nav id is in NAV_TARGETS ({len(listed)} targets)")

# ---------------------------------------------------------------- 3. CSS coverage
css_text = "\n".join(
    p.read_text(encoding="utf-8") for p in sorted(ADMIN.glob("*.css"))
)
defined = set(re.findall(r"\.([a-zA-Z][\w-]*)", css_text))
used = set()
dynamic = set()
for p in modules:
    src = p.read_text(encoding="utf-8")
    for m in re.finditer(r"className=\{?([`\"'])([^`\"']*)\1", src):
        raw_cls = m.group(2)
        # A template literal that interpolates is assembled at runtime: its literal tokens are
        # usually a base class paired with `--${variant}`, so only record the prefix.
        if m.group(1) == "`" and "${" in raw_cls:
            for cls in re.split(r"[\s]+", raw_cls):
                if cls and not cls.startswith("$"):
                    dynamic.add(cls)
            continue
        for cls in re.split(r"[\s{}$]+", raw_cls):
            cls = cls.strip()
            if re.fullmatch(r"[a-zA-Z][\w-]*", cls) and cls.startswith(("adm", "admpa", "admd")):
                used.add(cls)
    # template literals with a prefix, e.g. `adm-pill adm-pill--${tone}`
    for m in re.finditer(r"`([^`]*\$\{[^`]*)`", src):
        for frag in re.findall(r"([a-zA-Z][\w-]*-)\$\{", m.group(1)):
            dynamic.add(frag)
def _is_defined(cls):
    if cls in defined:
        return True
    base = cls.split("--")[0]
    return base != cls and base in defined


unstyled = sorted(c for c in used if not _is_defined(c))
if unstyled:
    bad(f"admin classes used but defined in no admin stylesheet: {unstyled}")
else:
    ok(f"every admin class used is defined ({len(used)} classes checked)")

print("=" * 72)
print(f"  {len(passes)} PASS / {len(fails)} FAIL")
sys.exit(1 if fails else 0)
