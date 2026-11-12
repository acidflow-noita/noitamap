# Deploy from a copied folder

For security v2, apply migrations and provision the new independent keys first,
as described in [README.md](README.md). Coordinate the client and Worker rollout;
copying the folder alone does not provision those resources.

The `noitamap-auth` folder contains its own game-ticket issuer and can be deployed
without the neighboring Guessr project. Copy `src/`, `migrations/`,
`wrangler.jsonc`, `package.json`, `package-lock.json` and `tsconfig.json`.
Also copy `check-cleanup.mjs`. Install dependencies on the destination machine
so its executable links match that system. Use Node.js 22.12.0 or later.
The lockfile pins Wrangler 4.160.1 with patched dependencies. The two required
binary install scripts are approved by exact package version in `package.json`.
Do not use `npm audit fix --force` or approve every dependency script.

On the Windows host, overwrite the matching files in
`C:\Users\Alex\Documents\git\Personal\noitamap\workers\noitamap-auth`.
Using the existing **primary account** login, run these PowerShell commands one
at a time and stop if a command fails:

```powershell
Set-Location 'C:\Users\Alex\Documents\git\Personal\noitamap\workers\noitamap-auth'
npm ci
npx wrangler d1 migrations apply ACCOUNT_DB --remote
npm run deploy
npm run deploy:dev
node .\check-cleanup.mjs
```

`npm ci` installs local dependencies; it does not deploy either Worker. The two
deploy commands upload production auth and the disabled dev configuration,
respectively. The migration command applies `0002_sessions.sql` if missing and
does nothing when it has already been applied. Keep the production keys already
created in Secrets Store; do not generate replacements during this file copy.

After deployment, the checker should report `productionAuthV2: true` and
`developmentAuthDisabled: true`. Legacy provider counts can remain nonzero until
scheduled migration at 05:17 UTC; this does not require a new login to the VM.
Keep the legacy provider key until migration is confirmed complete. Do not run
secret deletion commands while either deployment check is false.

For a build check without uploading, run `npm run deploy -- --dry-run`.
Keep `.env` and `.dev.vars` files, plus the `.wrangler` and `node_modules`
directories, out of the transfer archive. Production secrets remain in Cloudflare.
