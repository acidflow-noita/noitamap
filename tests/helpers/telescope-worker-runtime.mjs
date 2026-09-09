// Execute the production browser-worker bundle in a Node worker thread.
// Browser *worker* globals only: no Image, HTMLImageElement or HTMLCanvasElement.
// Raster operations and PNG decoding use native Skia, not no-op canvas mocks.
import {
  parentPort,
  workerData,
  Worker as NodeWorker,
} from "node:worker_threads";
import { readFile, access } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  Canvas,
  ImageData,
  createCanvas,
  loadImage,
  Image,
  DOMMatrix,
} from "@napi-rs/canvas";

const root = workerData.root;
const output = workerData.output ?? resolve(root, "dist");
const NativeResponse = Response;
const NativeBlob = Blob;
const workerURL = new URL("http://noitamap.test/assets/pw-worker.js");
const events = new EventTarget();
const requests = [];
const missing = [];
const urls = new Map();
let blobID = 0;
const context = createCanvas(1, 1).getContext("2d");
const nativeDrawImage = context.constructor.prototype.drawImage;
const nativePutImageData = context.constructor.prototype.putImageData;

async function localFetch(input, init) {
  let url = new URL(
    typeof input === "string" ? input : (input.url ?? input.href),
    workerURL,
  );
  // import.meta.url in the executed bundle is file://; in the browser it is
  // /assets/<chunk>.js. Resolve its data URLs against the served output root.
  if (url.protocol === "file:")
    url = new URL(
      "/" + relative(output, fileURLToPath(url)).split(sep).join("/"),
      workerURL,
    );
  requests.push(url.href);
  if (url.pathname === "/__terrain-diagnostics") return new NativeResponse(null, { status: 204 });
  if (url.protocol === "data:") {
    const [header, body] = url.href.split(",", 2);
    return new NativeResponse(
      Buffer.from(
        header.endsWith(";base64") ? body : decodeURIComponent(body),
        header.endsWith(";base64") ? "base64" : "utf8",
      ),
      { headers: { "Content-Type": header.slice(5).split(";")[0] } },
    );
  }
  if (urls.has(url.href)) return new NativeResponse(urls.get(url.href));
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  // Production workers may read ONLY deployed files, not the source checkout.
  // The fixture-only bundle deliberately omits copying public/ to save a copy.
  const directories =
    workerData.mode === "fixture"
      ? [output, resolve(root, "public")]
      : [output];
  for (const directory of directories) {
    const file = resolve(directory, relativePath);
    if (!file.startsWith(directory + sep)) continue;
    try {
      await access(file);
      const data = await readFile(file);
      return new NativeResponse(init?.method === "HEAD" ? null : data, {
        headers: {
          "Content-Length": String(data.byteLength),
          "X-Archive-Meta": String(data.byteLength),
          "Content-Type": /\.json$/.test(file)
            ? "application/json"
            : /\.png$/.test(file)
              ? "image/png"
              : "application/octet-stream",
        },
      });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
    }
  }
  missing.push(url.pathname);
  return new NativeResponse("Not found", { status: 404 });
}

Object.assign(globalThis, {
  self: globalThis,
  location: workerURL,
  OffscreenCanvas: Canvas,
  OffscreenCanvasRenderingContext2D: context.constructor,
  ImageData,
  DOMMatrix,
  fetch: localFetch,
  caches: {
    async open() {
      return { match: (url) => localFetch(url), async put() {} };
    },
  },
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  postMessage: (data, transfer = []) =>
    parentPort.postMessage(
      {
        type: "result",
        data,
        requests,
        missing,
        imageGlobal: typeof globalThis.Image,
      },
      transfer,
    ),
  async createImageBitmap(source, ...args) {
    const image =
      source instanceof NativeBlob
        ? await loadImage(await source.arrayBuffer())
        : source;
    const crop =
      args.length >= 4 ? args.slice(0, 4) : [0, 0, image.width, image.height];
    const options = args.length >= 4 ? args[4] : args[0];
    const bitmap = createCanvas(
      options?.resizeWidth ?? crop[2],
      options?.resizeHeight ?? crop[3],
    );
    let drawable = image;
    if (image instanceof ImageData) {
      drawable = createCanvas(image.width, image.height);
      nativePutImageData.call(drawable.getContext("2d"), image, 0, 0);
    }
    nativeDrawImage.call(
      bitmap.getContext("2d"),
      drawable,
      ...crop,
      0,
      0,
      bitmap.width,
      bitmap.height,
    );
    bitmap.close = () => {};
    return bitmap;
  },
});
URL.createObjectURL = (blob) => {
  const url = `blob:http://noitamap.test/${++blobID}`;
  urls.set(url, blob);
  return url;
};
URL.revokeObjectURL = (url) => urls.delete(url);
// Load native EGL before hiding process; the app itself still takes browser paths.
const graphics =
  workerData.mode === "terrain"
    ? (await import("./native-gles.mjs")).createNativeGLES()
    : null;
