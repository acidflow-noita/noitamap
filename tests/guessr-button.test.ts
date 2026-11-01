// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isGuessrAvailable } from "../src/guessr-availability";
import { createGuessrButton } from "../src/guessr-button";

vi.mock("../src/i18n", () => ({
  default: { t: (_key: string, fallback: string) => fallback },
}));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("dynamic-map Guessr entry", () => {
  it.each([
    "dynamic-map.noitamap.com",
    "dynamic-map.noitamap.pages.dev",
    "localhost",
    "127.0.0.1",
    "[::1]",
  ])("allows the dynamic deployment or local testing: %s", (hostname) => {
    expect(isGuessrAvailable(hostname)).toBe(true);
  });
  it.each([
    "noitamap.com",
    "dev.noitamap.com",
    "native-map.noitamap.com",
    "dynamic-map.noitamap.com.example.org",
  ])("does not expose Guessr on another deployment: %s", (hostname) => {
    expect(isGuessrAvailable(hostname)).toBe(false);
    const anchor = document.createElement("div");
    document.body.append(anchor);
    createGuessrButton(anchor, { hostname }, false);
    expect(document.getElementById("noitaGuessrButton")).toBeNull();
  });
  it("adds one direct navbar link beside the report and leaves local Vite testing available", () => {
    const Popover = vi.fn(function () {});
    vi.stubGlobal("bootstrap", { Popover });
    const report = document.createElement("div"),
      drawing = document.createElement("div");
    report.id = "seed-report-ui-wrapper";
    document.body.append(report, drawing);
    const local = { hostname: "192.168.1.2" };
    createGuessrButton(drawing, local, true);
    createGuessrButton(drawing, local, true);
    const links =
      document.querySelectorAll<HTMLAnchorElement>("#noitaGuessrButton");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/guess/");
    expect(links[0].getAttribute("aria-label")).toBe("NoitaGuessr");
    expect(links[0].hasAttribute("title")).toBe(false);
    expect(links[0].getAttribute("data-bs-html")).toBe("true");
    const heading = document.createElement("div");
    heading.innerHTML = links[0].getAttribute("data-bs-title")!;
    expect(heading.querySelector("img")?.getAttribute("src")).toBe("/assets/noitaguessr-logo.svg");
    expect(heading.querySelector("img")?.alt).toBe("NoitaGuessr");
    expect(links[0].hasAttribute("data-i18n-title")).toBe(false);
    expect(links[0].getAttribute("data-i18n-content")).toBe("guessr.content");
    expect(Popover).toHaveBeenCalledExactlyOnceWith(links[0]);
    expect(report.nextElementSibling).toBe(links[0].parentElement);
    expect(links[0].parentElement!.nextElementSibling).toBe(drawing);
  });
});
