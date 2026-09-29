import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = workerData.root, output = workerData.output;
const location = new URL('http://noitamap.test/assets/native-scene-worker.js');
const requests = [];
const events = new EventTarget();
Object.assign(globalThis, {
  self: globalThis, location,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  async fetch(input, options) {
    let url = new URL(typeof input === 'string' ? input : input.url ?? input.href, location);
    if (url.protocol === 'file:') url = new URL('/' + relative(output, fileURLToPath(url)).split(sep).join('/'), location);
    requests.push(url.pathname);
    if (url.protocol === 'data:') {
      const [header, body] = url.href.split(',', 2);
      return new Response(Buffer.from(header.endsWith(';base64') ? body : decodeURIComponent(body),
        header.endsWith(';base64') ? 'base64' : 'utf8'));
    }
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    for (const directory of [output, resolve(root, 'public')]) {
      const filename = resolve(directory, name);
      if (!filename.startsWith(directory + sep)) continue;
      try {
        const bytes = await readFile(filename);
        return new Response(options?.method === 'HEAD' ? null : bytes, {
          headers: { 'Content-Length': String(bytes.byteLength), 'Content-Type': filename.endsWith('.json') ? 'application/json' : 'application/octet-stream' },
        });
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error; }
    }
    throw new Error(`Native scene worker requested undeployed asset: ${url}`);
  },
  postMessage(data, options) {
    parentPort.postMessage({ data, requests, canvasAvailable: typeof OffscreenCanvas !== 'undefined',
      imageAvailable: typeof Image !== 'undefined' }, options?.transfer ?? options ?? []);
  },
});
const queue = [];
let ready = false;
parentPort.on('message', data => { if (ready) self.onmessage({ data }); else queue.push(data); });
try {
  await import(pathToFileURL(workerData.entry).href);
  ready = true;
  for (const data of queue.splice(0)) self.onmessage({ data });
} catch (error) { parentPort.postMessage({ fatal: error.stack }); parentPort.close(); }
