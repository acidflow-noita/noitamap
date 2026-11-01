# NoitaGuessr deployment

The website stays at `https://dynamic-map.noitamap.com/guess/`. Its production
API default is `https://guessr-api.sage-data.xyz`; local Vite keeps its local
round service unless an explicit `VITE_GUESSR_API_URL` is supplied.

## Alpha: exact setup and release order

The owner confirmed both GitLab variables were added on 2026-10-31. Steps 1–2
are complete; their permissions will be exercised by the first publication job.
The owner applied the ten-round D1 migration; a read-only Wrangler check
confirmed no pending migrations on 2026-10-31.
The release files have been checked locally. Review the release commits, then
use the push commands below. These instructions do not perform a deployment.

Release preparation on 2026-10-31 synchronized the private API checkout with
the current Worker, its 19 shared modules and migration `0004_ten_rounds.sql`.
That checkout passes type checking, eight local Worker runtime tests and a
Wrangler dry-run build. Production deployment is still pending.

The release security review checked Git-tracked and non-ignored candidate files
in the map, dynamic-map worktree, Pro, baker, private API and both image repositories,
including archive contents and unpublished commits. It found no known signing or
publisher secrets in those candidates. Gitleaks findings were reviewed as public
OAuth client identifiers, game identifiers or source-file hashes. Credential files
are ignored and untracked; the dynamic-map worktree's missing ignore rules were
added. Redacted receipts stay under ignored `task/guessr/private/alpha-release-2026-10-31/`.
Repeat the checks against the exact staged files and outgoing commits before any
commit/push. Never force-add credential files, dump secret values into logs or
copy provider/signing credentials into a private repository as a shortcut.

### 1. Create the image-upload token in the secondary Cloudflare account

Open [Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens).
Select **ACID HELPER**, account **`3d75ffad634d443fca37da68c0ed4f3c`**.

1. Select **Create Token → Create Custom Token → Get started**.
2. Name it **`noitaguessr-gitlab-pages`**.
3. Add **Account → Cloudflare Pages → Edit** permission.
4. If the form asks for account resources, select **Include → Specific account
   → ACID HELPER**. An account-owned token is already tied to its selected account.
5. Leave client-IP filtering empty for the shared GitLab runners.
6. Continue to the summary, create the token, and copy its value.

