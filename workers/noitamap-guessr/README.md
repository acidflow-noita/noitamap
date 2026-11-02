# NoitaGuessr alpha

Alpha release source. The secondary Cloudflare database and image projects
and API are deployed. The owner confirmed adding both GitLab CI credentials on
2026-10-31. The ten-round migration is applied and the private API checkout is
synchronized; release commits/deployments and the first Daily publication remain.
See [deployment instructions and current resources](DEPLOYMENT.md).

## Current state

The lobby has three illustrated mode cards, a resumable-game strip and actual
recent/best results. The map navbar entry uses the same Bootstrap popover as
the other Pro controls. The reviewed area inventory is unchanged.

Chat vs Streamer has ten rounds using the demo's HUD, clue controls and
guess board. Guesses travel through the shared `noitaguessr` Twitch channel.
The host receives them using their own linked Twitch identity and explicit
`user:read:chat` permission. EventSub runs directly between their browser and
Twitch; each viewer's latest valid `!noitaguessr_guess ✦…✦` before submission wins.
The setup switch "Share game links as announcements" is off by default and
remembered locally, including across OAuth returns and game refreshes. Sharing
posts a normal message in the host's own channel when off, or an announcement
when on. Setup offers optional Twitch posting consent before play; hosts who
skip consent retain a copy-link button and are never redirected mid-round.
Normal messages use `user:write:chat`; announcements additionally require
`moderator:manage:announcements`. This direct browser request
does not invoke the game or auth Worker. A confirmed post disables the button
for two seconds. Failed or uncertain requests are never retried automatically.
Game admission requires Pro; its badge describes admission for this game rather
than the expiry of the short-lived game ticket. Active games do not solicit gifts.
The receiver checks the embedded sender against Twitch's actual sender and
rejects copied packets, recent repeated nonces, other round IDs and closed rounds.
This prevents direct copy/paste; the encoding does not attest client point costs.
Assistance costs are captured when the guess arrives, with no speed bonus.
Equal totals share a rank. The free map picker sends through the viewer's Twitch
account without a Noitamap account. All participants, including the streamer, appear in the final
searchable/sortable table and downloadable HTML/JSON results.

With ordinary `npm run dev`, the host can connect the same remembered Twitch
identity used by the chatter page. Start a new game to listen to the shared
transport channel. The localhost host score uses a separate synthetic identity, so the
owner can test as a chatter in another tab too. Production still uses the
verified Pro/Twitch host identity and excludes a second host entry. The explicit
Offline testing option retains the simulator; it never receives real Twitch chat.

Production solo sessions use encrypted continuation tokens instead of D1
session rows. Live stream state uses one SQLite Durable Object per channel;
only optional final publication writes an immutable D1 result row. Results are host-reported casual
scores: the server verifies the host, bounded score components, participants,
round counts and totals, but does not attest messages observed in the browser.
Prepared Daily rounds use the same area/proximity scoring and exploration
allowance as the other modes. Public result reads still
consume Worker/D1 allowances; a downloaded result works without that service.
Publication is bounded to 1,500 participants, 1.5 MiB per document, 200 stored
games, 100 publications/day and 20/host/day. Larger games remain fully available
locally and in downloads. Local benchmarks do not guarantee the Workers Free
CPU allowance on the deployed service.

Shared account linking now supports Patreon and Twitch on one account. Pro is
the union of active paid Patreon membership, a Twitch subscription to wuote,
and the existing verified grants for wuote/dunkorslam. The same account controls
are used by the main map and Guessr. The auth Worker has its
`ACCOUNT_DB` binding and migration in the primary account; see
[`../noitamap-auth/README.md`](../noitamap-auth/README.md). Guessr resource and
deployment status is tracked separately in [DEPLOYMENT.md](DEPLOYMENT.md).

The interface uses Noitamap's shared dark-blue theme. Guessr explicitly loads
the same Inter stylesheet as the main map and inherits the dynamic seed field's
tabular/slashed-zero and alternate-digit features. The game uses the available
viewport width instead of the old 1,360px cap. The clue and guess panels have
matching heights, larger internal spacing and a distinct blue primary action;
the same round components style both demo and the older Daily fixture.
Guessr now uses Bootstrap **6.0.0-alpha.1**, bundled through Vite. How to play
uses Bootstrap's `Dialog` plugin with a native `<dialog class="dialog
dialog-scrollable">`, standard header/body/footer and `data-bs-dismiss="dialog"`.
Centering, backdrop and focus trapping come from Bootstrap/native dialog behavior.
The Daily Pro gate directly mounts the shared `createProControls` factory from
`src/auth/pro-controls.ts`; Noitamap's `AuthUI` delegates to the same factory.
Provider logos, translations, subscription links and visibility rules are shared
with `auth-providers.css`. Guessr's generic button styles exclude these branded controls. Progress
is saved before the shared auth service starts login; the old custom Daily login
buttons and standalone membership link are removed.

