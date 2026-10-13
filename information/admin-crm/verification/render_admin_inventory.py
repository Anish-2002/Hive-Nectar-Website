#!/usr/bin/env python3
"""Render the live admin RPC catalogue into the guide (section 23.11).

The guide verifier requires the guide to *name* every live admin function. Rather than
hand-maintaining a list that goes stale the moment a migration lands (which is exactly
what happened to the hand-written table in section 23.4), this renders the catalogue
from `live_admin_sigs.json` -- the file `dump_live_admin_sigs.py` writes straight from
pg_proc -- into a fenced region of the guide. Re-running replaces that region in place,
so the appendix cannot drift from the database.

Usage:  python3 render_admin_inventory.py [--check]
  (no args)  rewrite the region in information/HIVE-MEADOWS-GUIDE.md
  --check    exit 1 if the region is missing or out of date, writing nothing
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path("/home/it-guy/Documents/hive nectar/The Meadows react.")
GUIDE = ROOT / "information/HIVE-MEADOWS-GUIDE.md"
SIGS = HERE / "live_admin_sigs.json"
BEGIN = "<!-- BEGIN GENERATED ADMIN INVENTORY -->"
END = "<!-- END GENERATED ADMIN INVENTORY -->"

HEADING = "### 23.11 The live admin RPC catalogue (generated)"


def render(sigs):
    lines = [
        BEGIN,
        "",
        HEADING,
        "",
        f"Generated from `pg_proc` on the production project by `dump_live_admin_sigs.py`;",
        f"rendered into this file by `render_admin_inventory.py`. **{len(sigs)} functions.**",
        "Do not hand-edit the table: rerun the scripts. `defaults` counts the trailing",
        "parameters that carry a DEFAULT, which PostgREST may omit from a call.",
        "",
        "| function | arguments | defaults | returns | public EXECUTE |",
        "|---|---|---|---|---|",
    ]
    for name in sorted(sigs):
        f = sigs[name]
        args = (f.get("args") or "-").replace("|", "\\|")
        lines.append(
            f"| `{name}` | `{args}` | {f.get('n_defaults', 0)} | {f.get('returns', '?')} "
            f"| {'yes' if f.get('public_execute') else 'no'} |"
        )
    lines += ["", END, ""]
    return "\n".join(lines)


def main():
    if not SIGS.exists():
        sys.exit(f"{SIGS} missing -- run dump_live_admin_sigs.py first")
    sigs = json.loads(SIGS.read_text(encoding="utf-8"))
    if not sigs:
        sys.exit("live_admin_sigs.json is empty")
    block = render(sigs)
    text = GUIDE.read_text(encoding="utf-8")
    if BEGIN in text and END in text:
        head, rest = text.split(BEGIN, 1)
        _, tail = rest.split(END, 1)
        new = head + block.rstrip("\n") + tail
    else:
        new = text.rstrip("\n") + "\n\n" + block
    if new == text:
        print(f"up to date ({len(sigs)} functions)")
        return
    if "--check" in sys.argv:
        print(f"OUT OF DATE: the rendered inventory does not match {len(sigs)} live functions")
        sys.exit(1)
    GUIDE.write_text(new, encoding="utf-8")
    named = sum(1 for n in sigs if n in new)
    print(f"rendered {len(sigs)} functions into {GUIDE.name}; all named: {named == len(sigs)}")


if __name__ == "__main__":
    main()
