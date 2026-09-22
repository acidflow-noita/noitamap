# Dynamic Map: changes compared with production `main`

## Scope and how to use this document

This is an announcement reference, not a list of every intermediate WIP commit.
It describes features that survive in the current source, distinguishes public
features from restricted or experimental ones, and avoids counting generated
assets, dependency updates and abandoned experiments as separate user features.

- **Baseline:** freshly fetched `origin/main`,
  `7db8c87de2c42303ce3df974ad08f8ea26557a24` — “Add map logo for Patreon auth”,
  February 25, 2026.
- **Development snapshot:** `dynamic-map`,
  `83290744ecc32ce07dedee2629e914a8293be9ed` — “Adjust zoom timing”,
  September 21, 2026 (America/New_York). Navigation timing remains subject to
  manual visual review, despite the fix being included in this commit.
- **Comparison checked:** September 22, 2026 (UTC).
- **Scale of the branch comparison:** 420 commits not reachable from `main`;
  777 changed paths in the committed tree comparison. These are engineering
  scope figures, not 420 new features.
- **Pro companion:** local `task/noitamap-pro`, commit
  `bbe58a2` — “Adjust report V2”. Its feature/access checks were reviewed as well.
- **Deployment caveat:** this verifies repository contents and the latest fetched
  `main` ref, not which asset revision a live browser/CDN currently serves.

A shorter announcement draft is in `dynamic-map-announcement.md`. **Pro-only
features are collected in the final section of this document.**

## 1. The main change: an interactive map for a seed, not just a captured atlas

Production `main` is primarily a viewer for captured maps, with map selection,
static overlays and search. Dynamic Map adds a seed-generation workflow on top
of that existing atlas.

### Added

- Enter a seed and generate its world layout and indexed points of interest.
- Inspect the main world and the adjacent west/east parallel worlds.
- Open today's daily seed or the previous daily seed directly from the toolbar.
- Recognize a manually entered/current mod-linked seed as the daily seed when it
  matches the daily feed.
- Retain the selected seed and distinguish daily, previous-daily and custom seed
  states in the toolbar.
- Open the corresponding seed in Noita Telescope from the map UI.
- Use the dynamic map as the default map selection while keeping the captured
  map catalogue available.

### What this means for players

The map can answer “what is in *this seed*, and where can I find it?” rather than
only showing a representative captured world.

### Important boundaries

The normal custom-seed input currently accepts **1–2,147,483,647**. Do not call
that every possible game seed. The visible generator is the regular dynamic
world workflow; NG+/Nightmare support inside engine adapters is not the same as
a released custom-seed UI for every game mode or mod.

**Evidence:** `src/dynamic-map.ts`, `src/dynamic_ui.ts`,
`src/telescope/telescope-adapter.ts`, `src/data_sources/daily_seed.ts`,
`src/data_sources/url.ts`.

## 2. A dedicated daily-map delivery path

Daily maps are not simply forced through the same client-generation process as
an arbitrary custom seed.

- Daily/previous-daily seed feeds and update/serve workers were added.
- Available pre-baked daily imagery can be streamed through Deep Zoom tiles,
  with corresponding seed data used for POIs and search.
- Daily data and imagery have explicit cache identities/version handling.
- A baked map avoids unnecessary generator startup, repeated all-unlocks
  generation, and the misleading client-generation loading strip.
- Repeat visits can reuse cached data rather than rebuilding everything.
- Generation and baking distinguish a complete set of worlds from incomplete
  output; incomplete bake results must fail rather than silently look valid.
- Local completed-bake viewing and diagnostic paths were added for maintenance.

**Announcement wording:** “Daily seeds now have a dedicated pre-generated map
loading path.” Avoid universal loading-time promises: network, cache state,
assets and deployment availability still matter.

**Evidence:** `src/dynamic-map.ts`, `src/telescope/baked-dzi-loader.ts`,
`src/telescope/baked-generation.ts`, `src/telescope/bake-entry.ts`,
`workers/daily-seed-updater/`, `workers/daily-seed-serve/`,
`tests/daily-seed-cache.test.ts`, `tests/native-bake-entry-runtime.test.ts`.