The migration follows `bootstrap-v5-v6-migration` and `bootstrap-vite`, using
the documentation at https://getbootstrap.com/llms.txt and
https://getbootstrap.com/llms-full.txt. Both Guessr and the main map now use the
same pinned Bootstrap 6 npm package, bundled by Vite, with its own declarations.
Guessr imports only the components it uses. There is no Bootstrap 5 CDN fallback.

Vite processes Bootstrap's precompiled CSS, retaining its `--bs-` token prefix;
this existing CSS-based project does not need a new Sass compilation pipeline.
Shared `design-tokens.css` contains the Noitamap palette, mapped to Bootstrap 6
color tokens. Shared auth components and provider styles are used across both
applications. The 1rem provider spacing uses v6's `mt-5`.
Promotional copy, custom challenge links, free endless-mode selectors, and game
timers have been removed. The active demo now selects three area-first random
starts through the local round service. It uses the complete reusable opaque
image set; gameplay never creates or reslices image assets. Answers and the
coordinate-to-image lookup remain private until submission. Round reveals show
the location, distance and labels such as "Normal difficulty" inside the guess
map's existing header, with a compact badge showing points earned that round.
The earned score also appears when reviewing a completed round. There is no
separate reveal card. The map automatically
frames the guess and answer with padding; near/perfect guesses retain terrain
context, and the larger answer marker stays visible behind an overlapping guess.
Running totals and live score budgets are hidden; the game total and detailed
area/proximity breakdown appear on the final results screen. This is a
presentation change; the agreed score budgets and assistance rules still apply.
Daily shows each result immediately, accepts late guesses,
and lets an unfinished game continue after its daily date changes.
Daily and demo share the round HUD and map-header reveal. Daily's Next round /
View results button is in the bottom action row, matching the demo. The global
Enter shortcut and its badge have been removed. Prepared Daily rounds use the
same clue camera, zoom/travel controls and saved exploration allowance as Demo.
The older single-image fixture remains available only for compatibility tests.

The demo displays a native 27×12 window assembled from existing lossless image
pieces from the supplied capture. Seven
zoom levels progressively lower the maximum score: 5000, 4600, 4100, 3500, 2800,
2000 and 1000. Successive new zoom-outs cost 400, 500, 600, 700, 800 and 1000
points; each newly visited travel position costs 100 points. Returning to
a position is free, zooming in never refunds points, and the original starting
point remains the answer. Failed image loads do not charge points. These values
are draft tuning choices. Progress and penalties survive refresh.

Clue zoom/travel is button-only: wheel/trackpad scrolling over the clue scrolls
the page and cannot spend points. Hover tooltips show each button's current
cost, computed from the same transition as a click; zero-cost actions read
"Free action". Zooming back into previously revealed levels, returning to the
start and revisiting a position reflect their actual free cost. Cost labels are
limited to clue exploration controls; ordinary actions and guess-map controls
have no cost labels. Skip explains that the round will score zero. Disabled
exploration controls explain their limit instead of showing "Free action".
No API call or points charge occurs on hover.

Movement is 90% of the current visible width/height, rounded to native pixels,
leaving about 10% overlap. The widest starting image defines the fixed exploration
boundary. All four arrows are disabled when fully zoomed out. Zooming out near an
edge shifts the camera back inside that boundary without an extra travel charge;
the ordinary zoom score cap still applies. A short slide keeps terrain traceable,
and reduced-motion preferences skip the animation.

Zoom/reset buttons use Bootstrap Icons, beside an inverted-T arrow pad. Buttons
have accessible names and tooltips but no visible text. The seven SVGs are the
same Bootstrap Icons v1.13.1 used by Noitamap, bundled with their MIT license so
the offline gallery needs no icon-font/CDN request.

The gallery's wider context image and view outline are developer-preview tools
only; they are not included in the game UI. Gallery and game share the camera
and native-pixel compositor. The old 256-pixel value describes prepared source
image spacing only; it is not a movement distance.

The reference viewer loads lossless native tiles, including heaven and hell,
and uses nearest-neighbour enlargement. It no longer enlarges a single overview.
The source PNG remains untouched and is never delivered to the browser.

The October 16 correction changes the current priority: replace the fixed
point sample with an area catalog covering every biome and substantial pixel
scene/landmark in the captured main world, including heaven and hell. Each
puzzle should select an area, then a seeded random valid starting point inside
it. The tree must not always use one hardcoded coordinate. The existing 30
points are test fixtures, not the intended production puzzle catalog.

A comprehensive source inventory is now available offline at
`task/guessr/area-inventory/index.html`, with `areas.csv`, `inventory.json`,
`summary.txt`, and the separate `scene-audit.json`/`.txt`. It accounts for all
129 boundary records, their222 main-plane connected components,28 projected
vertical components, the explicit elevator continuation,76 marker records and
45 fixed/spliced scene recipes. These are audit records, not373 unique approved
questions: aliases, construction fragments, point-only markers and unverified
scene placements are clearly distinguished. The scene audit also covers all
59 biome-scene mappings and334 configured family-scene names.

