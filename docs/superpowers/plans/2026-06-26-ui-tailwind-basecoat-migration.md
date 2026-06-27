# UI Migration (Bootstrap -> Tailwind v4 + Basecoat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Bootstrap with Tailwind v4 + Basecoat across noitamap + noitamap-pro, yielding a unified, reserved, professional dark UI (slate + teal) that visibly differs from the Bootstrap look.

**Architecture:** Single ATOMIC cutover on one branch. Bootstrap and Tailwind/Basecoat cannot coexist (utility/component class-name collisions, e.g. Tailwind `.collapse` -> `visibility: collapse` vs Bootstrap `.collapse`). So Task 1 removes Bootstrap (CSS+JS) and turns on the Tailwind/Basecoat pipeline first; subsequent tasks convert each chrome surface. After Task 1, a converted surface renders correctly while un-converted surfaces look unstyled-but-functional - so surfaces are testable as they land. The app is not "shippable" until the last task, but it is inspectable throughout.

**Tech Stack:** Tailwind CSS v4.3.1 (`@tailwindcss/vite`), `basecoat-css` 0.3.11 (vanilla shadcn components + auto-init JS), Vite, vanilla TS. Bootstrap Icons font is RETAINED.

**Reference:** Design + full inventory in `docs/superpowers/specs/2026-06-26-ui-tailwind-basecoat-migration-design.md` (tokens, color inventory, Bootstrap->Basecoat mapping, identity rules). This plan holds the authoritative atomic task order; the spec's sections 7-8 sequencing is superseded.

## Testing approach (read first)

This is a UI migration; visual correctness is validated MANUALLY by the user in the browser (`npm run dev`), per surface, as each task lands. Per-step TDD does not apply to markup conversion. Automated coverage is one guard test (Task 8) asserting the mechanical invariants (no Bootstrap left). Where a task changes TS logic (e.g. search filter activation in a later pillars effort), that logic gets a unit test - but chrome markup tasks are gated by the user's visual check + the guard test, not unit tests.

## Global Constraints

- Dark mode ONLY. Never light. Apply `.dark` globally; drop light theme.
- Colors come ONLY from Tailwind v4's named palette via tokens (`var(--color-slate-*)`, `--color-teal-*`, `--color-amber-*`, `--color-red-*`). No ad-hoc hex in chrome.
- Token system = the block in `src/styles/app.css` (slate neutrals; `--primary` neutral slate; teal = accent via `--ring`/`--brand`; one amber `--warning`; red `--destructive`).
- Do NOT touch the biome-boundaries overlay colors/markup.
- Do NOT restyle the map-overlay/positioning CSS that is not Bootstrap chrome (`.osOverlayPOI`, `.osOverlayPopup` geometry, `.coordinate`, `.overlay.*` z-index, biome label text, pan-pulse). Keep these working; only retheme their colors to tokens where they are chrome-ish (POI card surface), never their geometry.
- Keep the 6 material-type colors as an isolated semantic data palette (retheme nothing).
- Keep the Bootstrap Icons font (`bootstrap-icons` CDN link stays).
- noitamap-pro migrates in lockstep (Task 7); it reuses noitamap's chrome + injects its own UI.
- The navbar MUST fit one row at 1920px wide (icon-only buttons, overflow menu).
- The result must visibly DIFFER from the Bootstrap look (hairline borders, unified ~32px control height + radius 0.5rem, segmented groups, denser/flatter).
- Leave `src/telescope/telescope-adapter.ts` (the dirty `wormFix` change) untouched - it is unrelated task-2 work.
- Do not commit on the user's behalf; the user commits. (Steps say "commit" for the executor's own workflow only if the user enables it; otherwise stage nothing.)

---

## File Structure

- `src/styles/app.css` - the design system: Tailwind import, preflight, Basecoat import, token block, and all migrated chrome component CSS (replaces the chrome parts of the 5 legacy CSS files).
- `index.html` - Bootstrap CDN removed; navbar + toast markup rebuilt on Basecoat.
- `public/css/*.css` - legacy files: chrome rules deleted as surfaces migrate; non-chrome map/overlay rules retained (or moved into app.css).
- TS chrome builders updated to emit Basecoat markup and drop `bootstrap.*` init: `nav.ts`, `language-selector.ts`, `dynamic_ui.ts`, `main.ts`, `i18n-dom.ts`, `auth/auth-ui.ts`, `search/unifiedsearch.ts`, `seed-report-button.ts`, `drawing/drawing-ui.ts`, `konami.ts`, `telescope/telescope-osd-bridge.ts`.
- noitamap-pro: `src/alchemy/alchemy-ui.ts`, `src/seed-report/sidebar.ts`, `src/high-value/*`, `src/popover-autodismiss.ts`, `src/app_osd.ts`, `src/drawing/simplification-preview.ts`, `src/drawing/sidebar.ts`.
- `tests/no-bootstrap.test.ts` - new guard test (Task 8).

