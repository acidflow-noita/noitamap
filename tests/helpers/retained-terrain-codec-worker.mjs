import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

globalThis.self = {
  postMessage: (message, { transfer = [] } = {}) =>
    parentPort.postMessage(message, transfer),
};
await import(pathToFileURL(workerData.entry).href);
parentPort.on("message", (data) => self.onmessage({ data }));
