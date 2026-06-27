# UI Redesign: Bootstrap -> Tailwind v4 + Basecoat (Design Spec)

Date: 2026-06-26
Scope: noitamap (base) + noitamap-pro (lockstep). Status: awaiting review.

> CORRECTION (post-P1 test): Bootstrap and Tailwind/Basecoat CANNOT coexist. Tailwind's generated
> utilities (e.g. `.collapse` -> `visibility: collapse`) and Basecoat's component classes
> (`.btn`/`.popover`/`.card`/...) collide with Bootstrap's identically-named classes; CSS cascade
> layers don't help when the collision lands on a different property. Confirmed empirically - a P1
> smoke test (Tailwind utilities imported while Bootstrap still loaded) made the navbar's `.collapse`
> menu `visibility: collapse`, so the menu vanished but kept its height. Therefore the migration is a
> single ATOMIC cutover on one branch: enable preflight + Basecoat, remove Bootstrap CSS+JS, and
> convert every chrome surface together. The app does NOT render correctly until the cutover is
> complete (no testable half-Bootstrap state). This supersedes the phased/coexistence sequencing in
> sections 7-8; the implementation plan holds the authoritative atomic task order.

## 1. Goal

Task 1: the UI reads as "AI-slop glow" and "rainbow vomit". Make it unified, reserved,
professional. Fewer colors. This is a DARK-MODE-ONLY app (never light).

Decision (escalated from the original "just tidy the palette" scope): drop Bootstrap
entirely and rebuild the component layer on Tailwind v4 + Basecoat (vanilla shadcn-style
components). The palette cleanup is the deliverable; the framework swap is the vehicle and
removes the root cause (a pile of `!important` overrides fighting Bootstrap defaults).

Constraints:
- Strictly use Tailwind 4.x palette colors (map tokens to `var(--color-*)` palette vars).
- Do NOT touch the biome-boundaries overlay colors.
- noitamap-pro shares the same chrome and must migrate in lockstep.
- Work in isolation (branch); single cutover, no half-Bootstrap state shipped to prod.
- Do not commit on the user's behalf. User does manual testing.

## 2. Locked decisions

- Library: Basecoat (`basecoat-css` 0.3.11, MIT). Already installed. Confirmed vanilla,
  Tailwind-based, ships positioned JS for dropdown-menu/popover/select/toast/tabs/sidebar/
  command; `[data-tooltip]` is CSS-only; `.dialog` uses native `<dialog>`.
  (DaisyUI considered and rejected: colorful-by-default DNA fights the "reserved" goal, and
  its CSS-only dropdowns lack guaranteed cross-browser flip/shift, so we would have to add
  Floating UI anyway. Basecoat gives Bootstrap-popover parity out of the box.)
- Tailwind: `tailwindcss` 4.3.1 + `@tailwindcss/vite` 4.3.1. Already installed.
- Neutral family = slate (keep existing identity; kills the stray gray-900 too).
- Accent = teal, used sparingly (focus ring, links, active/selected, daily-seed). `--primary`
  fill stays NEUTRAL slate for restraint (REVIEW POINT: set `--primary` to teal instead if you
  want teal primary buttons).
- Consolidate gold/amber/yellow sprawl into ONE amber "warning/premium" token.
- Keep the 6 material-type colors as an isolated semantic DATA palette (game data, like charts).
- Keep the Bootstrap Icons font (swapping all icons to Lucide is out of scope).

## 3. Current-state inventory (what we are removing)

Competing accent hues in the chrome today:
- teal (`#14b8a6`, accent + daily-seed), cyan (`#22d3ee/#0891b2/#67e8f9`, loading bar +
  drawing info), gold/amber/yellow (`#ffc107 #fbbf24 #eab308 #ca8a04 #b08a2a #ffd36e`,
  prev-daily + links + pro upsell + runfast + close button), emerald (badge), blue+purple
  (`#3b82f6`/`#a855f7` drop zones), sky (`#7dd3fc` hotkey), red (danger/highlight).

Two neutral families: slate (most) vs Tailwind gray-900 (`rgba(17,24,39,..)` drawing sidebar/
toolbar).

Ad-hoc grays to fold into the slate ramp: `#ccc #888 #777 #666 #999 #aaa #bbb #ddd #1a1f2a
#181a20 #222933 #2a2d35 #3a3d45 #3a3a4a #47546b` and various `#fff8/#000a/#fffN` alphas.

"AI-slop glow" surface to remove or tame:
- Loading strip: cyan gradient bar + cyan box-shadow glow + two shimmer animations + cyan-
  bordered pill with backdrop-blur (`public/css/style.css`).
- White box-shadow ring on checked search filters `rgba(248,249,250,0.25)` (`search.css`).
- Rainbow `bg-glow` animated gradient on the (already disabled) dono button (`dono-button.css`).
- Multiple backdrop-blurs (drawing sidebar/toolbar/drop-overlay, search overlays).
- Gold pro-upsell gradient + gold dashed placeholder (`overlay-styles.css`).

