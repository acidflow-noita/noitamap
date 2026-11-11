import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "vite";
import { deliveryPlugin } from "../build_scripts/vite-delivery";
import { createHash } from 'node:crypto';
import { contentSecurityPolicy } from '../build_scripts/security-headers';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(headers = "") {
  const root = await mkdtemp(join(tmpdir(), "noitamap-delivery-"));
  roots.push(root);
  const files: Record<string, string> = {
    "index.html": '<script type="module" src="/main.js"></script>',
    "main.js": 'console.log("fixture");',
    "public/game-translations/common.csv": "build input",
    "public/translations.csv": "unused duplicate",
    "public/assets/atlas.json": "{}",
    "public/data/translations.csv": "runtime translations",
    "public/assets/full_materials.json": "[]",
    "public/assets/spritesheet.png": "runtime sprites",
  };
  if (headers) files["public/_headers"] = headers;
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), contents);
  }
  return root;
}

async function compile(root: string, input = "index.html") {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [deliveryPlugin()],
    build: {
      assetsDir: "build",
      rollupOptions: { input: join(root, input) },
    },
  });
}

describe("production delivery output", () => {
  it('hashes the callback and embeds auth cleanup before other executable scripts', async () => {
    const root = await fixture();
    const bootstrap = 'window.bootstrapRan = true;', callback = 'window.callbackRan = true;';
    await writeFile(join(root, 'index.html'), '<!doctype html><html><head><script data-cfasync="false" src="/auth-bootstrap.js"></script></head><body><script type="module" src="/main.js"></script></body></html>');
    await writeFile(join(root, 'public/auth-bootstrap.js'), bootstrap);
    await mkdir(join(root, 'public/guess'));
    await writeFile(join(root, 'public/guess/twitch-callback.html'), `<script data-cfasync="false">${callback}</script>`);
    await compile(root);
    const html = await readFile(join(root, 'dist/index.html'), 'utf8'), headers = await readFile(join(root, 'dist/_headers'), 'utf8');
    expect(html).toContain('<script data-cfasync="false">' + bootstrap + '</script>');
    expect(html).not.toContain('src="/auth-bootstrap.js');
    expect(headers).toContain("'sha256-" + createHash('sha256').update(bootstrap).digest('base64') + "'");
    expect(html.indexOf(bootstrap)).toBeLessThan(html.indexOf('type="module"'));
    expect(headers).toContain("'sha256-" + createHash('sha256').update(callback).digest('base64') + "'");
    expect(headers).toContain("script-src-attr 'none'"); expect(headers).not.toContain("'unsafe-eval'");
    expect(headers).not.toContain('static.cloudflareinsights.com');
    expect(headers).toContain('https://www.googletagmanager.com');
  });
  it('fails a build-time policy check when a new untrusted executable CDN is introduced', () => {
    expect(() => contentSecurityPolicy(['<script src="https://cdn.example/unpinned.js"></script>'])).toThrow('Untrusted external script');
  });
  it('hashes inline scripts using the browser’s normalized HTML line endings', () => {
    const policy = contentSecurityPolicy(['<script>\r\nwindow.ready = true;\r\n</script>']);
    expect(policy).toContain(createHash('sha256').update('\nwindow.ready = true;\n').digest('base64'));
  });
  it('retains delivery policy when the independent game page is added', async () => {
    const root = await fixture();
    await mkdir(join(root, 'guess'));
    await writeFile(join(root, 'guess/index.html'), '<title>Game</title><script type="module" src="/main.js"></script>');
    await build({ root, configFile: false, logLevel: 'silent', plugins: [deliveryPlugin()],
      build: { assetsDir: 'build', rollupOptions: { input: { main: join(root, 'index.html'), game: join(root, 'guess/index.html') } } } });
    expect(await readFile(join(root, 'dist/guess/index.html'), 'utf8')).toContain('<title>Game</title>');
    expect(await readFile(join(root, 'dist/_headers'), 'utf8')).toContain('max-age=31536000, immutable');
    await expect(readFile(join(root, 'dist/game-translations/common.csv'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it("omits only build-only copies and caches the fingerprinted bucket", async () => {
    const existingHeaders = "/*\n  X-Content-Type-Options: nosniff\n";
    const root = await fixture(existingHeaders);
    await compile(root);
    const headers = await readFile(join(root, "dist/_headers"), "utf8");
    expect(headers).toContain(existingHeaders);
    expect(headers).toContain("/build/*\n  Cache-Control: public, max-age=31536000, immutable");
    expect(headers).not.toContain("/assets/*");
    for (const file of ["game-translations/common.csv", "translations.csv", "assets/atlas.json"]) {
      await expect(readFile(join(root, "dist", file))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "public", file), "utf8")).toBeTruthy();
    }
    for (const file of ["data/translations.csv", "assets/full_materials.json", "assets/spritesheet.png"])
      expect(await readFile(join(root, "dist", file), "utf8")).toBe(await readFile(join(root, "public", file), "utf8"));
  });

  it("preserves an existing cache policy without conflicting directives", async () => {
    const policy = "/*\n  Cache-Control: no-cache\n";
    const root = await fixture(policy);
    await compile(root);
    const headers = await readFile(join(root, "dist/_headers"), "utf8");
    expect(headers).toContain(policy);
    expect(headers).not.toContain('max-age=31536000');
    expect(headers).toContain('Content-Security-Policy:');
  });

  it("leaves native bake and custom JavaScript entry builds alone", async () => {
    const root = await fixture();
    await compile(root, "main.js");
    await expect(readFile(join(root, "dist/_headers"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "dist/game-translations/common.csv"), "utf8")).toBe("build input");
    expect(await readFile(join(root, "dist/assets/atlas.json"), "utf8")).toBe("{}");
  });
});