## 3. More detailed generated terrain and scene assembly

The branch adds a substantial terrain/scene pipeline rather than just placing
seed icons over a static image.

- Seed-specific biome layouts, backgrounds and placed pixel scenes.
- Main-world/parallel-world scene preparation and per-biome generation.
- Corrected scene layering, transparency, background masks and colour handling.
- Special handling for areas such as the Tower, Pyramid, Hiisi Base, eye room,
  meditation chamber, coral chest area and Friend cave.
- Fixes for duplicated scene placements and objects, misaligned backgrounds,
  black seams/bars and incorrect alpha handling.
- Final-pixel terrain infrastructure, multi-resolution tile pyramids, improved
  terrain edges and flatter liquid/powder surfaces where supported.
- Bottom-edge/elevator continuation and terrain-boundary refinements.
- Native CPU and explicit native GPU bake paths, worker-based preparation and
  renderer diagnostics for maintaining higher-detail daily output.

**Do not overstate this:** the public **live “render every pixel” toggle is not
present**. Final-pixel/bake infrastructure does not mean every custom seed uses
that rendering path interactively. Nor is the map a live simulation of a run's
explosions, flowing liquids, destroyed terrain or collected items.

**Evidence:** `README.md` → “Full-pixel terrain and daily baking”;
`src/telescope/terrain-*.ts`, `src/telescope/full-pixel-*.ts`,
`src/telescope/liquid-surfaces.ts`, `src/telescope/pixel-pyramid.ts`,
`tests/full-pixel-toggle.test.ts`, `tests/terrain-scenes.test.ts`.

## 4. Seed-specific objects throughout the world

Dynamic Map expands the old static-overlay model with generated object data.

### Findable categories

- Starting loadout information, wands and their carried spells.
- Loose/shop spells and spell-bearing containers.
- Treasure chests and special chests, with known contents and quantities.
- Potions, flasks, powder pouches and named materials.
- Health upgrades and full-health regeneration pickups.
- Holy Mountains and their associated objects.
- Perks and their displayed choices, subject to the run-order caveat below.
- Enemies, bosses, boss-related objects and known loot.
- Orbs and orb-related unlock information.
- Quest/landmark objects, including tablets, the Evil Eye, music machines/music
  stones, the Moon Radar, essence-related objects and other special-room items.
- Achievement pillars and relevant destinations.

### Data-quality improvements

- Nested container contents and wand decks contribute to the searchable
  inventory rather than disappearing inside their parent object.
- Repeated identical chest drops preserve their quantity.
- Canonical identities and parent/source links reduce duplicate objects and
  double counting.
- Scene-specific duplication fixes cover cases such as the meditation cube,
  special chests and boss sprites/rewards.
- Boss placement includes supported parallel-world cases and correction of
  older baked POI snapshots.
- Missing/wrong sprites and raw internal names received dedicated fixes and
  coverage checks, including animated/alive wands, robots and special containers.

**Perk caveat:** displayed perk sequences depend on assumptions about Holy
Mountain order and extra-perk choices. The UI points users to Noitool's advanced
workflow when an exact travel/pickup history matters. Do not announce perfect
perk prediction for arbitrary runs.

**Evidence:** `src/telescope/telescope-adapter.ts`,
`src/telescope/poi-inventory.ts`, `src/telescope/poi-containers.ts`,
`src/telescope/scene-pois.ts`, `src/telescope/boss-pois.ts`,
`src/telescope/perk-i18n.ts`, `tests/poi-inventory.test.ts`,
`tests/boss-pois.test.ts`, `tests/scene-pois.test.ts`.

## 5. Search becomes a seed exploration tool

Search existed in production; **searching the generated seed inventory** is the
major addition.

- Search real objects in the selected seed, across the loaded worlds.
- Dedicated category filters for wands, spells, items, chests, Holy Mountains,
  potions, health pickups, perks, bosses, enemies, orbs and achievement pillars.
