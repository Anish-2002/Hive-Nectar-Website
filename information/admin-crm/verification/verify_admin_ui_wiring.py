#!/usr/bin/env python3
"""
Verify that every admin RPC the new React admin UI calls is (a) real, (b) called
with argument names PostgREST will actually accept, and (c) called with every
argument the function requires.

Why this exists: PostgREST resolves RPC arguments by JSON key. A misspelled key is
not an error the compiler can catch -- it is a 404/400 at runtime, or worse, a call
with NULLs.

GROUND TRUTH IS THE CATALOG, NOT A DOCUMENT.
The first revision parsed a hand-maintained table in 03-ADMIN-RPC-SIGNATURES.md
and asserted it held exactly 44 rows. When migration 02 added five functions the
table went stale and the verifier reported eight false failures against functions
that were live and working. It now refreshes the signature list from pg_proc via
dump_live_admin_sigs.py on every run, falling back to that script's cached JSON if
the management API is unreachable.

Read-only: reads pg_proc (for the signature list), reads source files, writes
nothing to the database.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path("/home/it-guy/Documents/hive nectar/The Meadows react.")
LIVE = HERE / "live_admin_sigs.json"
DUMP = HERE / "dump_live_admin_sigs.py"
ADMIN_DIR = ROOT / "src/admin"
FILES = [ADMIN_DIR / "sections.jsx", ADMIN_DIR / "AdminApp.jsx", ADMIN_DIR / "api.js"]
# Every module of the admin surface is scanned, not a fixed pair of files: a section
# added in its own file (sections-crm.jsx) must be held to the same rules.
FILES += sorted(p for p in ADMIN_DIR.glob("*.jsx") if p not in FILES)

# The kinds admin_*/site_content_* handle -- one per branch of the CASE in
# 2026-10-13-03-site-content.sql. A typo would return "Unknown content kind"
# at runtime and render an empty table, which looks exactly like "no rows".
KNOWN_CONTENT_KINDS = {"hub", "nav", "social", "policy", "founder"}

passes, warnings, failures = [], [], []


def ok(msg):
    passes.append(msg)


def warn(msg):
    warnings.append(msg)


def bad(msg):
    failures.append(msg)


# ---------------------------------------------------------------- signatures
def live_signatures():
    """Refresh from pg_proc; fall back to the cached dump when offline."""
    cached = LIVE.exists()
    try:
        r = subprocess.run(
            [sys.executable, str(DUMP)], capture_output=True, text=True, timeout=150
        )
        if r.returncode == 0 and LIVE.exists():
            src = "refreshed from pg_proc"
        else:
            src = None
    except Exception as e:  # noqa: BLE001 - any failure means "use the cache"
        src, _ = None, e
    if src is None:
        if not cached:
            bad("could not reach pg_proc and no cached signature dump exists")
            return {}, None
        src = "cached dump (pg_proc unreachable)"
    data = json.loads(LIVE.read_text(encoding="utf-8"))
    return data, src


live, src_of_truth = live_signatures()
sigs = {
    name: [p.split()[0] for p in f["args"].split(",") if p.strip()]
    for name, f in live.items()
}
if sigs:
    ok(f"loaded {len(sigs)} live admin RPC signatures ({src_of_truth})")
    not_jsonb = sorted(n for n, f in live.items() if f["returns"] != "jsonb")
    # The live catalogue arrives sorted, so the expectation is kept sorted too.
    NON_JSONB_OK = sorted(["add_admin", "admin_ok", "remove_admin", "admin_actor_email", "admin_can", "admin_role_of"])
    if not_jsonb == NON_JSONB_OK:
        ok(f"all {len(sigs)} are SECURITY DEFINER; only {len(NON_JSONB_OK)} known helpers return non-jsonb")
    else:
        warn(f"non-jsonb returns: {not_jsonb} (expected {NON_JSONB_OK})")
    public_open = sorted(n for n, f in live.items() if f.get("public_execute"))
    if public_open:
        warn(f"PUBLIC still holds EXECUTE on: {public_open}")
    else:
        ok("no live admin RPC is reachable by the public key")

src = {p.name: p.read_text(encoding="utf-8") for p in FILES if p.exists()}
joined = "\n".join(src.values())

# ------------------------------------------------- referenced names exist
referenced = set()
for name in sigs:
    if re.search(r"['\"]" + re.escape(name) + r"['\"]", joined):
        referenced.add(name)
# Only names used as rpc('<name>') or as an ENTITIES value count as RPC calls. A bare
# quoted 'admin_*' string may legitimately be a column name -- contact_inquiries has an
# admin_notes column -- so matching any quoted string false-positives.
called = set(re.findall(r"rpc\(\s*'([a-z_0-9]+)'", joined))
called |= set(re.findall(r"(?:list|save|remove):\s*'([a-z_0-9]+)'", joined))
missing = sorted(n for n in called if n.startswith("admin_") and n not in sigs)
if missing:
    for name in missing:
        bad(f"UI calls unknown RPC: {name}")
else:
    ok("every admin_* RPC the UI calls exists in the live project")

# Non-prefixed functions (add_admin/remove_admin/is_admin) may not be in the admin_*
# set; they are confirmed live by a direct PostgREST probe instead.
UNPREFIXED = {"add_admin", "remove_admin", "is_admin"}

# ------------------------------------------- explicit rpc('x', { ... }) calls
def _balanced_call(text, start):
    """Text inside the first {...} after `start`, honouring nesting so a nested object or a
    ternary value (e.g. `p_overdue: overdueOnly ? null : true`) cannot leak fake keys."""
    i = text.find("{", start)
    if i < 0:
        return None
    depth = 0
    for j in range(i, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[i + 1:j]
    return None


def _arg_keys(body):
    """Top-level argument names only: depth-aware comma split, then the name before ':'."""
    parts, depth, cur = [], 0, ""
    for ch in body:
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    keys = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        name = re.split(r"\s*:", p)[0].strip().lstrip(".")
        if re.fullmatch(r"[A-Za-z_$][\w$]*", name):
            keys.append(name)
    return keys


explicit = []
for _m in re.finditer(r"rpc\(\s*'([a-z_0-9]+)'", joined):
    # Only a call whose argument list is a literal object right there can be checked by name.
    # `rpc('admin_set_points', args)` passes a prebuilt object, and `rpc('admin_get_themes')`
    # has no arguments at all: scanning forward for a `{` would pick up an unrelated object
    # later in the file and invent argument names.
    if not re.match(r"\s*,\s*\{", joined[_m.end():_m.end() + 40]):
        continue
    _body = _balanced_call(joined, _m.end())
    if _body is not None:
        explicit.append((_m.group(1), _body))
for name, body in explicit:
    keys = _arg_keys(body)
    if name not in sigs:
        if name in UNPREFIXED:
            ok(f"{name}: unprefixed helper, confirmed live by PostgREST probe")
            referenced.add(name)
        else:
            bad(f"{name}: not a live function")
        continue
    expected = sigs[name]
    # Trailing parameters with a DEFAULT may be omitted: PostgREST resolves the call
    # without them (proved by probe -- omitting p_tier returns the permission error,
    # not PGRST202). Only the required prefix has to be supplied.
    n_opt = live[name].get("n_defaults", 0) or 0
    required = expected[: len(expected) - n_opt] if n_opt else expected
    unknown = [k for k in keys if k not in expected]
    not_supplied = [a for a in required if a not in keys]
    if unknown:
        bad(f"{name}: argument key(s) {unknown} are not parameters (expected {expected})")
    elif not_supplied:
        # PostgREST rejects a call that omits a parameter without a default.
        bad(f"{name}: missing argument(s) {not_supplied}")
    elif n_opt and [a for a in expected if a not in keys]:
        omitted = [a for a in expected if a not in keys]
        ok(f"{name}: supplies {[k for k in keys]} and lets the database default {omitted}")
    else:
        ok(f"{name}: call site supplies exactly {expected}")

# --------------------------------------------------------- entity definitions
block = re.search(r"const ENTITIES = \{(.*?)\n\};", joined, re.S)
if not block:
    bad("could not find the ENTITIES table in sections.jsx")
else:
    body = block.group(1)
    entities = re.split(r"\n  (?=[a-z_]+: \{)", body)
    if len(entities) < 9:
        bad(f"only {len(entities)} entity definitions parsed -- check formatting")
    for chunk in entities:
        m = re.match(r"\s*([a-z_]+): \{", chunk)
        if not m:
            continue
        ent = m.group(1)
        get = lambda k: (re.search(rf"{k}:\s*'([^']+)'", chunk) or [None, None])[1]
        lst, sav, rem, arg = get("list"), get("save"), get("remove"), get("removeArg")
        # Two shapes are legal. A dedicated RPC takes the id in a named parameter
        # (removeArg: 'p_task_id'). A shared RPC pair -- the five content kinds --
        # takes the kind plus the id, built per row (removeArgs: (row) => ({...})).
        rem_keys, rem_err = None, None
        if not arg:
            a = re.search(r"removeArgs:\s*\(row\)\s*=>\s*\(\{([^}]*)\}\)", chunk, re.S)
            if a:
                rem_keys = re.findall(r"(\w+)\s*:", a.group(1))
                unknown = [k for k in rem_keys if k not in sigs.get(rem, [])]
                if unknown:
                    rem_err = (
                        f"{ent}: removeArgs builds {unknown}, which are not parameters "
                        f"of {rem} ({sigs.get(rem)})"
                    )
        if not all([lst, sav, rem]) or not (arg or rem_keys is not None):
            bad(f"{ent}: incomplete definition (list={lst} save={sav} remove={rem} removeArg={arg})")
            continue
        for label, fn in (("list", lst), ("save", sav), ("remove", rem)):
            if fn not in sigs:
                bad(f"{ent}: {label} RPC {fn} is not live")
                break
        else:
            kinds = set(re.findall(r"p_kind:\s*'([a-z_]+)'", chunk))
            if len(kinds) > 1:
                bad(f"{ent}: the call sites disagree on p_kind ({sorted(kinds)})")
            elif rem_err:
                bad(rem_err)
            elif arg and arg not in sigs[rem]:
                bad(f"{ent}: removeArg '{arg}' is not a parameter of {rem} (expected {sigs[rem]})")
            elif "p_data" not in sigs[sav]:
                bad(f"{ent}: {sav} does not take p_data (takes {sigs[sav]})")
            elif kinds:
                kind = sorted(kinds)[0]
                if "p_kind" not in sigs[lst] or "p_kind" not in sigs[sav] or "p_kind" not in sigs[rem]:
                    bad(
                        f"{ent}: passes p_kind but the live RPCs do not take it "
                        f"({lst} {sigs[lst]}, {sav} {sigs[sav]}, {rem} {sigs[rem]})"
                    )
                elif kind not in KNOWN_CONTENT_KINDS:
                    bad(
                        f"{ent}: p_kind='{kind}' is not one of the kinds migration 03 "
                        f"handles ({sorted(KNOWN_CONTENT_KINDS)})"
                    )
                else:
                    ok(f"{ent}: {lst}/{sav}/{rem} with p_kind='{kind}' match the live signatures")
                    referenced.update({lst, sav, rem})
            else:
                ok(f"{ent}: {lst} / {sav}(p_data) / {rem}({arg}) all match the live signatures")
                referenced.update({lst, sav, rem})

# ------------------------------------------------------------------ coverage
# Unwired live RPCs are missing scope, not a defect in what exists -- reported, not
# failed. A live function the UI does not call is still a working function.
#
# Five pre-existing live functions are deliberately NOT called by the new UI:
#   add_admin / remove_admin / admin_get_admins -- superseded by the role model in
#     migration 09 (admin_invite_admin + admin_set_team_role + admin_get_team_overview),
#     which replaced "is this person an admin" with named roles and an audit trail.
#   admin_can / admin_role_of -- permission predicates the database evaluates inside
#     each RPC. Calling them from the browser would move an authorisation decision
#     client-side, which is exactly what must not happen.
#   admin_log_action -- the audit writer. Every RPC logs its own action; a client-side
#     writer would let a caller forge audit rows.
INTENTIONAL = {
    "add_admin": "superseded by the migration 09 role model",
    "remove_admin": "superseded by the migration 09 role model",
    "admin_get_admins": "superseded by admin_get_team_overview",
    "admin_can": "database-side permission predicate; must not be a UI decision",
    "admin_role_of": "database-side permission predicate; must not be a UI decision",
    "admin_log_action": "audit writer; every RPC logs its own action",
    "admin_actor_email": "internal helper resolving the acting admin's email; called from "
                         "inside the SECURITY DEFINER RPCs, never from the browser",
    # Superseded surfaces. These still exist because dropping live functions needs its
    # own migration; nothing in the admin UI may call them, and the replacement is wired.
    "admin_get_config": "superseded by the app_settings store (admin_get_settings)",
    "admin_save_config": "superseded by admin_save_setting",
    "admin_delete_config": "superseded by admin_delete_setting",
    "admin_get_inquiries": "superseded by the support inbox; migration 11 backfilled "
                           "contact_inquiries into support_tickets",
    "admin_update_inquiry": "superseded by admin_update_ticket",
    "admin_delete_inquiry": "superseded by admin_delete_ticket",
    "admin_set_message_delivery": "records the mail provider's delivery callback; written "
                                  "by the transport/webhook, never from the browser",
}
unused = sorted(set(sigs) - referenced - set(INTENTIONAL))
if unused:
    warn(f"{len(unused)} live RPC(s) not yet wired into the UI: {unused}")
else:
    ok(
        f"all {len(set(sigs) - set(INTENTIONAL))} applicable live RPCs are referenced "
        f"by the admin UI ({len(INTENTIONAL)} deliberately not called)"
    )
for name, why in sorted(INTENTIONAL.items()):
    if name in sigs:
        ok(f"{name}: intentionally unwired -- {why}")

# ------------------------------------------------- nav entries resolve to a component
# A NAV entry whose `component:` identifier is neither imported nor declared locally
# renders as an empty screen (or throws) while every other check still passes. Checked
# by name against both the import blocks and the local `const X = ...` factories.
app_src = (ADMIN_DIR / "AdminApp.jsx").read_text(encoding="utf-8")
nav = re.search(r"const NAV_GROUPS = \[(.*?)\n\];", app_src, re.S)
if not nav:
    bad("AdminApp.jsx: no NAV_GROUPS array found")
else:
    comps = re.findall(r"component:\s*([A-Za-z0-9_]+)", nav.group(1))
    imports_src = "\n".join(re.findall(r"import\s*\{[^}]*\}\s*from\s*'[^']+';", app_src, re.S))
    imported = set(re.findall(r"[A-Za-z0-9_]+", imports_src))
    local = set(re.findall(r"^const\s+([A-Za-z0-9_]+)\s*=", app_src, re.M))
    unresolved = [c for c in comps if c not in imported | local]
    if unresolved:
        bad(f"NAV components not defined anywhere in AdminApp.jsx: {unresolved}")
    else:
        ok(f"all {len(comps)} NAV entries resolve to an imported or local component")

# ------------------------------------------------- every adm-* class exists in admin.css
# An invented class name renders unstyled, which reads as "broken screen" rather than
# "missing feature" -- and no other check would notice.
css_path = ADMIN_DIR / "admin.css"
if css_path.exists():
    defined = set(re.findall(r"\.(adm-[A-Za-z0-9_-]+)", css_path.read_text(encoding="utf-8")))
    used = set()
    for text in src.values():
        used |= set(re.findall(r'[\s"\'`]((?:adm-)[A-Za-z0-9_-]+)', text))
    # A name ending in "-" is a template prefix (`adm-toast--${kind}`), not a class.
    unstyled = sorted(u for u in used - defined if not u.endswith("-"))
    if unstyled:
        warn(f"{len(unstyled)} class(es) used but not defined in admin.css: {unstyled[:8]}")
    else:
        ok(f"all {len(used)} adm-* classes used by the admin UI exist in admin.css")
else:
    warn("admin.css not found; skipped the class-existence check")

# --------------------------------------------------------------- emoji audit
emoji_re = re.compile(
    "[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u2705\u274C\u2B50\u2B06\u2B07\u2190-\u21FF]"
)
for name, text in src.items():
    hits = emoji_re.findall(text)
    if hits:
        bad(f"{name}: contains {len(hits)} emoji/glyph(s): {''.join(sorted(set(hits)))}")
if not any("emoji" in f for f in failures):
    ok("no emoji in the admin UI source")

print("=" * 72)
for line in passes:
    print("  PASS  " + line)
for line in warnings:
    print("  WARN  " + line)
for line in failures:
    print("  FAIL  " + line)
print("=" * 72)
print(f"  {len(passes)} PASS / {len(warnings)} WARN / {len(failures)} FAIL")
print(f"  RPC coverage: {len(referenced & set(sigs))}/{len(sigs)} live admin RPCs wired")
sys.exit(1 if failures else 0)
