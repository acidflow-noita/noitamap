# Daily seed updater

This Worker runs at 00:01 UTC. Its HTTP handler always returns 404, and both
workers.dev and version preview URLs are disabled in the checked-in config.
The public seed files remain on the separate `daily-seed-serve` Worker.

If the public seed files lost CORS headers after a scheduled update, deploy the
updated updater and then repair the already-published assets once. From this
folder on the primary-account Windows host, run one command at a time:

```powershell
npm ci
npm run deploy
npm run repair:headers
```

The repair fetches the two currently published seed files, validates them,
and republishes those same bytes with the header rules using Wrangler. It does
not run the baker, replace secrets, or use the stale seed files in the source
repository. Future scheduled uploads include the header rules directly in
`assets.config._headers` and set each uploaded file's text MIME type. An uploaded
`/_headers` file by itself does not configure headers in the direct-upload API.

After the repair, open `https://dynamic-map.noitamap.com/?m=dy&ds=1` to request
the actual current Daily. Do not reuse a URL already pinned to a fallback seed.

Run deployment commands on the Windows host using its existing primary-account
login. Do not sign the VM into the primary account. The checked-in config pins
account `666c045f38dd332e459bfe2a18c4e9a9`.

1. In that Cloudflare account, open **Manage Account > Account API Tokens >
   Create Token**. Name it `noitamap-seed-updater`. Set **Scope: Specified
   Workers**, select only **daily-seed-serve**, and choose **Editor**. Leave
   client-IP filtering empty because the scheduled Worker uses this token.
2. Review and create the token. Keep the token page open for the next command.
3. In PowerShell, enter this Worker directory and run `npm ci`. Then run:

   ```powershell
   npx wrangler secrets-store secret create 291b9519666945a1a56adbb686c62d76 --name NOITAMAP_SEED_DEPLOY_TOKEN --scopes workers --remote
   ```

   Paste the token at Wrangler's hidden prompt. Create this secret once; if
   it already exists, retain it or deliberately update that existing secret.
   Never put its value in a command argument, source file, chat or Git.
4. Run `npm run deploy`. This deploys **daily-seed-updater**. Its token lets it
   update **daily-seed-serve**, which is a different Worker.
5. In **Workers & Pages > daily-seed-updater > Settings**, check the Cron
   trigger is `1 0 * * *` and workers.dev/preview URLs are disabled. It runs
   next at 00:01 UTC; deploying does not run the scheduled update immediately.
   After that run, its logs should contain `Deployed daily-seed-serve with
   seed:` and `Triggered bake pipeline #` (or an unchanged-seed message).

The `CF_API_TOKEN` binding points to `NOITAMAP_SEED_DEPLOY_TOKEN`. Keep the
existing `CF_ACCOUNT_ID` and `GITLAB_BIOME_BAKER_TRIGGER_TOKEN` store entries.
Do not revoke the previous shared API token until its other consumers have
been inventoried.

[Cloudflare token scopes](https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/)
and [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/).

The scheduled job continues to publish the current/previous seeds and trigger the existing GitLab
baker. A repeated run with an unchanged seed does neither, preserving the
previous day's seed. If the GitLab trigger fails after publication, run the
baker manually in GitLab with that seed. Do not reintroduce a public update URL.

Provider/API error bodies and upload credentials are never logged. Successful
seed values and pipeline IDs are public operational metadata. No extra storage
or polling was added.