- Search includes spells on wands and known contents of chests/containers.
- Proper names and game sprites make results more recognizable.
- Results include distance/world context and navigate to the corresponding POI.
- Language changes rebuild translated labels/index content rather than leaving
  stale names in the search results.
- Explicit indexing/loading states replace ambiguous empty results while data
  is still being prepared.
- Interaction-aware result updates reduce disruptive reordering while moving
  around the map.
- Search text and filters can be retained in shared links.
- Existing static-map search remains available with the appropriate static
  categories instead of displaying irrelevant dynamic filters.

**Evidence:** `src/search/unifiedsearch.ts`,
`src/search/unifiedsearchresults.ts`, `src/telescope/poi-display-name.ts`,
`tests/search-inventory.test.ts`, `tests/pillar-search.test.ts`.

## 6. More useful ordinary POI cards

Basic map interaction improves independently of the optional extended information
panels described in the Pro section.

- Click objects on the map or open their card from search.
- Recognizable wand/item/creature sprites and translated names.
- Wand characteristics and decks, including always-cast slots where recorded.
- Chest contents with multiplicities, flask/pouch material identity and parent
  container/source context.
- Relevant wiki/external links and per-object share actions.
- Card placement accounts for the report/drawing sidebar and viewport edges.
- Opening another target dismisses or supersedes stale cards/navigation work.
- Cards no longer accidentally open while a drawing tool owns map interaction.
- Improved mobile layering, popup dismissal and translated tooltips.

This section does **not** promise free access to every detailed creature, spell or
material reference panel: those access gates are separate.

**Evidence:** `src/telescope/telescope-osd-bridge.ts`,
`src/popover-util.ts`, `src/drawing/poi-interaction.ts`,
`tests/drawing-poi-interaction.test.ts`, `tests/poi-preview-name.test.ts`.

## 7. Unlock-aware exploration and achievement pillars

### Spell/content unlocks

- Accept unlock data supplied by the Noitamap in-game mod. The mod/link entry point itself is not being claimed as
  newly invented in this branch.
- Support all-unlocked, nothing-unlocked and mod-supplied unlock views.
- Swap eligible POI/card contents between prepared unlock variants.
- Keep unlock state in shareable URL data and refresh mod-supplied state when a
  new link arrives.
- Show relevant orb/spell unlock state instead of treating every save as equal.

Daily seeds use the all-unlocked view; the alternate-unlock workflow is not
advertised as an unrestricted daily-map setting.

### Achievement pillars

- Dedicated pillar data, icons/cards and a search category.
- Progress/locked-state display from supplied achievement flags.
- Explanations of requirements and links to relevant objects or locations.
- Pillar actions can jump to a place or invoke an appropriate map search.
- Better handling of orb-related and halo-related requirements and names.
- Achievement flags are separate from spell-unlock flags rather than treating
  the two as interchangeable.

These are supplied/save-derived states, not a claim that the browser watches a
live game continuously or can infer every achievement without input.

**Evidence:** `src/unlocks.ts`, `src/unlocks-toggle.ts`,
`src/pillars-unlocks.ts`, `src/data/pillars.ts`,
`tests/pillar-unlocks.test.ts`, `tests/pillar-places.test.ts`.

## 8. Spoiler controls and cursor information

- A spoiler-free mode hides supported wand/spell/item identities in the map,
  search and relevant cards; seed/recipe/report presentation also respects the
  applicable spoiler policy.
- Preferences persist rather than resetting on each visit.
- Cursor information includes chunk/world context and, when the live generator
  has material buffers, the material under the cursor.
- Material names use the game translation data.

**Restrictions:** baked daily views do not support the same spoiler/unlock
variants as live custom generation. The material-under-cursor probe requires
live material buffers and deliberately does not pretend those buffers exist on
a baked image-only view. Spoiler-free is not a guarantee that geography and every
landmark become non-spoiling.

