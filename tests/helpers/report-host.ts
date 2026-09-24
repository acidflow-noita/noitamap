import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveLocalPro } from "../../build_scripts/local-pro";
import { createBakedSageSnapshot, decodeSageRecord } from "../../src/sage/records";

/** Minimal real host contract for integration tests of the local report entries. */
export function createReportHostFixture(state = { authenticated: false, isSubscriber: false }) {
  const proRoot = resolveLocalPro(resolve(import.meta.dirname, "../..")).root!;
  const archive = JSON.parse(readFileSync(resolve(proRoot, "tests/fixtures/sage/306813029.json"), "utf8"));
  const record = { ...decodeSageRecord(Buffer.from(archive.data, "base64"), archive.seed), populationRevision: 4 };
  const snapshot = createBakedSageSnapshot(record.seed, record);
  document.body.innerHTML = '<input id="seedReportToggleBtn" type="checkbox"><input id="drawToggleBtn" type="checkbox">';
  let authListener: (() => void) | undefined;
  const pois = [{ id: "chest-1", type: "chest", pw: 0, worldX: 0, worldY: 0 }];
  const authService = {
    getState: () => ({ ...state, username: null, nickname: null, isFollower: false, provider: null }),
    getToken: () => null,
    isAuthenticated: () => state.authenticated,
    isFollower: () => false,
    isSubscriber: () => state.isSubscriber,
    login: vi.fn(),
    loginTwitch: vi.fn(),
    logout: async () => {},
    subscribe: (listener: () => void) => { authListener = listener; return () => {}; },
  };
  const hooks = {
    proFeatureAPI: 1,
    i18next: {
      language: "en",
      t: (key: string, options: any = {}) => String(options.defaultValue ?? key)
        .replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? "")),
      on: () => {},
    },
    authService,
    getAllDynamicPOIs: () => pois,
    getDynamicPOIs: () => [],
    getSeedParams: () => ({ seed: record.seed, isDaily: false }),
    getBakedSageSnapshot: () => snapshot,
    isLightMode: () => false,
    isSpoilerFree: () => false,
    onMapChange: () => {},
    onIndexingStateChange: () => {},
    onSpoilerFreeChange: () => {},
  } as unknown as NoitamapProHooks;
  return { hooks, authService, state, refreshAuth: () => authListener?.() };
}

export function clearReportHostFixture(hooks: NoitamapProHooks) {
  hooks.handleSeedReportToggle?.(false);
  document.body.replaceChildren();
  for (const id of ["seed-report-v3-style", "seed-report-summary-style"]) document.getElementById(id)?.remove();
  history.replaceState(null, "", "/");
}
