/** The main-thread barrel initializes DOM images. Never import it in a worker. */
export function loadWorkerTelescopeModules(fullPixels: boolean): Promise<any> {
  return fullPixels
    ? import("./full-pixel-worker-exports")
    : import("./worker-telescope-exports");
}
