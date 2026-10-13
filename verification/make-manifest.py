#!/usr/bin/env python3
"""make-manifest.py — prove the React port is a byte-for-byte carbon copy of the
current static site.

Every file the app ships is hashed against the file it was copied from in
/home/it-guy/Documents/hive nectar/Hive-Nectar-Website-02-aug2026:

  src/legacy/<page>.html   <-  <AUG>/<page>.html     (verbatim page markup)
  public/js/<x>.js         <-  <AUG>/js/<x>.js
  public/<x>.css           <-  <AUG>/<x>.css
  public/<data>.json       <-  <AUG>/<data>.json
  public/assets/**         <-  <AUG>/assets/**

Writes verification/FILE-MANIFEST.txt and verification/manifest.json.
Exit code 1 if ANY shipped file differs from its source (drift).
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
AUG = "/home/it-guy/Documents/hive nectar/Hive-Nectar-Website-02-aug2026"

PAIRS = []  # (shipped_path_rel_app, source_path_abs)


def add_dir(rel, aug_rel, exts=None):
    src_root = os.path.join(AUG, aug_rel)
    if not os.path.isdir(src_root):
        return
    for dirpath, _dirs, files in os.walk(src_root):
        for f in files:
            if f == "desktop.ini":
                continue
            if exts and not f.lower().endswith(exts):
                continue
            sp = os.path.join(dirpath, f)
            rel_in = os.path.relpath(sp, src_root)
            PAIRS.append((os.path.join(rel, rel_in), sp))


# pages
for f in sorted(os.listdir(os.path.join(APP, "src", "legacy"))):
    if f.endswith(".html"):
        PAIRS.append((os.path.join("src", "legacy", f), os.path.join(AUG, f)))

add_dir("public/js", "js", exts=(".js", ".mjs"))
add_dir("public/assets", "assets")
for f in ("style.css", "meadow-theme.css", "profile-meadow.css", "tester.css",
          "tasks_master.json", "admin_comms.json", "users.json"):
    if os.path.exists(os.path.join(AUG, f)):
        PAIRS.append((os.path.join("public", f), os.path.join(AUG, f)))
for f in sorted(os.listdir(AUG)):
    if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".svg", ".glb", ".ico")):
        PAIRS.append((os.path.join("public", f), os.path.join(AUG, f)))


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


rows, bad, missing = [], [], []
for rel, src in sorted(PAIRS):
    dst = os.path.join(APP, rel)
    if not os.path.exists(dst):
        missing.append(rel)
        continue
    if not os.path.exists(src):
        bad.append((rel, "SOURCE MISSING: " + src))
        continue
    hs, hd = sha(src), sha(dst)
    same = hs == hd
    rows.append({
        "file": rel, "source": src, "identical": same,
        "shippedBytes": os.path.getsize(dst), "sourceBytes": os.path.getsize(src),
        "sha256": hd,
    })
    if not same:
        bad.append((rel, f"sha differs: shipped {hd[:12]} vs source {hs[:12]}"))

json.dump(rows, open(os.path.join(HERE, "manifest.json"), "w"), indent=2)
with open(os.path.join(HERE, "FILE-MANIFEST.txt"), "w") as fh:
    fh.write("# Byte-identity manifest — The Meadows react. vs the current static site\n\n")
    fh.write(f"files compared: {len(rows)}\nidentical: {sum(1 for r in rows if r['identical'])}\n")
    fh.write(f"mismatches: {len(bad)}\nmissing on port: {len(missing)}\n\n")
    for r in rows:
        flag = "OK   " if r["identical"] else "DIFF "
        fh.write(f"{flag} {r['sha256'][:16]}  {r['shippedBytes']:>8}  {r['file']}\n")
    for rel, why in bad:
        fh.write(f"!! {rel}: {why}\n")
    for rel in missing:
        fh.write(f"?? MISSING ON PORT: {rel}\n")

print(f"compared {len(rows)} shipped files | identical {sum(1 for r in rows if r['identical'])}"
      f"/{len(rows)} | mismatches {len(bad)} | missing {len(missing)}")
for rel, why in bad:
    print("  DIFF", rel, why)
for rel in missing:
    print("  MISSING", rel)
sys.exit(1 if (bad or missing) else 0)
