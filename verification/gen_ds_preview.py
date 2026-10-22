#!/usr/bin/env python3
"""Render `visual/ds-preview.html` — the CRM design-system design sheet.

The authenticated CRM cannot be screenshotted without an administrator session,
so this renders the same stylesheets the bundle ships (admin.css, dashboard.css,
phase-a.css, mail.css, ds.css, ds-legacy.css — in bundle order) against a static
copy of the shell markup. It proves typography, colour, spacing, density and the
component vocabulary; it does not prove data wiring (the jsdom verifier and the
live RPC probes cover that).

The navigation is parsed out of AdminApp.jsx at generation time, so the sidebar
in the sheet is the real menu, not a hand-written approximation.
"""
from __future__ import annotations

import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADMIN_APP = ROOT / "src" / "admin" / "AdminApp.jsx"
OUT = ROOT / "visual" / "ds-preview.html"
SHEETS = [
    "../src/admin/admin.css",
    "../src/admin/dashboard.css",
    "../src/admin/phase-a.css",
    "../src/admin/mail.css",
    "../src/admin/ds-legacy.css",
    "../src/admin/ds.css",
]


def nav_groups() -> list[tuple[str, str, list[tuple[str, str]]]]:
    """Parse NAV_GROUPS out of AdminApp.jsx."""
    src = ADMIN_APP.read_text()
    start = src.index("const NAV_GROUPS = [")
    end = src.index("\n];", start)
    body = src[start:end]
    groups: list[tuple[str, str, list[tuple[str, str]]]] = []
    for line in body.split("\n"):
        m = re.match(r"    id: '([^']+)',", line)
        if m:
            groups.append([m.group(1), "", []])  # type: ignore[arg-type]
            continue
        m = re.match(r"    label: '([^']+)',", line)
        if m and groups:
            groups[-1][1] = m.group(1)  # type: ignore[index]
            continue
        m = re.match(r"      \{ id: '([^']+)', label: '([^']+)'", line)
        if m and groups:
            groups[-1][2].append((m.group(1), m.group(2)))  # type: ignore[index]
    return [(g[0], g[1], g[2]) for g in groups]  # type: ignore[misc]


ICONS: dict[str, str] = {}