Files holding chrome styling:
- `public/css/style.css` (nav, dropdowns, badges, search, loading strip, skeleton, spell modal)
- `public/css/search.css` (unified search overlay + filters)
- `public/css/overlay-styles.css` (POI popups `.osOverlayPopup`, extended-info, material types)
- `public/css/drawing-sidebar.css` (drawing sidebar/toolbar, drop zones)
- `public/css/dono-button.css`, `public/css/slider.css`
- `index.html` (Bootstrap CDN + all chrome markup + 8 toasts)

## 4. Target token system

Basecoat themes via the shadcn CSS-variable contract, re-exported to Tailwind through
`@theme { --color-*: var(--*) }`. We override one block. Dark applied globally (add
`class="dark"` to `<html>`, keep the existing `data-bs-theme` only until Bootstrap is removed);
the light `:root` values are dropped.

Proposed override (values are Tailwind v4 palette vars to honor the "Tailwind colors only" rule):

```css
:root, .dark {
  --radius: 0.5rem;

  --background: var(--color-slate-950);
  --foreground: var(--color-slate-100);

  --card: var(--color-slate-900);
  --card-foreground: var(--color-slate-100);
  --popover: var(--color-slate-900);
  --popover-foreground: var(--color-slate-100);

  --primary: var(--color-slate-100);          /* neutral fill; REVIEW: teal instead? */
  --primary-foreground: var(--color-slate-950);

  --secondary: var(--color-slate-800);
  --secondary-foreground: var(--color-slate-100);

  --muted: var(--color-slate-800);
  --muted-foreground: var(--color-slate-400); /* replaces #888/#999/#aaa/#ccc body grays */

  --accent: var(--color-slate-800);           /* subtle hover bg (shadcn semantics) */
  --accent-foreground: var(--color-slate-100);

  --destructive: var(--color-red-500);
  --destructive-foreground: var(--color-slate-50);

  --border: var(--color-slate-800);
  --input: var(--color-slate-700);
  --ring: var(--color-teal-500);              /* teal focus ring = the accent */

  /* app brand + meaning tokens, used sparingly */
  --brand: var(--color-teal-500);             /* links, active/selected, daily-seed */
  --brand-foreground: var(--color-teal-300);
  --warning: var(--color-amber-400);          /* prev-daily, pro/premium, external links */
  --warning-foreground: var(--color-amber-300);

  color-scheme: dark;
}

@theme {
  --color-brand: var(--brand);
  --color-warning: var(--warning);
  /* gives text-brand / border-brand / bg-warning utilities */
}
```

Material-type colors stay in their own block (`overlay-styles.css`), unchanged, as the
isolated data palette:
`solid/liquid/powder/gas/fire/acid` oklch values (matched 1:1 with bartender custom.css).

Result: chrome collapses from ~8 competing hues to slate + teal, with amber and red as
sparingly-used meaning colors, plus material-types isolated as data viz.

## 5. Glow / effects rules

Remove:
- Loading-bar cyan glow + shimmer -> flat `--brand` (teal) bar, no box-shadow.
- White box-shadow ring on checked filters -> border + bg using tokens.
- `bg-glow` rainbow gradient (dono button) -> delete (already disabled).
- Gratuitous backdrop-blurs where they add nothing.

Keep (standardized on tokens):
- shadcn elevation = 1px `--border` + one restrained soft shadow.
- Skeleton pulse, but subtle and token-colored.
- One backdrop-blur on the floating drawing panels only.

## 5.1 Added requirements (2026-06-26)

Visual identity - the redesign must read as a deliberate, coherent design that visibly DIFFERS
from the old Bootstrap look, not a recolor. Directions: hairline 1px `--border` everywhere, one
tighter unified radius (`--radius` 0.5rem), a single control height (~2rem/32px) and one spacing
scale, segmented control groups instead of Bootstrap `btn-group`, refined type scale (Inter,
tabular nums for coords/seeds), flatter and denser chrome, consistent padding inside
popovers/cards. Goal words: coherent, polished, professional.

One-row navbar at 1920px - the entire menu bar MUST fit on a single row at 1920px wide (not only
on 4K). Today it wraps because it is overloaded. Strategy:
- icon-only buttons; drop inline text labels (e.g. "Mod").
- one compact control height + minimal gaps.
- collapse secondary external links (mod/discord/github/runfast) into one compact cluster or an
  overflow "more" menu.
- overlay toggles as a tight segmented group; consider grouping rarely-used ones.
- search field flexible/collapsible so it yields width under pressure.
- target: full nav (incl. dynamic-map seed controls + auth + drawing entry) fits one row <= 1920px;
  verify at 1920px and degrade gracefully below.

## 6. Bootstrap -> Basecoat behavior swap

Bootstrap JS surface (confirmed: 128 refs across 13 files + index.html):

