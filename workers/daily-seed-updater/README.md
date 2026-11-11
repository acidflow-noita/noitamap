# Daily seed updater

This Worker runs at 00:01 UTC. Its HTTP handler always returns 404, and both
workers.dev and version preview URLs are disabled in the checked-in config.
The public seed files remain on the separate `daily-seed-serve` Worker.

Before deploying this security release, create a **dedicated** Cloudflare API
token restricted to the `daily-seed-serve` Worker in the primary account and
store it as `NOITAMAP_SEED_DEPLOY_TOKEN` in the existing Secrets Store. The
`CF_API_TOKEN` binding now points to that dedicated secret. Use the per-Worker
Editor role, not an account-wide Workers edit token. Verify the actual token
scope in Cloudflare; source configuration cannot prove its privileges.

Deploy from this folder using its Wrangler configuration. The scheduled job
continues to publish the current/previous seeds and trigger the existing GitLab
baker. A repeated run with an unchanged seed does neither, preserving the
previous day's seed. If the GitLab trigger fails after publication, run the
baker manually in GitLab with that seed. Do not reintroduce a public update URL.

Provider/API error bodies and upload credentials are never logged. Successful
seed values and pipeline IDs are public operational metadata. No extra storage
or polling was added.
