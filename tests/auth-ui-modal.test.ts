// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

class ModalStub {
  show(): void {}
  hide(): void {}
}

describe("Get Pro modal provider state", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it.each([
    [null, true, true],
    ["patreon", false, true],
    ["twitch", true, false],
  ] as const)("provider %s controls visible login buttons", async (provider, showPatreon, showTwitch) => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal("bootstrap", { Modal: ModalStub });
    const { authService } = await import("../src/auth/auth-service");
    const { AuthUI } = await import("../src/auth/auth-ui");
    (authService as any).state = {
      authenticated: provider !== null,
      username: "user",
      nickname: "user",
      isFollower: false,
      isSubscriber: false,
      provider,
    };

    AuthUI.showGetProModal();

    expect(!!document.querySelector("#patreonLoginBtn")).toBe(showPatreon);
    expect(!!document.querySelector("#twitchLoginBtn")).toBe(showTwitch);
  });
});