---

## Task 1: Pipeline flip - remove Bootstrap, enable Tailwind + Basecoat

**Files:**
- Modify: `src/styles/app.css` (enable preflight + Basecoat import; tokens already present)
- Modify: `src/main.ts` (import `app.css` + Basecoat JS)
- Modify: `index.html` (remove Bootstrap CDN CSS link + JS bundle script; keep bootstrap-icons)

**Deliverable:** App boots with Bootstrap gone and Tailwind/Basecoat active. Chrome looks unstyled (Bootstrap component classes now have no CSS) but the page loads, the map renders, and custom-CSS elements (map overlays, coordinate, loading strip) still work. This is the expected mid-migration state.

- [ ] In `src/styles/app.css`, uncomment/enable the Basecoat import and add preflight, so the top reads:
  ```css
  @layer theme, base, components, utilities;
  @import "tailwindcss/theme.css" layer(theme);
  @import "tailwindcss/preflight.css" layer(base);
  @import "tailwindcss/utilities.css" layer(utilities);
  @import "basecoat-css";
  ```
  (Keep the existing `:root,.dark` token block and `@theme inline` brand/warning block below it.)
- [ ] In `src/main.ts`, restore the CSS import as the first line and add Basecoat's JS (core auto-init + all components) right after:
  ```ts
  import "./styles/app.css";
  import "basecoat-css/all";
  ```
- [ ] In `index.html`, DELETE the Bootstrap CSS `<link>` (`bootstrap@5.3.8 .../bootstrap.min.css`) and the Bootstrap JS `<script>` (`bootstrap.bundle.min.js`). KEEP the `bootstrap-icons` `<link>`. Leave the 5 `/css/*.css` links for now (cleaned per surface later).
- [ ] Manual check (user): `npm run dev`, confirm the app loads, map renders, no console crash. Navbar/chrome will look unstyled - expected.
- [ ] Commit: `chore(ui): remove Bootstrap, enable Tailwind v4 + Basecoat pipeline`

---

## Task 2: Navbar (identity + one row at 1920px)

**Files:**
- Modify: `index.html` (the `<nav class="navbar ...">` block)
- Modify: `src/nav.ts` (map dropdown items + badges), `src/language-selector.ts`, `src/dynamic_ui.ts` (seed controls/popovers), `src/main.ts` (delete `bootstrap.Popover/Tooltip/Dropdown` init at ~1069-1323), `src/i18n-dom.ts` (re-init hook), `src/app.ts` (overlay popovers ~111-143)
- Modify: `src/styles/app.css` (navbar component CSS), `public/css/style.css` (delete migrated navbar rules)

**Interfaces (Basecoat markup contracts, from the installed package):**
- Dropdown: `<div class="dropdown-menu"> <button ...> <div data-popover ...> <div role="menu"> <button role="menuitem">...</button> </div></div></div>`. Auto-inits via Basecoat's MutationObserver - no JS `new` call. (Note: this `.dropdown-menu` is the Basecoat WRAPPER; with Bootstrap gone there is no collision.)
- Popover (rich): `<div class="popover"> <button> <div data-popover>...</div></div>`. Auto-inits.
- Tooltip (simple hover help): any element with `data-tooltip="text"` (CSS-only, no JS).
- Buttons: `class="btn-sm-outline"` / `class="btn-sm-icon-outline"` (icon-only). Active/selected via `aria-pressed` + token classes.

**Deliverable:** Navbar renders on Basecoat, works (dropdowns/tooltips/popovers), fits one row at 1920px, looks intentionally different from Bootstrap.

- [ ] Rebuild the navbar markup in `index.html`: brand logo; a flex row with one control height; map-selector + language + perf as Basecoat `dropdown-menu`; spoiler/overlay togglers as a segmented `btn-sm-icon` group; search as a flexible input; share/mod/discord/github/runfast collapsed into a single overflow `dropdown-menu` ("more") so the row fits 1920px; nav help text moved to `data-tooltip`.
- [ ] Update `src/nav.ts`: `buildDropdownLink` emits `role="menuitem"` markup; badges use `data-tooltip` (not `data-bs-*`); delete `refreshBadgePopovers`' `bootstrap.Popover` calls (Basecoat auto-inits; tooltips need none).
- [ ] Update `src/language-selector.ts` and `src/dynamic_ui.ts`: emit Basecoat dropdown/popover markup; delete `new bootstrap.Popover(...)` (seed input rich popover -> Basecoat `popover` with `data-popover` body).
- [ ] In `src/main.ts`, `src/app.ts`, `src/i18n-dom.ts`: delete all `bootstrap.Popover/Tooltip/Dropdown` create/get/dispose calls; replace the i18n re-init hook with `window.basecoat.initAll()` (re-scan after language swaps re-render markup).
- [ ] Add navbar CSS to `src/styles/app.css` using tokens; delete the migrated navbar rules from `public/css/style.css`.
- [ ] Manual check (user): navbar one row at 1920px; dropdowns/tooltips/seed popover work; language swap re-inits.
- [ ] Commit: `feat(ui): rebuild navbar on Basecoat (one-row @1920, new identity)`

