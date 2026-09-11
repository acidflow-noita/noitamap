import { expect, it } from "vitest";
import { requestProSidebar } from "../src/pro-sidebar-intent";
it("does not reopen a sidebar closed during loading", () => {
  const first = requestProSidebar("report", true);
  expect(first()).toBe(true);
  requestProSidebar("report", false);
  expect(first()).toBe(false);
});
it("gives the most recently requested sidebar priority without breaking handoff", () => {
  const drawing = requestProSidebar("drawing", true);
  const report = requestProSidebar("report", true);
  expect(drawing()).toBe(false);
  expect(report()).toBe(true);
  requestProSidebar("drawing", false);
  expect(report()).toBe(true);
});
