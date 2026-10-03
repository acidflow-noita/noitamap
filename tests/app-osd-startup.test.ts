// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { getTileData } from "../src/data_sources/tile_data";

vi.mock("../src/data_sources/overlays", () => ({ createOverlays: () => [] }));
vi.mock("../src/popover-util", () => ({ dismissPopovers: vi.fn() }));
vi.mock("../src/light-mode", () => ({ isLightMode: () => false }));
vi.mock("../src/simplistic-background", () => ({
  isSimplisticBackground: () => false,
}));
import { AppOSD } from "../src/app_osd";

let app: AppOSD | undefined;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement, kind: string) {
      return kind === "2d"
        ? (createCanvas(this.width, this.height).getContext("2d") as any)
        : null;
    } as any,
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1024);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(576);
  const { default: OSD } = await import("openseadragon");
  vi.stubGlobal("OpenSeadragon", OSD);
  const element = document.createElement("div");
  document.body.appendChild(element);
  app = new AppOSD(element, false);
});
afterEach(() => {
  app?.viewer.destroy();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('reports the constructed Canvas drawer when WebGL is requested but unavailable', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  app!.viewer.destroy();
  const element = document.createElement('div'); document.body.appendChild(element);
  app = new AppOSD(element, true);
  expect(app.getDrawerType()).toBe('canvas');
  expect(app.viewer.drawer).toBeInstanceOf(OpenSeadragon.CanvasDrawer);
  expect(warn).toHaveBeenCalledWith('[OSD] Drawer initialized: requested=webgl, active=canvas (fallback; requested drawer was not activated)');
  expect(log).not.toHaveBeenCalledWith(expect.stringContaining('active=webgl'));
});

it("opens the real OSD viewer from bundled geometry while all metadata requests hang", async () => {
  const resolvers: ((r: Response) => void)[] = [];
  const request = vi.fn(
    () => new Promise<Response>((resolve) => resolvers.push(resolve)),
  );
  vi.stubGlobal("fetch", request);
  const xhr = vi.spyOn(XMLHttpRequest.prototype, "open");
  const pos = { x: -3060, y: 3548, zoom: 2 ** -13.69 };
  let ready = false;
  const opened = app!.setMap("dynamic-main-branch", pos).then(() => {
    ready = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(ready).toBe(true);
  await opened;
  expect(request).toHaveBeenCalledTimes(3);
  expect(xhr).not.toHaveBeenCalled();
  expect(app!.world.getItemCount()).toBe(3);
  for (const [i, data] of getTileData("dynamic-main-branch").entries()) {
    const item = app!.world.getItemAt(i),
      image = JSON.parse(data.dziContent).Image;
    const bounds = item.getBounds();
    expect([bounds.x, bounds.y, bounds.width, bounds.height]).toEqual([
      Number(image.TopLeft.X),
      Number(image.TopLeft.Y),
      Number(image.Size.Width),
      Number(image.Size.Height),
    ]);
    expect(item.source.getTileUrl(10, 0, 0)).toBe(
      data.url.replace(/\.dzi$/, "_files/10/0_0.webp"),
    );
  }
  const camera = app!.getZoomPos();
  const reset = vi.spyOn(app!.world.getItemAt(0), "reset");
  resolvers.forEach((resolve) => resolve(new Response("build-42")));
  await vi.advanceTimersByTimeAsync(20);
  expect(app!.world.getItemAt(0).source.getTileUrl(10, 0, 0)).toContain(
    "?v=build-42",
  );
  expect(reset).toHaveBeenCalledTimes(1);
  expect(app!.getZoomPos()).toEqual(camera);
});

it("does not apply a late version response to a replacement map", async () => {
  const pendingVersions: ((r: Response) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pendingVersions.push(resolve);
        }),
    ),
  );
  let pending = app!.setMap("dynamic-main-branch");
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  pending = app!.setMap("regular-main-branch");
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  pending = app!.setMap("dynamic-main-branch");
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  pendingVersions.slice(0, 3).forEach(resolve => resolve(new Response("old-map")));
  await vi.advanceTimersByTimeAsync(20);
  expect(app!.world.getItemAt(0).source.queryParams).toBe("");
});
