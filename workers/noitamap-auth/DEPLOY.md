# Deploy from a copied folder

The `noitamap-auth` folder contains its own game-ticket issuer and can be deployed
without the neighboring Guessr project. Copy `src/`, `migrations/`,
`wrangler.jsonc`, `package.json`, `package-lock.json` and `tsconfig.json`.
Install dependencies on the destination machine so its executable links match
that system. From the copied folder, using the primary Cloudflare account:

```sh
npm ci
npm run deploy
```

For a build check without uploading, run `npm run deploy -- --dry-run`.
Keep `.env` and `.dev.vars` files, plus the `.wrangler` and `node_modules`
directories, out of the transfer archive. Production secrets remain in Cloudflare.