def nav_icons() -> dict[str, str]:
    """Section id -> Lucide component name, parsed out of AdminApp.jsx."""
    src = ADMIN_APP.read_text()
    block = src[src.index("const NAV_ICONS = {"):]
    block = block[: block.index("\n};")]
    out: dict[str, str] = {}
    for line in block.split("\n")[1:]:
        m = re.match(r"\s*'?([a-z-]+)'?:\s*([A-Za-z]+),", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def load_icons() -> dict[str, str]:
    """Lucide geometry rendered to static SVG markup (visual/icons.json)."""
    path = ROOT / "visual" / "icons.json"
    if not path.exists():
        raise SystemExit(
            "visual/icons.json is missing — render it first:\n"
            "  node -e \"...renderToStaticMarkup(createElement(Icon,{size:16}))\" > visual/icons.json\n"
            "see information/admin-crm/14-CRM-UI-REDESIGN.md (§visual proof)"
        )
    import json

    return json.loads(path.read_text())


def svg_for(section_id: str, cls: str = "ds-nav-icon") -> str:
    name = nav_icons().get(section_id)
    if not name or name not in ICONS:
        return ""
    return ICONS[name].replace('class="lucide', f'class="{cls} lucide', 1)


def glyph(name: str, cls: str = "", size: int = 16) -> str:
    svg = ICONS.get(name)
    if not svg:
        return ""
    svg = re.sub(r'width="\d+" height="\d+"', f'width="{size}" height="{size}"', svg, count=1)
    if cls:
        svg = svg.replace('class="lucide', f'class="{cls} lucide', 1)
    return svg


def sidebar(active: str = "members") -> str:
    out = [
        '      <div class="ds-brand">',
        '        <span class="ds-brand-mark" aria-hidden="true">HN</span>',
        '        <span class="ds-brand-text"><strong>Hive Nectar</strong><span>Admin CRM</span></span>',
        "      </div>",
        '      <nav class="ds-nav" aria-label="Administration sections">',
    ]
    for gid, label, items in nav_groups():
        out += [
            '        <div class="ds-nav-group">',
            f'          <button type="button" class="ds-nav-toggle" aria-expanded="true">',
            f'            <span class="ds-nav-toggle-label">{html.escape(label)}</span>',
            '            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
            "          </button>",
            '          <div class="ds-nav-panel">',
        ]
        for iid, ilabel in items:
            cls = "ds-nav-item is-active" if iid == active else "ds-nav-item"
            badge = '            <span class="ds-nav-count">12</span>\n' if iid == "review" else ""
            out += [
                f'            <button type="button" class="{cls}">',
                f'              {svg_for(iid)}',
                f'              <span>{html.escape(ilabel)}</span>',
                badge.rstrip("\n"),
                "            </button>",
            ]
        out += ["          </div>", "        </div>"]
    out += [
        "      </nav>",
        '      <div class="ds-side-foot">',
        '        <button type="button" class="ds-rail-toggle">',
        '          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
        '          <span class="ds-nav-label">Collapse menu</span>',
        "        </button>",
        "      </div>",
    ]
    return "\n".join(l for l in out if l)


def topbar() -> str:
    return f"""      <header class="ds-topbar">
        <div class="ds-crumbs">
          <button type="button" class="ds-sidebar-toggle" aria-label="Collapse the menu">
            {glyph('Menu', '', 18)}
          </button>
          <span class="ds-crumbs-group">MEMBERS &amp; RECOGNITION</span>
          <span class="ds-crumb-sep" aria-hidden="true">/</span>
          <span class="ds-crumb-current">Members</span>
        </div>

        <div class="ds-search" role="search">
          {glyph('Search', 'ds-search-icon', 16)}
          <input type="search" value="har" aria-label="Search sections and members">
          <button type="button" class="ds-search-clear" aria-label="Clear the search">{glyph('X', '', 14)}</button>
          <div class="ds-search-panel">
            <p class="ds-search-group">Sections</p>
            <button type="button" class="ds-search-hit"><span>Member Reviews</span><span class="ds-search-hit-note">review</span></button>
            <p class="ds-search-group">Members</p>
            <button type="button" class="ds-search-hit"><span>Harper Newman</span><span class="ds-search-hit-note">harper@example.com</span></button>
            <button type="button" class="ds-search-hit"><span>Harsh Patel</span><span class="ds-search-hit-note">harsh@example.com</span></button>
          </div>
        </div>

        <div class="ds-actions">
          <span class="ds-menu-wrap">
            <button type="button" class="ds-icon-btn" aria-expanded="true" aria-label="17 items need attention">
              {glyph('Bell', '', 18)}
              <span class="ds-bell-count">17</span>
            </button>
            <div class="ds-menu ds-menu--bell">
              <p class="ds-menu-head">Queues</p>
              <button type="button" class="ds-menu-item"><span class="ds-menu-item-label">Member reviews awaiting a decision</span><span class="ds-menu-item-value is-live">12</span></button>
              <button type="button" class="ds-menu-item"><span class="ds-menu-item-label">New support tickets</span><span class="ds-menu-item-value is-live">5</span></button>
              <button type="button" class="ds-menu-item"><span class="ds-menu-item-label">Mail the transport could not send</span><span class="ds-menu-item-value">0</span></button>
              <button type="button" class="ds-menu-item"><span class="ds-menu-item-label">Sigma logs in the inbox</span><span class="ds-menu-item-value">9</span></button>
              <button type="button" class="ds-menu-foot">Re-check the queues</button>
            </div>
          </span>
          <span class="ds-menu-wrap">
            <button type="button" class="ds-avatar" aria-expanded="false">
              <span class="ds-avatar-initials" aria-hidden="true">A</span>
              {glyph('ChevronDown', '', 14)}
            </button>
          </span>
        </div>
      </header>"""


def page() -> str:
    return """        <div class="ds-page">
          <div class="adm-head">
            <div>
              <h2>Members</h2>
              <p>Every account, its tier, its nectar balance and the last time it was active.</p>
            </div>
            <div class="adm-actions">
              <button type="button" class="ds-btn ds-btn--ghost">Export CSV</button>
              <button type="button" class="ds-btn ds-btn--primary">Invite a member</button>
            </div>
          </div>

          <div class="ds-stats">
            <div class="ds-stat"><p class="ds-stat-label">Members</p><p class="ds-stat-value">1,248</p><p class="ds-stat-foot">+38 this month</p></div>
            <div class="ds-stat"><p class="ds-stat-label">Collective tier</p><p class="ds-stat-value">312</p><p class="ds-stat-foot">25% of the meadow</p></div>
            <div class="ds-stat"><p class="ds-stat-label">Awaiting review</p><p class="ds-stat-value">12</p><p class="ds-stat-foot">Oldest 2 days</p></div>
            <div class="ds-stat"><p class="ds-stat-label">Nectar in circulation</p><p class="ds-stat-value">48,190</p><p class="ds-stat-foot">Across all tiers</p></div>
          </div>

          <div class="ds-card ds-card--flush">
            <div class="ds-toolbar">
              <div class="ds-field">
                <span class="ds-label">Search</span>
                <input class="ds-input" type="search" value="" placeholder="Name, username or email">
              </div>
              <div class="ds-field">
                <span class="ds-label">Tier</span>
                <select class="ds-select"><option>All tiers</option><option>Collective</option><option>Individual</option></select>
              </div>
              <div class="ds-field">
                <span class="ds-label">Status</span>
                <select class="ds-select"><option>Any status</option><option>Active</option><option>Paused</option></select>
              </div>
              <span class="ds-toolbar-spacer"></span>
              <button type="button" class="ds-btn ds-btn--sm">Reset</button>
              <button type="button" class="ds-btn ds-btn--sm ds-btn--primary">Apply</button>
            </div>

            <div class="ds-table-wrap">
              <table class="ds-table">
                <thead>
                  <tr><th>Member</th><th>Username</th><th>Tier</th><th class="ds-num">Nectar</th><th>Status</th><th>Last active</th></tr>
                </thead>
                <tbody>
                  <tr><td class="ds-strong">Harper Newman</td><td class="ds-sub">harper.n</td><td><span class="ds-pill ds-pill--accent">Collective</span></td><td class="ds-num">4,280</td><td><span class="ds-dot ds-dot--ok"></span> Active</td><td class="ds-sub">2 hours ago</td></tr>
                  <tr><td class="ds-strong">Harsh Patel</td><td class="ds-sub">harsh.p</td><td><span class="ds-pill">Individual</span></td><td class="ds-num">1,120</td><td><span class="ds-dot ds-dot--ok"></span> Active</td><td class="ds-sub">Yesterday</td></tr>
                  <tr><td class="ds-strong">Mira Okafor</td><td class="ds-sub">mira.o</td><td><span class="ds-pill ds-pill--accent">Collective</span></td><td class="ds-num">7,905</td><td><span class="ds-dot ds-dot--warn"></span> Review</td><td class="ds-sub">3 days ago</td></tr>
                  <tr><td class="ds-strong">Tomas Berg</td><td class="ds-sub">tomas.b</td><td><span class="ds-pill">Individual</span></td><td class="ds-num">640</td><td><span class="ds-dot ds-dot--danger"></span> Paused</td><td class="ds-sub">3 weeks ago</td></tr>
                  <tr><td class="ds-strong">Ada Lindqvist</td><td class="ds-sub">ada.l</td><td><span class="ds-pill ds-pill--info">Trial</span></td><td class="ds-num">75</td><td><span class="ds-dot ds-dot--ok"></span> Active</td><td class="ds-sub">Today</td></tr>
                </tbody>
              </table>
            </div>

            <div class="ds-pager">
              <span class="ds-sub">Showing 1–5 of 1,248</span>
              <span class="ds-pager-spacer"></span>
              <button type="button" class="ds-btn ds-btn--sm">Previous</button>
              <button type="button" class="ds-btn ds-btn--sm">Next</button>
            </div>
          </div>

          <div class="ds-tabs">
            <button type="button" class="ds-tab is-active">Profile</button>
            <button type="button" class="ds-tab">Reflections</button>
            <button type="button" class="ds-tab">Sigma logs</button>
            <button type="button" class="ds-tab">Recognition</button>
          </div>

          <div class="ds-card">
            <div class="ds-card-head"><h3 class="ds-card-title">Adjust the balance</h3><p class="ds-card-note">Every change is written to the audit log.</p></div>
            <div class="ds-field"><span class="ds-label">Amount</span><input class="ds-input" type="number" value="250"><span class="ds-hint">Positive adds nectar, negative removes it.</span></div>
            <div class="ds-field"><span class="ds-label">Reason</span><select class="ds-select"><option>Task verification</option><option>Correction</option></select></div>
            <div class="ds-field"><span class="ds-label">Note</span><textarea class="ds-textarea" rows="3">Approved after the reflection review.</textarea></div>
            <button type="button" class="ds-btn ds-btn--primary">Save the adjustment</button>
          </div>

          <div class="ds-card">
            <div class="ds-card-head"><h3 class="ds-card-title">Activity</h3></div>
            <div class="ds-timeline">
              <div class="ds-tl-item"><span class="ds-tl-dot"></span><div class="ds-tl-body"><p class="ds-tl-title">Reflection approved</p><p class="ds-tl-meta">Today, 09:14 · by Anish</p></div></div>
              <div class="ds-tl-item"><span class="ds-tl-dot"></span><div class="ds-tl-body"><p class="ds-tl-title">Nectar adjusted 250</p><p class="ds-tl-meta">Yesterday, 17:02 · by Anish</p></div></div>
              <div class="ds-tl-item"><span class="ds-tl-dot"></span><div class="ds-tl-body"><p class="ds-tl-title">Gift shipped</p><p class="ds-tl-meta">12 Oct, 11:40 · by the fulfilment desk</p></div></div>
            </div>
          </div>

          <div class="ds-member-panel">
            <div class="ds-member-head"><span class="ds-badge">HN</span><div><p class="ds-member-name">Harper Newman</p><p class="ds-member-sub">harper@example.com · Collective tier</p></div></div>
            <div class="ds-kv"><span>Member since</span><strong>14 Mar 2025</strong></div>
            <div class="ds-kv"><span>Nectar balance</span><strong>4,280</strong></div>
            <div class="ds-kv"><span>Reflections</span><strong>38</strong></div>
            <div class="ds-kv"><span>Open tickets</span><strong>1</strong></div>
          </div>

          <div class="ds-card">
            <div class="ds-empty"><p class="ds-empty-title">No reflections in this window</p><p>Widen the date range or clear the filters.</p></div>
          </div>
          <div class="ds-card">
            <p class="ds-loading">Loading the queue</p>
            <div class="ds-skeleton" style="height:14px;width:60%"></div>
            <div class="ds-skeleton" style="height:14px;width:85%"></div>
          </div>
          <div class="ds-card"><div class="ds-error">The review queue could not be read. Nothing was changed.</div></div>
        </div>"""


def inbox() -> str:
    """The support inbox: queue, thread with composer, member context."""
    q = []
    for no, subj, email, st, pr, when, active in [
        ('1042', 'Delivery still has not arrived', 'harper@example.com', 'open', 'high', '2 hours ago', True),
        ('1041', 'Cannot upgrade to the collective tier', 'harsh@example.com', 'new', 'normal', 'Yesterday', False),
        ('1038', 'Nectar balance looks wrong after a reversal', 'mira@example.com', 'pending_internal', 'high', '2 days ago', False),
        ('1035', 'Question about the decorator jar', 'tomas@example.com', 'resolved', 'low', '5 days ago', False),
    ]:
        q.append(f'''              <button type="button" class="ds-qitem{' is-active' if active else ''}">
                <span class="ds-qitem-top"><span class="ds-qitem-no">#{no}</span><span class="ds-qitem-subject">{subj}</span>{'<span class="ds-pill ds-pill--danger">overdue</span>' if pr == 'high' and st != 'resolved' else ''}</span>
                <span class="ds-qitem-meta"><span>{email}</span><span>&middot;</span><span>{st}</span><span>&middot;</span><span>{when}</span></span>
              </button>''')
    return f'''          <div class="adm-head">
            <div><h2>Support inbox</h2><p>Imported enquiries become tickets with a threaded conversation. A reply is queued for email and transmitted immediately.</p></div>
          </div>
          <div class="ds-inbox">
            <div class="ds-queue">
              <div class="adm-filters">
                <select class="ds-select"><option>All statuses</option><option>open</option></select>
                <select class="ds-select"><option>All priorities</option><option>high</option></select>
                <input class="ds-input" type="search" placeholder="Search subject, requester, email">
                <button type="button" class="ds-btn ds-btn--sm">Search</button>
              </div>
{chr(10).join(q)}
              <div class="ds-pager"><span class="ds-sub">4 of 6</span><span class="ds-pager-spacer"></span><button type="button" class="ds-btn ds-btn--sm">Next</button></div>
            </div>
            <div class="ds-thread">
              <section class="ds-ticket">
                <header class="ds-ticket-head">
                  <div style="flex:1 1 auto;min-width:0">
                    <p class="ds-ticket-title">#1042 — Delivery still has not arrived</p>
                    <p class="ds-ticket-sub">open &middot; high &middot; harper@example.com &middot; created 14 Oct 2026 &middot; SLA due 15 Oct 2026</p>
                  </div>
                  <button type="button" class="ds-btn ds-btn--sm">Close</button>
                </header>
                <div class="ds-ticket-grid">
                  <div class="ds-ticket-thread">
                    <div class="adm-panel">
                      <div class="adm-panel-title">Conversation</div>
                      <div class="ds-msg is-outbound">
                        <p class="ds-msg-head"><span class="adm-pill">inbound</span><span>Harper Newman</span><span>&middot;</span><span>14 Oct 09:12</span><span>&middot;</span><span>email: <span class="adm-ok">delivered</span></span></p>
                        <p class="ds-msg-body">My order says it shipped on the 9th but nothing has arrived. Could you check the tracking?</p>
                      </div>
                      <div class="ds-msg is-note">
                        <p class="ds-msg-head"><span class="adm-pill adm-pill--off">note</span><span>Anish</span><span>&middot;</span><span>14 Oct 09:40</span></p>
                        <p class="ds-msg-body">Internal: fulfilment desk confirmed the parcel left the depot; tracking number is in the gift record.</p>
                      </div>
                      <div class="ds-msg is-outbound">
                        <p class="ds-msg-head"><span class="adm-pill adm-pill--ok">outbound</span><span>Anish</span><span>&middot;</span><span>14 Oct 09:44</span><span>&middot;</span><span>email: <span class="adm-ok">delivered</span></span></p>
                        <p class="ds-msg-body">Thanks for flagging this — the parcel is with the courier and I have sent you the tracking reference.</p>
                      </div>
                    </div>
                    <div class="adm-panel">
                      <div class="adm-panel-title">Reply</div>
                      <div class="adm-form">
                        <div class="ds-field"><span class="ds-label">template</span><select class="ds-select"><option>&mdash; none &mdash;</option></select></div>
                        <div class="ds-field"><span class="ds-label">internal note</span><input type="checkbox"></div>
                        <div class="ds-field"><span class="ds-label">body</span><textarea class="ds-textarea" rows="4">The tracking link is in your gift record.</textarea></div>
                      </div>
                      <button type="button" class="ds-btn ds-btn--primary">Send reply</button>
                    </div>
                  </div>
                  <aside class="ds-ticket-context">
                    <div class="adm-panel">
                      <div class="adm-panel-title">Member</div>
                      <p class="ds-strong">Harper Newman</p>
                      <p class="adm-note">harper@example.com &middot; Collective &middot; active</p>
                      <div class="ds-kv"><span>Nectar balance</span><strong>4,280</strong></div>
                      <div class="ds-kv"><span>Earned all time</span><strong>9,140</strong></div>
                      <div class="ds-kv"><span>Reflections</span><strong>38</strong></div>
                      <div class="ds-kv"><span>Sigma logs</span><strong>21</strong></div>
                      <div class="ds-kv"><span>Reviews due</span><strong>2</strong></div>
                      <div class="ds-kv"><span>Recognition awaiting the member</span><strong>1</strong></div>
                      <div class="ds-kv"><span>Open tickets</span><strong>1</strong></div>
                      <div class="ds-kv"><span>Member since</span><strong>14 Mar 2025</strong></div>
                    </div>
                    <div class="adm-panel">
                      <div class="adm-panel-title">Ticket</div>
                      <div class="adm-filters">
                        <select class="ds-select"><option>open</option></select>
                        <select class="ds-select"><option>high</option></select>
                        <select class="ds-select"><option>&mdash; unassigned &mdash;</option></select>
                      </div>
                    </div>
                  </aside>
                </div>
              </section>
            </div>
          </div>
'''


def main() -> int:
    global ICONS
    ICONS = load_icons()
    def link(s: str) -> str:
        """Cache-bust with the file's mtime: the sheet is regenerated often."""
        p = ROOT / s.replace('../', '')
        stamp = int(p.stat().st_mtime) if p.exists() else 0
        return f'<link rel="stylesheet" href="{s}?v={stamp}">'

    groups = nav_groups()
    total = sum(len(g[2]) for g in groups)
    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hive Nectar CRM — design system sheet</title>
<!-- The four legacy sheets, then the design system, in the order the bundle loads them. -->
{chr(10).join(link(s) for s in SHEETS)}
<style>
  /* preview only: ds.css asks for /fonts/…, which resolves under the Vite root
     (dev) and dist/ (build). Served from the repo root the font sits in public/. */
  @font-face {{ font-family: 'Inter'; font-style: normal; font-weight: 400 700; font-display: swap;
    src: url('../public/fonts/inter-latin.woff2') format('woff2'); }}
  body {{ margin: 0; }}
  .sheet-note {{ position: fixed; right: 12px; bottom: 12px; z-index: 90; max-width: 320px;
    padding: 10px 12px; border: 1px solid #E5E7EB; border-radius: 8px; background: #FFFFFF;
    font: 12px/1.5 Inter, system-ui, sans-serif; color: #64748B; box-shadow: 0 12px 32px rgba(16,24,40,.12); }}
</style>
</head>
<body>
<div class="adm-shell ds-shell">
  <aside class="ds-side">
{sidebar()}
  </aside>
  <div class="ds-body">
{topbar()}
    <main class="adm-main ds-main">
{page()}
{inbox()}
    </main>
  </div>
</div>
<p class="sheet-note"><strong>Static design sheet.</strong> {len(groups)} navigation groups, {total} sections,
figures are placeholders. Rendered from the shipped stylesheets so typography, colour, spacing and density
can be reviewed without an administrator session.</p>
<script>
  // ?clean=1 drops the demonstration popovers (bell, search) and the note, so
  // the sheet can be screenshotted without overlay clutter.
  if (location.search.includes('clean')) {{
    document.querySelectorAll('.ds-menu, .ds-search-panel, .sheet-note')
      .forEach(function (el) {{ el.remove(); }});
  }}
</script>
</body>
</html>
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(doc)
    # A second sheet that hosts the first in a 1640px-wide iframe (media queries
    # inside an iframe resolve against the iframe, not the window) so the wide
    # three-column layout can be inspected and screenshotted on any display.
    def wrapper(src: str, title: str, height: int) -> str:
        return (
            '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<title>{title}</title></head>'
            '<body style="margin:0;background:#F3F4F6">'
            f'<iframe src="{src}" title="{title}" '
            f'style="display:block;width:1640px;height:{height}px;border:0;zoom:.77"></iframe>'
            '</body></html>'
        )

    wide = OUT.with_name('ds-preview-wide.html')
    wide.write_text(wrapper('ds-preview.html', 'Hive Nectar CRM - design sheet at 1640px', 2600))
    # The inbox alone, so the workspace can be screenshotted on its own.
    inbox_sheet = OUT.with_name('ds-inbox.html')
    inbox_sheet.write_text(doc.replace(page(), ''))
    inbox_wide = OUT.with_name('ds-inbox-wide.html')
    inbox_wide.write_text(wrapper('ds-inbox.html', 'Hive Nectar CRM - support inbox at 1640px', 1250))
    print(f"wrote {OUT.relative_to(ROOT)} + 3 variants ({len(doc)} bytes) - {len(groups)} groups, {total} sections")
    return 0


if __name__ == "__main__":
    sys.exit(main())
