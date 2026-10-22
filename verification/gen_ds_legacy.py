#!/usr/bin/env python3
"""Generate `src/admin/ds-legacy.css` — the migration shim for the design system.

Why this exists
---------------
The CRM grew four stylesheets (admin.css, dashboard.css, phase-a.css, mail.css)
with 26 distinct font-size values (22 of them below 15px) and literal colours
copied from the member theme (#7A6B5D, #2E2A24, #E7DFD1, #C8A96E, #FBF7F0 ...).
Re-skinning every one of those rules by hand is how the drift happened in the
first place, so the shim is generated from the shipped bytes instead:

  * every legacy rule that declares `font-size` is re-emitted, scoped to the
    design-system shell (`.ds-shell <selector>`), with a size from the type scale
    chosen by the role of the selector;
  * every legacy rule that declares a literal member-theme colour is re-emitted
    with the matching design token;
  * `font-family` declarations that would pull in Fredoka/Manrope are re-emitted
    as the design-system font stack;
  * `@media` context and selector groups are preserved.

Property precedence: every emitted selector carries an extra class (`.ds-shell`)
so it outranks the rule it replaces no matter which file the browser parsed last.

Re-run this after adding a legacy rule:  /usr/bin/python3 verification/gen_ds_legacy.py
"""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADMIN = HERE.parent / "src" / "admin"
SOURCES = ["admin.css", "dashboard.css", "phase-a.css", "mail.css"]
OUT = ADMIN / "ds-legacy.css"

# literal member-theme colours -> design token
COLOR_MAP = {
    "#2e2a24": "var(--ds-text)",
    "#231f1a": "var(--ds-text)",
    "#1f2937": "var(--ds-text)",
    "#7a6b5d": "var(--ds-muted)",
    "#64748b": "var(--ds-muted)",
    "#8a7b6b": "var(--ds-muted)",
    "#a3947f": "var(--ds-muted)",
    "#e7dfd1": "var(--ds-border)",
    "#efe7da": "var(--ds-border)",
    "#e5e7eb": "var(--ds-border)",
    "#f2ece1": "var(--ds-border-soft)",
    "#c8a96e": "var(--ds-accent)",
    "#d9a441": "var(--ds-accent)",
    "#b8923f": "var(--ds-accent-ink)",
    "#fbf7f0": "var(--ds-bg)",
    "#fffdf9": "var(--ds-surface)",
    "#ffffff": "var(--ds-surface)",
    "#fff": "var(--ds-surface)",
    "#f7f1e6": "var(--ds-bg-sunken)",
    "#2f6b4f": "var(--ds-ok)",
    "#1f7a4d": "var(--ds-ok)",
    "#b42318": "var(--ds-danger)",
    "#a4262c": "var(--ds-danger)",
    "#9a6b00": "var(--ds-warn)",
    "#1e5b8a": "var(--ds-info)",
    "#eee6d8": "var(--ds-border-soft)",
}

# selectors that must not be re-emitted (already the design system's own, or
# document-level: the shell handles those itself)
SKIP_SELECTOR = re.compile(r"ds-|^:root|^html|^body|^\*")


def px_of(value, root=16.0):
    value = value.strip().lower()
    m = re.match(r"^(-?[\d.]+)(rem|em|px|pt)?$", value)
    if not m:
        return None
    n = float(m.group(1))
    unit = m.group(2) or "px"
    if unit == "rem":
        return n * root
    if unit == "em":
        return n * root
    if unit == "pt":
        return n * 4 / 3
    return n


def clamp(n, lo, hi):
    return max(lo, min(hi, n))


def scale_for(selector):
    """Pick a size on the requested type scale for a legacy selector."""
    s = selector.lower()

    def has(*words):
        return any(w in s for w in words)

    if has("h1", ":title", "__title", ".title"):
        return 30.0
    if has("h2"):
        return 20.0
    if has("h3"):
        return 17.0
    if has(" h4", "h4,"):
        return 15.0
    if has("th"):
        return 12.5          # table header: a label, still >= 12.5px
    if has("td", " tbody", "cell"):
        return 13.5          # table data: 13-14px minimum
    if has("pill", "badge", "tag", "chip"):
        return 12.0
    if has("label", "legend", "hint", "note", "meta", "sub", "foot", "caption", "eyebrow"):
        return 12.5
    if has("stat", "metric", "value", "big", "score", "kpi"):
        return 26.0
    if has("nav", "side", "menu"):
        return 14.0
    if has("pre", "code", "mono"):
        return 12.5
    return 15.0              # body


