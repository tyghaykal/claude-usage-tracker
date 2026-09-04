---
version: alpha
name: Claude Usage Tracker — Notion-derived design system
description: Notion's warm-paper, near-black, single-blue-accent design language, adapted from marketing-site source material to this app's actual surfaces — a dashboard, tables, forms, modals, and toasts, not a landing page.
source: DESIGN-notion-1.md (Notion marketing-site analysis)

colors:
  primary: "#0075de"
  primary-active: "#005bab"
  on-primary: "#ffffff"
  canvas: "#ffffff"
  canvas-soft: "#f6f5f4"
  surface: "#ffffff"
  ink: "#000000"
  ink-secondary: "#31302e"
  ink-muted: "#615d59"
  ink-faint: "#a39e98"
  hairline: "#e6e6e6"

typography:
  heading-1:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 700
    letterSpacing: -0.5px
  heading-2:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 600
    letterSpacing: -0.25px
  heading-3:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 600
    letterSpacing: -0.1px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
  button:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 500
  caption:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
  eyebrow:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: 600
    letterSpacing: 0.06em

rounded:
  xs: 4px
  md: 8px
  lg: 12px
  full: 9999px

components:
  nav-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    activeIndicator: "{colors.primary}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
    pressed: "{colors.primary-active}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
  button-danger:
    textColor: "#b91c1c"
    rounded: "{rounded.full}"
  card:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.lg}"
    elevation: level-1
  text-input:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.xs}"
  data-table-cell:
    headerBackground: "{colors.canvas-soft}"
    headerTypography: "{typography.eyebrow}"
    bodyTypography: "{typography.body-sm}"
    rowBorder: "{colors.hairline}"
  badge-pill:
    rounded: "{rounded.full}"
    typography: "{typography.eyebrow}"
  modal-card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    elevation: level-2
  toast:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    elevation: level-1

---

## Overview

This is Notion's design language (see `DESIGN-notion-1.md` for the full marketing-site
analysis) trimmed to what this app actually has: a top nav, cards, a filterable table,
forms, modals, and toasts. No hero band, no pricing table, no sticker illustrations —
those were Notion-marketing-only and don't map onto a dashboard.

What carries over: the warm off-white canvas instead of clinical white, near-black text
in Inter, exactly one structural accent color (`{colors.primary}`, #0075de) reserved for
primary actions and active nav state, hairline borders over heavy shadows, and pill-shaped
primary/secondary buttons contrasted with tighter-radius utility chrome.

**Key characteristics, dashboard-scoped:**
- Warm paper canvas (`{colors.canvas-soft}`) as the page background, white cards on top
- Near-black Inter type, tight negative tracking on headings only
- One structural accent (`{colors.primary}`) for CTAs, links, and active nav — nothing else is ever painted blue
- Pill buttons (`{rounded.full}`) for primary/secondary actions, 8px radius for compact utility controls, 4px for form inputs
- Hairline + barely-there layered shadow for elevation, never a hard drop-shadow
- Existing semantic status colors (red/amber/emerald for danger/warning/success badges) are kept as-is — Notion's marketing site doesn't define a status ramp, so this app's existing conventions fill that gap

## Implementation mapping (Tailwind)

This app is Tailwind v3 + Vue 3, with almost every view built from raw `slate-*` utility
classes plus a handful of shared classes in `client/src/style.css` (`.btn-primary`,
`.card`, `.input`, `.th`/`.td`, `.badge`). Two moves cover the whole app without touching
every view file:

1. **`slate` → `stone`.** Tailwind's built-in `stone` scale is already a near-exact match
   for Notion's warm neutrals (`stone-100` ≈ `{colors.canvas-soft}`, `stone-400` ≈
   `{colors.ink-faint}`, `stone-800` ≈ `{colors.ink-secondary}`). A repo-wide `slate-` →
   `stone-` rename reskins all ~400 existing utility-class occurrences at once — no custom
   gray scale needed.
2. **`primary` as a new Tailwind color**, extended (not overridden) with `DEFAULT` #0075de
   and `active` #005bab. Only touches the handful of places that represent a primary
   action or active state: `.btn-primary`, the nav `active-class`, and focus rings.

Everything else (radii, shadow, font) is a small `tailwind.config.js` extension plus
edits to the shared classes in `style.css` — not a per-view rewrite.

| Notion token | Tailwind usage here |
|---|---|
| `{colors.canvas-soft}` | `bg-stone-100` (page background) |
| `{colors.surface}` / `{colors.canvas}` | `bg-white` (cards, nav, inputs) |
| `{colors.hairline}` | `border-stone-200` |
| `{colors.ink}` / `-secondary` / `-muted` / `-faint` | `stone-900` / `stone-800` / `stone-500` / `stone-400` |
| `{colors.primary}` / `-active` | `primary` / `primary-active` (new Tailwind color) |
| `{rounded.xs}` (4px) | `rounded` (Tailwind default) |
| `{rounded.lg}` (12px) | `rounded-xl` |
| `{rounded.full}` | `rounded-full` |
| Level-1 shadow | `shadow-notion` (new Tailwind shadow) |

## Do's and Don'ts

### Do
- Reserve `primary` for the primary action, links, and active nav — nothing decorative.
- Keep the page on `stone-100`; use white for any surface that sits on top of it.
- Set heading letter-spacing tight (handled globally via `h1`/`h2`/`h3` base styles); leave body text at default tracking.
- Use `rounded-full` for primary/secondary buttons, `rounded-md`/default for compact utility controls and inputs.

### Don't
- Don't introduce a second structural accent color alongside `primary`.
- Don't put `rounded-full` on inputs — they stay tight at the default (4px) radius.
- Don't add heavy drop-shadows; use the `shadow-notion` layered shadow or a hairline alone.
- Don't reintroduce hero bands, pricing cards, or sticker illustrations — out of scope for this app.
