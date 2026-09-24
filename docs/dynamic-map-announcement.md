# Introducing Dynamic Map for NoitaMap

NoitaMap is growing beyond captured atlases: **you can now explore a generated
map for a specific seed**, find its loot and plan where to go next.

The existing captured maps are still available. Dynamic Map adds a new way to
use the site alongside them.

## Explore your seed

Enter a supported seed, open today's daily, or revisit the previous daily.
Explore the main world and its adjacent west/east parallel worlds, with a
main-world-only option when you want a lighter view.

Daily maps have a dedicated pre-generated loading path, while custom seeds are
generated on demand. The terrain and scene pipeline has also received a lot of
work: better backgrounds, special rooms, scene placement, transparency and
terrain edges.

## Find the things that matter

Search the generated map for wands, spells, chests, potions, health pickups,
perks, Holy Mountains, enemies, bosses, orbs and achievement pillars.

Search includes spells on wands and known container contents. Cards show useful
context such as wand decks, materials and repeated chest drops, and you can jump
from a result to its location or share a link to that particular object.

Starting loadouts, quest objects and special-room items are also part of the
expanded map data.

## Bring your progress with you

Supported links from the Noitamap in-game mod can carry your unlock information.
For custom seeds, you can compare supported all-unlocked, nothing-unlocked and
save-derived views instead of assuming every player has the same unlocks.

Achievement pillars now have their own cards, requirements, progress information
and search/navigation actions. A spoiler-free option is available for supported
custom-seed views.

## More useful links and a more practical interface

Shared links can retain the seed, map view, overlays, search filters and selected
object. The toolbar and popup/sidebar behavior have been reworked for smaller
screens, and translation coverage has expanded across the site's 16 supported
languages, using the game's own names where available.

There is also a free high-level seed summary, plus the new UPS captured map and
its sideworld overlay.

## More ways to control the workload

Dynamic Map adds main-world-only, creature-skipping and simplified-background
options, alongside extensive work on caching, lazy loading and background
workers. Available options differ between generated and pre-baked views.

Supported portals now have GPU-particle animations, with an instant on/off
switch in Performance settings. This renderer is experimental, so the switch is
there if it does not suit your device.

## Shared drawings are still free to view

You do not need Pro to open supported shared drawings or import a Magic
Screenshot. Image import/vectorization is also available in the free viewer;
editing and exporting annotations are part of Pro.

## A few important boundaries

This is a seed map, not a live simulation of everything happening in your run.
Some results—especially perk sequences—depend on run-order assumptions, and
custom-generation settings do not all apply to baked daily maps.

The current input supports seeds 1–2,147,483,647. The final-pixel work in the
baking pipeline is not a promise of a live full-pixel mode for every custom seed.

## Noitamap Pro

Alongside the public map improvements, Pro adds a separate set of planning and
reference tools:

- **Create and edit map annotations:** freehand drawings, arrows, lines, shapes,
  filled shapes and text, with colour/stroke controls, layer ordering,
  undo/redo and keyboard shortcuts.
- **Save and share your work:** named drawings, editable JSON exports and Magic
  Screenshots that can carry the drawing data. Recipients can view supported
  shared drawings without subscribing.
- **Extended game information:** detailed spell, creature and material panels,
  including supported damage/resistance information, material effects and
  reaction-tool links.
- **High-value filtering:** highlight the configured useful/rare objects on the
  map and narrow search to the same set.
- **Alchemy help:** Alchemic Precursor and Lively Concoction recipes for the seed,
  with navigation to ingredient sources found in the map data.
- **Detailed seed reports:** world/biome counts, spell occurrences, wand details,
  location drilldowns and daily-seed comparisons.

The redesigned **Seed Report is now the default**. Finds puts high-value
spells, featured wands and Rare finds first. Expanded lists keep their markers
visible; hover highlights without moving the map, and Go to location navigates
explicitly. Locations show both display and internal biome names.

A separate Statistics tab shows Sage's existing population references and
daily comparisons. Ranked seed links open Sage. Missing data is explained,
not replaced with estimates. The old report versions and preview switcher
have been removed.

The free preview now shows compact text comparisons using the same Sage V4
counts and averages as Statistics. It reuses baked/cached records, explains
missing data and hides controls that require Pro access.
