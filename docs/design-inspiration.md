# Design Inspiration — Glassmorphic Cards

This document captures the visual style applied to JobPilot's dashboard stat
cards, so the same aesthetic can be reproduced in future sessions or other
projects without needing to re-share the original inspiration screenshot.

**Original reference**: smart-home dashboard mockup with frosted-glass widget
cards (temperature, lighting, wifi, music player, etc.) floating on a dark
ambient background. Drop the screenshot at `docs/inspiration/glass-cards.png`
to keep this doc anchored to its source.

## Core ingredients

The "floating glass cards on dark surface" look is built from five layers:

1. **Dark gradient backdrop** — the dark surface that the cards float over.
   Without this, the translucent card base is invisible.
   ```html
   <div class="bg-gradient-to-br from-slate-900 via-slate-900 to-slate-950
               rounded-3xl p-5 shadow-2xl shadow-slate-950/30">
   ```

2. **Ambient glow blobs** — large blurred coloured circles in the corners that
   give the dark surface depth and lighting. Decorative; sit behind content.
   ```html
   <div class="absolute -top-32 -right-24 h-72 w-72 rounded-full
               bg-indigo-500/20 blur-3xl pointer-events-none" />
   <div class="absolute -bottom-32 -left-24 h-72 w-72 rounded-full
               bg-emerald-500/10 blur-3xl pointer-events-none" />
   ```
   Pick blob colours that match the product's brand accents. Keep opacity low
   (`/10` to `/20`) so they whisper rather than shout.

3. **Translucent card base** — the actual glass effect.
   ```html
   <div class="relative overflow-hidden rounded-2xl
               bg-white/[0.04] backdrop-blur-xl
               border border-white/10
               shadow-lg shadow-black/30">
   ```
   - `bg-white/[0.04]` (4% white) is the minimum that registers visually but
     stays subtle. Going above `/10` makes it look flat-grey instead of glass.
   - `backdrop-blur-xl` is the frosted softening. Reduce to `lg` if the
     content behind the card is already blurry from the ambient blobs.
   - `border border-white/10` is the subtle "glass edge" — required.
     Without it, the card edges disappear entirely.
   - `shadow-lg shadow-black/30` is the lift. The dark colour matches the
     dark backdrop and reads as ambient occlusion, not a drop shadow.

4. **Top-edge highlight** — a 1px gradient line along the top of the card
   that catches light like a real piece of frosted acrylic. This is the
   single detail that takes the cards from "translucent rectangle" to
   "looks like glass".
   ```html
   <div class="absolute inset-x-3 top-0 h-px
               bg-gradient-to-r from-transparent via-white/25 to-transparent
               pointer-events-none" />
   ```
   Inset slightly (`inset-x-3`) so the highlight doesn't reach the rounded
   corners — keeping it crisp.

5. **Hover/active states** — lift slightly on hover by bumping the
   translucency and shadow. Avoid changing the card colour — the glass
   shouldn't darken or saturate.
   ```html
   class="hover:bg-white/[0.07] hover:border-white/20
          hover:shadow-xl hover:shadow-black/40 transition-all"
   ```

## Typography on glass

Text on a glass card sits over a noisy translucent background. Three rules:

- **Label** (small, all-caps): `text-[10px] text-white/50 font-medium tracking-wider uppercase`.
  Light, secondary; the value is the hero.
- **Value** (large, prominent): `text-3xl font-semibold text-white` (default).
  Override with bright `text-amber-300` / `text-emerald-300` / `text-red-300`
  for status accents — these jewel-tone shades read clearly against dark glass
  without the over-saturation of `-500` or `-400` shades.
- **Sub-label** (caption): `text-xs text-white/50`.

Avoid `text-gray-*` for white-on-glass text — opacity (`text-white/50`) is
cleaner because it always picks up the underlying card colour temperature.

## Corner radius hierarchy

- Outer dark container: `rounded-3xl` (24px)
- Individual cards: `rounded-2xl` (16px)
- Inner pills / chips / buttons: `rounded-xl` (12px)

This nested-radius pattern (always smaller as you nest deeper) is what makes
the layout feel intentional rather than randomly rounded.

## When to apply this style

Glass cards work best for:
- Dashboards with a small number of high-signal "widgets" (stats, status
  cards, hero numbers).
- Hero/header sections that set tone for the page.
- Settings panels with grouped controls.

Glass cards work poorly for:
- Dense lists / tables (the translucency adds visual noise and hurts
  scannability — keep those on a plain light or solid-dark surface).
- Long-form content (the eye gets tired reading through translucency).
- Print-style data layouts (invoices, reports).

In JobPilot specifically: applied to the 5 stat cards (Jobs found / Applied
/ In review / Interviews / Failed). The job list itself stays on the
existing light surface because there are hundreds of rows and they need to
be scannable at a glance.

## Quick reuse checklist

When porting this style to another project:

- [ ] Drop the original screenshot at `docs/inspiration/glass-cards.png`
- [ ] Build the dark gradient + glow-blob container first; verify it shows
- [ ] Add one card, get the glass effect right before duplicating
- [ ] Tune the `bg-white/[0.04]` value — `/03` to `/06` is the usable range
- [ ] Replace status colours with the `-300` shade variants
- [ ] Verify on a real (non-bright-white) browser background — pure white
      backgrounds make the dark gradient look flat
