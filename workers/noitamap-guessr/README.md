# NoitaGuessr API

This Worker runs in the secondary Cloudflare account, ACID HELPER. The primary authentication Worker is a separate deployment. See [deployment instructions and current resources](DEPLOYMENT.md).

## Multiplayer connection

Chat vs Streamer and 1v1 use one hibernating `StreamCoordinator` Durable Object per game. Gameplay uses authenticated WebSockets. Twitch is used for identity and optional invitation/result posts in the streamer's own channel. Gameplay does not read Twitch chat or send guesses, receipts or state updates there.

For multiplayer clue replays, apply `0011_clue_replays.sql` to the Guessr D1 database, deploy this Worker, then deploy the matching frontend. Games created after the update advertise replay support to their players.

The first WebSocket frame authenticates the connection. Provider credentials never enter URLs, socket attachments, application logs or persistent game storage. Resume credentials are scoped to the game, identity and protocol generation. Old resume credentials and old gameplay frames are rejected. The frontend discards the previous chat-transport token once and requests identity-only Twitch access for players.

The coordinator owns absolute deadlines, accepted guesses and final publication. Refreshing a page does not restart a timer. Players keep an outbox on their device until the coordinator confirms durable storage. Reconnects replay the same submission ID and revision. A newer guess cannot be replaced by a late confirmation for an older one.

Other players' pins remain private until their round is released. The host receives submitted counts and player names, without unrevealed opponent pins or future clue frames. Automatic ping/pong responses use WebSocket hibernation. A completed game stops reconnecting and sending keepalives after its published result arrives.

## Game flow

Multiplayer supports 3, 5 and 10 rounds, with 5 selected by default. The default round timer is 90 seconds. Starting a game opens a lobby with no deadline. The host shares the link and then presses Start game. The countdown is silent. Timed games hold intermediate results for at least eight seconds before automatic round progression.

The streaming-protection option is on by default for Chat vs Streamer and off for 1v1. With protection on, the other players complete each location before the streamer sees it. With protection off, both sides play the same location together. A 1v1 roster has exactly two players, and the host must approve the named ready opponent. Leaving an active 1v1 match concedes it and opens the result.

An unsent last marker is submitted automatically at zero. The existing bounded submission grace period remains in place. The receive timestamp is captured before the coordinator's serialized write queue, so a burst of on-time frames does not become late just because persistence takes time.

## Results and history

Each player’s clue replay records displayed camera actions and accepted guesses, including revisions. Changed views travel in batches on the existing WebSocket. After reveal, the public API returns ordered actions and whole seconds from that player’s round opening. Private storage retains the original camera timestamps. Show replay opens an inline timeline in the round results or standings. Hover or focus a step to review it. Play all advances the steps at half-second intervals. Published reads use `GET /api/streams/results/{game}/rounds/{round}/replays/{player}`.

Replay pages count against the result storage budget. When only the scores fit, the coordinator serves the recordings for its usual 24-hour retention period. Removing a result also removes its archived recordings.

History returns numeric placement and score totals for any selected player in the existing page request. New results include compact totals in their metadata. Apply `0008_result_history_summaries.sql` before deploying this feature. For older compressed results, the Worker prepares at most one missing summary per history request and stores it separately. Later reads reuse it. The original result and scores remain immutable. Full historical payloads stay in Cloudflare during this preparation. The separate summary and its row overhead count against the existing storage budget.

Completed games publish one immutable compressed result to D1. Public result reads and channel history do not require login. Publication retries are idempotent and continue after a browser disconnect. Local result copies and HTML/image exports remain available if publication is delayed.

Apply `0012_player_colors.sql` before deploying the color fallback. Newly published games index recorded Twitch colors by stable player ID. For immediate recovery after migrating, run `npm run backfill:colors -- --apply` with the secondary account and D1 settings in [capacity setup](CAPACITY.md). Running it without `--apply` reports the pending count. The scheduled task also backfills up to 12 historical records per run. The public results reader fills only missing colors from that index, in one batch. Install the matching auth Worker update so public Twitch colors can also be read with the app credentials when a player’s own access token has expired.

