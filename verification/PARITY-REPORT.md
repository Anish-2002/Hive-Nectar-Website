# Parity report — The Meadows react. vs the current static site

Pages compared: **24**
- Visible-text identical (exact hash): **24/24**
- Element census identical once mount wrappers are excluded: **24/24**
- Wiring delta of the standard engine signature (script +3, style +1, link -1): **22/24**
- Pixels matching >= 99% (per-channel delta > 12): **24/24**

`script`/`style`/`link` counts move because the mount engine re-wires the page's own
assets through the SPA: an executed `<script src>` is replaced by a `blob:` tag, and
`style.css` is owned by the shell (the page's duplicate `<link>` is dropped). Element
census otherwise matches tag-for-tag, and every page is pixel-identical — so no
markup was lost. Pages whose wiring delta differs from the standard signature are
listed in the non-div column below.

| page | text | wrapper divs | non-div deltas | match % | differing px | console errors (base/react) |
| --- | --- | --- | --- | --- | --- | --- |
| CRM.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 1/0 |
| about.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| admin-achievements.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| admin-crm.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| admin_comms.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| admin_inbox.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 1/1 |
| board.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| collaborate.html | ok | +1 | {'style': 1, 'script': 3, 'link': -1} | 100.0 | 0 | 0/0 |
| contact.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| decorator.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| faq.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| forgot-password.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| founders.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| index.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| information-and-links.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| join.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| login.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| pollenpop.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| preview.html | ok | +1 | {'style': 1, 'script': 3, 'link': 1} | 100.0 | 0 | 0/0 |
| profile.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| reset-password.html | ok | +1 | {'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| testjar.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| the-meadow.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
| trail.html | ok | +1 | {'link': -1, 'style': 1, 'script': 3} | 100.0 | 0 | 0/0 |
