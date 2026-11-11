import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { contentSecurityPolicy } from './security-headers.ts';

// Build inputs / duplicate metadata. Runtime translations use locales and
// telescope's data/translations.csv; sprite metadata uses generated JS chunks.
const BUILD_ONLY_PUBLIC_FILES = [
  "game-translations/common.csv",
  "translations.csv",
  "assets/atlas.json",
];
const IMMUTABLE_PATH = "/build/*";

/** Cloudflare Pages already negotiates gzip/Brotli. Keep the deploy small and
 * cache only the separate bucket containing Vite's fingerprinted outputs. */
export function deliveryPlugin(): Plugin {
  let config: ResolvedConfig;
  let enabled = false;
  return {
    name: "production-delivery",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
      const input = config.build.rollupOptions.input;
      const inputs = typeof input === "string" ? [input] : Array.isArray(input) ? input : Object.values(input || {});
      // Native bakers/tests provide TS entries and keep their existing output.
      enabled = !config.isWorker && !config.build.ssr && !config.build.lib &&
        config.build.assetsDir === "build" &&
        inputs.every(input => input.endsWith('.html')) &&
        inputs.some(input => resolve(config.root, input) === resolve(config.root, "index.html"));
    },
    async transformIndexHtml(html) {
      if (!enabled || !html.includes('src="/auth-bootstrap.js"')) return html;
      const script = await readFile(resolve(config.root, 'public/auth-bootstrap.js'), 'utf8');
      // Cleanup must not depend on another request succeeding. The generated
      // CSP hashes these exact bytes; Rocket Loader must leave their order alone.
      return html.replace(/<script\b[^>]*\bsrc="\/auth-bootstrap\.js"[^>]*>\s*<\/script>/,
        `<script data-cfasync="false">${script}</script>`);
    },
    async writeBundle(options, bundle) {
      if (!enabled || !bundle["index.html"]) return;
      const outDir = resolve(config.root, options.dir || config.build.outDir);
      for (const file of BUILD_ONLY_PUBLIC_FILES) await rm(resolve(outDir, file), { force: true });
      const headersPath = resolve(outDir, "_headers");
      let headers = "";
      try {
        headers = await readFile(headersPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // A user-authored policy takes precedence. Never append a second cache
      // directive: Pages concatenates matching header values rather than
      // applying a most-specific-rule-wins policy.
      if (/^\s*Cache-Control\s*:/im.test(headers)) {
        this.warn("Existing _headers cache policy retained; configure /build/* caching there if desired.");
      } else {
        headers += `\n# Vite fingerprinted outputs only.\n${IMMUTABLE_PATH}\n  Cache-Control: public, max-age=31536000, immutable\n`;
      }
      if (/^\s*Content-Security-Policy(?:-Report-Only)?\s*:/im.test(headers))
        throw Error('Review the existing CSP before combining it with the generated security policy.');
      const documents = Object.values(bundle).filter(file => file.type === 'asset' && file.fileName.endsWith('.html'))
        .map(file => 'source' in file ? typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source) : '');
      // Public copies are not Rollup assets. The OAuth callback must keep its
      // synchronous scrub/postMessage script under the same origin-wide policy.
      try { documents.push(await readFile(resolve(outDir, 'guess/twitch-callback.html'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      headers += `\n/*\n  Cache-Control: no-transform\n  Content-Security-Policy: ${contentSecurityPolicy(documents)}\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n/auth-bootstrap.js\n  Cache-Control: no-cache\n`;
      await writeFile(headersPath, headers.trimStart());
    },
  };
}
