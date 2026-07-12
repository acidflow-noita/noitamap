// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "../../noitamap-pro/src/public-report-entry";

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

describe("anonymous public Seed Report", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById("seed-report-style")?.remove();
  });

  it("opens the TLDR and locked upsell without authentication", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    document.body.innerHTML = '<input id="seedReportToggleBtn" type="checkbox"><input id="drawToggleBtn" type="checkbox">';

    const hooks: any = {
      i18next: { t: (_key: string, options: any = {}) => options.defaultValue || _key, on: () => {} },
      authService: {
        getState: () => ({ authenticated: false, isSubscriber: false }),
        getToken: () => null,
        isAuthenticated: () => false,
        isFollower: () => false,
        isSubscriber: () => false,
        login: vi.fn(),
        loginTwitch: vi.fn(),
        logout: async () => {},
        subscribe: () => () => {},
      },
      getAllDynamicPOIs: () => [{ id: "chest-1", type: "chest", pw: 0, worldX: 0, worldY: 0 }],
      getDynamicPOIs: () => [],
      getSeedParams: () => ({ seed: 123, isDaily: false }),
      isLightMode: () => false,
      isSpoilerFree: () => false,
      onMapChange: () => {},
      onIndexingStateChange: () => {},
      onSpoilerFreeChange: () => {},
    };

    await init(hooks);
    hooks.handleSeedReportToggle(true);

    expect(document.querySelector("#seed-report-sidebar.open")).not.toBeNull();
    expect(document.querySelector(".sr-tldr")).not.toBeNull();
    expect(document.body.textContent).toContain("How this seed compares");
    expect(document.body.textContent).toContain("Seed report is a Pro feature");
    expect(document.body.textContent).toContain("Sign in with Patreon");
  });
});

