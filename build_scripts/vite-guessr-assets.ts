import type { Plugin } from "vite";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { isGuessrPagePath } from '../src/guessr/routes.ts';

/** The separately deployable Pages assets stay in ignored task storage. */
export function guessrAssetsPlugin(root: string): Plugin {
  const directory = resolve(root, "task/guessr/site");
  const install = async (server: any) => {
    // Production builds need neither the local game service nor its private
    // filesystem adapter. Load it only when a dev/preview server is started.
    const { localImageGameMiddleware } = await import('./guessr/local-image-game.ts');
    const { LocalLiveRooms } = await import('./guessr/local-live-room.ts');
    const rooms = new LocalLiveRooms(root);
    if (server.httpServer) rooms.attach(server.httpServer);
    server.middlewares.use((req: any, _res: any, next: () => void) => {
      const url = new URL(req.url, 'http://local');
      if ((req.method === 'GET' || req.method === 'HEAD') && isGuessrPagePath(url.pathname))
        req.url = '/guess/index.html' + url.search;
      next();
    });
    // Vite allows workspace files during development. Keep the private index
    // and answers inaccessible even through direct /@fs or workspace URLs.
    server.middlewares.use((req: any, res: any, next: () => void) => {
      let path: string;
      try {
        path = decodeURIComponent(
          new URL(req.url, "http://local").pathname,
        ).replaceAll("\\", "/");
      } catch {
        res.statusCode = 400;
        res.end();
        return;
      }
      if (
        path.includes("/task/guessr/private/") ||
        path.endsWith("/task/guessr/private")
      ) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      next();
    });
    server.middlewares.use("/guessr-api", localImageGameMiddleware(root, rooms));
    server.middlewares.use("/guessr-images", async (req: any, res: any) => {
      const path = new URL(req.url, "http://local").pathname;
      if (
        !["GET", "HEAD"].includes(req.method) ||
        !/^\/(?:dataset\.json|images\/[a-f0-9]{32,64}\.webp)$/.test(path)
      ) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      try {
        const file = resolve(root, "task/guessr/opaque-site", "." + path),
          info = await stat(file);
        res.setHeader(
          "Content-Type",
          path.endsWith(".webp") ? "image/webp" : "application/json",
        );
        res.setHeader("Content-Length", info.size);
        res.setHeader(
          "Cache-Control",
          path.endsWith(".webp")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
        if (req.method === "HEAD") res.end();
        else
          createReadStream(file)
            .on("error", () => res.destroy())
            .pipe(res);
      } catch {
        res.statusCode = 404;
        res.end("Image not found");
      }
    });
    server.middlewares.use(
      "/guessr-assets",
      async (req: any, res: any, next: () => void) => {
        if (!["GET", "HEAD"].includes(req.method)) return next();
        try {
          const path = resolve(
            directory,
            "." + decodeURIComponent(new URL(req.url, "http://local").pathname),
          );
          if (!path.startsWith(directory + sep)) return next();
          const info = await stat(path);
          if (!info.isFile()) return next();
          const mime: Record<string, string> = {
            ".json": "application/json",
            ".dzi": "application/xml",
            ".webp": "image/webp",
            ".png": "image/png",
          };
          res.setHeader(
            "Content-Type",
            mime[extname(path)] || "application/octet-stream",
          );
          res.setHeader("Content-Length", info.size);
          res.setHeader("Cache-Control", "no-cache");
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          createReadStream(path)
            .on("error", () => res.destroy())
            .pipe(res);
        } catch {
          res.statusCode = 404;
          res.end("Game asset not found");
        }
      },
    );
  };
  return {
    name: "local-guessr-assets",
    configureServer: install,
    configurePreviewServer: install,
  };
}
