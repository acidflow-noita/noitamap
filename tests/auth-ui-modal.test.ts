// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState, LinkedAccount } from "../src/auth/auth-service";

const mocks = vi.hoisted(() => ({
  state: {
    authenticated: false,
    username: null,
    nickname: null,
    isFollower: false,
    isSubscriber: false,
    provider: null,
  } as AuthState,
  authListeners: new Set<(state: AuthState) => void>(),
  languageListeners: new Set<() => void>(),
  translationPrefix: "",
  dialogShow: Promise.resolve(),
  dialogHide: Promise.resolve(),
  menuHide: Promise.resolve(),
  dialogs: [] as Array<{
    element: HTMLDialogElement;
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  menus: [] as Array<{
    element: HTMLElement;
    menu: HTMLElement;
    config: { placement: string };
    hide: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../src/bootstrap", () => {
  const menus = new WeakMap<HTMLElement, Menu>();

  class Dialog {
    constructor(public element: HTMLDialogElement) {
      mocks.dialogs.push(this);
    }

    show = vi.fn(async () => {
      this.element.open = true;
      await mocks.dialogShow;
      this.element.dispatchEvent(new Event("shown.bs.dialog"));
    });

    hide = vi.fn(async () => {
      if (!this.element.dispatchEvent(new Event("hide.bs.dialog", { cancelable: true }))) return;
      await mocks.dialogHide;
      this.element.open = false;
      // Bootstrap fires hidden before the lifecycle promise resolves.
      this.element.dispatchEvent(new Event("hidden.bs.dialog"));
    });

    dispose = vi.fn();
  }

  class Menu {
    menu: HTMLElement;

    constructor(public element: HTMLElement, public config: { placement: string }) {
      this.menu = element.nextElementSibling as HTMLElement;
      menus.set(element, this);
      mocks.menus.push(this);
    }

    static getInstance(element: HTMLElement): Menu | null {
      return menus.get(element) ?? null;
    }

    hide = vi.fn(async () => {
      if (!this.menu.classList.contains("show")) return;
      this.element.dispatchEvent(new Event("hide.bs.menu", { cancelable: true }));
      this.menu.classList.remove("show");
      await mocks.menuHide;
      this.element.setAttribute("aria-expanded", "false");
      this.element.dispatchEvent(new Event("hidden.bs.menu"));
    });

    dispose = vi.fn(() => menus.delete(this.element));
  }

  return { Dialog, Menu };
});

vi.mock("../src/auth/auth-service", () => ({
  authService: {
    getState: vi.fn(() => ({ ...mocks.state })),
    init: vi.fn(async () => ({ ...mocks.state })),
    subscribe: vi.fn((listener: (state: AuthState) => void) => {
      mocks.authListeners.add(listener);
      return () => mocks.authListeners.delete(listener);
    }),
    login: vi.fn(),
    loginTwitch: vi.fn(),
    unlink: vi.fn(async (provider: LinkedAccount['provider']) => {
      mocks.state = { ...mocks.state, linkedAccounts: mocks.state.linkedAccounts?.filter(account => account.provider !== provider) };
    }),
    logout: vi.fn(async () => {
      mocks.state = { ...mocks.state, authenticated: false, provider: null };
      mocks.authListeners.forEach((listener) => listener(mocks.state));
    }),
  },
}));

vi.mock("../src/i18n", () => ({
  default: {
    t: (_key: string, fallback: string) => mocks.translationPrefix + fallback,
    on: (_event: string, listener: () => void) => mocks.languageListeners.add(listener),
  },
}));

import { authService } from "../src/auth/auth-service";
import { AuthUI } from "../src/auth/auth-ui";

function pendingTransition() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setAuthState(state: Partial<AuthState>) {
  mocks.state = { ...mocks.state, ...state };
  mocks.authListeners.forEach((listener) => listener(mocks.state));
}

function linkedAccount(provider: LinkedAccount['provider'], values: Partial<LinkedAccount> = {}): LinkedAccount {
  return {
    provider, userId: `${provider}-user`, username: provider, login: null,
    isFollower: false, isSubscriber: false, membershipStatus: 'inactive', checkedAt: 0,
    ...values,
  };
}

async function createAuthUI() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  new AuthUI(container);
  await Promise.resolve();
  return container;
}

it('reserves both account labels before a delayed sign-in check completes', async () => {
  let resolve!: (state: AuthState) => void;
  vi.mocked(authService.init).mockImplementationOnce(() => new Promise<AuthState>(done => { resolve = done; }));
  const container = document.createElement('div'); document.body.append(container);
  new AuthUI(container);
  const sizer = container.querySelector('.auth-button-sizer')!;
  expect(sizer.getAttribute('aria-hidden')).toBe('true');
  expect(sizer.textContent).toContain('Get Pro');
  expect(sizer.textContent).toContain('Your account');
  resolve({ ...mocks.state, authenticated: true, provider: 'twitch' });
  await vi.waitFor(() => expect(container.querySelector('#authButton')?.textContent).toContain('Your account'));
  expect(container.querySelector('.auth-button-sizer')).toBe(sizer);
  expect(container.querySelector('#authButton')!.nextElementSibling?.classList.contains('menu')).toBe(true);
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = {
    authenticated: false,
    username: null,
    nickname: null,
    isFollower: false,
    isSubscriber: false,
    provider: null,
  };
  mocks.translationPrefix = "";
  mocks.dialogShow = Promise.resolve();
  mocks.dialogHide = Promise.resolve();
  mocks.menuHide = Promise.resolve();
  mocks.dialogs.length = 0;
  mocks.menus.length = 0;
});

afterEach(() => {
  document.body.replaceChildren();
  mocks.authListeners.clear();
  mocks.languageListeners.clear();
});

describe("Get Pro dialog", () => {
  it.each([
    [null, true, true],
    ["patreon", false, true],
    ["twitch", true, false],
  ] as const)("provider %s controls visible login buttons", (provider, showPatreon, showTwitch) => {
    setAuthState({ authenticated: provider !== null, provider });

    AuthUI.showGetProModal();

    const dialog = document.querySelector<HTMLDialogElement>("#getProModal")!;
    expect(dialog).toBeInstanceOf(HTMLDialogElement);
    expect(dialog.classList.contains("dialog")).toBe(true);
    expect(dialog.getAttribute("data-bs-theme")).toBe("dark");
    expect(dialog.querySelector(":scope > .dialog-body")).not.toBeNull();
    expect(dialog.querySelector(".modal-dialog, .modal-content, .btn-close-white")).toBeNull();
    expect(dialog.querySelector('[data-bs-dismiss="dialog"]')).not.toBeNull();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Get Pro");
    expect(!!dialog.querySelector("#patreonLoginBtn")).toBe(showPatreon);
    expect(!!dialog.querySelector("#twitchLoginBtn")).toBe(showTwitch);
    expect(dialog.querySelectorAll('.pro-col > .btn-patron[target="_blank"]')).toHaveLength(2);
    expect(dialog.querySelectorAll('.pro-gift')).toHaveLength(2);
    expect(mocks.dialogs[0].show).toHaveBeenCalledOnce();
  });

  it("localizes its close action using the shared map label", () => {
    mocks.translationPrefix = "Translated ";
    AuthUI.showGetProModal();
    expect(document.querySelector('[data-bs-dismiss="dialog"]')?.getAttribute('aria-label')).toBe('Translated Close');
  });

  it("shares a dialog across repeated requests until it is dismissed", async () => {
    AuthUI.showGetProModal();
    AuthUI.showGetProModal();

    expect(document.querySelectorAll("#getProModal")).toHaveLength(1);
    expect(mocks.dialogs).toHaveLength(1);

    await mocks.dialogs[0].hide();

    expect(mocks.dialogs[0].dispose).toHaveBeenCalledOnce();
    expect(document.querySelector("#getProModal")).toBeNull();

    AuthUI.showGetProModal();
    expect(mocks.dialogs).toHaveLength(2);
  });

  it.each([
    ["#patreonLoginBtn", "login"],
    ["#twitchLoginBtn", "loginTwitch"],
  ] as const)("waits for show and hide before %s starts sign-in", async (selector, loginMethod) => {
    const showing = pendingTransition();
    const hiding = pendingTransition();
    mocks.dialogShow = showing.promise;
    mocks.dialogHide = hiding.promise;
    AuthUI.showGetProModal();
    const instance = mocks.dialogs[0];
    const button = instance.element.querySelector<HTMLButtonElement>(selector)!;
    const onHidden = vi.fn(() => {
      expect(instance.dispose).not.toHaveBeenCalled();
      expect(authService[loginMethod]).not.toHaveBeenCalled();
    });
    instance.element.addEventListener("hidden.bs.dialog", onHidden, { once: true });

    button.click();
    button.click();
    const otherLogin = loginMethod === 'login' ? 'loginTwitch' : 'login';
    instance.element.querySelector<HTMLButtonElement>(loginMethod === 'login' ? '#twitchLoginBtn' : '#patreonLoginBtn')!.click();
    expect(instance.hide).not.toHaveBeenCalled();
    expect(authService[loginMethod]).not.toHaveBeenCalled();

    showing.resolve();
    await vi.waitFor(() => expect(instance.hide).toHaveBeenCalledOnce());
    expect(instance.element.isConnected).toBe(true);
    expect(instance.dispose).not.toHaveBeenCalled();
    expect(authService[loginMethod]).not.toHaveBeenCalled();

    hiding.resolve();
    await vi.waitFor(() => expect(authService[loginMethod]).toHaveBeenCalledOnce());
    expect(onHidden).toHaveBeenCalledOnce();
    expect(instance.dispose).toHaveBeenCalledOnce();
    expect(instance.element.isConnected).toBe(false);
    expect(instance.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(authService[loginMethod]).mock.invocationCallOrder[0],
    );
    expect(authService[otherLogin]).not.toHaveBeenCalled();
  });

  it("cancels sign-in when dialog hiding is prevented and permits a later provider request", async () => {
    AuthUI.showGetProModal();
    const instance = mocks.dialogs[0];
    instance.element.addEventListener('hide.bs.dialog', event => event.preventDefault(), { once: true });

    instance.element.querySelector<HTMLButtonElement>('#patreonLoginBtn')!.click();
    await vi.waitFor(() => expect(instance.hide).toHaveBeenCalledOnce());
    expect(instance.element.open).toBe(true);
    expect(instance.dispose).not.toHaveBeenCalled();
    expect(authService.login).not.toHaveBeenCalled();

    instance.element.querySelector<HTMLButtonElement>('#twitchLoginBtn')!.click();
    await vi.waitFor(() => expect(authService.loginTwitch).toHaveBeenCalledOnce());
    expect(authService.login).not.toHaveBeenCalled();
    expect(instance.dispose).toHaveBeenCalledOnce();
  });
});

describe("Shared provider controls", () => {
  it("keeps inline IDs unique and saves before starting the selected provider login", () => {
    const calls: string[] = [];
    vi.mocked(authService.login).mockImplementationOnce(() => { calls.push('patreon'); });
    vi.mocked(authService.loginTwitch).mockImplementationOnce(() => { calls.push('twitch'); });
    const inline = AuthUI.createProControls({
      beforeLogin: () => { calls.push('save'); },
      idPrefix: 'guessr-daily-',
    });
    document.body.append(inline);
    AuthUI.showGetProModal();
    expect(document.querySelectorAll('#patreonLoginBtn')).toHaveLength(1);
    expect(document.querySelectorAll('#guessr-daily-patreonLoginBtn')).toHaveLength(1);

    inline.querySelector<HTMLButtonElement>('.btn-patreon')!.click();
    inline.querySelector<HTMLButtonElement>('.btn-twitch')!.click();
    expect(calls).toEqual(['save', 'patreon', 'save', 'twitch']);
    expect(authService.login).toHaveBeenCalledOnce();
    expect(authService.loginTwitch).toHaveBeenCalledOnce();
  });

  it("shows both linked memberships and gifts without interpreting account names as markup", () => {
    setAuthState({
      authenticated: true, provider: 'patreon', accountId: 'linked-account', isSubscriber: true,
      linkedAccounts: [
        linkedAccount('patreon', { username: 'Supporter', isSubscriber: true, membershipStatus: 'active' }),
        linkedAccount('twitch', { username: '<img src=x onerror=alert(1)>' }),
      ],
    });
    const controls = AuthUI.createProControls();
    expect(controls.querySelectorAll('.pro-provider-status')).toHaveLength(2);
    expect(controls.querySelectorAll('.pro-membership-active')).toHaveLength(1);
    expect(controls.querySelectorAll('.pro-membership-inactive')).toHaveLength(1);
    expect(controls.querySelectorAll('.pro-unlink')).toHaveLength(2);
    expect(controls.querySelectorAll('.btn-twitch, .btn-patreon')).toHaveLength(0);
    expect(controls.querySelectorAll('.pro-gift')).toHaveLength(2);
    expect(controls.querySelector('img')).toBeNull();
    expect(controls.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it("retains the host login guard after disconnecting a linked account", async () => {
    setAuthState({
      authenticated: true, provider: 'patreon', accountId: 'linked-account',
      linkedAccounts: [linkedAccount('patreon'), linkedAccount('twitch')],
    });
    const onLogin = vi.fn<(startLogin: () => void) => void>();
    const beforeLogin = vi.fn();
    const container = document.createElement('div');
    container.append(AuthUI.createProControls({ onLogin, beforeLogin }));
    document.body.append(container);
    container.querySelector<HTMLButtonElement>('.pro-unlink')!.click();
    await vi.waitFor(() => expect(container.querySelector('#twitchLoginBtn')).not.toBeNull());

    container.querySelector<HTMLButtonElement>('#twitchLoginBtn')!.click();
    expect(onLogin).toHaveBeenCalledOnce();
    expect(beforeLogin).not.toHaveBeenCalled();
    expect(authService.loginTwitch).not.toHaveBeenCalled();
    onLogin.mock.calls[0][0]();
    expect(beforeLogin).toHaveBeenCalledOnce();
    expect(authService.loginTwitch).toHaveBeenCalledOnce();
  });
});

describe("Auth account menu", () => {
  it("shows every connected provider and opens account management for subscribers", async () => {
    setAuthState({
      authenticated: true, provider: 'patreon', accountId: 'linked-account', isSubscriber: true,
      linkedAccounts: [linkedAccount('patreon'), linkedAccount('twitch')],
    });
    const container = await createAuthUI();
    expect(container.querySelector('.menu-header')?.textContent).toContain('Patreon + Twitch');
    const manage = container.querySelector<HTMLButtonElement>('#manageAccountsBtn')!;
    expect(manage.classList.contains('menu-item')).toBe(true);
    expect(manage.textContent).toBe('Connected accounts');
    manage.click();
    expect(document.querySelectorAll('#getProModal .pro-provider-status')).toHaveLength(2);
  });

  it.each([false, true])("renders a flat account menu with subscriber=%s", async (isSubscriber) => {
    setAuthState({ authenticated: true, provider: "twitch", isSubscriber });
    const container = await createAuthUI();
    const button = container.querySelector("#authButton")!;
    const menu = container.querySelector(".menu")!;

    expect(button.getAttribute("data-bs-toggle")).toBe("menu");
    expect(button.classList.contains("theme-success")).toBe(true);
    expect(button.nextElementSibling).toBe(menu);
    expect(menu.tagName).toBe("DIV");
    expect(menu.querySelector("ul, li")).toBeNull();
    expect(container.querySelector(".dropdown, .dropdown-toggle, .dropdown-menu")).toBeNull();
    expect(menu.querySelector(".menu-header")?.textContent).toContain("Twitch");
    expect(!!menu.querySelector("#upgradeProBtn")).toBe(!isSubscriber);
    expect(!!menu.querySelector(".fg-success")).toBe(isSubscriber);
    expect(mocks.menus[0].config).toEqual({ placement: "bottom-end" });

    menu.querySelector<HTMLButtonElement>("#upgradeProBtn")?.click();
    expect(!!document.querySelector("#getProModal")).toBe(!isSubscriber);
  });

  it("waits for menu hide before removing it after sign-out", async () => {
    setAuthState({ authenticated: true, provider: "patreon" });
    const container = await createAuthUI();
    const instance = mocks.menus[0];
    instance.menu.classList.add("show");
    const hiding = pendingTransition();
    mocks.menuHide = hiding.promise;

    container.querySelector<HTMLButtonElement>("#logoutBtn")!.click();
    expect(authService.logout).toHaveBeenCalledOnce();
    expect(instance.hide).toHaveBeenCalledOnce();
    expect(instance.menu.isConnected).toBe(true);
    expect(instance.dispose).not.toHaveBeenCalled();

    hiding.resolve();
    await vi.waitFor(() => expect(instance.menu.isConnected).toBe(false));
    expect(instance.dispose).toHaveBeenCalledOnce();
    const button = container.querySelector<HTMLButtonElement>("#authButton")!;
    expect(button.getAttribute("data-bs-toggle")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBeNull();
    expect(button.textContent).toContain("Get Pro");
    button.click();
    expect(document.querySelector("#getProModal")).not.toBeNull();
  });

  it("renders the latest auth state when language changes during menu cleanup", async () => {
    setAuthState({ authenticated: true, provider: "patreon" });
    const container = await createAuthUI();
    const oldMenu = mocks.menus[0];
    oldMenu.menu.classList.add("show");
    const hiding = pendingTransition();
    mocks.menuHide = hiding.promise;

    mocks.translationPrefix = "Translated ";
    mocks.languageListeners.forEach((listener) => listener());
    setAuthState({ provider: "twitch", isSubscriber: true });
    expect(oldMenu.hide).toHaveBeenCalledOnce();
    expect(oldMenu.menu.isConnected).toBe(true);

    hiding.resolve();
    await vi.waitFor(() => expect(mocks.menus).toHaveLength(2));
    expect(oldMenu.dispose).toHaveBeenCalledOnce();
    expect(oldMenu.menu.isConnected).toBe(false);
    expect(container.querySelectorAll(".menu")).toHaveLength(1);
    expect(container.querySelector(".menu-header")?.textContent).toContain("Translated Your account: Twitch");
    expect(container.querySelector(".fg-success")?.textContent).toContain("Translated Pro active");
  });

  it("waits for an automatic menu close already in progress before rebuilding", async () => {
    setAuthState({ authenticated: true, provider: "patreon" });
    const container = await createAuthUI();
    const oldMenu = mocks.menus[0];
    oldMenu.menu.classList.add("show");
    const hiding = pendingTransition();
    mocks.menuHide = hiding.promise;

    const closed = oldMenu.hide();
    setAuthState({ isSubscriber: true });
    await Promise.resolve();
    expect(oldMenu.hide).toHaveBeenCalledOnce();
    expect(oldMenu.dispose).not.toHaveBeenCalled();
    expect(oldMenu.menu.isConnected).toBe(true);

    hiding.resolve();
    await closed;
    await vi.waitFor(() => expect(mocks.menus).toHaveLength(2));
    expect(oldMenu.dispose).toHaveBeenCalledOnce();
    expect(oldMenu.menu.isConnected).toBe(false);
    expect(container.querySelector(".fg-success")?.textContent).toContain("Pro active");
  });
});