**Evidence:** `src/spoiler-free.ts`, `src/material-hover.ts`,
`src/mouse_tracker.ts`, `src/unlocks-toggle.ts`,
`tests/baked-spoiler-policy.test.ts`.

## 9. Better links, sharing and free viewing of annotations

- Short, organized URL parameters for map/view/overlay state, with backward
  compatibility for older long parameter names.
- Dynamic seed and daily-seed state in links.
- Search queries, filters, selected POIs and seed-report open state in links.
- Stable POI links open the intended card/location; static POI links retain
  coordinate-based destinations.
- Per-card sharing and clearer copied/loading/failure feedback.
- Switching between dynamic and captured maps cleans up inappropriate state.
- **Viewing someone else's drawing is free:** supported Magic Screenshot/WebP
  and JSON import paths are exposed to non-subscribers as well.
- Import/drop/paste flows and error handling were substantially improved.
- Image vectorization is also exposed in the unauthenticated/non-subscriber
  sidebar: import supported artwork into the annotation viewer. Editing the
  resulting shapes is the separate subscriber capability. SVG has a direct
  parsing path; raster artwork uses the bundled vectorizer.
- Imported drawings can carry their map/seed context so the viewer opens the
  relevant map rather than silently attaching annotations to the wrong one.

Drawing creation/editing, subscriber save controls and export are covered in
the final Pro section. Imported/example drawings can still appear in the free
viewer; do not describe every form of local drawing storage as subscriber-only. Do not describe the remaining external image-hosting
mechanism as a new synchronized cloud-account library.

**Evidence:** `src/data_sources/url.ts`, `src/data_sources/param-mappings.ts`,
`src/main.ts`, `src/drop-overlay.ts`,
`task/noitamap-pro/src/drawing/sidebar.ts`,
`task/noitamap-pro/src/drawing/binary-encoder.ts`.

## 10. Public seed-summary access

There was no equivalent generated-seed reporting workflow in production `main`.

- The report button works for non-subscribers through a lightweight public
  report bundle.
- Public users can see a high-level “how this seed compares” summary for tracked
  categories, while detailed sections explain their Pro access requirements.
- Loading feedback, retry/failure behavior and sidebar state handling are
  explicit rather than appearing to do nothing during a bundle request.
- The public report path does not require loading the drawing renderer.

**Accuracy wording:** the public/Classic summary and the newer V2 census are not
identical implementations. Do not extend the V2 source-audit claim to every
statistical calculation in the older public/Classic view.

**Evidence:** `src/report-bundle.ts`, `src/seed-report-button.ts`,
`src/seed-report-loading.ts`,
`task/noitamap-pro/src/seed-report/public-sidebar.ts`,
`tests/public-report.test.ts`, `tests/report-bundle.test.ts`.

## 11. Animated portals

- Animated portal effects for supported dynamic-map portal placements.
- Vendored GPU-particle effects rather than a collection of pre-rendered
  animation atlas frames.
- A dedicated worker and one shared GPU context for the portal overlay.
- Camera reprojection keeps completed particle frames attached to the map while
  fresh worker frames are being produced.
- Effects remain tied to world scale, including while panning/zooming.
- Shared simulation timing and preserved offscreen state avoid restarting the
  animation sequence every time a portal re-enters view.
- Visible eye-room and meditation portals use the same default no-zoom-cutoff
  activation policy.
- An instant, persistent **Animated portals** switch in Performance settings.
- Bounded active-instance/memory budgets and smaller cropped frame transfers.
- Reviewed cosmetic particle collisions for the static eye-room setup.

**Status:** this backend is experimental, even though the switch is enabled by
default in the dynamic map. It needs supported worker/WebGL2 facilities; there
is no promised universal fallback or guaranteed frame rate. Eye-room collision
is not a general simulation of every terrain change or every portal.

**Evidence:** `src/portals/`, `src/portal-animations.ts`,
`docs/experimental-gpu-portals.md`, `docs/portal-collision-audit.md`.

## 12. Performance and loading improvements