| Bootstrap feature | Basecoat replacement | Primary files (init sites) |
|---|---|---|
| Popover (nav help, title-only) | `[data-tooltip]` (CSS) | index.html, nav.ts, i18n-dom.ts, main.ts |
| Popover (rich: seed input html, title+content) | Basecoat `popover` (JS) | dynamic_ui.ts, seed-report-button.ts, drawing-ui.ts, app.ts, unifiedsearch.ts |
| Dropdown (map/language/perf/auth) | Basecoat `dropdown-menu` (JS) | index.html, auth-ui.ts, main.ts |
| Toast (8) | Basecoat `toast` (JS) | index.html, main.ts, konami.ts, telescope-osd-bridge.ts |
| Modal (auth login; spell modal already custom) | native `<dialog>` (`.dialog`) | auth-ui.ts, style.css `#spellModalOverlay` |
| Collapse (mobile navbar) | small custom toggle | index.html, main.ts |
| btn-check / form-switch | Basecoat input/switch + Tailwind | index.html, drawing/search |
| badge / list-group / spinner-border | Basecoat badge + Tailwind | nav.ts, search, drawing |
| Icons (bootstrap-icons font) | KEEP | unchanged |

Notes / gotchas to honor during implementation:
- `i18n-dom.ts` re-inits popovers/tooltips on language change; the new equivalents must
  re-init on the same hook.
- Seed input popover uses `html:true, sanitize:false` (rich content).
- Perf-mode is a manual-trigger popover AND a dropdown, with nested hover popovers on items.
- POI marker card (`.marker-tooltip`, z-index 10000) and `.osOverlayPopup` are map overlays;
  audit builders in `popover-util.ts` and `src/telescope/telescope-osd-bridge.ts`. Keep their
  z-index relationships (popovers must paint above the card).
- Navbar wraps on mobile; positioned popovers/dropdowns (Basecoat JS) preserve current flip/
  shift behavior.

## 7. Build integration

- Add `@tailwindcss/vite` plugin to `vite.config.ts`.
- New entry `src/styles/app.css`:
  `@import "tailwindcss";` then `@import "basecoat-css";` then the token override block and the
  migrated component CSS (folding in the 5 legacy CSS files surface by surface).
- Wire `app.css` via `main.ts` (or an HTML link) and remove the 5 legacy `<link>`s as each
  surface is migrated.
- Final step: remove Bootstrap CDN `<link>` (CSS) and `<script>` (bundle) and bootstrap-icons
  stays (separate CDN link).
- `@types/bootstrap` dependency removed at the end.

## 8. Work breakdown (internal phases; one cutover)

Kept runnable per checkpoint by migrating component-family by component-family. Bootstrap and
Tailwind may both load transiently during dev; Bootstrap removed at the end.

- P1: build wiring + token block + `.dark` global + base typography. Verify Tailwind compiles,
  tokens resolve.
- P2: navbar chrome - buttons, map/language/perf dropdowns, overlay toggle group, nav help
  popovers/tooltips, runfast/share/mod/discord/github buttons, badges.
- P3: search - unified search overlay, filter group, result rows, "no results"/indexing
  placeholders; POI popups (`.osOverlayPopup`) + extended-info card + pro-upsell placeholder.
- P4: toasts (8) + dialogs (auth login modal, spell modal) + loading strip (de-glow).
- P5: drawing sidebar + bottom toolbar + drop overlay + slider + dono button cleanup.
- P6: noitamap-pro lockstep - alchemy-ui, seed-report sidebar, high-value, popover-autodismiss,
  app_osd injected UI, simplification-preview (replace `#ff00ff`/`#222`/`#888` inline styles),
  drawing/sidebar.
- P7: remove Bootstrap CDN + `@types/bootstrap` + dead legacy CSS; QA pass.

## 9. QA

Manual checklist (user): every dropdown (map, language, perf, auth), every nav popover/tooltip,
seed input rich popover, all 8 toasts, auth modal, spell modal, mobile navbar collapse + wrapped
popover placement, search overlay + filters, POI card + extended-info + pro placeholder, drawing
sidebar/toolbar/drop-overlay, pro alchemy + seed-report sidebars.

Automated guard (vitest): assert post-migration there are no `data-bs-*` attributes, no
`bootstrap.` JS references, no Bootstrap CDN links in `index.html`, and no legacy ad-hoc hex
from the inventory list remain in `src` / `public/css`.

## 10. Out of scope / preserved

- Biome-boundaries overlay colors (untouched, per instruction).
- Material-type semantic colors (kept as data palette).
- Bootstrap Icons font (kept).
- Dirty `src/telescope/telescope-adapter.ts` (the `wormFix` nudge) is task-2 work, left as-is.

## 11. Risks

- Tailwind preflight vs Bootstrap reboot coexisting during dev -> transient visual drift;
  mitigated by single-branch cutover and removing Bootstrap before ship.
- Popover positioning parity on the wrapped mobile navbar -> verify Basecoat JS placement.
- Pro shares base chrome -> base changes can break pro mid-migration; P6 closes the gap before
  ship and the guard test covers both repos.
- Rich/nested popovers (seed input html, perf-mode nested) need careful re-init wiring.
- i18n re-init hooks must drive the new components.
