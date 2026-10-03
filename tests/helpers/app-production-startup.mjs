/** Execute shipped ES modules in a Node VM/DOM. No browser or external requests. */
import vm from "node:vm";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
const [root, dist, map, renderer = 'canvas'] = process.argv.slice(2);
const require = createRequire(root + "/package.json");
const { JSDOM } = require("jsdom");
const { createCanvas } = require("@napi-rs/canvas");
const html = await readFile(dist + "/index.html", "utf8");
const dom = new JSDOM(html, {
  url: "https://telescope-api-preview.noitamap.com/?m=" + map + "&se=92",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const w = dom.window,
  context = dom.getInternalVMContext();
const errors = [];
const drawerLogs = [];
w.localStorage.setItem('noitamap-renderer', renderer);
w.console = {
  ...console,
  log: (...args) => { if (String(args[0]).startsWith('[OSD] Drawer')) drawerLogs.push(args.map(String).join(' ')); },
  warn: (...args) => { if (String(args[0]).startsWith('[OSD] Drawer')) drawerLogs.push(args.map(String).join(' ')); },
  error: (...args) => {
    errors.push(args.map(String).join(" "));
  },
};
w.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
w.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};
w.BroadcastChannel = class {
  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  close() {}
};
w.TextEncoder = TextEncoder;
w.TextDecoder = TextDecoder;
w.Headers = Headers;
w.Response = Response;
w.Request = Request;
w.AbortSignal.timeout = AbortSignal.timeout;
const canvases = new WeakMap();
w.HTMLCanvasElement.prototype.getContext = function (kind) {
  if (kind !== "2d") return null;
  let value = canvases.get(this);
  if (!value) {
    value = createCanvas(this.width, this.height);
    canvases.set(this, value);
  }
  if (value.width !== this.width) value.width = this.width;
  if (value.height !== this.height) value.height = this.height;
  return value.getContext("2d");
};
Object.defineProperty(w.HTMLElement.prototype, "clientWidth", {
  get: () => 1024,
});
Object.defineProperty(w.HTMLElement.prototype, "clientHeight", {
  get: () => 576,
});
const requested = [];
w.fetch = async (url, options) => {
  const u = new URL(url, w.location.href);
  requested.push(u.href);
  if (u.origin !== w.location.origin) return new Promise(() => {});
  try {
    const bytes = await readFile(resolve(dist, "." + u.pathname));
    return new Response(bytes, {
      headers: {
        "Content-Type": u.pathname.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
};
w.addEventListener("error", (e) => errors.push(String(e.error)));
w.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
const modules = new Map();
async function getModule(file) {
  if (modules.has(file)) return modules.get(file);
  const promise = (async () =>
    new vm.SourceTextModule(await readFile(file, "utf8"), {
      context,
      identifier: file,
      initializeImportMeta(meta) {
        meta.url =
          "https://telescope-api-preview.noitamap.com/" +
          file.slice(dist.length + 1);
      },
      importModuleDynamically: async (specifier, referencing) => {
        const m = await getModule(
          resolve(dirname(referencing.identifier), specifier),
        );
        if (m.status === "unlinked") await m.link(link);
        if (m.status === "linked") await m.evaluate();
        return m;
      },
    }))();
  modules.set(file, promise);
  return promise;
}
const link = (specifier, referencing) =>
  getModule(resolve(dirname(referencing.identifier), specifier));
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"/)[1];
const m = await getModule(resolve(dist, "." + entry));
// The application module may arrive after DOMContentLoaded.
if (w.document.readyState === "loading")
  await new Promise((resolve) =>
    w.document.addEventListener("DOMContentLoaded", resolve, { once: true }),
  );
await m.link(link);
await m.evaluate();
for (let i = 0; i < 100 && !w.__noitamap && !errors.length; i++)
  await new Promise((r) => setTimeout(r, 20));
const ready = !!w.__noitamap;
const dropdown = w.document.querySelector("[data-bs-toggle=dropdown]");
if (ready && dropdown) {
  const menu = w.bootstrap.Dropdown.getOrCreateInstance(dropdown);
  menu.show();
  if (dropdown.getAttribute("aria-expanded") !== "true")
    errors.push("Dropdown did not open");
  menu.hide();
  menu.dispose();
}
await writeFile(
  resolve(dist, `startup-${map}-${renderer}.json`),
  JSON.stringify({ ready, errors, requested, drawerLogs,
    activeDrawer: w.__noitamap?.osd.viewer.drawer.getType(),
    canvasDrawer: w.__noitamap?.osd.viewer.drawer instanceof w.OpenSeadragon.CanvasDrawer,
    switchChecked: w.document.getElementById('drawerToggle')?.checked,
    switchDisabled: w.document.getElementById('drawerToggle')?.disabled,
  }),
);
w.close();
process.exitCode = ready && !errors.length ? 0 : 1;