### Controls players can use

- Main-world-only mode to avoid loading the adjacent parallel worlds.
- A creature-skipping option to reduce marker load.
- A simplified background option for a lower-detail/lower-overhead map view.
- Animated-portal enable/disable control.
- Small-screen defaults favor the lower-cost modes where the current view
  supports them.

These options are not identical on live-generated and pre-baked daily views.

### Engineering changes that support responsiveness

- Lazy loading and smaller feature-specific entry points.
- Separate public-report and Pro feature loading.
- Main-world-first work and background parallel-world generation.
- Reuse of an already open map tab for supported links from the in-game mod,
  instead of unnecessarily generating another copy in a new tab.
- Cached scene/material assets, prepared scene reuse and shared spritesheets.
- Spatial POI indexing and tiled marker rendering rather than making every
  object an independent DOM element.
- Multi-resolution terrain/tile infrastructure and progressive delivery.
- Non-blocking loading UI and replacement of loading shells in place.
- Cache-version/identity fixes, stale request cancellation and multiple-tab
  coordination.
- IndexedDB/cache-lock handling that lets generation proceed if cache access
  fails or stalls rather than treating disk cache as a prerequisite.
- Reduced duplicate work when the seed/unlock state has not changed.
- Updated OpenSeadragon and more explicit renderer/fallback/error behavior.

**Safe wording:** “A lot of work has gone into loading, caching and lower-cost
viewing options.” Do not publish an unmeasured speedup, RAM reduction or
“buttery smooth on every device” claim.

**Evidence:** `src/light-mode.ts`, `src/skip-creatures.ts`,
`src/simplistic-background.ts`, `src/tab-coordinator.ts`,
`src/pro-loader.ts`, `src/pro-module.ts`, `src/telescope/cache-storage.ts`,
`src/telescope/poi-spatial-index.ts`, `src/telescope/marker-tile-source.ts`,
`src/telescope/terrain-worker-pool.ts`, `src/telescope/worker-scenes.ts`.

## 13. Interface, accessibility and localization

- Reorganized toolbar/map menus with contextual controls and an overflow menu
  for narrower screens.
- Seed controls and daily/custom state integrated into the map UI.
- More consistent icon buttons, card layouts and sidebar loading feedback.
- Improved popup/sidebar layering and dismissal on mobile.
- Chunk-boundary overlay and refinements to biome overlays/hover presentation.
- Map labels, badges, patch-date information and compatible-overlay visibility.
- More consistent translated titles, tooltips, ARIA labels and live updates
  when changing language.
- Expanded content/label coverage across the **16 supported locales**. These
  languages already existed in `main`; the improvement is broader and more
  consistent translation coverage, not sixteen newly added language choices.
- Expanded use of canonical `common.csv` names for game content, with generated
  translation/catalogue checks instead of inventing in-game terminology.
- Added/expanded creature, material, biome, pillar and report translations.
- Brazilian Portuguese number formatting is mapped correctly rather than being
  interpreted as Breton by `Intl`.
- Browser/privacy-mode rendering problems have clearer failure/warning paths.
- Navigation, reports and drawing loads are cancellable; opening a different
  sidebar does not leave the previous load free to steal focus later.

**Navigation status:** the pointing-arrow navigation has received repeated
changes. The latest correction separates origin-anchored zoom-out,
constant-zoom travel along the arrow, and destination-anchored zoom-in. Its
mathematical/phase checks pass, but its final visual feel is still being manually
reviewed. Describe this as navigation work, not a proven performance headline.

**Evidence:** `index.html`, `src/overflow-menu.ts`, `src/i18n-dom.ts`,
`src/language-selector.ts`, `src/locales/`, `build_data/report-v2-*.json`,
`build_scripts/*translations.cjs`, `src/app_osd.ts`,
`tests/goto-animation.test.ts`, `tests/report-translations.test.ts`.

## 14. Captured maps, integrations and maintenance work

The release does not remove the existing captured atlas catalogue.