The source masks cover every one of the70x48 biome-map cells exactly, with no
overlap or gaps, and match the source PNG. Holes are retained. Game labels are
looked up in the supplied `common.csv`; unnamed entries retain internal IDs.
The offline viewer now defaults to curated puzzle-area groups over the actual
capture, with separate views for unassigned sources and the complete audit.
`build_scripts/guessr/area-curation.json` records the grouping decisions;
`puzzle-areas.csv` exports them. Outlines show the union boundary and holes,
without internal chunk-row borders suggesting extra puzzle areas. The grouping
layer does not pretend that source masks are final valid-start masks.

The latest review supersedes the mechanical component-based proposals:

- EDR is one recognition area, including the tiny rock patch above the Ancient
  Laboratory. It is easy to identify and uses Normal scoring
  (1,000 area + 4,000 proximity). Tower
  context may help locate a point; it does not create another EDR patch area.
- All Pyramid construction IDs form one Pyramid.
- Surface winter components form one Snowy Wasteland. The six winter-material
  patches underground join the Snowy Chasm. Blank elevated strips near the
  Cloudscape/Gourd room are not separate Lake/Winter questions.
  Snowy Wasteland starting views with snow pixels use Normal; those without
  snow pixels use Hard. Classify the original starting clue and keep that tier
  fixed during travel/zoom. Unknown classification requires review; do not
  infer snow from the source biome label or general color variation.
- Both the bridge and the populated cavern directly below it are included
  with Frozen Vault. There is no standalone bridge puzzle or blanket `empty`
  exclusion.
- The Ancient Laboratory and the separate Ylialkemisti boss room remain
  distinct. Labels come from the original game CSV, with editorial qualifiers.
- Jungle terrain variants, The Tower's floors and each Holy Mountain's construction
  pieces are grouped by place. Holy Mountains at different depths stay distinct.
  The Tower uses the user's requested English display name, overriding the
  original CSV's "Tower". The lowest Holy Mountain beside Kolmi is recorded
  separately inside the Laboratory scene; its precise room footprint remains
  pending, rather than incorrectly applying its exception to the sixth HM.

