// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ initial: false, updateURL: vi.fn() }));
vi.mock("../src/i18n", () => ({ default: { t: (key: string, fallback: any) => typeof fallback === "string" ? fallback : fallback?.defaultValue ?? key } }));
vi.mock("../src/data_sources/url", () => ({ parseURL: () => ({seedReportOpen: state.initial}), updateURLWithSeedReport: state.updateURL }));
vi.mock("../src/auth/auth-service", () => ({ authService: { ready: Promise.resolve({}) } }));
import { createSeedReportButton } from "../src/seed-report-button";
import { createSeedReportLoading } from "../src/seed-report-loading";
import { requestProSidebar } from "../src/pro-sidebar-intent";

let finish: (value: boolean) => void;
let load: ReturnType<typeof vi.fn>;
let input: HTMLInputElement;
const click = (open: boolean) => { input.checked = open; input.dispatchEvent(new Event("change")); };
const installReport = () => {
  const panel = document.createElement("div"); panel.id = "seed-report-sidebar"; document.body.appendChild(panel);
  const toggle = vi.fn((open: boolean) => panel.classList.toggle("open", open));
  (window as any).__noitamap.handleSeedReportToggle = toggle;
  return toggle;
};
beforeEach(() => {
  state.initial = false; state.updateURL.mockClear();
  requestProSidebar("report", false);
  document.body.innerHTML = '<div><div id="drawing-ui-wrapper"></div></div>';
  (window as any).__noitamap = {};
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  load = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  createSeedReportButton(document.getElementById("drawing-ui-wrapper")!, {loadProBundle: load});
  input = document.getElementById("seedReportToggleBtn") as HTMLInputElement;
});
afterEach(() => {
  requestProSidebar("report", false);requestProSidebar("drawing", false);
  document.body.replaceChildren();delete (window as any).__noitamap;
  vi.restoreAllMocks();vi.unstubAllGlobals();
});

describe("immediate seed report loading feedback", () => {
  it("shows feedback synchronously, before downloading, and hands off when ready", async () => {
    click(true);
    expect(document.getElementById("seed-report-loading")?.getAttribute("aria-busy")).toBe("true");
    expect(load).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const toggle = installReport();finish(true);
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledWith(true));
    expect(document.getElementById("seed-report-loading")).toBeNull();
    expect(input.checked).toBe(true);expect(input.hasAttribute("aria-busy")).toBe(false);
  });
  it("close immediately cancels opening without waiting for the download", async () => {
    click(true);await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    (document.querySelector("#seed-report-loading .sr-loading-close") as HTMLButtonElement).click();
    expect(document.getElementById("seed-report-loading")).toBeNull();expect(input.checked).toBe(false);
    const toggle = installReport();finish(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(toggle).not.toHaveBeenCalledWith(true);expect(state.updateURL).toHaveBeenLastCalledWith(false);
  });
  it("removes feedback immediately when drawing is requested", async () => {
    click(true);await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    requestProSidebar("drawing", true);
    expect(document.getElementById("seed-report-loading")).toBeNull();expect(input.checked).toBe(false);
    const toggle=installReport();finish(true);await new Promise(resolve => setTimeout(resolve, 20));
    expect(toggle).not.toHaveBeenCalledWith(true);
  });
  it("shows a real failure state with retry instead of an endless skeleton", async () => {
    click(true);await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));finish(false);
    await vi.waitFor(() => expect(document.getElementById("seed-report-loading")?.getAttribute("aria-busy")).toBe("false"));
    expect((document.querySelector(".sr-loading-placeholders") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector(".sr-loading-actions") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("seed-report-loading")?.textContent).toContain("couldn't be loaded");
    load.mockImplementationOnce(async () => { installReport(); return true; });
    (document.querySelector(".sr-loading-actions button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("#seed-report-sidebar.open")).not.toBeNull());
    expect(document.getElementById("seed-report-loading")).toBeNull();
  });
  it("does not flash a loading panel once the feature is available", () => {
    const toggle=installReport();click(true);
    expect(toggle).toHaveBeenCalledWith(true);expect(load).not.toHaveBeenCalled();
    expect(document.getElementById("seed-report-loading")).toBeNull();
  });
  it("updates slow-load text honestly, without an invented percentage", () => {
    vi.useFakeTimers();const panel=createSeedReportLoading(vi.fn(),vi.fn());
    vi.advanceTimersByTime(8000);
    expect(document.getElementById("seed-report-loading")?.textContent).toContain("Still loading");
    expect(document.getElementById("seed-report-loading")?.textContent).not.toMatch(/\d+%/);
    panel.remove();vi.useRealTimers();
  });
});