- Added the **UPS** map entry (`ups-main`) and its separately toggleable sideworld
  overlay (`qlc-sideworld`). The user-facing UPS name and QLC internal asset keys
  refer to this integration; they should not be advertised as two new game maps.
- All prior tile-source map keys remain present in the comparison.
- Sideworld controls appear only where supported and reflect actual load success.
- Static-map cards/links benefit from the shared UI and sharing improvements.
- The map can hand off relevant workflows to existing community tools, including
  Noita Telescope and wiki pages; additional specialized integrations are listed
  with their Pro features below.
- An experimental Discord component-style link card was added alongside the
  ordinary Open Graph fallback. It is navigation, not an embedded interactive
  map, and not a dynamically generated card for the exact seed in a query string.
- Build-time asset generation, compatibility boundaries between Telescope forks,
  automated regression coverage, and local development workflows expanded.

The Discord crawler hook and actual link previews need deployment/client
verification. Keep them out of the main announcement headline until checked.

**Evidence:** `src/data/tilesources.json`, `src/sideworld.ts`, `src/nav.ts`,
`docs/discord-card.md`, `build_scripts/`, `tests/`, `.gitmodules`.

## 15. Announcement guardrails and rollout checklist

### Do not announce these as generally available facts

- Live full-pixel rendering for every custom seed.
- A live reconstruction of terrain destruction or an active player's inventory.
- Exact perk outcomes independent of run order.
- Unlimited parallel worlds in the ordinary UI.
- Dynamic generation for every captured map, mod, NG+ or Nightmare mode.
- An automatic all-seeds or all-possible-values guarantee beyond the actual
  supported input/data population.
- Universal GPU support or measured frame-rate/loading-time improvements.
- The Discord experiment as a stable, seed-aware live embed.
- Every internal console/debug feature as a new supported UI feature.
- Removed experiments such as URL-embedded full drawings or a synchronized
  cloud library as features of the final implementation.

### Before posting

1. Choose the intended release/preview URL and verify it opens the correct branch.
2. Verify daily/previous-daily data and deployed bake assets are current.
3. Manually check the final navigation behavior and portal toggle on target devices.
4. Check the free/subscriber paths independently, including failed logins/loads.
5. Confirm any provider-dependent subscription requirements before naming them.
6. Confirm that the public host and Pro assets are deployed in the intended order.
7. Decide whether experimental features belong in the launch announcement or a
   separate “currently testing” paragraph.

### Comparison method

The complete public-tree difference was taken against the fetched production
branch tip, not only the common merge base. Commit history was used to find
features, then current code/UI/access checks were used to exclude features that
were removed, remain internal, or are restricted. The comparison includes map
data, rendering, interaction, localization, build/runtime plumbing and the
current companion feature gates.

To reproduce the source scope without changing the working branch:

```sh
git fetch origin main dynamic-map
git diff --name-status origin/main 83290744ecc32ce07dedee2629e914a8293be9ed
git log --oneline origin/main..83290744ecc32ce07dedee2629e914a8293be9ed
git -C task/noitamap-pro show --no-patch bbe58a2
```

The source comparison intentionally does not treat a passing unit test as a
visual browser test or as proof that a deployment has already propagated.

## 16. Pro-only additions and improvements

This section is deliberately separate from the public feature catalogue.
Feature access is determined by subscription/auth checks, not simply by which
repository a file lives in: extended information is host-side but gated; free
annotation import/viewing uses companion code but remains free.

### 16.1 Create and edit drawings on the map

- Move/select, freehand, line, arrow, rectangle, circle, ellipse, polygon, point
  and text tools.
- Filled rectangle/circle/ellipse/polygon tools and fill-opacity control.
- Stroke width, colour selection and custom colour picking.
- Text size/editing, more direct on-canvas/WYSIWYG-style editing and corrected
  selection behavior while editing text.
