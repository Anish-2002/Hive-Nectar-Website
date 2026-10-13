#!/usr/bin/env python3
"""Dump the live admin RPC surface straight from pg_proc.

The wiring verifier used to parse a hand-maintained markdown table, so adding
functions in a later migration made it report false failures. This dumps the
catalog instead and writes it to JSON, which becomes the verifier's ground truth.

Read-only: one SELECT against pg_proc through the management API.
"""
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REF = "gxboojbfmpejbjolfmjq"
CRED = Path.home() / ".hive-nectar/credentials.env"
PROJ = Path("/home/it-guy/Documents/hive nectar/The Meadows react.")
OUT = Path(__file__).resolve().parent / "live_admin_sigs.json"
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"

SQL = """
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       pg_get_function_result(p.oid) as ret,
       case when p.prosecdef then 'definer' else 'invoker' end as security,
       p.pronargdefaults as n_defaults,
       (select count(*)
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where a.grantee = 0) > 0 as public_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and (p.proname like 'admin\\_%' or p.proname in ('add_admin', 'remove_admin'))
 order by p.proname
"""


def load_env(path):
    out = {}
    for line in path.read_text().splitlines():
        m = re.match(r"^([A-Za-z_]+)=(.*)$", line.strip())
        if m and m.group(2).strip():
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


token = load_env(CRED).get("SUPABASE_ACCESS_TOKEN")
if not token:
    sys.exit("no SUPABASE_ACCESS_TOKEN in credentials.env")

req = urllib.request.Request(
    API,
    data=json.dumps({"query": SQL}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        rows = json.loads(r.read().decode())
except urllib.error.HTTPError as e:
    sys.exit(f"query failed: {e.code} {e.read().decode()[:400]}")

funcs = {
    r["proname"]: {
        "args": r["args"],
        "returns": r["ret"],
        "security": r["security"],
        "n_defaults": r["n_defaults"],
        "public_execute": r["public_execute"],
    }
    for r in rows
}
OUT.write_text(json.dumps(funcs, indent=2, sort_keys=True) + "\n", encoding="utf-8")

# The doc is generated from the same query, so it cannot drift from the verifier's
# ground truth the way the hand-maintained table did.
DOC = PROJ / "information/admin-crm/05-LIVE-RPC-SIGNATURES.md"
DOC.parent.mkdir(parents=True, exist_ok=True)
lines = [
    "# Live admin RPC signatures (generated)",
    "",
    "Generated from `pg_proc` on the production project `gxboojbfmpejbjolfmjq` by",
    f"`dump_live_admin_sigs.py`. Do not hand-edit: rerun the script ({len(funcs)} functions).",
    "",
    "`defaults` = trailing parameters carrying a DEFAULT, which PostgREST may omit.",
    "`public` = PUBLIC still holds EXECUTE (an anon-key caller can reach the guard).",
    "",
    "| function | arguments | defaults | returns | security | public |",
    "|---|---|---|---|---|---|",
]
for name in sorted(funcs):
    f = funcs[name]
    lines.append(
        f"| `{name}` | `{f['args'] or '-'}` | {f['n_defaults']} | {f['returns']} "
        f"| {f['security']} | {'yes' if f['public_execute'] else 'no'} |"
    )
DOC.write_text("\n".join(lines) + "\n", encoding="utf-8")

print(f"live admin functions: {len(funcs)}")
for name in sorted(funcs):
    f = funcs[name]
    suffix = f"  [{f['security']}, defaults={f['n_defaults']}]"
    print(f"  {name}({f['args']}) -> {f['returns']}{suffix}")
nonder = [n for n, f in funcs.items() if f["returns"] != "jsonb"]
print(f"returns jsonb: {len(funcs) - len(nonder)}/{len(funcs)}")
if nonder:
    print(f"NOT jsonb: {nonder}")
open_ = sorted(n for n, f in funcs.items() if f["public_execute"])
print(f"PUBLIC holds EXECUTE on: {open_ or 'none'}")
print(f"wrote {OUT}")
print(f"wrote {DOC}")
