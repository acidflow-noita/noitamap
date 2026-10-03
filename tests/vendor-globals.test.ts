// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

it("installs the packaged OSD and Bootstrap globals and operates a UI dropdown", async () => {
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(null);
  await import("../src/app/vendor-globals");
  context.mockRestore();
  const globals = window as any;
  expect(globals.OpenSeadragon.Viewer).toBeTypeOf("function");
  document.body.innerHTML =
    '<div class="dropdown"><button data-bs-toggle="dropdown">Menu</button><div class="dropdown-menu">Map</div></div>';
  const button = document.querySelector("button")!;
  const dropdown = new globals.bootstrap.Dropdown(button);
  dropdown.show();
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(
    document.querySelector(".dropdown-menu")!.classList.contains("show"),
  ).toBe(true);
  dropdown.hide();
  dropdown.dispose();
  document.body.innerHTML = "";
});