`hills2` (the user's `hills_2`) and `sky_light_injector` remain excluded as
independent questions. The complete native hills2 mask was inspected:
3,145,728 pixels, 99.61% black, with no meaningful independent puzzle location.
Low color variation or `hasStuff:false` alone is never grounds for exclusion.
Candidate masks whose overview is over90% black are flagged for content/mask
review rather than silently sampled or automatically deleted: a small real
bridge/altar can exist inside a mostly empty coarse allocation.

To reproduce the boundary catalog and validation (no browser/server):
`python3 build_scripts/guessr/build-area-inventory.py`, then
`node build_scripts/guessr/validate-area-inventory.mjs`, then rerun the Python
builder to embed the content-audit statistics. `--common` selects the original
game translation CSV if it is not in the sibling noita-sources checkout.
The source scene audit remains a separate recorded input with explicit source
references. Capture-aligned scene placements/final eligible masks are still
required before enabling these candidates in gameplay.

The local demo uses 42 curated source-union masks and applies area-aware
scoring. These are logical chunk masks for manual review, not final traced
pixel footprints. Snowy Wasteland is excluded until snow classification exists,
and the lowest Holy Mountain is excluded until its room footprint is traced.
Unassigned source records are not silently enabled. Every new start must contain
at least one nonblack, nontransparent native pixel in its initial **27×12** view.
The image export records compact private content rectangles once; the round
service intersects their visible-view footprints with the area mask, preserves
holes and samples uniformly from the eligible integer positions. Image overlaps
and tile seams do not duplicate sampling weight. Entirely blank areas cannot
supply a puzzle. No decoding, recutting or new image assets happen during play.
Old saved games repair only unanswered black starts; submitted results remain
unchanged. The changed round ID resets its old camera and assistance allowance.
The mode cards and map panels share the same 16px layout gutter.
Further capture suitability and selection weights still need review. Valid
sampled points persist when resuming; a shared
daily must give everyone the same points. Slice the ENTIRE supplied captured
map once into reusable images covering the whole map, with opaque filenames.
Gameplay chooses an area and valid starting position, then selects the already
prepared images needed for that view. Movement and zoom reuse those images;
the browser displays the relevant window without generating new image assets.
Do not preselect a bounded pool of question positions or recut images per round,
session, movement or zoom. This supersedes the proposed offline question-pool
approach. Daily maps are the exception: prepare their reusable image sets every
day from the new bake, in the baker CI job or a companion job.
How to divide difficult areas between ordinary play and special modes, and
the final control/assistance rules, are being discussed. `area-rules.ts` tests
membership with source runs and holes, samples integer pixel positions, and
calculates the two score components. `image-game-server.ts` selects existing
images and keeps active answers private; it does not decode or encode images.

The approved difficulty tiers are **Easy, Normal and Hard**. Their base-score
budgets for real-player testing supersede the earlier 50/50 proposal:

| Tier | Area recognition | Position |
| --- | ---: | ---: |
| Easy | 500 | 4,500 |
| Normal | 1,000 | 4,000 |
| Hard | 3,000 | 2,000 |

All temples use Easy (the four sky temples, Magical Temple instances and
Temple of the Art). Ordinary Holy Mountains have an explicit Normal-tier
override of **1,500 area + 3,500 position**; this is not a fourth tier.
The lowest Holy Mountain next to Kolmi uses Easy, **500 + 4,500**. EDR uses
Normal. Snowy Wasteland switches between Normal and Hard based on the original
clue's snow pixels, as described above. The catalog records the conditional
rule; snow classification still needs the captured-content sampling work.

Every round still has a 5,000-point maximum. The new demo gives the area budget
only for membership in the selected area; proximity uses the existing 64-pixel
perfect tolerance and exponential distance curve for initial player testing.
The zoom/travel allowance scales both components. The distance curve is still
subject to tuning. The old Daily fixture retains its old scoring until migrated.

Approved area-identity rule (implemented for the local demo's reviewed unions): each distinct
recognizable place is a recognition area, even when places share a biome name,
color or engine ID. Disconnected source masks within one place are grouped;
connectivity alone is not a rule for creating or splitting puzzles. EDR is the
explicit broad recognition-area exception. Recognizing the type but selecting
a different named physical instance earns no area points;
the position component is calculated separately. Use explicit puzzle-area
geometry, not equality of biome colors. The
current boundary overlay traces chunk-grid shapes scaled by512; it is useful
input, not independently pixel-accurate geometry. Preserve disconnected
polygons and holes; the existing biomePathBounds bounding-box helper is not
a membership test. Validate geometry against the captured image and add
actual large-scene footprints and missing vertical-region geometry.

Apply that rule consistently, not only to the elevator:
- Fungal Caverns: the main caverns and the square enclave inside the jungle
  are separate puzzle/recognition areas.
- Meat Realm: the main section containing the boss's meat room and the
  secondary section are separate puzzle/recognition areas. The user's boss
  reference specifically means the one inside the meat room. Do not merge
  the disconnected sections for area credit. Source polygon holes and the
  separate meatroom engine entry must be handled deliberately; a distinct
  source color alone must not split one physical region. Named large-room
  puzzle footprints remain explicit rather than inferred from color.
- Infinite Hiidet elevator: a distinct puzzle/recognition area despite the
  engine's robobase label. Include its512-pixel-wide continuation through the
  captured Hell extent, not just the bottom-row stub in the main biome map.
  The main Power Plant must not count as the same recognition area.
- Keep main-world, Heaven and Hell instances explicit. A scene puzzle declares
  its recognition area; overlapping parent-biome geometry does not silently
  determine its scoring policy.

Do not use revealed pixel area as a proxy for information gained. A distinctive
biome-boundary junction or pixel-scene edge can identify a view precisely;
accounting for the camera displacement then locates the original starting
point. A much larger uniform view may add almost nothing. Recognizing these
features is part of the player's skill. The proposed revealed-area multiplier
is withdrawn. If zoom/travel penalties remain, describe them as explicit
assistance costs rather than a measurement of information. The prototype's
existing penalties have not been changed by this design decision.

The GitLab baker now has a separate non-blocking `guessr-daily` job. It consumes
the completed bake, prepares a reusable image set and publishes five shared
rounds atomically. Images load directly from Pages; preparation and gameplay
are covered by real-image/API tests. Live CI credentials and the first real
Daily activation still require the rollout steps in [DEPLOYMENT.md](DEPLOYMENT.md).

Clue delivery must not reveal the answer through the Network tab. Publish the
complete reusable image set under opaque IDs (random IDs or suitable hashes),
with no position encoded in their names. Clue requests,
paths, embedded metadata and public manifests must not contain world/tile
coordinates, the target area name/ID, or a public lookup back to the source map.
Movement and zoom use coordinates relative to that clue's private origin.
The clue viewer must never request the reference map's `level/x_y` tiles for
its selected location. Reference-map tiles used by the player's guess board
are a separate use and must not be requested based on the hidden target.

The private preparation output retains the area geometry and the mapping from
world positions to image IDs. Gameplay selects from this existing catalog;
selecting a new starting position must never trigger image preparation.
Keep the coordinate lookup out of public clue metadata. Merely renaming images
while publishing `places[].x/y` or a full coordinate-to-filename index is
insufficient: the current local `pack.json` does expose those answers and is
not a production question manifest. For answers to remain private until a
guess, submit the guess for scoring/reveal in one lightweight round request;
the image requests themselves stay static and cacheable. Do not reintroduce
an API or database counter per image, move or zoom.

## Run locally

The whole-map opaque export and private index are prepared in this workspace.
From `/home/w/Documents/git/noitamap`, run:

```sh
npm run dev
```

Open `http://localhost:5173/guess/` and Start demo. Play again samples new
positions; reload resumes the same active point and camera. The round result
shows area/proximity points. This uses a local API for starting/resuming and
submitting rounds; zoom and movement load static images with opaque names.
The local service is part of the Vite plugin, so no Worker/D1 setup is required
for the new demo. It blocks direct HTTP access to `task/guessr/private/`.

Start a stream at `http://localhost:5173/guess/stream/`, then use **Copy game
link** once. Connect Twitch, start a new game, then open its copied link in a second tab
(for wuote: `http://localhost:5173/guess/stream/wuote/`):
the first clue arrives automatically, and closing/advancing rounds updates it
without sharing another URL. Start a new game after upgrading from the old
snapshot-link build; old active sessions have no registered live room.
Sign in with Twitch from the page header, place a pin, and press Send guess
inside the map panel. Consent alone sends nothing;
each send is an explicit action using the viewer's own Twitch account. This
does not require Noitamap login or Pro. The local host receives real chat after connecting Twitch; choosing Offline
testing instead uses simulated messages. Existing simulated games keep their
original mode and cannot recover previously unrecorded chat messages.

The production link is `/guess/stream/wuote/`, with no clue payload or fragment.
One read-only WebSocket receives the current clue and round status, including
when joining late, and stays connected across games. Future clues/answers and host tokens are never broadcast. On round closure,
the answer and scored host roster arrive through this same connection. Each
chatter sees their recorded pin, actual location, distance and earned points.
Completed standings are pushed automatically, including to late joiners, with
a shareable results page; HTML/JSON downloads remain optional. The images remain the existing static Pages
assets. Chatters use the demo's zoom/travel/return controls; these do not call
the game Worker. The round, coordinates, allowance and round UUID are encoded together as a
compact runic payload; scoring also retains the existing shared
host ceiling. Zooming back in or returning to visited locations never refunds
spent points. The viewer's current camera, pin, costs and confirmed submission
are saved locally across reloads.
Every viewer starts at the same puzzle origin and explores independently.
The round is centered in the header. The map keeps mouse/trackpad navigation
without separate zoom buttons. Legacy snapshot URLs still display their image, but live sessions accept only
the encoded payload with the current round ID. The runic encoding and copy-error
checksum are intentional obfuscation, not encryption or authentication.
Assistance remains client-reported, as agreed for this casual game.

Before returning an answer, the service persists the room's closed state. The
host also closes locally before making that request. Old/closed/future round
guesses and a previous game's matching round number cannot alter scores; live
commands must carry the current server-issued round UUID. This is a casual game:
the host's locally collected standings and client-reported assistance are not a
server-attested anti-cheat system.

### Live-room request budget

Viewers do not poll, send application heartbeats, or send guesses to the Worker.
The host makes one pulse request per minute, which broadcasts an outgoing
heartbeat to everyone. The coordinator uses hibernation rather than timers.
The host's Pro ticket refreshes separately (currently every 20 minutes); viewers
never contact the main-account Pro Worker for room state.

For 1,000 viewers remaining connected for an eight-hour, 20-game stream:

| Operation | Worker requests |
| --- | ---: |
| Viewer joins | 1,000 |
| Host minute pulses | 480 |
| 20 starts, 100 reveals, 100 advances, 20 publications | 240 |
| Total before reconnects/preflights/result reads | **1,720** |

The separate DO request count is similar, plus infrequent alarm invocations.
Each host update normally writes state plus an alarm: approximately 1,440 SQLite
row writes in this example. There are no per-viewer or per-guess writes. Each
viewer's fresh join per game would instead make the Worker total about 20,720.
Result-page reads, retries, pauses, reconnects, host clock/auth requests and CORS
preflights add to these estimates. The client caps automatic reconnection at six
retries per outage and then offers manual Reconnect. Each room currently admits
up to 1,500 simultaneous viewers.

Workers Free and DO Free each have their own 100,000-request daily limit; DO
storage/compute limits are separate too. Outgoing WebSocket messages are not
metered as requests. Free limits fail closed rather than enabling paid usage,
but application checks cannot prevent abusive traffic consuming requests.
Keep this deployment on the secondary account. No R2 or billing change.
See [Cloudflare's DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Vite includes its own local WebSocket/file adapter using the same room reducer.
Deployment uses `LIVE_ROOMS` and the SQLite migration in `wrangler.jsonc`.
Production remains disabled pending hosting setup. The independent runtime
checks run with `npm test` in `workers/noitamap-guessr/`; they include hibernation,
durable closure and late joins. The main tests cover bounded reconnection,
zero viewer messages through 20 games/eight simulated hours, and stale guesses.

The existing Twitch application **noitamap-map-auth** has the user-confirmed
callbacks `https://dynamic-map.noitamap.com/guess/twitch-callback.html` and
`http://localhost:5173/guess/twitch-callback.html`. Use **localhost on port 5173**
for this check; another port or `127.0.0.1` is a different OAuth callback.
`npm run dev -- --port 5173 --strictPort` prevents Vite silently choosing another
port. Viewer access tokens are remembered in the site's own browser storage,
validated before restoring a session, and checked hourly. Sign-out removes the
saved token; expired/revoked tokens require signing in again. Twitch delivery is
attempted once per click; an uncertain response is never automatically retried.
The chatter's existing `user:read:chat` and `user:write:chat` permissions cover
the shared transport. There is no chat window, composer, iframe or Chatterino
setup. A compact connection bar retains the streamer identity, Pro status and
gift action. Twitch sign-in occupies the right map panel until connected.
The indicator distinguishes connected, reconnecting, offline and sign-in states.
Send feedback uses a brief button popover rather than inserting content above
the panels. "Guess sent" means Twitch accepted the send; it does not claim a
receipt from the streamer's collector. An uncertain send is not retried automatically.

`noitaguessr` is transport only. Pro eligibility is still an active subscription
to wuote, an active Patreon membership, or an existing verified exception.
No new Worker call or database write is made for receiving/validating a guess.
The existing live-room state connection remains separate; this change does not
yet replace its broadcast/reconnect path. The packet's random nonce also makes
fresh submissions distinct without exposing coordinates or the point allowance.
The implementation uses Twitch's [browser OAuth flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#implicit-grant-flow),
[Send Chat Message API](https://dev.twitch.tv/docs/api/reference/#send-chat-message),
and [token validation requirements](https://dev.twitch.tv/docs/authentication/validate-tokens/).

To reproduce the one-time data preparation on a fresh checkout:

```sh
node build_scripts/guessr/prepare-captured-map.mjs
python3 build_scripts/guessr/build-area-inventory.py
node build_scripts/guessr/export-image-set.mjs
```

Reuse the existing outputs; the preparation commands need the owner's
`task/guessr/full_map.png`, original translations, and recorded scene audit.
The complete 13,704-coordinate pyramid is exported as **11,301 opaque WebPs**
(identical pieces share an image), **430,265,228 bytes**. The public directory
is `task/guessr/opaque-site/`; it contains only images, a safe dataset descriptor
and cache headers. The private coordinate index is
`task/guessr/private/image-set.json`; sessions are in the sibling `image-games/`.
A repeated full export reused every ID and rewrote zero images. Source image
bytes are unchanged; EXIF/XMP and incomplete coverage are rejected.

The old 4,592 clue images for 30 fixed locations and `prepare-clues.mjs` remain
legacy review fixtures. The active demo does not load their answer-bearing pack.

Open `task/guessr/dataset/index.html` directly for the offline dataset gallery.
It includes all zoom sizes and travel positions, plus contact sheets and a CSV
index. No dev server is needed. The actual image files are in
`task/guessr/site/clues/`; the selection is in
`build_scripts/guessr/captured-locations.json`. Unchanged locations are reused
when preparing again. Superseded initial crops are archived outside the asset
directory under `task/guessr/retired-clues/`.

Vite dev/preview serves opaque assets at `/guessr-images/` and round routes at
`/guessr-api/`. The guess board's coordinate-addressed reference imagery stays
at `/guessr-assets/captured/`; clue selection never uses those URLs. The source
PNG and private index are not bundled into the site. Production artifacts are
prepared locally and uploaded to the secondary account's separate image projects.
`VITE_GUESSR_ROUND_API_URL` selects an external solo-service base, or
`VITE_GUESSR_API_URL` supplies `/api/games` and `/api/streams` from the same Worker.
`VITE_GUESSR_ASSET_URL` belongs
to the old fixed-location loader.

Run `npm run prepare-guessr-hosting` to refresh the reusable deployment artifacts:

| Artifact | Local directory | Intended hosting |
| --- | --- | --- |
| Opaque clue images (11,303 files) | `task/guessr/opaque-site/` | Pages at `guessr-tiles.sage-data.xyz` |
| Reference map (13,705 files) | `task/guessr/reference-site/` | Separate Pages at `guessr-map.sage-data.xyz` |
| Private catalog, image grid and valid starts | `task/guessr/private/worker-assets/` | Game Worker's private `ASSETS` binding |

The two Pages uploads stay below the Free plan's 20,000-file limit; the command
checks counts and never deploys. It reuses existing image bytes and hardlinks
reference tiles where possible. Private sampling data totals about 10 MB,
including a 27 KB catalog, with per-area binary samplers loaded only as needed.
Do not upload private Worker data to Pages. The safe public
`public/guessr/config.json` contains reference framing, never hidden targets.

The game D1 database is provisioned and migrations are applied. Before live use,
finish secrets, image uploads and API verification, then enable `SOLO_ENABLED`,
`STREAM_ENABLED` and `GAME_ENABLED`. Supply the shared `GAME_SIGNING_SECRET` for
auth tickets, a separate `STREAM_SIGNING_SECRET` for encrypted session state,
and `DAILY_PUBLISH_SECRET` for the CI publisher. Daily also requires a published
seed-matched image package. The private assets
binding must remain `run_worker_first: true`; HTTP access to its data is rejected.
The frontend stays on dynamic-map and uses the configured game API URL. These
are deployment instructions, not actions performed by preparation.

Current hosting decision: keep the game at `https://dynamic-map.noitamap.com/guess/`.
Its navbar entry sits beside the seed-report control and reuses the same Pro
accent. Other production deployments do not show the entry; direct game visits
there redirect to dynamic-map. Local Vite development and loopback previews stay
available. This supersedes the earlier `game.noitamap.com` plan.

The secondary Cloudflare account and `sage-data.xyz` hold Guessr's
opaque tiles, game API and published results. The existing shared auth Worker remains the Pro authority for
both the dynamic map and Guessr. Stream games accumulate guesses locally, then
optionally publish one final result document, with a downloadable result as a fallback.
Use Pages for static tiles/assets and Workers Free + D1 for stored results on
the secondary account. Cached Worker responses must not be described as
unmetered static reads.

**Hard billing constraint:** R2 is excluded. Do not attach a payment method,
enable paid services, or upgrade plans on either Cloudflare account. When free
quotas are exhausted, cloud persistence must stop gracefully while local play
and downloadable results remain available; never upgrade automatically.

For the older Pro/Daily fixture, run
`node build_scripts/guessr/preview.mjs --pro` and open
http://127.0.0.1:5177/guess/. This starts local Worker/D1/auth instances
with a synthetic Pro identity and sample daily data. It uses no real login or
Cloudflare credentials. Omit `--pro` for the guest state in a fresh profile.
Set `PORT` to choose another localhost port. `GUESSR_MINIFLARE_PATH` can point to
an existing Miniflare Node entry if installed elsewhere.

Stop with Ctrl+C. The owner controls manual-review servers. Automated checks
must always stop their own servers when finished.

The ordinary Vite dev server serves the demo and local stream simulator at
`/guess/`. Without `VITE_GUESSR_API_URL`, Daily shows an unavailable state.

## Agreed direction

- Main world only in every mode, including heaven and hell. No parallel worlds.
- Use the pristine `task/guessr/full_map.png` for captured-map content. It is
  36,352×73,728 pixels. Slice the complete map once, using bounded memory, into
  reusable images with opaque filenames. Gameplay selects existing images for
  random valid starting positions, zoom and movement; no per-question image
  preparation. Publish relative-only clue framing metadata and keep the world
  position lookup private. Do not send coordinate-addressed source URLs to the
  clue viewer.
- Start at about 27×12 world pixels. Replace the clue image with a wider image
  around the same target when zooming out; progressively lower the maximum score.
- The original point stays the answer after travel. New exploration costs
  points; revisiting already revealed views or returning to the start is free.
- No countdowns, speed scoring, synchronized match barriers, or custom shared
  challenges. The common daily is sufficient. Yesterday can be replayed.
- Three free demo rounds with random valid starts. Full content and extended
  modes are for Pro.
- Pro controls access to content; the round UI and clue-control presets must
  be shared with the demo. The area redesign replaces fixed demo coordinates
  with sampled starts; the three-round demo limit remains.
- EDR is easy to recognize but may be difficult to pinpoint. It uses Normal
  scoring (1,000/4,000). Hell difficulty,
  Hardcore and tiebreaker use remain design choices.
- Casual no-cheating rules/manual moderation. Do not add expensive image-matching
  detection or cryptographic enforcement of every zoom/travel action.
- Serve prepared imagery from a separate Pages project; ordinary gameplay stays
  local. R2 is prohibited; Durable Objects are not required. Backend calls are for accounts,
  round submission/answer reveal and optional score persistence, not individual
  clue images, movements or zooms.
- Daily preparation belongs alongside the existing biome bake, reusing its seed
  and output. Each daily map gets its own reusable image set from the baker CI
  job or a companion job. A game-pack failure must not block normal daily-map
  publication.

Twitch chat commands are implemented; live deployment/OAuth testing is pending.
The shared auth backend explicitly grants Pro to the verified Twitch logins
`wuote` (owner) and `dunkorslam` (Patreon member unable to recover Patreon login).
Both OAuth sign-in and silent refresh apply the exceptions to Twitch's canonical
login, never a client-supplied name or display name. The ordinary signed-session
and game-ticket gates then carry that access. This requires deploying the auth
Worker; an existing non-Pro access token needs a fresh Twitch sign-in or refresh.

The host sees a participant count and connection state. OBS layout, moderation
exclusions, channel-point rewards and guaranteed reconnect submission recovery
remain deferred.

The implemented path sends `!noitaguessr_guess ✦…✦`, with all guess fields inside a compact runic payload. Numeric plaintext examples below are for offline input and older sessions only.
The deferred alternative is one reusable 1-point custom reward named
"NoitaGuessr guess". Its required
text is also `!noitaguessr_guess 2 -3152 874`: command, round number, X, Y. The map picker copies
exactly the same command for chat and redemption input. Optional Send guess can
send that command through Twitch chat after the viewer grants chat-write permission;
reward redemption still happens inside Twitch. Reuse the same reward across all
rounds and games; do not create rewards
per round. Twitch supplies the viewer identity and timestamp. The host browser
handles duplicate guesses per viewer and round, independently of the point cost.
Do not use a one-redemption-per-stream limit: it would prevent later-round guesses.

The shared command formatter/parser is prepared in `src/guessr/guess-command.ts`.
Live packets are encoded and bound to the Twitch sender; offline parsing accepts typographic minus/dash variants,
double hyphens, and copied non-breaking spaces. It validates the round and map
bounds and rejects ambiguous input. The live chat path uses it; future reward
input must use it too.

For future reward recovery, the app must create its own reward, keep redemptions queued until
recorded, and retrieve unfulfilled redemptions after reconnecting. Ordinary
EventSub WebSocket messages missed while disconnected are not replayed. Do not
promise guaranteed delivery. These calls go directly between the host browser
and Twitch; they do not require a Cloudflare call per guess. No rewards or
permissions have been created. See [Twitch redemption documentation](https://dev.twitch.tv/docs/api/reference/#get-custom-reward-redemption)
and [WebSocket recovery documentation](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/).

The whole-map opaque export, local demo selection, camera integration and
area-aware scoring are implemented for manual review. Next complete the
remaining masks/classifications and validate the location pool with the owner.
The prepared Daily now uses static images and the shared exploration controls;
its separate GitLab job runs alongside map publication after the shared bake.
Independent hosting, linked Pro login and chat input still require the remaining
deployment/OAuth checks.
The deferred stream extras still need discussion.

## Prototype files

`src/guessr/` contains the frontend and local rules. `public/guessr/practice/`
contains the old sample assets. `build_scripts/guessr/` contains preparation and
local test tools. D1 migrations 0001–0004 are applied to the secondary database,
including the ten-round change (verified 2026-10-31).
`GAME_ENABLED`, `SOLO_ENABLED` and `STREAM_ENABLED` are enabled. Daily still needs
its first real CI publication. Account and database IDs in the Worker config are real.
The auth route uses a separate game signing key, installed on both the secondary
game Worker and primary production auth Worker. Provider/JWT keys remain primary-only.
Original game files, pinned submodules and the separate Pro bundle are unchanged.

The earlier private-world capture/preparation tools remain experiments. Their
outputs belong under ignored `task/guessr/private/` or outside the repository,
never in public Git/builds. They are not the newly agreed captured-PNG pipeline.

## Checks

The combined lobby/auth/stream update passed **225 tests in 25 files**, the
frontend and both Worker TypeScript checks, a production Vite build and a
Wrangler dry-run package check (46 private assets, about 60 KiB Worker code).
The actual prepared-data stream service also completed a local five-round
lifecycle with publication, retry and read-back checks. No browser automation,
real Twitch messages or Cloudflare mutations were used. Live account linking,
Twitch consent/reconnection and deployed Free-plan performance still require
manual integration testing after configuration.

The Bootstrap 6 migration passed 12 auth/delivery unit checks, TypeScript and a
production build with a dependency-graph audit. The audit verifies that Guessr
loads v6 CSS/JS without the v5 AuthUI module, the main map does not load v6, the
unused datepicker JS is omitted, and the extracted main-map CSS declarations
match their originals. Results: `task/guessr/bootstrap6-audit.json`.

The viewer sending/resume integration and subsequent native-chat/UI revision passed **108 focused tests in 9 files**,
the frontend TypeScript check, and a production Vite build. A separate check
round-tripped 1,820 snapshots from the actual image dataset across all seven
zoom levels and the map edges, preserving frame geometry and order. Every
tested URL fit Twitch's 500-character limit, including a 25-character channel;
the largest was 497 characters. Results: `task/guessr/viewer-link-check.json`.
OAuth popup, EventSub and delivery responses were simulated; real Twitch consent,
native chat rendering and delivery still need the owner's manual check.

The earlier image-pipeline change passed 102 unit checks (the seam comparison was rerun after
replacing a slow assertion), TypeScript and a production Vite build. A temporary
HTTP-only check compared 1,348,164 displayed pixels to the pristine captured
source, checked saved-game resume, private-route blocking, pre-guess answer
withholding and post-guess area/proximity scoring. No browser was launched.
The owner performs browser/UI review; do not run browser automation as part of
this work without a new explicit instruction.

```sh
npm test -- tests/guessr-rules.test.ts tests/guessr-command.test.ts tests/guessr-worker.test.ts \
  tests/guessr-auth-ticket.test.ts tests/guessr-pack.test.ts \
  tests/guessr-captured-map.test.ts tests/guessr-camera.test.ts tests/vite-delivery.test.ts
npm run typecheck
npx tsc --project workers/noitamap-guessr/tsconfig.json
```

Browser/UI review is performed manually by the owner. Unit and HTTP checks do
not validate production Daily publishing or a real Twitch OAuth/EventSub session.
