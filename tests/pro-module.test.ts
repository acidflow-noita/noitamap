import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { build, createLogger, type UserConfig } from "vite";
import appConfig from "../vite.config";

const root = resolve(import.meta.dirname, "..");
const config = appConfig as UserConfig;
const hostedCode =
  "export async function init(hooks) { hooks.loaded.push('hosted'); }";
const dataUrl = (code: string) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

// Compile the real loader with Vite's two build-time flags. This exercises the
// actual import branches without requiring the private repo or network access.
async function compileLoader(
  dev: boolean,
  localAvailable: boolean,
  localCode?: string,
) {
  const localId = "\0test-local-pro";
  const warnings: string[] = [];
  const logger = createLogger("warn");
  logger.warn = logger.warnOnce = (message) => {
    warnings.push(message);
  };
  const result: any = await build({
    configFile: false,
    root,
    publicDir: false,
    customLogger: logger,
    define: {
      ...config.define,
      "import.meta.env.DEV": JSON.stringify(dev),
      __LOCAL_PRO_AVAILABLE__: JSON.stringify(localAvailable),
      __BUILD_VERSION__: JSON.stringify("pro-loader-test"),
    },
    plugins: [
      {
        name: "test-local-pro",
        resolveId(id) {
          if (id === "virtual:noitamap-pro") {
            return localAvailable
              ? localId
              : resolve(root, "src/pro-unavailable.ts");
          }
        },
        load(id) {
          if (id === localId) {
            return (
              localCode ??
              "export async function init(hooks) { hooks.loaded.push('local'); }"
            );
          }
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      modulePreload: false,
      lib: { entry: resolve(root, "src/pro-module.ts"), formats: ["es"] },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  expect(warnings).toEqual([]);
  const output = (Array.isArray(result) ? result : [result]).flatMap(
    (bundle: any) => bundle.output,
  );
  const entry = output.find(
    (file: any) => file.type === "chunk" && file.isEntry,
  );
  expect(entry).toBeTruthy();
  // Native import lets Node execute Vite's browser output. The Blob URL API is
  // adapted below because Node supports data: imports but not browser blob: ones.
  return import(/* @vite-ignore */ dataUrl(entry.code)) as Promise<
    typeof import("../src/pro-module")
  >;
}

function mockHostedBundle(code = hostedCode) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(code));
  vi.stubGlobal("fetch", fetchMock);
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue(dataUrl(code));
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { fetchMock, create, revoke };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Pro module selection", () => {
  it("uses the same real checkout detection for the flag and the local alias", () => {
    const localPath = resolve(root, "../noitamap-pro/src/pro-entry.ts");
    const available = existsSync(localPath);
    expect(config.define?.__LOCAL_PRO_AVAILABLE__).toBe(
      JSON.stringify(available),
    );
    const aliases = config.resolve?.alias as Record<string, string>;
    expect(aliases["virtual:noitamap-pro"]).toBe(
      available ? localPath : resolve(root, "src/pro-unavailable.ts"),
    );
  });

  it.each([
    { dev: true, localAvailable: false, source: "hosted" },
    { dev: true, localAvailable: true, source: "local" },
    { dev: false, localAvailable: false, source: "hosted" },
    { dev: false, localAvailable: true, source: "hosted" },
  ])(
    "loads $source Pro with DEV=$dev and local source=$localAvailable",
    async ({ dev, localAvailable, source }) => {
      const { loadProModule } = await compileLoader(dev, localAvailable);
      const { fetchMock, create, revoke } = mockHostedBundle();
      const hooks = { loaded: [] as string[] };
      const module = await loadProModule();
      await module.init(hooks as unknown as NoitamapProHooks);
      expect(hooks.loaded).toEqual([source]);

      if (source === "local") {
        expect(fetchMock).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      } else {
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
          "https://noitamap-pro.acidflow.stream/pro.js?v=pro-loader-test",
          { cache: "no-cache" },
        );
        expect(create).toHaveBeenCalledTimes(1);
        const blob = create.mock.calls[0][0] as Blob;
        expect(blob.type).toBe("application/javascript");
        expect(await blob.text()).toBe(hostedCode);
        expect(revoke).toHaveBeenCalledExactlyOnceWith(dataUrl(hostedCode));
      }
    },
  );

  it("does not mask a broken local Pro init by falling back to hosted code", async () => {
    const { loadProModule } = await compileLoader(
      true,
      true,
      "export async function init() { throw new Error('broken local Pro'); }",
    );
    const { fetchMock } = mockHostedBundle();
    const module = await loadProModule();
    await expect(module.init({} as NoitamapProHooks)).rejects.toThrow(
      "broken local Pro",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports real hosted HTTP failures instead of loading the unavailable placeholder", async () => {
    const { loadProModule } = await compileLoader(true, false);
    const { fetchMock, create } = mockHostedBundle();
    fetchMock.mockResolvedValue(new Response("Unavailable", { status: 503 }));
    await expect(loadProModule()).rejects.toThrow(
      "Failed to fetch Pro bundle: HTTP 503",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("propagates a hosted module failure and still releases the Blob URL", async () => {
    const { loadProModule } = await compileLoader(true, false);
    const code =
      "throw new Error('broken hosted Pro'); export async function init() {}";
    const { revoke } = mockHostedBundle(code);
    await expect(loadProModule()).rejects.toThrow("broken hosted Pro");
    expect(revoke).toHaveBeenCalledExactlyOnceWith(dataUrl(code));
  });
});