const browserWorkers = new Set();
let refusedContexts = 0;
class BrowserWorker {
  onmessage = null;
  onerror = null;
  pending = [];
  started = false;
  constructor(url) {
    const target = url instanceof URL ? url : new URL(url, workerURL);
    const localFile = target.protocol === "file:" ? fileURLToPath(target) : "";
    const entry = localFile.startsWith(output + sep)
      ? localFile
      : resolve(output, target.pathname.replace(/^\/+/, ""));
    this.worker = new NodeWorker(fileURLToPath(import.meta.url), {
      workerData: {
        root,
        output,
        entry,
        mode: "nested-worker",
      },
    });
    browserWorkers.add(this);
    this.worker.on("message", (message) => {
      if (message.type === "ready") {
        this.started = true;
        for (const [data, transfers] of this.pending.splice(0))
          this.worker.postMessage(data, transfers);
      } else if (message.type === "fatal")
        this.onerror?.({ message: message.error });
      else {
        if (message.missing?.length) missing.push(...message.missing);
        this.onmessage?.({ data: message.data });
      }
    });
    this.worker.on("error", (error) =>
      this.onerror?.({ message: error.message }),
    );
  }
  postMessage(data, transfers = []) {
    if (this.started) this.worker.postMessage(data, transfers);
    else this.pending.push([data, transfers]);
  }
  terminate() {
    browserWorkers.delete(this);
    void this.worker.terminate();
  }
}
if (workerData.mode === "terrain" || workerData.mode === "cpu-terrain")
  globalThis.Worker = BrowserWorker;
function canvasWithoutWebGL() {
  const canvas = createCanvas(1, 1),
    events = new EventTarget();
  const native = canvas.getContext.bind(canvas);
  canvas.addEventListener = events.addEventListener.bind(events);
  canvas.removeEventListener = events.removeEventListener.bind(events);
  canvas.getContext = (type, ...args) => {
    if (type === "webgl2") {
      refusedContexts++;
      const event = new Event("webglcontextcreationerror");
      Object.defineProperty(event, "statusMessage", {
        value:
          "BindToCurrentSequence failed (deliberately disabled WebGL test)",
      });
      events.dispatchEvent(event);
      return null;
    }
    return native(type, ...args);
  };
  return canvas;
}
// Do not accidentally take Telescope's Node-only shortcuts. Exercise the same
// fetch, PNG/bitmap and top-level initialization branches as a browser worker.
globalThis.process = undefined;

try {
  if (["fixture", "terrain", "cpu-terrain"].includes(workerData.mode)) {
    // The fixture generator uses the main-thread tile builder's canvases. The
    // production PW worker below still starts with *no* DOM/Image constructors.
    globalThis.document = {
      createElement: (tag) =>
        tag === "canvas"
          ? graphics
            ? graphics.createCanvas(1, 1)
            : workerData.mode === "cpu-terrain"
              ? canvasWithoutWebGL()
              : createCanvas(1, 1)
          : { style: {}, appendChild() {}, setAttribute() {}, remove() {} },
      getElementById: () => null,
      body: { appendChild() {} },
      baseURI: workerURL.origin + "/",
      documentElement: {
        style: {},
        addEventListener() {},
        removeEventListener() {},
      },
      addEventListener() {},
      removeEventListener() {},
      getElementsByTagName: () => [],
    };
    globalThis.window = globalThis;
    if (graphics || workerData.mode === "cpu-terrain") {
      globalThis.Image = Image;
      globalThis.HTMLCanvasElement = Canvas;
      globalThis.HTMLImageElement = Image;
      Object.defineProperty(globalThis, "localStorage", {
        value: { getItem: () => "1" },
        configurable: true,
      });
    }
    const fixture = await import(pathToFileURL(workerData.entry).href);
    parentPort.postMessage({
      type: "fixture",
      data:
        graphics || workerData.mode === "cpu-terrain"
          ? await fixture.renderTerrainFixture(
              workerData.seed,
              workerData.cached,
            )
          : await fixture.generateFixture(
              workerData.fullPixels,
              workerData.seed,
            ),
      graphics: graphics
        ? { renderer: graphics.renderer, draws: graphics.draws }
        : workerData.mode === "cpu-terrain"
          ? { renderer: "CPU worker; WebGL disabled", refusedContexts }
          : undefined,
      requests,
      missing,
    });
  } else {
    await import(pathToFileURL(workerData.entry).href);
    // Exercise the shared drawImage shim with an uncached canvas: browser-only
    // instanceof checks must not reference constructors absent in real workers.
    if (
      typeof globalThis.Image !== "undefined" ||
      typeof globalThis.HTMLCanvasElement !== "undefined" ||
      typeof globalThis.HTMLImageElement !== "undefined"
    ) {
      throw new Error(
        "The worker test must not provide DOM image constructors",
      );
    }
    const source = createCanvas(2, 2),
      target = createCanvas(2, 2);
    source.getContext("2d").fillStyle = "#123456";
    source.getContext("2d").fillRect(0, 0, 2, 2);
    target.getContext("2d").drawImage(source, 0, 0);
    if (
      String(target.getContext("2d").getImageData(0, 0, 1, 1).data) !==
      "18,52,86,255"
    ) {
      throw new Error("Worker canvas shim changed source pixels");
    }
    parentPort.on("message", async (data) => {
      try {
        await globalThis.onmessage({ data });
      } catch (error) {
        parentPort.postMessage({ type: "fatal", error: error.stack });
      }
    });
    parentPort.postMessage({ type: "ready" });
  }
} catch (error) {
  parentPort.postMessage({
    type: "fatal",
    error: error.stack,
    requests,
    missing,
  });
}

if (graphics) graphics.dispose();

for (const worker of browserWorkers) worker.terminate();