---

## Task 3: Unified search

**Files:**
- Modify: `src/search/unifiedsearch.ts`, `src/search/unifiedsearchresults.ts`
- Modify: `src/styles/app.css` (search overlay/filter/result CSS), `public/css/search.css` + `public/css/style.css` (delete migrated search rules)

**Deliverable:** Search overlay, filter group, result rows, "no results"/indexing placeholders rendered on Basecoat/Tailwind tokens; result popovers auto-init.

- [ ] Convert the unified search overlay container, filter button group (`#unifiedSearchFilterBox`), and result rows to token-based classes (`bg-popover`, `border-border`, hover `bg-accent`). Filters become a segmented toggle group; checked = `--brand` ring (not the white box-shadow).
- [ ] Replace any `data-bs-toggle="popover"` / `new bootstrap.Popover` in `unifiedsearch.ts` (lines ~949, 1000, 1682) with Basecoat markup (auto-init).
- [ ] Move migrated rules into `app.css`; delete them from `search.css` + `style.css`.
- [ ] Manual check (user): search opens, filters toggle, results render, popovers work.
- [ ] Commit: `feat(ui): migrate unified search to Basecoat/Tailwind`

---

## Task 4: POI cards, extended-info, pro-upsell placeholder

**Files:**
- Modify: `src/popover-util.ts`, `src/material-info.ts`, `src/extended-info/index.ts`, `src/telescope/telescope-osd-bridge.ts` (POI card / marker-tooltip builders)
- Modify: `src/styles/app.css`, `public/css/overlay-styles.css` (retheme chrome colors to tokens; KEEP geometry/positioning + material-type colors + biome rules)

**Deliverable:** POI popup card (`.osOverlayPopup`), extended-info section, and the non-pro upsell placeholder use tokens (slate surface, teal/amber accents) while keeping their geometry, z-index, material-type colors, and biome label styling untouched.

- [ ] Retheme `.osOverlayPopup` surface/border/links from ad-hoc hex (`#1a1f2a #ccc #ffc107 #47546b`) to tokens (`bg-card`, `text-card-foreground`, `--brand`/`--warning` links). Keep size/arrow/transform geometry.
- [ ] Retheme extended-info grays (`#888 #777 #aaa #bbb #ddd #ccc`) to `text-muted-foreground`/`text-card-foreground`; the gold pro placeholder to the single `--warning` token (flat, no gradient glow).
- [ ] Do NOT change `.material-type-*`, `.overlay.*` z-index, biome label text-shadow, pan-pulse.
- [ ] Manual check (user): click a POI, card themed correctly; material colors intact; biome overlay unchanged.
- [ ] Commit: `feat(ui): retheme POI cards + extended-info to tokens`

---

## Task 5: Toasts, dialogs, loading strip

**Files:**
- Modify: `index.html` (8 toast blocks), `src/main.ts` (~1232 toast), `src/konami.ts` (~41), `src/telescope/telescope-osd-bridge.ts` (~1158), `src/auth/auth-ui.ts` (~242 modal)
- Modify: `src/styles/app.css` + `public/css/style.css` (loading strip de-glow; spell modal)

**Deliverable:** Toasts on Basecoat `toast`; auth login + spell modal on native `<dialog>` (`.dialog`); loading strip flat teal (no cyan glow/shimmer pile).

- [ ] Convert the 8 toasts in `index.html` to Basecoat toast markup; replace `new bootstrap.Toast(...)` calls with Basecoat's toast trigger (dispatch the documented event / add the toast element).
- [ ] Convert auth modal (`auth-ui.ts` `new bootstrap.Modal`) and the spell modal (`#spellModalOverlay`) to native `<dialog class="dialog">` + `showModal()`/`close()`.
- [ ] Loading strip: replace cyan gradient + `box-shadow` glow + double shimmer with a flat `bg-brand` bar; keep the pill but token-themed, drop the colored glow.
- [ ] Manual check (user): trigger a toast (share copy), open auth + spell modals, trigger a load and watch the strip.
- [ ] Commit: `feat(ui): migrate toasts/dialogs + de-glow loading strip`

---

## Task 6: Drawing sidebar, toolbar, drop overlay

