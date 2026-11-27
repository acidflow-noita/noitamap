# Capacity for new games

Set `GAME_CAPACITY_GUARD=account` in the Worker configuration after commissioning the observer. With the guard enabled, admission requires a fresh account usage reading. Existing authenticated players can continue to submit guesses and reconnect while new starts are paused. A verified host has a separate allowance of 20 room creations per UTC day.

The external observer reads aggregate Worker requests for the whole Guessr account from Cloudflare GraphQL. It leaves room for the rest of the day’s background activity, using the larger of yesterday’s comparable period and the recent hourly rate. It also accounts for the gap between the observation and the next refresh using the busiest observed minute in the last hour. The server atomically reserves the remaining requests in D1 before accepting a new match or a new streamer-game participant.

The reservation counts normal completion calls and a recovery allowance. Each multiplayer seat budgets its upgrade, one probe and reconnect per remaining round, and a final result read. A duel reserves both seats on creation. A streamer room reserves the host first and adds each new chatter once. Demo and Ranked include round submissions, advancement or legacy image reads, preflight and a retry. A confirming usage observation credits completed rounds and releases completed or expired holds. Outstanding holds carry over at midnight UTC. Repeated refreshes, other account traffic, provider outages and separate Durable Object or D1 limits can still exceed a forecast. This is application load protection, not a Cloudflare reservation or an account-wide guarantee under unlimited traffic.

## Live setup

1. Apply the Guessr migrations through `0013_game_capacity.sql`. They include a hold for existing unfinished Ranked attempts and a conservative temporary hold for earlier live rooms. Existing stateless Demo tokens issued before the upgrade have no server-side inventory.
2. On a machine outside the game Worker, use Node 22.18 or newer. Provide `CLOUDFLARE_ACCOUNT_ID` and `GUESSR_ANALYTICS_TOKEN` (Account Analytics Read on the secondary account). From `workers/noitamap-guessr`, `npm run capacity` reports current usage without changing anything.
3. Serve `GUESSR_PUBLIC_STATUS_FILE` as an ordinary JSON file on an existing static web origin independent of the game API. Configure its verified URL with `VITE_GUESSR_AVAILABILITY_URL` at frontend build time. Allow the map origin to read the file, use a short cache lifetime (at most 15 seconds) and publish atomically. The observer needs a writable path that actually serves this URL.
4. On the Guessr API zone, create a disabled custom Block rule with ref `guessr_pause_game_starts`. Provision it in the existing zone custom ruleset. Use this exact expression for the current host.

   ```
   (http.host eq "guessr-api.sage-data.xyz" and http.request.method in {"POST" "OPTIONS"} and http.request.uri.path in {"/api/streams/sessions" "/api/games/sessions" "/api/attempts/new"})
   ```

   The ruleset stops those requests before they invoke the Worker. Existing game sockets, saved attempt URLs and result publication stay available. The legacy start-or-resume route also checks capacity within the Worker.
5. Supply `GUESSR_DATABASE_ID`, `GUESSR_CAPACITY_DB_TOKEN` (secondary-account D1 write), `GUESSR_ZONE_ID`, `GUESSR_RULESET_ID`, `GUESSR_START_RULE_ID`, and `GUESSR_EDGE_TOKEN` (custom rule access on the Guessr zone). Use the existing secrets facility. The game Worker itself receives none of these management credentials. On the external machine run `npm run capacity -- --apply --watch`. The observer runs about once a minute and only edits the designated rule when its state changes. Use one observer.
6. Verify the public status URL and a fresh D1 observation before deploying the guarded Worker and frontend. Old static status or missing telemetry pauses new starts temporarily. The amber bar shows the player's local retry time. A confirmed full-day pause lasts until midnight UTC. The menu reads the static file and checks it again before starting a game. It does not poll the game Worker from each playing tab.

Keep paused-start protection in place while repairing a stalled observer. Restore its external static publication, D1 access and Cloudflare rule access before reopening play.
