# THE MEADOW — design tokens

Single source of truth for `profile-meadow.css` (profile page) and
`meadow-theme.css` (every other page). Values below were taken from the
reference stylesheet (`files/profile.css`) and then tuned with `@google/design.md`
lint: `muted` and `faint` were darkened until every token clears WCAG AA on the
surfaces it actually lands on. Border/ring tokens (`line`, `sage3`, `clay`) are
documented but are not component-level colours.

```yaml
colors:
  primary: "#3E5A44"
  primary-dark: "#7FA486"
  bg: "#F6F4EC"
  bg-dark: "#151A16"
  surface: "#FDFCF8"
  surface-dark: "#1D241F"
  topbar: "#F9F7F1"
  topbar-dark: "#181E1A"
  ink: "#2E4A37"
  ink-dark: "#DDE8DC"
  text: "#46564B"
  text-dark: "#BCC8BD"
  muted: "#626C65"
  muted-dark: "#94A297"
  faint: "#6A786C"
  faint-dark: "#7F8D82"
  line: "#E4E7DA"
  line-dark: "#2D372F"
  soft: "#F1F3E9"
  soft-dark: "#242D26"
  sage1: "#E7ECDC"
  sage1-dark: "#26322A"
  sage2: "#DCE4CF"
  sage2-dark: "#2C3A30"
  sage3: "#C5D2BA"
  sage3-dark: "#3B4D40"
  sage5: "#7A9170"
  sage5-dark: "#8FAE84"
  green: "#3E5A44"
  green-dark: "#7FA486"
  gold: "#F0E8CB"
  gold-dark: "#3A3622"
  clay: "#F4E3DA"
  clay-dark: "#3B2B22"
  t2-ink: "#8A4B2A"
  t2-ink-dark: "#E3A98A"
typography:
  display:
    fontFamily: Newsreader
    fontWeight: 500
    letterSpacing: -0.01em
  body:
    fontFamily: Inter
    fontWeight: 400
    fontSize: 15px
    lineHeight: 1.5
  eyebrow:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: 700
    letterSpacing: 0.14em
rounded:
  hero: 28px
  card: 20px
  chip: 999px
  inset: 12px
spacing:
  unit: 8px
  target-min: 44px
```

## Colors

Every page consumes colour through variables, never literals — `js/app.js`
`applyTheme()` writes the legacy palette as **inline** custom properties on
`<html>`, so `html { --token: … !important }` is the only way to outrank it.
`meadow-theme.css` remaps the app's names onto these tokens; the namespaced
`--m-*` copies exist so the two sheets never collide.

| app variable | token | value |
|---|---|---|
| `--bg` | `bg` | #F6F4EC |
| `--card` | `surface` | #FDFCF8 |
| `--primary`, `--primary-dark` | `green` | #3E5A44 |
| `--secondary` | `sage1` | #E7ECDC |
| `--fg` | `text` | #46564B |
| `--fg-muted` | `muted` | #626C65 |
| `--border`, `--border-light` | `line` | #E4E7DA |
| `--honey-gradient` | `green → ink` | #3E5A44 → #2E4A37 |
| `--error` | `clay` | #A8574A |
| `--success` | `green` | #3E5A44 |

Headings render in `ink` (#2E4A37) over body copy in `text` (#46564B).

## Typography

Newsreader carries every display face (h1–h6, `.section-title`) with a Georgia
fallback; Inter carries body copy, controls and labels. Both are loaded once per
page from Google Fonts (preconnect + one stylesheet link).

## Elevation & Depth

One shadow pair, reused everywhere: `--m-sh` for resting surfaces and
`--m-sh-hover` for hover/overlay. Covers are `rgba(30,42,34,.45)`.

## Shapes

Radius by role: hero 28px, card 20px, control 12px, chip 999px, inset 12px.
Focus uses `--m-ring` (3px sage halo) and `:focus-visible` gets a 2px sage5 outline.

## Components

`button-primary` is the only high-emphasis action; `button-secondary` is the
quiet sibling; `pill-active` marks the selected segment filter.

## Do's and Don'ts

- **Do** route every colour through a token; never hard-code a hex in a page sheet.
- **Do** keep the shared sheet additive — colour, type, radius, shadow only.
- **Don't** set `display`, `position`, sizes or margins here: page layout is owned
  by `style.css` / `tester.css` and an earlier shared-sheet `display:flex`
  override broke the mobile hamburger.
- **Don't** nest component variants; `button-primary-hover` is a sibling key.

## Notes

- Tokens are declared on `body.page-profile`, not `:root`, because `js/app.js` writes
  theme colours as **inline** custom properties on `<html>`; body-scoped values are the
  nearest declaration for every descendant, so they win without `!important`.
- `line`, `sage3` and `clay` raise lint warnings only because a colour-only component
  schema cannot express border/ring tokens. They are intentional, not failures.
- Nothing in this file is a credential or endpoint; it is a design contract.