- Undo/redo; delete; copy/cut/paste; keyboard shortcuts.
- Layer ordering: bring forward/backward and move to front/back.
- Show/hide drawings and switch between map, black and white backgrounds.
- Named saved drawings, reload/delete/new-drawing workflows and examples.
- Map/seed context retained with drawings, with map switching on load when needed.
- Rendering work to preserve filled shapes, improve selection and avoid
  continuous redraw when an idle drawing has not changed.
- Map-object clicks are suppressed while the drawing tool owns the interaction.

**Evidence:** `task/noitamap-pro/src/drawing/sidebar.ts`,
`drawing/doodle-integration.ts`, `drawing/fill-state.ts`,
`drawing/selection-state.ts`, `drawing/retained-renderer.ts`,
`drawing/hotkeys.ts`, `tests/drawing-fill.test.ts`,
`tests/drawing-selection.test.ts` (paths after the first are within Pro).

### 16.2 Export/share drawings and edit imported artwork

- Map-cropped screenshot/image download, including correct filled-shape output.
- “Magic Screenshot” WebP files carrying drawing data that can be re-imported.
- JSON export/import for editable drawing data.
- Sharing/upload flows with progress, fallback/error handling and clearer names.
- Edit and reuse shapes brought in through the free import/vectorization
  workflow, then use the subscriber export/share controls.
- Better binary encoding/decoding, larger-coordinate handling and restored shape
  fidelity on import.

**Boundaries:** public users can view/import shared drawings and invoke
vectorization without a subscription. Editing/creating/exporting are the Pro
workflow. Vectorization
works best for pixel art/flat-colour artwork; it is not guaranteed for arbitrary
photos. Saved local drawings are not a promise of account-synchronized cloud
storage, and external upload availability is not controlled by the map alone.

**Evidence:** `task/noitamap-pro/src/drawing/screenshot.ts`,
`drawing/binary-encoder.ts`, `drawing/storage.ts`, `drawing/cloud-storage.ts`,
`drawing/vectorize.ts`, `drawing/sidebar.ts`.

### 16.3 Extended game-information panels

- Expanded information for supported **spells, creatures and materials**,
  beyond the ordinary map marker/card data. Material panels can be reached from
  relevant item/container cards; that does not make all item/perk information a
  separate paid reference feature.
- Spell properties, damage-related details and supported spawn/tier information.
- Creature health/combat information, damage multipliers/resistances and
  supported immunity data.
- Material properties and hazard/type information.
- Stain and ingestion effects for materials where recorded.
- Material reaction information and links to Bartender filtered by reagent or
  product.
- Localized labels and lazy data loading rather than eagerly fetching every
  reference dataset on ordinary map startup.

Do not promise a complete simulation or an entry for every game object: these
panels display the supported indexed reference data.

**Evidence:** `src/extended-info/index.ts` (`isProUser()` gate),
`public/assets/full_creatures.json`, `public/assets/full_spells.json`,
`public/assets/full_materials.json`, `build_scripts/generate-material-effects.cjs`,
`build_scripts/generate-reaction-roles.cjs`.

### 16.4 High-value map/search filter

- A subscriber high-value toggle highlights the supported rare/useful objects
  with a distinctive ring and narrows the search results to the same predicate.
- Shared classification between map markers and search avoids two different
  definitions of “high value”.
- Covers the configured rare/useful spell, orb and landmark-item categories.
- Clear locked/loading behavior for users who cannot yet use the filter.

**Evidence:** `src/search/unifiedsearch.ts`,
`task/noitamap-pro/src/high-value/install.ts`,
`task/noitamap-pro/src/high-value/predicates.ts`.

### 16.5 Seed-specific alchemy recipes and ingredient navigation

- Calculate **Alchemic Precursor** and **Lively Concoction** ingredients for the
  selected seed using the integrated recipe implementation.
- Show recipes in the search workflow, with localized material names/icons.
- Locate known nearby ingredient sources and jump to their map positions.
- Explain when the loaded map data has not found an ingredient; provide the
  relevant external Telescope handoff instead of inventing a location.
- Refresh recipe rows when indexing completes or the selected seed changes.
- Respect spoiler redaction where that mode applies.

