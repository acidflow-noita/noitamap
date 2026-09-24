// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { resolveLocalPro } from "../build_scripts/local-pro";
import { createProLoader } from "../src/pro-loader";
import { createReportHostFixture, clearReportHostFixture } from "./helpers/report-host";

describe.skipIf(!resolveLocalPro(resolve(import.meta.dirname, "..")).available)(
  "single Seed Report lazy entry",
  () => {
    let fixture: ReturnType<typeof createReportHostFixture> | undefined;
    afterEach(() => {
      if (fixture) clearReportHostFixture(fixture.hooks);
      fixture = undefined;
      delete (window as any).noitamap_pro_loaded;
      delete (window as any).noitamap;
    });

    it.each([
      { authenticated: false, isSubscriber: false },
      { authenticated: true, isSubscriber: false },
      { authenticated: true, isSubscriber: true },
    ])("loads only V3 on demand for %j", async state => {
      fixture = createReportHostFixture(state);
      const { hooks } = fixture;
      const importModule = vi.fn(() => import("virtual:noitamap-pro"));
      const load = createProLoader(hooks, importModule);

      expect(await load()).toBe(true);
      expect(hooks.isProFeatureReady?.("report")).toBe(false);
      expect(document.getElementById("seed-report-v3")).toBeNull();

      expect(await Promise.all([load("report"), load("report")])).toEqual([true, true]);
      expect(importModule).toHaveBeenCalledOnce();
      expect(hooks.isProFeatureReady?.("report")).toBe(true);
      for (const other of ["drawing", "alchemy", "high-value", "effects"] as const) {
        expect(hooks.isProFeatureReady?.(other)).toBe(false);
      }
      const report = document.getElementById("seed-report-v3")!;
      expect(report.hidden).toBe(true);
      hooks.handleSeedReportToggle!(true);
      expect(report.hidden).toBe(false);
      expect(report.classList.contains("open")).toBe(true);
      expect(!!report.querySelector(".sr-locked-banner")).toBe(!state.isSubscriber);
      await vi.waitFor(() => expect(!!report.querySelector(".sr-tldr svg")).toBe(!state.isSubscriber));
      expect(document.querySelector("#seed-report-sidebar, #seed-report-v2, #seed-report-preview-tools")).toBeNull();
      expect(await load("report")).toBe(true);
      expect(document.querySelectorAll("#seed-report-v3")).toHaveLength(1);
    });
  },
);
