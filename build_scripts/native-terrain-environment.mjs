/** Native Node environment for the shared browser generator. No browser process,
 * graphics driver, WebGL context, HTTP server, or display is required. */
import { readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import {
  Canvas,
  Image,
  ImageData,
  DOMMatrix,
  Path2D,
  createCanvas,
  loadImage,
} from "@napi-rs/canvas";

export function installNativeTerrainEnvironment({
  root,
  bundle,
  workerScript,
  fullPixels = true,
}) {
  const nodeProcess = process;
  const origin = new URL("http://native-bake.invalid/");
  const nativeFetch = globalThis.fetch;
  const eventTarget = new EventTarget();
  const children = new Set();
  const elements = new Map();
  const diagnostics = [];
  const pendingImages = new Set();
  async function fetchFile(input, options) {
    let url = new URL(
      typeof input === "string" ? input : (input.url ?? input.href),
      origin,
    );
    if (url.protocol === "blob:" || url.protocol === "data:")
      return nativeFetch(url, options);
    if (url.protocol === "file:")
      url = new URL(
        relative(bundle, fileURLToPath(url)).split(sep).join("/"),
        origin,
      );
    if (url.pathname === "/__terrain-diagnostics")
      return new Response(null, { status: 204 });
    if (url.origin !== origin.origin && !url.pathname.startsWith("/data/"))
      throw new Error(`Unexpected external request in native bake: ${url}`);
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    for (const base of [bundle, resolve(root, "public")]) {
      const file = resolve(base, name);
      if (!file.startsWith(base + sep)) continue;
      try {
        const data = await readFile(file);
        return new Response(options?.method === "HEAD" ? null : data, {
          headers: {
            "Content-Type": file.endsWith(".json")
              ? "application/json"
              : file.endsWith(".png")
                ? "image/png"
                : "application/octet-stream",
            "Content-Length": String(data.length),
            "X-Archive-Meta": String(data.length),
          },
        });
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
      }
    }
    throw new Error(`Missing bake asset: ${name}`);
  }
  class BrowserImage extends Image {
    _url = "";
    get src() {
      return this._url;
    }
    set src(url) {
      if (typeof url !== "string") {
        super.src = url;
        return;
      }
      this._url = url;
      const pending = fetchFile(url)
        .then((response) => response.arrayBuffer())
        .then((bytes) => {
          super.src = Buffer.from(bytes);
        });
      pendingImages.add(pending);
      void pending
        .catch((error) => diagnostics.push(String(error)))
        .finally(() => pendingImages.delete(pending));
    }
  }
  function element(tag) {
    if (tag === "canvas") return createCanvas(1, 1);
    if (tag === "img") return new BrowserImage();
    const el = {
      style: {},
      dataset: {},
      children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild(child) {
        this.children.push(child);
        if (child.id) elements.set(child.id, child);
        return child;
      },
      setAttribute() {},
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    return el;
  }
  class BrowserWorker {
    onmessage = null;
    onerror = null;
    constructor(url) {
      const target = url instanceof URL ? url : new URL(url, origin);
      const path =
        target.protocol === "file:" &&
        fileURLToPath(target).startsWith(bundle + sep)
          ? fileURLToPath(target)
          : resolve(bundle, target.pathname.replace(/^\/+/, ""));
      this.worker = new NodeWorker(workerScript, {
        workerData: {
          role: "web-worker",
          root,
          bundle,
          entry: path,
          fullPixels,
        },
      });
      children.add(this);
      const queue = [];
      let ready = false;
      this.postMessage = (data, transfers = []) => {
        if (ready) this.worker.postMessage(data, transfers);
        else queue.push([data, transfers]);
      };
      this.worker.on("message", (message) => {
        if (message.__ready) {
          ready = true;
          for (const [data, transfers] of queue.splice(0))
            this.worker.postMessage(data, transfers);
        } else this.onmessage?.({ data: message });
      });
      this.worker.on("error", (error) =>
        this.onerror?.({ message: error.message, error }),
      );
    }
    terminate() {
      children.delete(this);
      void this.worker.terminate();
    }
  }
  const ctx = createCanvas(1, 1).getContext("2d");
  Object.assign(globalThis, {
    self: globalThis,
    window: globalThis,
    location: origin,
    Image: BrowserImage,
    HTMLImageElement: BrowserImage,
    ImageData,
    DOMMatrix,
    Path2D,
    HTMLCanvasElement: Canvas,
    OffscreenCanvas: Canvas,
    CanvasRenderingContext2D: ctx.constructor,
    Worker: BrowserWorker,
    fetch: fetchFile,
    caches: {
      async open() {
        return { match: (url) => fetchFile(url), async put() {} };
      },
    },
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
    document: {
      createElement: element,
      createElementNS: (_ns, tag) => element(tag),
      getElementById: (id) => elements.get(id) ?? null,
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementsByTagName: () => [],
      body: element("body"),
      documentElement: element("html"),
      baseURI: origin.href,
      addEventListener() {},
      removeEventListener() {},
    },
    async createImageBitmap(source, ...args) {
      let image =
        source instanceof Blob
          ? await loadImage(await source.arrayBuffer())
          : source;
      if (image instanceof ImageData) {
        const canvas = createCanvas(image.width, image.height);
        canvas.getContext("2d").putImageData(image, 0, 0);
        image = canvas;
      }
      const crop =
        args.length >= 4 ? args.slice(0, 4) : [0, 0, image.width, image.height];
      const bitmap = createCanvas(crop[2], crop[3]);
      bitmap
        .getContext("2d")
        .drawImage(image, ...crop, 0, 0, bitmap.width, bitmap.height);
      bitmap.close = () => {};
      return bitmap;
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Noitamap native CPU baker" },
    configurable: true,
  });
  const storage = new Map([
    ["noitamap-gl-terrain", fullPixels ? "1" : "0"],
    ["noitamap-telescope-version", "2026-07-05-telescope-4683b94"],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    configurable: true,
  });
  // Import-time PNG/data code must take the shipped-asset/browser path, not
  // upstream's Node file:// shortcut. Restore Node before encoding with sharp.
  globalThis.process = undefined;
  return {
    restoreProcess() {
      globalThis.process = nodeProcess;
    },
    async waitImages() {
      await Promise.all([...pendingImages]);
    },
    diagnostics,
    close() {
      for (const child of children) child.terminate();
      globalThis.process = nodeProcess;
    },
  };
}
