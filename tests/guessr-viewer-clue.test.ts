import { describe, expect, it } from "vitest";
import {
  cameraRect,
  intersection,
  planView,
  travelLimits,
  type ClueSource,
  type PreparedFrame,
} from "../src/guessr/clue-camera";
import {
  decodeViewerClue,
  encodeViewerClue,
  viewerClueLink,
  VIEWER_CLUE_LIMITS,
  type ViewerClueSnapshot,
} from "../src/guessr/viewer-clue";

const config = {
  version: "guessr-images-4c856fd7c7556ffa44eea9c455c33130",
  imageRoot: "https://clues.example/images",
};
const image = (id: number) =>
  `${config.imageRoot}/${id.toString(16).padStart(32, "0")}.webp`;
const source: ClueSource = {
  frames: Array.from({ length: 24 }, (_, i) => ({
    image: image(i + 1),
    x: -1282 + (i % 6) * 512,
    y: -770 + Math.floor(i / 6) * 512,
    width: 516,
    height: 516,
  })),
};
const snapshot: ViewerClueSnapshot = {
  source,
  camera: { dx: 0, dy: 0, level: 0 },
  round: 2,
  version: config.version,
};
const encode = (value = snapshot) => encodeViewerClue(value, config);
const decode = (payload: string) => decodeViewerClue(payload, config);
const encodedBytes = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");
function mutate(
  payload: string,
  change: (bytes: Uint8Array, data: DataView) => void,
): string {
  const bytes = Uint8Array.from(Buffer.from(payload, "base64url"));
  change(bytes, new DataView(bytes.buffer));
  return encodedBytes(bytes);
}