**Files:**
- Modify: `src/drawing/drawing-ui.ts` (~51 popover)
- Modify: `src/styles/app.css` + `public/css/drawing-sidebar.css` (migrate), `public/css/slider.css`, `public/css/dono-button.css`

**Deliverable:** Drawing sidebar/toolbar/drop overlay on tokens (slate, not gray-900; one accent); danger=red token, info=brand token; drop-zones use muted token tints not blue/purple; dono `bg-glow` rainbow deleted.

- [ ] Migrate `.drawing-sidebar`/`.drawing-toolbar` to `bg-card`/`border-border` tokens (replace `rgba(17,24,39,..)` gray-900 + white-alpha borders); buttons to Basecoat; `btn-outline-danger` -> `--destructive`, `btn-outline-info` -> `--brand`.
- [ ] Drop zones: replace blue (`#3b82f6`) / purple (`#a855f7`) tints with `--muted`/`--brand` token tints; keep dashed affordance.
- [ ] Delete the `.bg-glow` rainbow gradient block in `dono-button.css` (dead/disabled); replace `drawing-ui.ts` popover init with Basecoat markup.
- [ ] Manual check (user): open drawing sidebar (dev flag), toolbar, drag-drop overlay.
- [ ] Commit: `feat(ui): migrate drawing UI to tokens`

---

## Task 7: noitamap-pro lockstep

**Files:**
- Modify: `noitamap-pro/src/alchemy/alchemy-ui.ts`, `src/seed-report/sidebar.ts`, `src/high-value/install.ts`, `src/popover-autodismiss.ts`, `src/app_osd.ts`, `src/drawing/simplification-preview.ts`, `src/drawing/sidebar.ts`

**Deliverable:** Pro-injected UI (alchemy, seed-report sidebar, high-value markers, drawing extras) renders on the same tokens/Basecoat; pro popovers auto-init; ad-hoc inline colors (`#ff00ff`, `#222`, `#888`) replaced with tokens.

- [ ] Convert pro `style.cssText` inline colors to token-based classes; replace `bootstrap.*`/`data-bs-*` usage and `popover-autodismiss` Bootstrap assumptions with Basecoat.
- [ ] Verify pro builds via its entry (`pro-entry.ts`) and reuses noitamap chrome classes.
- [ ] Manual check (user, pro build): alchemy UI, seed-report sidebar, high-value list.
- [ ] Commit: `feat(ui): migrate noitamap-pro UI to Basecoat/Tailwind`

---

## Task 8: Cleanup + guard test

**Files:**
- Modify: `index.html`, `public/css/*.css` (delete dead Bootstrap-targeting rules + `--bs-*` overrides no longer referenced), `package.json` (drop `@types/bootstrap`), `global.d.ts` (drop `bootstrap` global decl if present)
- Create: `tests/no-bootstrap.test.ts`

**Deliverable:** No Bootstrap residue; an automated guard locks it in.

- [ ] Delete remaining dead chrome rules and unused `--bs-*` vars from the legacy CSS; keep only retained map/overlay rules (or move them into `app.css` and drop the legacy files from `index.html`).
- [ ] Remove `@types/bootstrap` from `package.json`; remove any `declare const bootstrap` / `window.bootstrap` typings.
- [ ] Write `tests/no-bootstrap.test.ts` asserting across `src/`, `index.html`, `public/css/`: no `data-bs-`, no `bootstrap.` JS refs, no `cdn.jsdelivr.net/npm/bootstrap@` (CDN; bootstrap-icons allowed), and none of the inventoried ad-hoc chrome hex (`#1a1f2a #222933 #2a2d35 #181a20 #47546b` etc.).
- [ ] Run: `npx vitest run tests/no-bootstrap.test.ts` - Expected: PASS.
- [ ] Manual QA (user): full checklist - every dropdown, tooltip, the 8 toasts, both modals, search, POI card, drawing UI, pro UI, mobile navbar collapse + one-row @1920.
- [ ] Commit: `chore(ui): remove Bootstrap residue + add no-bootstrap guard test`

---

## Self-Review

- Spec coverage: tokens (T1), navbar identity + one-row (T2), search (T3), POI/extended-info (T4), toasts/dialogs/loading (T5), drawing (T6), pro lockstep (T7), Bootstrap removal + guard (T8), biome boundaries untouched (constraint), material colors preserved (T4), Bootstrap Icons kept (constraint). Covered.
- The plan intentionally does not inline every line of converted markup (a UI migration of this size would make that thousands of lines); it gives exact files, exact Basecoat contracts, exact token mappings, and exact init-call deletions, with the converted markup produced during execution against those contracts and validated by the user's per-surface visual check. This is the deliberate adaptation noted in "Testing approach."
