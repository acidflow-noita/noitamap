# NoitaGuessr API

This Worker runs in the secondary Cloudflare account, ACID HELPER. The primary authentication Worker is a separate deployment. See [deployment instructions and current resources](DEPLOYMENT.md).

## Multiplayer connection

Chat vs Streamer and 1v1 use one hibernating `StreamCoordinator` Durable Object per game. Gameplay uses authenticated WebSockets. Twitch is used for identity and optional invitation/result posts in the streamer's own channel. Gameplay does not read Twitch chat or send guesses, receipts or state updates there.

Deploy this Worker before its matching frontend. This transport update uses the existing Durable Object binding and database tables. It needs no new secret or D1 migration.

The first WebSocket frame authenticates the connection. Provider credentials never enter URLs, socket attachments, application logs or persistent game storage. Resume credentials are scoped to the game, identity and protocol generation. Old resume credentials and old gameplay frames are rejected. The frontend discards the previous chat-transport token once and requests identity-only Twitch access for players.

The coordinator owns absolute deadlines, accepted guesses and final publication. Refreshing a page does not restart a timer. Players keep an outbox on their device until the coordinator confirms durable storage. Reconnects replay the same submission ID and revision. A newer guess cannot be replaced by a late confirmation for an older one.

Other players' pins remain private until their round is released. The host receives submitted counts and player names, without unrevealed opponent pins or future clue frames. Automatic ping/pong responses use WebSocket hibernation. A completed game stops reconnecting and sending keepalives after its published result arrives.

## Game flow

Multiplayer supports 3, 5 and 10 rounds, with 5 selected by default. The default round timer is 90 seconds. Starting a game opens a lobby with no deadline. The host shares the link and then presses Start game. The countdown is silent. Round results remain visible for 30 seconds.

The streaming-protection option is on by default for Chat vs Streamer and off for 1v1. With protection on, the other players complete each location before the streamer sees it. With protection off, both sides play the same location together. A 1v1 roster has exactly two players, and the host must approve the named ready opponent. Leaving an active 1v1 match concedes it and opens the result.

An unsent last marker is submitted automatically at zero. The existing bounded submission grace period remains in place. The receive timestamp is captured before the coordinator's serialized write queue, so a burst of on-time frames does not become late just because persistence takes time.

## Results and history

History returns numeric placement and score totals for any selected player in the existing page request. New results include compact totals in their metadata. Apply `0008_result_history_summaries.sql` before deploying this feature. For older compressed results, the Worker prepares at most one missing summary per history request and stores it separately. Later reads reuse it. The original result and scores remain immutable. Full historical payloads stay in Cloudflare during this preparation. The separate summary and its row overhead count against the existing storage budget.

Completed games publish one immutable compressed result to D1. Public result reads and channel history do not require login. Publication retries are idempotent and continue after a browser disconnect. Local result copies and HTML/image exports remain available if publication is delayed.

Result storage has an application byte budget below the Free D1 limit. Existing daily and per-host publication caps also apply. These safeguards do not make Worker or Durable Object usage unlimited. Keep both Cloudflare accounts on the intended Free plans.

SvC results can show groups of accounts that merit review. The coordinator derives private, game-specific keyed network identifiers from the trusted edge address. Raw addresses are not saved. The client reports at most one clue-navigation event per round, which is deduplicated across retries. Public warnings contain player names and round numbers, never network identifiers. They do not prove cheating or change scores.

## Identity and optional Twitch posting

Chatter OAuth needs no chat scopes. Its token stays in the current tab's `sessionStorage`, so F5 can restore it. A public user ID may remain locally for result personalization. Closing the tab ends that stored login, subject to the browser's session-restore behavior. Explicit sign-out clears local credentials and requests Twitch revocation.

Pro players can reuse their verified site session for 1v1. Game tickets are verified by the Worker before assigning a seat. Temporary provider failures are retried without erasing valid saved credentials.

The primary auth Worker requests `user:write:chat` only when the streamer enables link posting. Announcements additionally need `moderator:manage:announcements`. Reading chat is not needed. Posting permission is separate from hosting permission. A permission or posting failure must not stop an active game.

## Prepared imagery

Clue and reference images are static Pages assets. Viewing or moving an image does not invoke this Worker. Daily publication uses prepared generated terrain from the separate non-blocking Guessr job in the biome-baker pipeline. Each game pins its imagery version so a publication cannot change an active game's locations.

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
