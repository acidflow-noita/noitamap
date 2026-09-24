// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "virtual:noitamap-public-report";
import { resolve } from "node:path";
import { resolveLocalPro } from "../build_scripts/local-pro";
import { createReportHostFixture, clearReportHostFixture } from "./helpers/report-host";

describe.skipIf(!resolveLocalPro(resolve(import.meta.dirname, "..")).available)(
  "public Seed Report entry",
  () => {
    let fixture: ReturnType<typeof createReportHostFixture> | undefined;
    afterEach(() => {
      if (fixture) clearReportHostFixture(fixture.hooks);
      fixture = undefined;
    });

    it.each(["", "v1", "classic", "v2", "v3"])("opens the sole V3 report for legacy preview value '%s'", async preview => {
      history.replaceState(null, "", preview ? `/?sr=1&reportPreview=${preview}` : "/?sr=1");
      fixture = createReportHostFixture();
      const { hooks, authService } = fixture;
      await init(hooks);
      hooks.handleSeedReportToggle!(true);

      const report = document.querySelector<HTMLElement>("#seed-report-v3.open")!;
      expect(report).not.toBeNull();
      expect(report.hidden).toBe(false);
      expect(report.querySelector("#seed-report-v3-body")).not.toBeNull();
      await vi.waitFor(() => expect(report.querySelector(".sr-tldr svg")).not.toBeNull());
      expect(report.textContent).toContain("How this seed compares");
      expect(report.textContent).toContain("Seed report is a Pro feature");
      expect(report.textContent).toContain("Sign in with Patreon");
      report.querySelector<HTMLButtonElement>(".btn-patreon")!.click();
      expect(authService.login).toHaveBeenCalledOnce();
      expect(document.querySelector("#seed-report-sidebar, #seed-report-v2, #seed-report-preview-tools")).toBeNull();
      expect(new URL(location.href).searchParams.has("reportPreview")).toBe(false);
      expect(new URL(location.href).searchParams.get("sr")).toBe("1");
      report.querySelector<HTMLButtonElement>(".sr3-close")!.click();
      expect(report.hidden).toBe(true);
      expect(new URL(location.href).searchParams.has("sr")).toBe(false);
    });

    it("updates the same public report after subscription without another installer", async () => {
      fixture = createReportHostFixture();
      const { hooks, state, refreshAuth } = fixture;
      await init(hooks); hooks.handleSeedReportToggle!(true);
      const report = document.getElementById("seed-report-v3")!;
      expect(report.querySelector(".sr-locked-banner")).not.toBeNull();
      await vi.waitFor(() => expect(report.querySelector(".sr-tldr")).not.toBeNull());
      state.authenticated = true; state.isSubscriber = true; refreshAuth();
      expect(report.querySelector(".sr-locked-banner")).toBeNull();
      expect(report.querySelector(".sr-tldr")).toBeNull();
      expect(report.querySelector(".sr3-find")).not.toBeNull();
      expect(document.querySelectorAll("#seed-report-v3")).toHaveLength(1);
      hooks.handleSeedReportToggle!(false);
      expect(report.hidden).toBe(true);
    });
  },
);