describe("static viewer clue snapshots", () => {
  it('shares complete exploration coverage and starting costs in a Twitch-sized link', () => {
    const payload = encode({ ...snapshot, assistance: { widest: 4, travelSpent: 200 } });
    const result = decode(payload);
    expect(result.assistance).toEqual({ widest: 4, travelSpent: 200 });
    for (let level = 0; level <= 6; level++) {
      const bounds = travelLimits(source, level);
      for (const camera of [{ dx: 0, dy: 0, level }, { dx: bounds.maxX, dy: bounds.minY, level }])
        expect(planView(result.source, cameraRect(camera))).toEqual(planView(source, cameraRect(camera)));
    }
    expect(viewerClueLink('https://dynamic-map.noitamap.com/guess/?channel=abcdefghijklmnopqrstuvwxy', payload).fitsTwitch).toBe(true);
    expect(() => encode({ ...snapshot, source: { frames: [source.frames![7]] }, assistance: { widest: 0, travelSpent: 0 } })).toThrow();
    for (const value of [7 << 13, 5001])
      expect(() => decode(mutate(payload, (_, data) => data.setUint16(24, value, true)))).toThrow();
  });
  it("keeps the exact panned crop and original target origin using only visible images", () => {
    const camera = { dx: 273, dy: 274, level: 3 };
    const decoded = decode(encode({ ...snapshot, camera }));
    expect(decoded.camera).toEqual(camera);
    expect(decoded.origin).toEqual({ x: 0, y: 0 });
    expect(decoded.round).toBe(snapshot.round);
    expect(decoded.version).toBe(config.version);
    const rect = cameraRect(camera);
    expect(decoded.source.frames).toEqual(planView(source, rect));
    expect(decoded.source.frames).toHaveLength(4);
    expect(decoded.source.frames!.length).toBeLessThan(source.frames!.length);
    expect(
      decoded.source.frames!.every((frame) => intersection(frame, rect)),
    ).toBe(true);
    expect(planView(decoded.source, rect)).toEqual(planView(source, rect));
  });

  it("preserves every native zoom and bounded edge position", () => {
    for (let level = 0; level <= 6; level++) {
      const bounds = travelLimits(source, level);
      for (const [dx, dy] of [
        [0, 0],
        [bounds.maxX, bounds.maxY],
        [bounds.minX, bounds.minY],
      ]) {
        const camera = { dx, dy, level };
        const decoded = decode(encode({ ...snapshot, camera }));
        expect(decoded.camera).toEqual(camera);
        expect(planView(decoded.source, cameraRect(camera))).toEqual(
          planView(source, cameraRect(camera)),
        );
      }
    }
  });

  it("serializes only allowlisted current-view fields", () => {
    const secret = {
      answer: { x: 912345, y: -654321 },
      areaId: "hidden-area",
      session: { id: "session-secret", token: "session-token" },
      token: "reveal-token",
      auth: "auth-secret",
      futureRounds: [{ image: "future-round-secret" }],
    };
    const payload = encode({
      ...snapshot,
      ...secret,
      camera: { ...snapshot.camera, ...secret },
      source: {
        ...snapshot.source,
        ...secret,
        frames: snapshot.source.frames!.map((frame) => ({
          ...frame,
          ...secret,
        })),
      },
    });
    expect(payload).toBe(encode());
    expect(Object.keys(decode(payload)).sort()).toEqual([
      "camera",
      "origin",
      "round",
      "source",
      "version",
    ]);
    const raw = Buffer.from(payload, "base64url").toString("utf8");
    for (const name of Object.keys(secret)) expect(raw).not.toContain(name);
    for (const frame of decode(payload).source.frames!)
      expect(Object.keys(frame).sort()).toEqual([
        "height",
        "image",
        "width",
        "x",
        "y",
      ]);
  });

  it("reconstructs all image addresses from trusted configuration", () => {
    const payload = encode();
    const local = decodeViewerClue(payload, {
      ...config,
      imageRoot: "/guessr-images/images/",
    });
    expect(local.source.frames![0].image).toMatch(
      /^\/guessr-images\/images\/[a-f0-9]{32}\.webp$/,
    );
    expect(Buffer.from(payload, "base64url").toString()).not.toContain("https");
    for (const address of [
      "https://evil.example/images/" + "1".repeat(32) + ".webp",
      config.imageRoot + "/../" + "1".repeat(32) + ".webp",
      config.imageRoot + "/" + "1".repeat(32) + ".webp?token=secret",
      config.imageRoot + "/" + "1".repeat(32) + ".png",
      "data:image/webp;base64,AAAA",
      "javascript:alert(1)",
    ]) {
      const frame = { ...source.frames![0], x: -258, y: -258, image: address };
      expect(() =>
        encode({ ...snapshot, source: { frames: [frame] } }),
      ).toThrow();
    }
    for (const imageRoot of [
      "//evil.example/images",
      "data:image/webp;base64,",
      "http://evil.example/images",
      "https://user:secret@clues.example/images",
      "https://clues.example/images?token=secret",
      "images",
      "",
    ])
      expect(() =>
        decodeViewerClue(payload, { ...config, imageRoot }),
      ).toThrow();
  });

  it("rejects incompatible datasets and malformed versions", () => {
    expect(() =>
      decodeViewerClue(encode(), { ...config, version: "different-dataset" }),
    ).toThrow("different dataset");
    expect(() =>
      encode({ ...snapshot, version: "different-dataset" }),
    ).toThrow();
    expect(() =>
      decode(
        mutate(encode(), (bytes) => {
          bytes[0] = 99;
        }),
      ),
    ).toThrow();
    expect(() =>
      decode(
        mutate(encode(), (bytes) => {
          bytes[1] = 65;
        }),
      ),
    ).toThrow();
  });

  it("rejects oversized, noncanonical, truncated, and trailing payloads", () => {
    const payload = encode();
    for (const invalid of [
      "",
      "A",
      payload + "=",
      payload + "#",
      " " + payload,
      payload.slice(0, -2),
      encodedBytes(
        Buffer.concat([Buffer.from(payload, "base64url"), Buffer.from([0])]),
      ),
      "A".repeat(VIEWER_CLUE_LIMITS.payloadCharacters + 1),
      // The final nonzero unused base64 bits must not alias a valid payload.
      payload.slice(0, -1) + "R",
    ])
      expect(() => decode(invalid)).toThrow();
  });

  it("rejects unsupported cameras, round values, and image counts before URLs are returned", () => {
    for (const change of [
      (bytes: Uint8Array) => (bytes[18] = 0),
      (bytes: Uint8Array) => (bytes[18] = 100),
      (bytes: Uint8Array) => (bytes[19] = 7),
      (_: Uint8Array, data: DataView) => data.setInt16(20, 1000, true),
      (_: Uint8Array, data: DataView) => data.setInt16(22, -1000, true),
      (bytes: Uint8Array) => (bytes[24] = 0),
      (bytes: Uint8Array) => (bytes[24] = VIEWER_CLUE_LIMITS.frames + 1),
    ])
      expect(() => decode(mutate(encode(), change))).toThrow();
    for (const camera of [
      { dx: Number.NaN, dy: 0, level: 0 },
      { dx: 0.5, dy: 0, level: 0 },
      { dx: 0, dy: 0, level: Number.POSITIVE_INFINITY },
      { dx: 0, dy: 0, level: -1 },
      { dx: 1, dy: 0, level: 6 },
    ])
      expect(() => encode({ ...snapshot, camera })).toThrow();
  });

  it("rejects invalid dimensions, invisible images, and partial viewport coverage", () => {
    for (const change of [
      (_: Uint8Array, data: DataView) => data.setUint16(45, 0, true),
      (_: Uint8Array, data: DataView) => data.setUint16(47, 0, true),
      (_: Uint8Array, data: DataView) => data.setUint16(45, 2049, true),
      (_: Uint8Array, data: DataView) => data.setInt16(41, 4097, true),
      (_: Uint8Array, data: DataView) => data.setInt16(43, -4097, true),
      (_: Uint8Array, data: DataView) => data.setInt16(41, 0, true),
      (_: Uint8Array, data: DataView) => data.setInt16(43, 0, true),
    ])
      expect(() => decode(mutate(encode(), change))).toThrow();
  });

  it("detects gaps even when overlapping frame area exceeds the viewport area", () => {
    const full = cameraRect(snapshot.camera);
    const frames: PreparedFrame[] = [
      { image: image(1), ...full, width: 20 },
      { image: image(2), ...full, x: full.x + 20, width: 7 },
    ];
    const payload = encode({ ...snapshot, source: { frames } });
    expect(decode(payload).source.frames).toHaveLength(2);
    // Move the second frame left: the left-hand overlap cannot fill the gap
    // on the right, although the two full image areas still sum to the view.
    expect(() =>
      decode(
        mutate(payload, (_, data) => {
          data.setInt16(65, full.x, true);
          data.setUint16(69, 26, true);
        }),
      ),
    ).toThrow();
  });

  it("rejects duplicate records and excessive declared decoded pixel memory", () => {
    const camera = { dx: 0, dy: 0, level: 6 };
    const payload = encode({ ...snapshot, camera });
    expect(() =>
      decode(
        mutate(payload, (bytes) => {
          const first = 26 + 4 * (bytes[25] + bytes[24] / bytes[25]);
          bytes.copyWithin(first + 17, first, first + 17);
        }),
      ),
    ).toThrow();
    expect(() =>
      decode(
        mutate(payload, (bytes, data) => {
          const axes = bytes[25] + bytes[24] / bytes[25];
          for (let i = 0; i < axes; i++) data.setUint16(28 + i * 4, 2048, true);
        }),
      ),
    ).toThrow();
  });

  it("fits a full native grid and a maximum-length channel in Twitch without truncating the view", () => {
    const base =
      "https://dynamic-map.noitamap.com/guess/?channel=abcdefghijklmnopqrstuvwxy";
    const small = viewerClueLink(base, encode());
    expect(small.fitsTwitch).toBe(true);
    expect(small.length).toBe(small.url.length);
    expect(new URL(small.url).hash).toBe("#clue=" + encode());
    const large = viewerClueLink(
      base,
      encode({ ...snapshot, camera: { dx: 0, dy: 0, level: 6 } }),
    );
    expect(large.length).toBeLessThanOrEqual(500);
    expect(large.fitsTwitch).toBe(true);
    expect(decode(new URL(large.url).hash.slice(6)).camera.level).toBe(6);
    expect(viewerClueLink(base + '&extra=' + 'x'.repeat(500), encode()).fitsTwitch).toBe(false);
  });

  it("rejects invalid grid dimensions, repeated cells and out-of-range cells", () => {
    const payload = encode({ ...snapshot, camera: { dx: 0, dy: 0, level: 6 } });
    expect(Buffer.from(payload, 'base64url')[0]).toBe(2);
    for (const count of [0, 7, 255])
      expect(() => decode(mutate(payload, bytes => { bytes[25] = count; }))).toThrow();
    expect(() => decode(mutate(payload, bytes => {
      const first = 26 + 4 * (bytes[25] + bytes[24] / bytes[25]);
      bytes[first + 16] = bytes[24];
    }))).toThrow();
  });
});
