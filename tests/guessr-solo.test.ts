import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SOLO_SESSION_LIFETIME,
  SOLO_TOKEN_LIMIT,
  SoloGameService,
  soloGameRoute,
  type SoloGameState,
  type SoloRoundSource,
} from "../src/guessr/solo-server";
import type { AreaDefinition } from "../src/guessr/area-rules";
import type { ImageGameConfig, ImageGameState } from "../src/guessr/image-game";

const now = 1800000000000;
const secret = "test-only-solo-key-with-at-least-32-characters";

function fixture() {
  const bounds = { x: -17920, y: 0, width: 4096, height: 2048 };
  const config: ImageGameConfig = {
    version: "test-private-capture-v1",
    bounds,
    overview: "",
    map: {
      width: 4096,
      height: 2048,
      tileSize: 512,
      overlap: 2,
      maxLevel: 12,
      tiles: "/reference/",
    },
  };
  const area: AreaDefinition = {
    id: "private-area",
    label: "Private area name",
    originY: 0,
    runs: [
      [0, 0, 8],
      [1, 0, 3],
      [1, 4, 8],
      [2, 0, 8],
    ],
    cells: 23,
    bounds,
    difficultyTier: "normal",
    scoring: { area: 1000, position: 4000, maximum: 5000 },
  };
  const selected = Array.from({ length: 3 }, (_, index) => ({
    area: {
      ...area,
      id: `${area.id}-${index}`,
      label: `${area.label} ${index}`,
    },
    answer: { x: -17664 + index * 512, y: 768 },
    frames: [
      {
        image: `/images/secret-clue-${index}.webp`,
        x: -256,
        y: -256,
        width: 514,
        height: 514,
      },
    ],
  }));
  const source: SoloRoundSource = {
    config: vi.fn(async () => config),
    sampleRounds: vi.fn(async () => selected),
  };
  const service = new SoloGameService(source, secret);
  return { config, selected, source, service };
}

function publicState({
  continuation: _token,
  ...state
}: SoloGameState): ImageGameState {
  return state;
}