def split_group(selector):
    """Split a selector group on commas that are not inside :is()/:where()."""
    out, depth, buf = [], 0, ""
    for ch in selector:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(buf.strip())
            buf = ""
        else:
            buf += ch
    if buf.strip():
        out.append(buf.strip())
    return out


def parse_rules(css):
    """Yield (media, selector, body) for every rule, keeping @media context."""
    i, n = 0, len(css)
    media = None
    while i < n:
        # skip comments and whitespace
        if css.startswith("/*", i):
            i = css.find("*/", i) + 2
            continue
        if css[i].isspace():
            i += 1
            continue
        if css.startswith("@media", i):
            open_at = css.index("{", i)
            media = css[i:open_at].strip()
            i = open_at + 1
            continue
        if css[i] == "}":
            media = None
            i += 1
            continue
        if css[i] == "@":                      # @font-face, @keyframes, @supports
            open_at = css.find("{", i)
            if open_at == -1:
                break
            depth, j = 1, open_at + 1
            while j < n and depth:
                if css[j] == "{":
                    depth += 1
                elif css[j] == "}":
                    depth -= 1
                j += 1
            i = j
            continue
        open_at = css.find("{", i)
        if open_at == -1:
            break
        close_at = css.find("}", open_at)
        if close_at == -1:
            break
        selector = css[i:open_at].strip()
        body = css[open_at + 1:close_at]
        yield media, selector, body
        i = close_at + 1


def declarations(body):
    out = []
    depth, buf = 0, ""
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == ";" and depth == 0:
            out.append(buf)
            buf = ""
        else:
            buf += ch
    if buf.strip():
        out.append(buf)
    parsed = []
    for decl in out:
        if ":" not in decl:
            continue
        prop, _, value = decl.partition(":")
        parsed.append((prop.strip().lower(), value.strip()))
    return parsed


def main():
    emitted = 0
    sizes = 0
    colors = 0
    fonts = 0
    blocks = {}
    order = []

    for name in SOURCES:
        path = ADMIN / name
        if not path.exists():
            continue
        for media, selector, body in parse_rules(path.read_text(encoding="utf-8")):
            decls = declarations(body)
            new = {}
            for prop, value in decls:
                if prop == "font-size":
                    size = px_of(value)
                    if size is None or size <= 0:
                        continue
                    new["font-size"] = f"{round_half(scale_for(selector)):g}px"
                elif prop == "font-family":
                    new["font-family"] = "var(--ds-font)"
                elif prop in ("color", "background-color"):
                    token = COLOR_MAP.get(value.replace(" ", "").lower())
                    if token:
                        new[prop] = token
            if not new:
                continue
            for sel in split_group(selector):
                sel = sel.strip()
                if not sel or SKIP_SELECTOR.search(sel):
                    continue
                # `> .child` / pseudo-elements keep working after the prefix.
                # The shell element itself carries both classes, so a descendant
                # prefix would never match it: use the compound form there.
                if sel in (".adm-shell", ".adm-gate") or sel.startswith((".ds-shell", "&")):
                    scoped = ".adm-shell.ds-shell" if sel == ".adm-shell" else sel
                else:
                    scoped = f".ds-shell {sel}"
                key = (media or "", scoped)
                if key not in blocks:
                    blocks[key] = {}
                    order.append(key)
                blocks[key].update(new)

    lines = [
        "/* GENERATED by verification/gen_ds_legacy.py - do not edit by hand.",
        " *",
        " * Design-system migration shim: re-emits the legacy CRM rules that carry",
        " * hard-coded font sizes or member-theme colours, scoped to .ds-shell and",
        " * pointed at the design tokens in ds.css. Re-run the generator after adding",
        " * a rule to admin.css / dashboard.css / phase-a.css / mail.css.",
        " */",
        "",
    ]
    current_media = None
    for media, scoped in order:
        if media != current_media:
            if current_media:
                lines.append("}")
            lines.append(f"{media} {{" if media else "")
            current_media = media
        body = blocks[(media, scoped)]
        pad = "  " if media else ""
        for prop, value in body.items():
            if prop == "font-size":
                sizes += 1
            elif prop == "font-family":
                fonts += 1
            else:
                colors += 1
        lines.append(f"{pad}{scoped} {{")
        for prop, value in body.items():
            lines.append(f"{pad}  {prop}: {value};")
        lines.append(f"{pad}}}")
        emitted += 1
    if current_media:
        lines.append("}")
    lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {OUT}")
    print(f"  rules: {emitted}  font-size: {sizes}  colour: {colors}  font-family: {fonts}")
    print(f"  bytes: {OUT.stat().st_size}")


def round_half(n):
    return round(n * 2) / 2


if __name__ == "__main__":
    main()
