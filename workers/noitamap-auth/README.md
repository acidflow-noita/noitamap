# Pro accounts and sessions

The primary auth Worker owns the account registry and provider credentials.
Production currently accepts only `https://dynamic-map.noitamap.com`. At the
future main-site cutover, deploy the hardened browser client to `noitamap.com`
first, then explicitly add that origin. The same Worker, accounts and provider
callbacks can serve both sites. Do not add preview hosts to production.

Pro is granted by an active paid Patreon campaign membership, a Twitch
subscription to the configured broadcaster, or an owner-approved stable Twitch
user ID. Names do not grant access. Linked providers share the account's Pro
status. Claimed paid-tier Patreon gifts qualify; free, declined, expired and
unrelated campaign memberships do not. Membership results last at most 24 hours
and are checked during renewal when older than one hour. Gameplay does not
check provider subscriptions every round.

## Security v2 rollout

This release intentionally rejects every old site session and old link intent.
There is no session migration or logout notification. Users sign in again.
Existing account links remain, and their encrypted provider records can be
re-encrypted independently of the old session format.

Before deploying, apply **both** D1 migrations to the primary account registry.
The existing `ACCOUNT_DB` binding selects the database:

```sh
npx wrangler d1 migrations apply ACCOUNT_DB --remote
```

Provision independent random secrets of at least 32 bytes in the primary
account's existing Secrets Store, using the names in `wrangler.jsonc`:

- `NOITAMAP_SESSION_SIGNING_SECRET`, for access, refresh and OAuth state keys
  separated by HKDF purpose.
- `NOITAMAP_CREDENTIAL_ENCRYPTION_SECRET`, for provider data only.

The primary-account migration has been verified: no old provider records
remain and broadcaster KV is encrypted. `LEGACY_CREDENTIAL_SECRET` has been
removed from the deployment configuration. Existing v2 account data and
sessions continue to use their independent keys. The former shared store
entry must not be deleted until its other consumers have been checked.

Generate secrets directly into the secret-setting tool or a protected ignored
file. Never put values in source, shell arguments, chat, logs or build artifacts.
Deploy the coordinated client/Worker release using the security rollout guide.
Do not deploy just the new Worker without its required keys and migration.

## Session behavior

Access and refresh tokens reference a registered session and account version.
Every authenticated auth request checks that registry. Logout revokes the
session; linking/unlinking invalidates previous account sessions. Refresh tokens
rotate exactly once and retain the original 90-day absolute session deadline.
An immediately repeated refresh receives no token; later reuse revokes its
session. The browser serializes same-origin refreshes with Web Locks.

Login returns require a per-tab nonce and are imported and scrubbed before
analytics or application scripts run. Connections require OAuth ownership proof,
a preview of both identities, and an explicit confirmation from the original
account. Preview responses never contain provider tokens. The confirmation uses
Bootstrap's native dialog and is translated in every supported language.

The auth Worker returns a Twitch access token only after checking its client,
owner, lifetime and allowed chat scopes. Refresh credentials remain encrypted
server-side. Ordinary Twitch sign-in asks for no scopes. Chat consent requests
`user:read:chat user:write:chat`; optional announcements additionally request
`moderator:manage:announcements`. Existing callback URLs are unchanged.

## Isolated development

The checked-in dev/local environments are **disabled**. They have no production
Secrets Store or KV bindings. To enable one, configure separate OAuth apps,
independent signing/encryption keys, isolated storage and its own allowed
origins. Local `.dev.vars` string secrets are supported and must stay ignored.
Do not run local development with production remote bindings. Never deploy
`wrangler.accounts-local.jsonc`; it is for offline migration tests only.

## Operations

Native rate-limit bindings run inside the existing invocation. They do not
create Worker requests, Durable Objects or per-request D1 counter writes.
Limits are approximate and per Cloudflare location, not a global spending cap.

Only explicit structured security events are logged. Invocation logs and traces
are disabled because OAuth callback URLs contain authorization codes. Do not
log request headers, URLs, bodies, tokens or provider responses.

Broadcaster setup remains disabled with `TWITCH_SETUP_KEY` unbound. If rerun,
use a temporary independent key and POST `/auth/twitch/broadcaster-setup` with
`X-Noitamap-Setup-Key`. Its JSON response contains the authorization URL and
sets the state cookie; open that URL in the same browser. The callback stores
encrypted credentials and never prints the refresh token. Remove the binding
and rotate the temporary key afterwards. Query-string keys are not accepted.

For a copied-folder build/deployment, see [DEPLOY.md](DEPLOY.md).


## Game ticket boundary

Auth alone holds `GAME_TICKET_PRIVATE_KEY` (Secrets Store secret
`NOITAMAP_GAME_TICKET_PRIVATE_KEY`), a P-256 private JWK. The secondary Guessr
Worker holds only the matching public JWK, in `GAME_TICKET_PUBLIC_KEY`.
Tickets use ES256 with version 2 and a 20-minute expiry. Old symmetric tickets
are rejected. Never put the private JWK on the secondary account.

Generate the pair with `node tok_gen_script/game-ticket-keys.mjs /private/path`.
The script writes two protected files and never prints key contents. Upload the
private file to primary auth's Secrets Store and the public file to the secondary
Worker's `GAME_TICKET_PUBLIC_KEY` secret binding. Do not include the private
files in a source archive. The existing secondary `GAME_SIGNING_SECRET` is now
used only for solo-game encryption: rotate it independently during cutover,
and remove the obsolete shared value from primary/dev authentication.

`POST /auth/game-ticket` requires Pro. `POST /auth/result-ticket` requires a
registered login but does not require paid status. Its result-management ticket
cannot start/play games. This permits owners to remove a published result after
their subscription ends. No ticket or subscription lookup is needed to read a
public result. These signatures are verified locally in the receiving Worker;
there is no added verification request.