This is a Pages API token, created in Cloudflare and consumed by GitLab.
It does not belong in Cloudflare Secrets Store or a Worker's secrets.
The primary WUOTE account is not used for these image uploads.
[Cloudflare's Pages token instructions](https://developers.cloudflare.com/pages/configuration/api/).

### 2. Save both values in the biome-baker GitLab project

Open [biome-baker → Settings → CI/CD](https://gitlab.com/wuote-public-group/biome-baker/-/settings/ci_cd),
expand **Variables**, and select **Add variable** twice:

| Key | Value to paste |
| --- | --- |
| `GUESSR_CLOUDFLARE_API_TOKEN` | The token created in step 1 |
| `GUESSR_DAILY_PUBLISH_SECRET` | The existing value after `=` in `task/guessr/private/production-prep-2026-10-25/cloudflare/gitlab-publisher-secret.env` |

For both: **Type = Variable**, **Environment scope = All (`*`)**,
**Visibility = Masked and hidden**, **Protect variable = enabled**,
**Expand variable reference = disabled**. Save each variable.
The publisher file is inside the ignored local `task/` directory; its value is
already installed on the Guessr Worker. Copy the value without the variable
name or quotes. Do not create a replacement value.

Protected variables are available only on protected refs. Use the baker's
protected **`main`** branch for the publication pipeline; check its protection
under **Settings → Repository → Branch rules** if necessary.
[GitLab's variable settings](https://docs.gitlab.com/ci/variables/).

`GUESSR_CLOUDFLARE_ACCOUNT_ID` and the project/domain/background settings are
already in `.gitlab-ci.yml`. The only two new CI variables needed here are the
two values above. The Pages token is not the credential for applying D1 migrations.

### 3. Prepare and publish the website and Pro release commits

The source locations and destinations are:

| Component | Local repository | Push / merge destination |
| --- | --- | --- |
| Guessr frontend and shared map changes | `/home/w/Documents/git/noitamap` | `acidflow-noita/noitamap`: push `noitamap-guessr`, then merge its PR into `dynamic-map` |
| Pro bundle | `/home/w/Documents/git/noitamap/task/noitamap-pro` | `WUOTE/noitamap-pro`: `main` |
| Guessr API export | `/home/w/Documents/git/noitamap/task/guessr/private/repository-export-2026-10-25/noitamap-guessr` | `WUOTE/noitamap-guessr`: `main` |
| Baker | `/home/w/Documents/git/noitamap/task/biome-baker` | GitLab `wuote-public-group/biome-baker`: `main` |

Before committing, reconcile the Guessr branch with the latest `dynamic-map`
changes. The private API export was synchronized on 2026-10-31 and now contains
the current Worker, shared rules and ten-round migration.
Repeat the synchronization if those source modules change before release.
Rebuild both Pro entries using `npm run build` in the Pro repository and include
their generated entry files/chunks in its reviewed release commit.

After the frontend release commit is prepared, push from the map repository root:

```sh
cd /home/w/Documents/git/noitamap
git push origin noitamap-guessr
```

Open a GitHub pull request with **base = `dynamic-map`** and
**compare = `noitamap-guessr`**. Merge that PR and wait for the dynamic-map
website deployment to succeed. The URL is
`https://dynamic-map.noitamap.com/guess/`.

After the Pro release commit is prepared:

```sh
git -C /home/w/Documents/git/noitamap/task/noitamap-pro push origin main
```

Verify the existing primary-account Pro deployment serves the new release.
No primary auth secret needs to be regenerated for this UI release.

### 4. Apply the ten-round database migration in ACID HELPER

Use the installed Wrangler in the map repository's Worker directory:

```sh
cd /home/w/Documents/git/noitamap/workers/noitamap-guessr
npx wrangler whoami --account 3d75ffad634d443fca37da68c0ed4f3c
npx wrangler d1 migrations list noitamap-guessr --remote
npx wrangler d1 migrations apply noitamap-guessr --remote
```

If `whoami` does not confirm access to ACID HELPER, run `npx wrangler login`
and authorize the secondary account before continuing. This uses Wrangler's
Cloudflare login, not the Pages-only GitLab token.
The configured database is `noitamap-guessr`, ID
`0cf10a94-a762-43e7-88ec-866a319dc324`. Confirm that
`0004_ten_rounds.sql` is applied before deploying the new API.
[Cloudflare's migration instructions](https://developers.cloudflare.com/d1/reference/migrations/).

### 5. Publish the updated private API repository

After its synchronized release commit is prepared and step 4 is complete:

```sh
git -C /home/w/Documents/git/noitamap/task/guessr/private/repository-export-2026-10-25/noitamap-guessr push origin main
```

In **Cloudflare → ACID HELPER → Workers & Pages → noitamap-guessr → Builds**,
wait for that commit's deployment. Its root is `workers/noitamap-guessr`, build
command is `npm run typecheck`, and deployment command is `npx wrangler deploy`.
Check `https://guessr-api.sage-data.xyz/health` returns 200. Existing Worker
secrets, domains and captured-image Pages projects remain usable.

### 6. Run the first Daily publication

The independent `guessr-daily` job is already committed in the baker repository
at `7d3f8f3`. Start a new pipeline after the Noitamap release is merged, so the
recorded source revision includes the Daily preparation scripts.

1. Open **GitLab → biome-baker → Build → Pipelines → New pipeline**.
2. Choose branch **`main`** (this is the baker branch).
3. Set **`NOITAMAP_BRANCH=dynamic-map`**, **`BAKE_KIND=daily`**,
   **`DEPLOY=1`**. Leave **`SEED`** blank for the current Daily, or enter the exact
   current seed when repeating a bake. Leave **`GPU_BENCHMARK=0`**.
4. Run the pipeline and wait for **`bake`** to succeed.
5. Start the manual **`deploy`** and **`guessr-daily`** jobs. They can run in
   parallel; neither waits for the other. Guessr failure does not block the map.
6. Open the Guessr job's `manifest.json` and `publication.json` artifacts.
   Confirm a successful publication for the expected day/seed and ten rounds.

An older completed pipeline may pin source from before the Guessr scripts
existed. Rerunning its Guessr job cannot change that pinned revision.
Scheduled Daily pipelines run the separate Guessr job automatically once the
credentials and source are in place.

### 7. Verify the alpha on the deployed website

Verify Demo, Pro sign-in, a ten-round Daily, refresh/resume, and results at
`https://dynamic-map.noitamap.com/guess/`. Verify Chat vs Streamer in two separate
tabs/accounts and measure the secondary account's request usage during joins,
refreshes and reconnects before opening it to a larger audience.
The requested stream timer and host restriction are still unfinished work;
the deployment procedure does not implement those features.

## Accounts and resources

Guessr uses the secondary account `3d75ffad634d443fca37da68c0ed4f3c` (ACID HELPER).
The existing Noitamap auth Worker stays in the primary account. Never copy
Patreon/Twitch client credentials or the auth JWT secret to Guessr.

| Resource | Name / ID | Purpose |
| --- | --- | --- |
| D1 | `noitamap-guessr` / `0cf10a94-a762-43e7-88ec-866a319dc324` | Daily attempts, scores, published stream results |
| Pages | `noitaguessr-tiles` | Opaque clue images at `guessr-tiles.sage-data.xyz` |
| Pages | `noitaguessr-map` | Reference map at `guessr-map.sage-data.xyz` |
| Worker | `noitamap-guessr` | API at `guessr-api.sage-data.xyz` |
| Durable Object | `LIVE_ROOMS` / `LiveRoom` | Stream round state |

The D1 database, both Pages projects and the game Worker are deployed. Database
migrations `0001`–`0004` are applied (verified with Wrangler on 2026-10-31). Custom domains and DNS records are configured.
Captured clues/reference tiles and the fixed background snapshot are uploaded;
live HTTP checks matched their bytes to local files. The API health check returns
200 and direct access to its private catalog returns 404. The three game secrets
are installed on the secondary Worker. The game API is enabled.

Production and development auth now have separate migrated account registries;
their code is deployed, with the production game secret matching Guessr. The
existing provider/JWT secrets are unchanged. The owner confirmed the secondary
Pages CI token and publisher secret were added to GitLab on 2026-10-31. Remaining
launch work is the source/API release commits, deployment and first real
seed-matched Daily publication. Real linked-provider
consent and a streamer/chatter game still need the owner's manual verification.
The reviewed inventory is unchanged: the current captured map and the verified
composed Daily both contain 42 eligible areas. Snowy Wasteland's conditional
rule and the final Holy Mountain geometry remain excluded by the existing catalog.

No R2, payment method or paid upgrade is part of this deployment. Each Pages
deployment is checked against 20,000 files and 25 MiB per file.

## Initial image and Worker setup

The captured images are already prepared and uploaded. The following describes
how to regenerate them when the source capture or reviewed areas change; it is
not an outstanding deployment step.

From the map repository, `npm run prepare-guessr-hosting` produces these complete
output directories:

| Local upload root | Contents | Destination |
| --- | --- | --- |
| `task/guessr/opaque-site/` | `images/`, `dataset.json`, `_headers` | Pages project `noitaguessr-tiles` |
| `task/guessr/reference-site/` | `map_files/`, `_headers` | Pages project `noitaguessr-map` |
| `task/guessr/private/worker-assets/` | `game-data/` | Game Worker's private `ASSETS` binding |

These image projects serve the prepared files directly. There is no additional
`dist/` or `public/` directory inside them, and no Vite build for these uploads.
For example, uploading `opaque-site/` makes
`opaque-site/images/<hash>.webp` available at
`https://guessr-tiles.sage-data.xyz/images/<hash>.webp`.
The application's separate `npm run build` still outputs the website to `dist/`.

For future image updates, upload the two public roots shown in the table.
The Pages projects use `main` as their production deployment label. This is
the `--branch main` option on the upload command, not an instruction to create
or switch a Git branch or push these image directories to Git.
The private directory belongs only in the Worker's `ASSETS` binding;
`run_worker_first: true` and the route handler deny direct HTTP access to it.
Use this project's pinned Wrangler for directory uploads and Worker deployment.
Explicitly select the secondary account/credential; the machine's ordinary
Wrangler login may belong to the primary account.

If a shell reports `npm: command not found`, load the installed nvm environment
first. On this workspace:

```sh
. "$HOME/.nvm/nvm.sh"
nvm use 26.10.0
npm run prepare-guessr-hosting
```

### Secrets: Cloudflare setup is already complete

These three secrets have already been generated using 48 cryptographically
random bytes each, encoded as base64url. Their values are independent, except
where the same value must be shared between two services. Do not generate new
values to finish this deployment.

| Secret | Account and destination | Current state |
| --- | --- | --- |
| `GAME_SIGNING_SECRET` | Primary WUOTE account → `noitamap-auth`; secondary ACID HELPER account → `noitamap-guessr` | The same value is installed in both production Workers. Used for game tickets. |
| `STREAM_SIGNING_SECRET` | Secondary ACID HELPER account → `noitamap-guessr` | Installed. Used for stream sessions. |
| `DAILY_PUBLISH_SECRET` | Secondary ACID HELPER account → `noitamap-guessr` | Installed on the Worker; the owner confirmed adding the matching GitLab `GUESSR_DAILY_PUBLISH_SECRET` on 2026-10-31. |

The account IDs are WUOTE `666c045f38dd332e459bfe2a18c4e9a9` and ACID HELPER
`3d75ffad634d443fca37da68c0ed4f3c`. The development auth Worker deliberately does
not receive the production game-signing key.

The existing publisher value is saved locally in
`task/guessr/private/production-prep-2026-10-25/cloudflare/gitlab-publisher-secret.env`.
The owner confirmed this value was added to GitLab as
`GUESSR_DAILY_PUBLISH_SECRET`, together with the secondary-account Pages token
`GUESSR_CLOUDFLARE_API_TOKEN`, on 2026-10-31. The first publication job will verify
that both credentials work; no secret values were read back from GitLab.

The other installed values are in `game-worker-secrets.json` and
`auth-game-secret.json` in the same ignored directory. These files have owner-only
read/write permissions. Keep every value out of Git, command arguments, logs and
job artifacts. The
primary auth account has its own `ACCOUNT_DB` registry and migration;
see [the auth configuration](../noitamap-auth/README.md). Named auth
environments with different JWT secrets need separate account databases.

The image uploads, Worker secrets and all three mode flags are configured.
Daily still requires its first published image package; enabling the mode does
not create one.

## Private repository preparation

Three standalone local repositories are prepared under
`task/guessr/private/repository-export-2026-10-25/`. Their `main` branches are now
pushed to private repositories under `WUOTE`, preserving the initial GitHub
README commits:

| Repository folder | Versioned contents |
| --- | --- |
| [`noitaguessr-tiles`](https://github.com/WUOTE/noitaguessr-tiles) | `public/images/`, safe dataset metadata, headers and a validated build to `dist/` |
| [`noitaguessr-map`](https://github.com/WUOTE/noitaguessr-map) | Reference tiles in `public/`, clean snapshot in `background/`, and a build selecting one dataset into `dist/` |
| [`noitamap-guessr`](https://github.com/WUOTE/noitamap-guessr) | Worker source, its 19 required shared modules, locked dependencies, schema migrations and the private answer/image dataset |

The API repository also has recovery archives of the uncommitted Noitamap and
baker source changes, with their base commits and checksums. They exclude
credential files. The original 419 MiB capture needs a private GitHub release
asset: it exceeds the 100 MiB limit for a normal Git file.

All three local exports passed their build/package checks. The image builds
reject unexpected public files, and the exports/recovery archives were checked
against the actual three generated secret values. Credential paths are ignored
in the main map, Pro, baker and exported repositories. Nothing is staged.

The private repositories are verified on GitHub. The image repositories retain
their clean pushed baselines; the API checkout has the pending release changes
described above. Each child folder is a separate Git repository; do not
force-add the ignored parent directory to the public Noitamap repository.
The upload used the existing VS Code HTTPS Git sign-in. Cloudflare's native
Git connections are now configured for all three private repositories.

The existing Pages projects were successfully connected in place on October 26,
retaining their project IDs, domains and older immutable deployments. The earlier
replacement-project advice does not apply to this setup. No domain migration or
Daily asset-host change is needed.

| Cloudflare project | Repository root | Build command | Output / deploy |
| --- | --- | --- | --- |
| `noitaguessr-tiles` (Pages) | Repository root | `npm run build` | `dist` |
| `noitaguessr-map` (Pages) | Repository root | `npm run build` | `dist` |
| `noitamap-guessr` (Worker) | `workers/noitamap-guessr` | `npm run typecheck` | `npx wrangler deploy` |

All three watch `main`. The Worker's preview configuration uses the same root
and type-check command, with its existing `npx wrangler preview` deploy command.
Do not leave Pages build/output settings blank: that publishes the repository
root under incorrect URLs, and the map repository's two datasets together exceed
the Pages per-deployment file limit.

The secondary account also contains `twitch-relay`, `ups-main`, and four older
`sage-data-*` projects. They are not included in the three Guessr exports.
The SAGE data totals 806 GiB locally; version its source, configuration and
deployment manifests rather than trying to commit that bulk dataset to GitHub.
Existing Cloudflare data survives VM deletion, but Git-backed recovery for
those older projects still needs separate work.

The VM should only be discarded after the remote pushes, original capture
archive and fresh-clone deployments have been verified. Local prepared folders
and local recovery archives alone do not satisfy that requirement.

## Daily GitLab job

Full games now contain ten rounds (50,000 points maximum); the demo stays at
three rounds. Before deploying the updated Guessr API, apply migration
`0004_ten_rounds.sql` to its D1 database. It expands the existing round/score
constraints; no five-round game compatibility is supported. Run from
`workers/noitamap-guessr` with the secondary-account credentials:

```sh
npx wrangler d1 migrations apply noitamap-guessr --remote
```

The updated Daily preparer selects ten locations from the same prepared image
set. No extra full-map render or additional tile deployment is required solely
because the number of rounds increased.

The baker repository is `task/biome-baker`. Its `guessr-daily` job consumes the
completed `bake` artifacts and runs **alongside** the normal map `deploy` job.
Both need only `bake`; map publication does not depend on Guessr. The Guessr job
has `allow_failure: true` and its own resource group. There is no second render
of the map and no Guessr work in the map publication script.

The bake records `out/source-revision.txt`. Guessr checks out that exact
Noitamap revision, checks the seed/manifest/tiles, composites the native overlay
over the clean static background, and exports the whole reusable opaque image
set. It recomputes valid starts and selects ten shared rounds once in CI.
Gameplay selects existing images; it never slices or renders them again.

The clean background is a one-time snapshot of the dynamic map's static layer,
not a full map captured from another seed. Prepare it using:

```sh
node --import tsx build_scripts/guessr/daily-background.mts \
  --out=task/guessr/private/background-site \
  --cache=task/guessr/private/background-cache
```

Upload that directory to a `background` preview branch of `noitaguessr-map`.
Pin its **immutable deployment URL** ending in `/background.json` as
`GUESSR_BACKGROUND_URL`. Never use the moving branch alias for this setting.
GitLab caches the downloaded tiles by background identity.

The job supplies the non-secret settings below. Add only the two secrets as
protected, masked/hidden baker CI/CD variables, available to the protected ref
used by daily triggers. Do not reuse the main map API token. Project variables
can override the other settings if hosting changes.

| Variable | Value |
| --- | --- |
| `GUESSR_CLOUDFLARE_ACCOUNT_ID` | `3d75ffad634d443fca37da68c0ed4f3c` |
| `GUESSR_CLOUDFLARE_API_TOKEN` | Secondary-account token with Pages Edit |
| `GUESSR_CLUE_PROJECT` | `noitaguessr-tiles` |
| `GUESSR_REFERENCE_PROJECT` | `noitaguessr-map` |
| `GUESSR_API_URL` | `https://guessr-api.sage-data.xyz` |
| `GUESSR_DAILY_PUBLISH_SECRET` | Same publisher secret as the game Worker |
| `GUESSR_BACKGROUND_URL` | `https://be7f1c1e.noitaguessr-map.pages.dev/background.json` |

Daily uploads use the `daily-images` preview branch on the two existing Pages
projects. The package records each immutable deployment URL, so the captured
dataset, yesterday's Daily and unfinished games are not overwritten. The
publisher checks the current/previous daily seed before upload and again before
activation, verifies the selected images are available, then activates all ten
rounds in one D1 batch. A missing image, changed seed, stale bake or a replacement
after a player started leaves the existing Daily unchanged.

On a web-triggered pipeline the Guessr publication is a separate optional manual
job. Scheduled/triggered daily pipelines run it automatically. `DEPLOY=0` prepares
and validates only. `GUESSR_DAY=YYYY-MM-DD` can explicitly set the date; otherwise
the pipeline creation date is used, minus one day for `yesterdays-daily`.

Only safe `manifest.json` and `publication.json` receipts are retained as GitLab
artifacts, for two days. Private question data and image sets are not artifacts.
Pages preview deployments are retained; automatic deletion of old image
deployments is not configured and must not remove images for ongoing games.

## Rollout and checks

1. Complete the secondary images/API and primary auth configuration.
2. Prepare the map and matching Pro changes for the user's separate commits;
   keep Guessr on the aligned `dynamic-map` base. No staging/pushing is automated.
3. Push/merge the Noitamap source before the baker change: the baker pins the
   actual renderer revision, which must contain the new preparation scripts.
4. Set the GitLab variables, push the baker changes and run one manual Daily
   publication. Check its receipt matches the published map's day/seed.
5. Manually verify Demo, Pro Daily including refresh, and a streamer/chatter
   game in separate tabs. Confirm private assets return 404, clues use opaque
   filenames, and local testing controls are absent on the production origin.

Relevant local checks cover real image composition/export, publication failures,
atomic Daily replacement, scoring, refresh/resume and the independent GitLab
job graph. Root and both Worker typechecks/builds are also required. A dry-run
build does not prove live OAuth consent or production provider responses.
