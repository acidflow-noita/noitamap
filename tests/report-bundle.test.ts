import { describe, expect, it } from "vitest";
import { reportBundleFor } from "../src/report-bundle";

describe("Seed Report bundle routing", () => {
  it("serves the public TLDR bundle to anonymous users", () => {
    expect(reportBundleFor({ authenticated: false, isSubscriber: false })).toBe("public");
  });

  it("serves the public TLDR bundle to logged-in non-subscribers", () => {
    expect(reportBundleFor({ authenticated: true, isSubscriber: false })).toBe("public");
  });

  it("serves the protected bundle only to authenticated subscribers", () => {
    expect(reportBundleFor({ authenticated: true, isSubscriber: true })).toBe("subscriber");
  });
});
