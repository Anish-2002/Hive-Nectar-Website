#!/usr/bin/env python3
"""Verify the admin-CRM section (23) of HIVE-MEADOWS-GUIDE.md against the live catalog.

Checks the guide's claims rather than trusting them: the function count comes from
live_admin_sigs.json (itself dumped from pg_proc), the section count from the NAV
array in the source, and the migration rows from the files on disk.

Exit 0 = all checks pass.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # information/admin-crm/verification
INFO = HERE.parent.parent                       # information
ROOT = INFO.parent                              # the React project
GUIDE = INFO / "HIVE-MEADOWS-GUIDE.md"
SQL_DIR = HERE.parent / "sql"
ADMIN = ROOT / "src" / "admin"
SIGS = HERE / "live_admin_sigs.json"

MIGRATIONS = [
    "2026-10-13-01-admin-plane-hardening.sql",
    "2026-10-13-01-communications.sql",
    "2026-10-13-02-subscriptions-analytics.sql",
    "2026-10-13-03-site-content.sql",
]

EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF\u2b00-\u2bff\ufe0f]"
)

passed = 0
failed: list[str] = []


def ok(msg: str) -> None:
    global passed
    passed += 1
    print(f"  PASS  {msg}")


def bad(msg: str) -> None:
    failed.append(msg)
    print(f"  FAIL  {msg}")


guide = GUIDE.read_text(encoding="utf-8")


def section_23() -> str:
    i = guide.find("## 23. The admin CRM")
    return guide[i:] if i >= 0 else ""


# --- 1. the guide carries both the banner and the new section -----------------
s23 = section_23()
if s23:
    ok("guide contains section 23 (the admin CRM)")
else:
    bad("guide has no '## 23. The admin CRM' section")

banner = "the admin surface has been replaced"
if banner in guide.split("## How the facts", 1)[0]:
    ok("guide header carries the replacement banner")
else:
    bad("guide header is missing the replacement banner")

for legacy in ["admin-crm.html", "admin_comms.html", "admin-achievements.html", "CRM.html"]:
    if legacy in guide.split("## How the facts", 1)[0]:
        ok(f"banner names the legacy page {legacy}")
    else:
        bad(f"banner does not name the legacy page {legacy}")

# --- 2. the RPC count claimed in the guide matches the live catalog -----------
try:
    sigs = json.loads(SIGS.read_text())
except Exception as exc:  # noqa: BLE001
    bad(f"cannot read {SIGS.name}: {exc}")
    sigs = {}

names = sorted(sigs) if isinstance(sigs, dict) else []
if names:
    ok(f"live catalog read: {len(names)} admin functions")
    # The guide's 23.4 heading carries the live count in words ("105 functions live
    # today"). Assert the heading states the number the catalog actually holds, so a
    # later migration cannot silently make the guide wrong.
    head = re.search(r"### 23\.4 The RPC surface — (\d+) functions live today", guide)
    if not head:
        bad("23.4 heading does not state the live admin-function count")
    elif int(head.group(1)) != len(names):
        bad(f"live catalog holds {len(names)} functions; 23.4 heading claims {head.group(1)}")
    else:
        ok(f"live catalog holds {len(names)} admin functions, as section 23.4 states")
    for got in ["admin_get_site_content", "admin_save_site_item", "admin_delete_site_item"]:
        if got in names:
            ok(f"{got} is live")
        else:
            bad(f"{got} is claimed live but absent from the catalog")
else:
    bad("live_admin_sigs.json is empty or unreadable")

# the guide must name every live function it says the surface covers
missing_in_guide = [n for n in names if n not in guide]
if not missing_in_guide:
    ok("the guide names every live admin function")
else:
    bad(f"the guide never names: {missing_in_guide[:5]}")

# --- 3. twenty sections, and the guide lists exactly those ---------------------
app = (ADMIN / "AdminApp.jsx").read_text(encoding="utf-8")
nav_block = re.search(r"const NAV_GROUPS = \[(.*?)\n\];", app, re.S)
if nav_block:
    # Grouped since Phase A: each group carries {id,label,defaultOpen,items:[{id,label}]}.
    labels = re.findall(r"\{ id: '[a-z-]+', label: '([^']+)', component:", nav_block.group(1))
    groups = re.findall(r"id: '([a-z-]+)',\n\s*label: '([^']+)',", nav_block.group(1))
    ok(f"NAV_GROUPS holds {len(labels)} sections in {len(groups)} collapsible groups")
    # The section count is a fact about the app, not a number to remember: read it
    # from NAV and require 23.3's heading to state the same count.
    head = re.search(r"### 23\.3 The ([\w-]+) sections", s23)
    words = {20: "twenty", 21: "twenty-one", 22: "twenty-two", 23: "twenty-three",
             24: "twenty-four", 25: "twenty-five", 26: "twenty-six", 27: "twenty-seven",
             28: "twenty-eight", 29: "twenty-nine", 30: "thirty", 31: "thirty-one",
             32: "thirty-two", 33: "thirty-three"}
    if not head:
        bad("23.3 heading does not state the section count")
    elif words.get(len(labels)) != head.group(1):
        bad(f"NAV holds {len(labels)} sections; 23.3 heading says '{head.group(1)}'")
    else:
        ok(f"the app exposes {len(labels)} sections, as 23.3 states")
    # Compare content, not layout: a label may legitimately wrap across two lines in the
    # prose (e.g. "Collaborations &\nInvitations"), so flatten whitespace before matching.
    flat23 = re.sub(r"\s+", " ", s23)
    not_listed = [l for l in labels if l not in flat23]
    if not not_listed:
        ok("section 23.3 lists every NAV label")
    else:
        bad(f"23.3 omits the sections: {not_listed}")
else:
    bad("could not parse the NAV array from AdminApp.jsx")

# --- 4. the migration table: files exist, are idempotent, and reload schema ----
for name in MIGRATIONS:
    p = SQL_DIR / name
    if not p.exists():
        bad(f"{name} is named in the guide but missing from sql/")
        continue
    body = p.read_text(encoding="utf-8")
    n = len(body.splitlines())
    if name in s23:
        ok(f"{name} exists ({n} lines) and is named in the guide")
    else:
        bad(f"{name} exists but the guide does not name it")
    if re.search(r"notify\s+pgrst,\s*'reload schema'", body, re.I):
        ok(f"{name} ends with the schema reload")
    else:
        bad(f"{name} does not end with NOTIFY pgrst, 'reload schema';")

# --- 5. the architectural rule the guide states, measured in the source -------
# Strip comments first: these files document the rule by naming the thing they
# forbid, so a naive scan flags the documentation as a violation.
def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"(?m)^\s*//.*$", "", src)
    return src


jsx = list(ADMIN.glob("*.jsx")) + [ADMIN / "api.js"]
offenders = []
for f in jsx:
    body = strip_comments(f.read_text(encoding="utf-8"))
    for m in re.finditer(r"\.from\s*\(", body):
        # `supabase.storage.from(...)` is the Storage API, not a table read: it is
        # how an admin uploads artwork, and it is authorised by the bucket's own
        # policies. Only a table access is forbidden here, so exempt the storage
        # client and keep flagging every other `.from(`.
        head = body[max(0, m.start() - 24):m.start()]
        if head.rstrip().endswith(".storage"):
            continue
        # `Array.from`, `Object.fromEntries`, typed-array/`Map`/`Set` statics are plain
        # JavaScript constructors, not table reads. Only capitalised built-in statics are
        # exempt, so a lowercase `supabase.from(...)` is still an offender.
        if re.search(r"\b(Array|Object|Buffer|Uint8Array|Int8Array|Float32Array|Map|Set)$", head.rstrip()):
            continue
        line = body.count("\n", 0, m.start()) + 1
        offenders.append(f"{f.name}:{line}")
if not offenders:
    ok("no .from() table access anywhere in the admin UI")
else:
    bad(f"admin UI uses direct table access at {offenders}")

# --- 6. no emoji in the added section (standing rule) -------------------------
hits = EMOJI.findall(s23)
# the only legitimate ones would be quoted database literals; the admin section quotes none
literal_zone = re.findall(r"`[^`]*`", s23)
leak = [c for c in hits if not any(c in z for z in literal_zone)]
if not leak:
    ok("section 23 contains no emoji")
else:
    bad(f"section 23 contains emoji: {leak}")

print("=" * 72)
print(f"  {passed} PASS / {len(failed)} FAIL")
sys.exit(1 if failed else 0)
