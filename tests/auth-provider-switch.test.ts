// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

async function serviceWithProvider(provider: "patreon" | "twitch" | null) {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const { default: i18next } = await import("../src/i18n");
  if (!i18next.isInitialized) await i18next.init({ lng: "en", fallbackLng: "en", resources: {} });
  const { authService } = await import("../src/auth/auth-service");
  (authService as any).state = {
    authenticated: provider !== null,
    username: provider ? "user" : null,
    nickname: null,
    isFollower: false,
    isSubscriber: false,
    provider,
  };
  return authService;
}

describe("cross-provider login confirmation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks before patreon -> twitch and aborts on cancel", async () => {
    const auth = await serviceWithProvider("patreon");
    const confirm = vi.fn((_message?: string) => false);
    vi.stubGlobal("confirm", confirm);
    auth.loginTwitch();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain("Twitch");
    expect(confirm.mock.calls[0][0]).toContain("Patreon");
  });

  it("asks before twitch -> patreon and aborts on cancel", async () => {
    const auth = await serviceWithProvider("twitch");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    auth.login();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("does not ask when anonymous", async () => {
    const auth = await serviceWithProvider(null);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    auth.login(); // jsdom logs a navigation-not-implemented error; harmless
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not ask for same-provider login", async () => {
    const auth = await serviceWithProvider("patreon");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    auth.login();
    expect(confirm).not.toHaveBeenCalled();
  });
});
