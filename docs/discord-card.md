# Experimental Discord link card

The initial HTML now carries the same `discord:component-embed` mechanism as the
user's particle-page experiment, with strict JSON (no trailing commas), a world
overview image, a spoiler warning, and three public navigation buttons:
Daily seed map, World atlas, New Game+ atlas. Existing Open Graph remains intact.
This is navigation, not an embedded playable map or live seed-search UI.

Discord's published Component Reference documents container/text/media-gallery/
action-row/link-button shapes; it does not establish a stable public contract
for this HTML crawler hook. Treat the hook as experimental. No Discord/browser
preview test has been performed; the user will check actual unfurling.

A useful future per-seed card could include seed number, main/PW scope, a map
location thumbnail, and links preserving coordinates and opening the report.
That requires an edge/server-rendered share endpoint. This static Vite document
cannot reflect query-specific seed data in its initial HTML; changing a script
in client JavaScript is not a reliable crawler implementation. Do not display
stale daily numbers, promise private drawing access, or embed private Pro data.

Non-browser checks validate strict JSON, public map routes, style-5 URL buttons,
Open Graph fallback, and absence of a hard-coded daily seed.