**Evidence:** `task/noitamap-pro/src/alchemy/recipe.ts`,
`task/noitamap-pro/src/alchemy/alchemy-ui.ts`,
`src/search/unifiedsearch.ts` (subscriber gate).

### 16.6 Detailed seed reports — current default/Classic

The full subscriber report adds detail beyond the free high-level summary:

- Per-world overview/comparison visualizations.
- Counts by biome and world with expandable object/location drilldowns.
- High-value spell categories and individual spell occurrences.
- Wand cards/decks and direct navigation to matching objects.
- Comparison against the relevant daily/previous-daily target.
- Loading states, cancellation, language refresh and spoiler-aware presentation.

**Evidence:** `task/noitamap-pro/src/seed-report/sidebar.ts`,
`seed-report/diff.ts`, `seed-report/aggregate.ts`, `seed-report/install.ts`.

### 16.7 Redesigned seed report V2 — opt-in preview, not the default

**Release status matters:** ordinary report URLs still select Classic. V2 is
selected by the explicit internal preview route (`reportPreview=v2`). Do not
announce that the redesign replaced the default report unless that routing is
changed for release.

The V2 implementation adds/improves:

- A compact “Seed report for …” heading, clearer world labels and a wider panel.
- Neutral, consistent controls rather than unrelated accent colours.
- An overview oriented toward useful spells, materials and wand opportunities.
- Clickable spell/resource entries and direct navigation for highlighted wands.
- Readable map-inventory cards, “none found” states and world breakdowns instead
  of a wall of numeric tables.
- Detailed Sage statistics behind disclosures, with a correctly seeded
  **Open in Sage** link.
- Separate map inventory and Sage natural-spawn census sources rather than
  treating them as interchangeable.
- Daily comparisons that reject self-comparisons and stale/mismatched responses.
- Authoritative static min/max/mean/median references for all **96 valid** bundled
  Sage summaries; 480 scalar values including standard deviation matched the
  source in the audit.
- The 60 non-axis category references remain accessible even if that seed's
  archive fetch fails.
- Full report UI/catalogue translation coverage across the supported locales.

**Statistical boundaries:** Sage's audited population is seeds
1–2,147,483,647. Eight legacy axis summaries are excluded as invalid. The 60
non-axis summaries are three-world totals, not per-world references. Individual
resources/wand-quality features do not gain invented population summaries. The
high-slot-wand threshold remains unspecified by its source. Missing shuffle data
means unknown, not “shuffle enabled”.

**Evidence:** `task/noitamap-pro/src/seed-report/v2/`,
`seed-report/preview-controller.ts`, `seed-report/v2/POPULATION-AUDIT.md`,
`build_scripts/audit-sage-population.mjs` (paths within Pro).

### 16.8 Pro delivery, authentication and reliability

- Account/subscription-aware feature access and clearer signed-in/subscriber
  status, locked-state explanations and upgrade/login actions.
- Patreon authentication and an additional Twitch authentication path in the
  branch; provider switching asks for confirmation rather than silently
  overwriting an active login.
- Feature-specific lazy loading: opening a report does not instantiate the
  drawing GPU renderer or load image-vectorization machinery.
- Explicit loading/failure feedback, retry paths and cancellation for sidebars.
- Retained content-addressed chunks and compatibility handling for older open
  tabs during deployment.
- Local companion-bundle development and deployment-verification tooling.

Authentication availability/subscription eligibility depend on worker/provider
configuration. Do not promise a particular Twitch tier/channel entitlement
without confirming the release configuration. Debug particle/player commands
are not a supported Pro feature announcement.

**Evidence:** `src/auth/`, `src/pro-loader.ts`, `src/pro-module.ts`,
`src/pro-sidebar-intent.ts`, `task/noitamap-pro/src/pro-entry.ts`,
`task/noitamap-pro/src/feature-loader.ts`,
`task/noitamap-pro/build_scripts/verify-deployment.mjs`.
