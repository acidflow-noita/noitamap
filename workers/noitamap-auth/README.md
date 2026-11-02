# Linked Patreon and Twitch accounts

The primary auth Worker owns the optional `ACCOUNT_DB` D1 registry. Main-map,
dynamic-map and Guessr clients use the existing auth URL selection. No provider
credential or auth signing secret belongs on the secondary game account.

`migrations/0001_linked_accounts.sql` stores stable provider IDs, encrypted OAuth
credentials, cached membership flags, and short-lived connection intents.
Provider refresh/access credentials use AES-GCM with the existing auth secret;
browser refresh JWTs reference the account and a revocable version. Display
names never identify accounts. The existing verified Twitch login grants for
`wuote` and `dunkorslam`, creator bypasses, paid active Patreon campaign membership,
and Twitch subscriptions to the configured broadcaster still apply.

Claimed Patreon gifts also qualify when `is_gifted` is true and the configured
campaign membership has a current paid-tier entitlement. Recipient payment
history is not required; expired, declined, free-tier and unrelated memberships
do not qualify. This uses the existing identity request. Validate one real
redeemed-gift response before production rollout: Patreon documents these fields
but does not guarantee a gift-specific `patron_status` combination.

Authenticated connections require both provider OAuth and a final POST using
the original account session. The browser also checks a per-tab pending link.
Two previously independent single-provider accounts can merge; a provider
already attached to a different multi-provider account cannot. Disconnecting
requires another usable sign-in method and revokes earlier account sessions.

Pro is the union of the linked providers. Membership results are cached for at
most 24 hours and refreshed during session renewal when older than one hour;
game actions never call provider membership APIs. Existing Pro asset Workers
continue reading `is_subscriber`. Already-issued asset JWTs remain valid until
their expiry (at most 24 hours); the auth Worker immediately rejects revoked
account versions. Legacy provider JWTs/refresh JWTs remain accepted and migrate
on their next successful provider refresh or sign-in.

## Production and development configuration

The registry databases are created and migrated in the **primary auth account**
`666c045f38dd332e459bfe2a18c4e9a9`. The checked-in Wrangler config binds:

| Environment | Database | ID |
| --- | --- | --- |
| Production | `noitamap-auth-accounts` | `843b3e88-230d-4912-8b7d-d1bcdb5b5d2d` |
| Development | `noitamap-auth-accounts-dev` | `458cdca7-305e-468b-8072-18bb3d05d142` |

For an additional environment, create and migrate its own database, then add:

```jsonc
"d1_databases": [{
  "binding": "ACCOUNT_DB",
  "database_name": "noitamap-auth-accounts",
  "database_id": "<actual database ID>",
  "migrations_dir": "migrations"
}]
```

Wrangler bindings must be configured separately for named environments. Use
separate databases for environments with different JWT secrets, because those
secrets encrypt the provider credentials. Keep the current auth Worker URL and
the existing allowed origins, including dynamic-map. Do not deploy the offline
configuration or use its zero ID for a remote database.

Twitch chat reuses `/auth/twitch/callback`, which must be registered for the
chosen auth Worker URL in the existing Twitch application. The explicit chat
connection asks for `user:read:chat` and `user:write:chat`, using `force_verify=true`.
Selecting announcements in Guessr setup also requests `moderator:manage:announcements`.
The choice is retained in the existing account-link intent; no database migration is needed. Ordinary
Twitch sign-in requests no scopes. The browser receives a validated user access
token only when its app ID, stable user ID, and allowed chat scopes match.
Existing read-only consent still receives guesses. Setup offers optional sharing
consent before play; without it the game provides a copy-link button. Other privileges are refused; refresh
credentials stay in D1. Posting goes directly from the browser to Twitch, with
no per-post auth Worker request and no automatic posting or retry.
No separate bot login, bot credentials, or live messaging test is required.

The game signing secret remains a separate secret shared with the secondary
game Worker. Game tickets use `account:<id>` and optionally contain verified
`twitchUserId` and `twitchLogin`; provider OAuth tokens never enter game tickets.

## Local checks

From the repository root (Node 26, providers fully mocked):

```sh
npm test -- tests/auth-linked-accounts.test.ts tests/auth-provider-switch.test.ts tests/auth-ui-modal.test.ts tests/auth-twitch-pro-access.test.ts tests/guessr-auth-ticket.test.ts
```

These tests execute the actual migration and registry SQL against in-memory
SQLite. They cover membership preservation, merges, link-session binding,
conflicts, disconnect revocation, cached membership expiry and scoped chat
tokens, alongside the legacy token/Pro gate tests.

With the Worker dependencies installed, from `workers/noitamap-auth`:

```sh
npm run db:migrate:local
npm run types:accounts
npx tsc --noEmit
```

`wrangler.accounts-local.jsonc` has no production bindings and is only for
offline D1 migration checks. Generated binding types use the real Wrangler
configuration. The offline config does not configure live OAuth. To exercise
the browser manually, configure the intended auth deployment and use the normal
Patreon/Twitch consent screens; no browser tests are run by the unit suite.

API contract: `authService.getTwitchChatSession()` returns
`{ accessToken, clientId, userId, login, expiresAt }` or `null` when consent is
missing. `expiresAt` is milliseconds. Keep that access token in memory and
revalidate at least hourly for an active chat connection.
`authService.connectTwitchChat()` runs registered workspace-save hooks before
redirecting. Guessr can register the `guessr` login-return feature.

References: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/),
[D1 transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[Twitch chat scope](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage),
[Twitch token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/).