describe("stateless demo continuations", () => {
  it("encrypts all private future rounds and exposes only the current relative frames", async () => {
    const { service, source, selected } = fixture();
    const game = await service.start(now);
    expect(source.sampleRounds).toHaveBeenCalledExactlyOnceWith(3);
    expect(game).toMatchObject({
      totalRounds: 3,
      round: 0,
      stage: "guess",
      results: [],
    });
    expect(game.current?.clue.frames).toEqual(selected[0].frames);
    expect(game.current?.difficultyTier).toBe(selected[0].area.difficultyTier);
    const serialized = JSON.stringify(game);
    for (const hidden of [
      "Private area name",
      "private-area",
      '"answer"',
      '"runs"',
      "secret-clue-1",
      "secret-clue-2",
    ])
      expect(serialized).not.toContain(hidden);
    const ciphertext = Buffer.from(
      game.continuation.split(".")[2],
      "base64url",
    ).toString("utf8");
    expect(ciphertext).not.toContain("Private area name");
    expect(ciphertext).not.toContain('"answer"');
    expect(game.continuation.length).toBeLessThan(SOLO_TOKEN_LIMIT);
    // A fresh process with only the same key/source can resume the browser token.
    expect(
      await new SoloGameService(source, secret).load(
        game.id,
        game.continuation,
        now,
      ),
    ).toEqual(game);
  });

  it("rejects tampering, wrong keys, cross-game tokens, wrong schema and expiry", async () => {
    const { service, source, config } = fixture();
    const game = await service.start(now);
    const other = await service.start(now);
    const parts = game.continuation.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    await expect(
      service.load(game.id, parts.join("."), now),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.load(other.id, game.continuation, now),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      new SoloGameService(source, secret + "different").load(
        game.id,
        game.continuation,
        now,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.load(game.id, game.continuation.replace(/^s1/, "s2"), now),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.load(game.id, game.continuation, now + SOLO_SESSION_LIFETIME),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      service.load(game.id, game.continuation, now - 60001),
    ).rejects.toMatchObject({ status: 400 });
    config.version = "changed-capture";
    await expect(
      service.load(game.id, game.continuation, now),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("scores through semantic masks and allowance, gates reviews, and makes identical retries idempotent", async () => {
    const { service, selected } = fixture();
    const start = await service.start(now);
    await expect(
      service.next(start.id, start.continuation, now),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.review(start.id, start.continuation, 0, now),
    ).rejects.toMatchObject({ status: 404 });
    const revealed = await service.guess(
      start.id,
      start.continuation,
      start.current!.id,
      selected[0].answer,
      2500,
      now,
    );
    expect(revealed.results).toHaveLength(1);
    expect(revealed.results[0]).toMatchObject({
      score: 2500,
      maximum: 2500,
      areaScore: 500,
      positionScore: 2000,
    });
    expect(JSON.stringify(revealed)).not.toContain("private-area-1");
    expect(
      await service.guess(
        start.id,
        revealed.continuation,
        start.current!.id,
        selected[0].answer,
        2500,
        now,
      ),
    ).toEqual(revealed);
    const repeatedOriginal = await service.guess(
      start.id,
      start.continuation,
      start.current!.id,
      selected[0].answer,
      2500,
      now,
    );
    expect(publicState(repeatedOriginal)).toEqual(publicState(revealed));
    await expect(
      service.guess(
        start.id,
        revealed.continuation,
        start.current!.id,
        null,
        2500,
        now,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.guess(
        start.id,
        revealed.continuation,
        start.current!.id,
        selected[0].answer,
        5000,
        now,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await service.review(start.id, revealed.continuation, 0, now),
    ).toMatchObject({
      result: revealed.results[0],
      clue: { frames: selected[0].frames },
    });
    await expect(
      service.review(start.id, revealed.continuation, 1, now),
    ).rejects.toMatchObject({ status: 404 });
    const next = await service.next(start.id, revealed.continuation, now);
    expect(next).toMatchObject({ round: 1, stage: "guess" });
    await expect(
      service.guess(
        start.id,
        next.continuation,
        start.current!.id,
        null,
        5000,
        now,
      ),
    ).rejects.toMatchObject({ status: 409 });

    // Guest demos permit old-token replay; only the returned submitted token
    // freezes its guess. No database is used to turn this into ranked play.
    const branch = await service.guess(
      start.id,
      start.continuation,
      start.current!.id,
      { x: -16128, y: 768 },
      5000,
      now,
    );
    expect(branch.results[0]).toMatchObject({ areaMatch: false, areaScore: 0 });
  });

  it("finishes exactly three rounds and retains all completed reviews", async () => {
    const { service } = fixture();
    let game = await service.start(now);
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      game = await service.guess(
        game.id,
        game.continuation,
        game.current!.id,
        null,
        5000,
        now,
      );
      game = await service.next(game.id, game.continuation, now);
    }
    expect(game).toMatchObject({
      stage: "complete",
      current: null,
      totalRounds: 3,
    });
    expect(game.results).toHaveLength(3);
    expect(game.results.every((r) => r.score === 0)).toBe(true);
    expect(await service.load(game.id, game.continuation, now)).toEqual(game);
    for (let ordinal = 0; ordinal < 3; ordinal++)
      expect(
        await service.review(game.id, game.continuation, ordinal, now),
      ).toMatchObject({ result: game.results[ordinal] });
    await expect(
      service.next(game.id, game.continuation, now),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.review(game.id, game.continuation, 3, now),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects invalid pins, allowances, missing secrets and oversized private payloads", async () => {
    const { service, source, selected } = fixture();
    const game = await service.start(now);
    for (const pin of [undefined, {}, { x: Infinity, y: 3 }, { x: 1e10, y: 3 }])
      await expect(
        service.guess(
          game.id,
          game.continuation,
          game.current!.id,
          pin,
          5000,
          now,
        ),
      ).rejects.toMatchObject({ status: 400 });
    for (const maximum of [undefined, "5000", -1, 5001, 1.5])
      await expect(
        service.guess(
          game.id,
          game.continuation,
          game.current!.id,
          null,
          maximum,
          now,
        ),
      ).rejects.toMatchObject({ status: 400 });
    expect(() => new SoloGameService(source, "")).toThrow("not configured");
    selected[0].area.label = "oversized ".repeat(10000);
    await expect(service.start(now)).rejects.toMatchObject({ status: 503 });
  });

  it("bounds HTTP requests, supports the existing lifecycle paths, and has no image route", async () => {
    const { service } = fixture();
    const request = (path: string, init?: RequestInit) =>
      new Request("https://games.example/api/games" + path, init);
    const post = (value: unknown, token?: string): RequestInit => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Guessr-State": token } : {}),
      },
      body: JSON.stringify(value),
    });
    const started = await soloGameRoute(
      request("/sessions", post({})),
      service,
      now,
    );
    expect(started?.status).toBe(201);
    const game = (await started!.json()) as SoloGameState;
    const path = `/sessions/${game.id}`;
    expect(
      (
        await soloGameRoute(
          request(path, { headers: { "X-Guessr-State": game.continuation } }),
          service,
          now,
        )
      )?.status,
    ).toBe(200);
    expect((await soloGameRoute(request(path), service, now))?.status).toBe(
      400,
    );
    expect(
      (
        await soloGameRoute(
          request("/sessions", post({ extra: true })),
          service,
          now,
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await soloGameRoute(
          request("/sessions", post({ extra: "a".repeat(3000) })),
          service,
          now,
        )
      )?.status,
    ).toBe(413);
    expect(
      (
        await soloGameRoute(
          request("/sessions", { method: "POST", body: "{}" }),
          service,
          now,
        )
      )?.status,
    ).toBe(415);
    expect(
      (
        await soloGameRoute(
          request("/sessions", { ...post({}), body: "{" }),
          service,
          now,
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await soloGameRoute(
          request(path, {
            headers: { "X-Guessr-State": "x".repeat(SOLO_TOKEN_LIMIT + 1) },
          }),
          service,
          now,
        )
      )?.status,
    ).toBe(413);
    expect(
      (
        await soloGameRoute(
          request(
            path + "/guess",
            post(
              { roundId: game.current!.id, guess: null, maximum: 5000 },
              game.continuation,
            ),
          ),
          service,
          now,
        )
      )?.status,
    ).toBe(200);
    expect(
      (await soloGameRoute(request("/config", post({})), service, now))?.status,
    ).toBe(405);
    expect(
      (await soloGameRoute(request("/images/example.webp"), service, now))
        ?.status,
    ).toBe(404);
    expect(
      await soloGameRoute(
        new Request("https://games.example/api/other"),
        service,
        now,
      ),
    ).toBeNull();
    expect(started?.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("demo continuation transport", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_GUESSR_API_URL", "https://games.example");
    vi.stubEnv("VITE_GUESSR_ROUND_API_URL", "");
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function transport() {
    const { service, config } = fixture();
    const calls: { path: string; token: string | null; body: string }[] = [];
    let loseResponse: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "https://map.example");
        calls.push({
          path: url.pathname,
          token: new Headers(init?.headers).get("X-Guessr-State"),
          body: String(init?.body ?? ""),
        });
        if (url.pathname === "/guessr/config.json")
          return Response.json(config);
        url.pathname = url.pathname.replace(/^\/guessr-api/, "/api/games");
        const response = await soloGameRoute(
          new Request(url, init),
          service,
          now,
        );
        if (loseResponse === url.pathname) {
          loseResponse = undefined;
          throw new TypeError("Connection interrupted after submission");
        }
        if (!response) throw new Error("Unexpected route");
        return response;
      }),
    );
    return {
      calls,
      loseNextResponse: (path: string) => {
        loseResponse = path;
      },
    };
  }

  it("persists opaque continuations by game ID across reloads and sends them for review", async () => {
    const { calls } = transport();
    let { imageGameRequest } = await import("../src/guessr/image-game");
    const game = await imageGameRequest<ImageGameState>("/sessions", {});
    expect(game).not.toHaveProperty("continuation");
    expect(storage.size).toBe(1);
    const records = JSON.parse([...storage.values()][0]);
    expect(records[0].id).toBe(game.id);
    expect(records[0].token).toMatch(/^s1\./);
    vi.resetModules();
    ({ imageGameRequest } = await import("../src/guessr/image-game"));
    expect(await imageGameRequest(`/sessions/${game.id}`)).toEqual(game);
    expect(calls.at(-1)?.token).toBe(records[0].token);
    const result = await imageGameRequest<ImageGameState>(
      `/sessions/${game.id}/guess`,
      { roundId: game.current!.id, guess: null, maximum: 5000 },
    );
    const review = await imageGameRequest<{ result: unknown }>(
      `/sessions/${game.id}/reviews/0`,
    );
    expect(review.result).toEqual(result.results[0]);
    expect(calls.at(-1)?.token).not.toBe(records[0].token);
  });

  it("recovers interrupted guesses and advances using the exact persisted mutation", async () => {
    const { calls, loseNextResponse } = transport();
    let { imageGameRequest } = await import("../src/guessr/image-game");
    let game = await imageGameRequest<ImageGameState>("/sessions", {});
    const path = `/sessions/${game.id}`;
    const submission = {
      roundId: game.current!.id,
      guess: null,
      maximum: 4000,
    };
    loseNextResponse(`/api/games${path}/guess`);
    await expect(imageGameRequest(path + "/guess", submission)).rejects.toThrow(
      "interrupted",
    );
    const original = calls.at(-1)!;
    // A reload must retain the request as well as the old encrypted state.
    vi.resetModules();
    ({ imageGameRequest } = await import("../src/guessr/image-game"));
    game = await imageGameRequest<ImageGameState>(path);
    expect(game.stage).toBe("reveal");
    expect(calls.at(-1)).toEqual(original);
    expect(game.results[0]).toMatchObject({ guess: null, maximum: 4000 });
    loseNextResponse(`/api/games${path}/next`);
    await expect(imageGameRequest(path + "/next", {})).rejects.toThrow(
      "interrupted",
    );
    const firstAdvance = calls.at(-1)!;
    game = await imageGameRequest<ImageGameState>(path);
    expect(game).toMatchObject({ round: 1, stage: "guess" });
    expect(calls.at(-1)).toEqual(firstAdvance);
  });

  it("bounds the continuation cache and keeps production config entirely static", async () => {
    const { calls } = transport();
    const { imageGameRequest } = await import("../src/guessr/image-game");
    for (let index = 0; index < 32; index++)
      await imageGameRequest("/sessions", {});
    const serialized = [...storage.values()][0];
    expect(JSON.parse(serialized)).toHaveLength(30);
    expect(serialized.length).toBeLessThanOrEqual(1_000_000);
    vi.stubEnv("VITE_GUESSR_API_URL", "");
    await imageGameRequest("/config");
    expect(calls.at(-1)?.path).toBe("/guessr/config.json");
    expect(calls.at(-1)?.token).toBeNull();
    await expect(imageGameRequest("/sessions", {})).rejects.toThrow(
      "not available",
    );
  });

  it("preserves the local API and works when localStorage cannot persist", async () => {
    const { calls } = transport();
    vi.stubEnv("DEV", true);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Storage disabled");
      },
      setItem: () => {
        throw new Error("Storage disabled");
      },
    });
    const { imageGameRequest } = await import("../src/guessr/image-game");
    await imageGameRequest("/config");
    expect(calls.at(-1)?.path).toBe("/guessr-api/config");
    const game = await imageGameRequest<ImageGameState>("/sessions", {});
    expect(await imageGameRequest(`/sessions/${game.id}`)).toEqual(game);
    expect(calls.at(-1)?.token).toMatch(/^s1\./);
    expect(storage.size).toBe(0);
  });

  it("leaves the local file-backed API unchanged when it has no continuation", async () => {
    vi.stubEnv("DEV", true);
    const game = publicState(await fixture().service.start(now));
    const fetcher = vi.fn(async () => Response.json(game));
    vi.stubGlobal("fetch", fetcher);
    const { imageGameRequest } = await import("../src/guessr/image-game");
    expect(await imageGameRequest("/sessions", {})).toEqual(game);
    expect(await imageGameRequest(`/sessions/${game.id}`)).toEqual(game);
    expect(fetcher).toHaveBeenLastCalledWith(
      `/guessr-api/sessions/${game.id}`,
      expect.objectContaining({ headers: {} }),
    );
    expect(storage.size).toBe(0);
  });
});