Result storage has an application byte budget below the Free D1 limit. New-game admission uses measured Cloudflare account traffic and completion reserves. Each verified Twitch host can still create up to 20 rooms per UTC day. See [capacity setup](CAPACITY.md). Apply `0010_stream_game_admission.sql` before deploying those checks. The claim is atomic and happens before puzzle sampling or coordinator creation. Failed preparation releases its claim; cancelled lobbies still count. Refreshes and reconnects do not claim new slots. Finished games are not rejected by daily publication counts. Limit messages show the reset time in the viewer's local timezone. Admission counters are retained for 32 days and cleaned without a cron job. These safeguards do not make Worker or Durable Object usage unlimited. Keep both Cloudflare accounts on the intended Free plans.

Final results can show a private review notice to the signed-in host. Reveal reasoning requests a fresh result-management ticket and sends it to `POST /api/streams/results/{game}/review`. The Worker verifies ownership before returning the case details with `Cache-Control: no-store`. Round broadcasts, public result reads, and score exports omit the reasoning. The public reader also redacts older JSON and compressed documents containing review details.

The static menu notice and protected starts use the account-wide capacity observation. A shortfall pauses new starts before the request wall. A missing or stale observation pauses new starts temporarily. The client displays shared limits in a thin warning strip above the menu and formats the reset in the player’s timezone. A personal daily limit appears on the affected action. A readable Cloudflare 1027 can also activate the service-wide strip. The client reads the status from the static site and expires notices locally.

## Identity and optional Twitch posting

Chatter OAuth needs no chat scopes. Its token stays in the current tab's `sessionStorage`, so F5 can restore it. A public user ID may remain locally for result personalization. Closing the tab ends that stored login, subject to the browser's session-restore behavior. Explicit sign-out clears local credentials and requests Twitch revocation.

Pro players can reuse their verified site session for 1v1. Game tickets are verified by the Worker before assigning a seat. Temporary provider failures are retried without erasing valid saved credentials.

The primary auth Worker requests `user:write:chat` only when the streamer enables link posting. Announcements additionally need `moderator:manage:announcements`. Reading chat is not needed. Posting permission is separate from hosting permission. A permission or posting failure must not stop an active game.

## Prepared imagery

Apply `0009_generated_stream_maps.sql` before deploying generated SvC support. The existing Guessr CI job now also prepares the full eligible location catalog as bounded encrypted static files. The publisher stores only private metadata and the per-dataset key in D1. It verifies the uploaded files before activation. No new secret, binding, paid service or request per clue movement is needed.

The first authenticated publication for the current UTC day enables generated maps for SvC. After that, a missing current-day package returns a preparation message instead of falling back to captured terrain. A game pins its day, seed, render identity, clue root and reference map. SvC selects fresh rounds from the full prepared location pool, independently of the ten Daily puzzles. PvP and Demo keep their current source.

For an upgrade after people already played today's Daily, run biome-baker on `main` through **New pipeline** with `GUESSR_SOURCE_ONLY=1`, `BAKE_KIND=daily`, and `DEPLOY=1`, then start **guessr-source-refresh**. This manual job restores the verified current-seed archive, uses the pinned Guessr tools and publishes with `--source-only`. It does not rerender/deploy the main map or replace Daily questions and attempts. Normal daily pipelines continue to publish both Daily puzzles and the generated SvC catalog in the separate, non-blocking Guessr job.

Clue and reference images are static Pages assets. Multiplayer replay messages record only the relative camera and timestamp. Daily publication uses prepared generated terrain from the separate non-blocking Guessr job in the biome-baker pipeline. Each game pins its imagery version so a publication cannot change an active game's locations.

Prepared sampling files are private Worker assets. Public requests cannot fetch `/game-data/` files. Anonymous demo calls are rate limited before sampling work. Origin checks allow the configured production site only.

## Local verification and portable source

From `workers/noitamap-guessr`:

```sh
npm ci
npm run typecheck
npm test
```

Runtime tests use local workerd with `remoteBindings: false`. They cover authenticated sockets, private snapshots, duplicate and revised guesses, stored network signals, timer recovery, hibernation, storage failures, PvP and idempotent D1 publication. No production account credentials are needed.

From the public repository root, synchronize reviewed source into the existing ignored private checkout:

```sh
node --import tsx build_scripts/guessr/sync-worker-repository.mts --repo=task/guessr/private/repository-export-2026-10-25/noitamap-guessr
```

The sync script requires a clean destination. It copies the Worker and its source dependencies. It does not copy secrets or prepared assets, and it does not commit, push or deploy. Review the destination diff and run its checks before pushing `main`.
