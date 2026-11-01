/** Static, current-view snapshots. Only opaque image IDs and clue-relative
 * geometry cross the fragment; a trusted caller supplies the image root. */
import {
  cameraRect,
  intersection,
  planView,
  preparedFrames,
  supportedCamera,
  type Camera,
  type ClueSource,
  type PreparedFrame,
  type ViewRect,
} from "./clue-camera.ts";

export interface ViewerClueConfig {
  /** The site's current public dataset version, never a value from the link. */
  version: string;
  /** Configured static image directory, never a value from the link. */
  imageRoot: string;
}

export interface ViewerClueSnapshot {
  source: ClueSource;
  camera: Camera;
  /** Human-readable round number, starting at one. */
  round: number;
  version: string;
  /** New round links include the full exploration area and its starting costs. */
  assistance?: { widest: number; travelSpent: number };
}

export interface DecodedViewerClue extends ViewerClueSnapshot {
  /** Frames and camera retain this original clue-relative target origin.
   * Pass source/camera directly to ClueViewport; do not centre them again. */
  origin: { x: 0; y: 0 };
}

export const VIEWER_CLUE_LIMITS = Object.freeze({
  payloadCharacters: 1024,
  frames: 16,
  dimension: 2048,
  pixels: 8 * 1024 * 1024,
  round: 99,
  twitchCharacters: 500,
});

const schema = 1;
const canonicalVersion = /^guessr-images-([a-f0-9]{32})$/;
const versionPattern = /^[A-Za-z0-9_-]{1,64}$/;
const idPattern = /^[a-f0-9]{32}$/;
const hex = Array.from({ length: 256 }, (_, n) =>
  n.toString(16).padStart(2, "0"),
);
const invalid = () => new Error("This shared clue link is invalid.");
const integer = (value: number, low: number, high: number) =>
  Number.isSafeInteger(value) && value >= low && value <= high;

function imageRoot(config: ViewerClueConfig): string {
  const value = config.imageRoot;
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    /[\\\s?#]/.test(value)
  )
    throw new Error("The clue image address is invalid.");
  // Relative roots are site-absolute. Absolute roots use HTTPS, or local HTTP
  // for development. The fragment can never replace this configured address.
  const url = new URL(value, "https://viewer-clue.invalid");
  const relative = value.startsWith("/") && !value.startsWith("//");
  if (
    (!relative &&
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    (!relative && !/^https?:\/\//.test(value)) ||
    url.username ||
    url.password
  )
    throw new Error("The clue image address is invalid.");
  return (relative ? url.pathname : url.href).replace(/\/+$/, "") + "/";
}

function validCamera(camera: Camera): boolean {
  return !!camera && integer(camera.level, 0, 6) && supportedCamera({}, camera);
}

function validFrame(frame: PreparedFrame, viewport: ViewRect): boolean {
  return (
    integer(frame.x, -4096, 4096) &&
    integer(frame.y, -4096, 4096) &&
    integer(frame.width, 1, VIEWER_CLUE_LIMITS.dimension) &&
    integer(frame.height, 1, VIEWER_CLUE_LIMITS.dimension) &&
    intersection(frame, viewport) !== null
  );
}

/** A bounded band sweep proves every viewport pixel is covered, including
 * seams. Overlap area alone is insufficient because it can hide gaps. */
function coversViewport(frames: PreparedFrame[], viewport: ViewRect): boolean {
  const cuts = frames.map((frame) => intersection(frame, viewport)!);
  const rows = [
    ...new Set([
      viewport.y,
      viewport.y + viewport.height,
      ...cuts.flatMap((cut) => [cut.y, cut.y + cut.height]),
    ]),
  ].sort((a, b) => a - b);
  for (let i = 1; i < rows.length; i++) {
    const intervals = cuts
      .filter((cut) => cut.y <= rows[i - 1] && cut.y + cut.height >= rows[i])
      .sort((a, b) => a.x - b.x);
    let right = viewport.x;
    for (const cut of intervals) {
      if (cut.x > right) return false;
      right = Math.max(right, cut.x + cut.width);
    }
    if (right !== viewport.x + viewport.width) return false;
  }
  return true;
}

function validateFrames(frames: PreparedFrame[], camera: Camera): void {
  const viewport = cameraRect(camera);
  if (
    frames.length < 1 ||
    frames.length > VIEWER_CLUE_LIMITS.frames ||
    frames.some((frame) => !validFrame(frame, viewport)) ||
    frames.reduce((sum, frame) => sum + frame.width * frame.height, 0) >
      VIEWER_CLUE_LIMITS.pixels ||
    new Set(frames.map((frame) => `${frame.image},${frame.x},${frame.y}`))
      .size !== frames.length ||
    !coversViewport(frames, viewport)
  )
    throw invalid();
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function readBase64(payload: string): Uint8Array {
  if (
    typeof payload !== "string" ||
    !payload.length ||
    payload.length > VIEWER_CLUE_LIMITS.payloadCharacters ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    payload.length % 4 === 1
  )
    throw invalid();
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
      (char) => char.charCodeAt(0),
    );
  } catch {
    throw invalid();
  }
  if (base64(bytes) !== payload) throw invalid();
  return bytes;
}

/** Encode a snapshot of the current viewport. Extra input properties are never
 * serialized. The returned base64url value is suitable for a #clue= fragment.
 * There are no network requests, image processing, session IDs, or live sync. */
export function encodeViewerClue(
  snapshot: ViewerClueSnapshot,
  config: ViewerClueConfig,
): string {
  const { source, camera, round, version, assistance } = snapshot;
  if (
    !versionPattern.test(version) ||
    version !== config.version ||
    !validCamera(camera) ||
    assistance !== undefined && (!integer(assistance.widest, camera.level, 6) || !integer(assistance.travelSpent, 0, 5000)) ||
    !integer(round, 1, VIEWER_CLUE_LIMITS.round) ||
    !source ||
    (source.frames
      ? !Array.isArray(source.frames) || source.frames.length > 256
      : Object.keys(source.views ?? {}).length > 256)
  )
    throw invalid();
  const root = imageRoot(config),
    coverage = assistance ? { dx: 0, dy: 0, level: 6 } : camera,
    viewport = cameraRect(coverage);
  const available = preparedFrames(source).filter((frame) =>
    validFrame(frame, viewport),
  );
  const frames = assistance ? available : planView({ frames: available }, viewport);
  validateFrames(frames, coverage);
  const ids = frames.map((frame) => {
    const id = frame.image.startsWith(root)
      ? frame.image.slice(root.length, -5)
      : "";
    if (!idPattern.test(id) || frame.image !== root + id + ".webp")
      throw new Error("Only prepared clue images can be shared.");
    return id;
  });
  // Native map pieces form a grid. Store each column/row geometry once while
  // retaining frame order, so even the widest view fits a Twitch chat link.
  const columns = [...new Map(frames.map(frame => [frame.x, { x: frame.x, width: frame.width }])).values()]
    .sort((a, b) => a.x - b.x);
  const rows = [...new Map(frames.map(frame => [frame.y, { y: frame.y, height: frame.height }])).values()]
    .sort((a, b) => a.y - b.y);
  const grid = frames.length >= 4 && columns.length * rows.length === frames.length
    && new Set(frames.map(frame => `${frame.x},${frame.y}`)).size === frames.length
    && frames.every(frame => columns.find(column => column.x === frame.x)!.width === frame.width
      && rows.find(row => row.y === frame.y)!.height === frame.height)
    && 1 + 4 * (columns.length + rows.length) + 17 * frames.length < 24 * frames.length;
  const bytes: number[] = [assistance ? (grid ? 4 : 3) : grid ? 2 : schema];
  const write16 = (value: number) =>
    bytes.push(value & 255, (value >> 8) & 255);
  const writeId = (id: string) => {
    for (let i = 0; i < 32; i += 2)
      bytes.push(parseInt(id.slice(i, i + 2), 16));
  };
  const compact = canonicalVersion.exec(version);
  if (compact) {
    bytes.push(0);
    writeId(compact[1]);
  } else {
    bytes.push(version.length);
    for (const char of version) bytes.push(char.charCodeAt(0));
  }
  bytes.push(round, camera.level);
  write16(camera.dx);
  write16(camera.dy);
  if (assistance) write16((assistance.widest << 13) | assistance.travelSpent);
  bytes.push(frames.length);
  if (grid) {
    bytes.push(columns.length);
    columns.forEach(column => { write16(column.x); write16(column.width); });
    rows.forEach(row => { write16(row.y); write16(row.height); });
  }
  frames.forEach((frame, i) => {
    writeId(ids[i]);
    if (grid) bytes.push(rows.findIndex(row => row.y === frame.y) * columns.length
      + columns.findIndex(column => column.x === frame.x));
    else {
      write16(frame.x);
      write16(frame.y);
      write16(frame.width);
      write16(frame.height);
    }
  });
  return base64(new Uint8Array(bytes));
}

/** Fully validate untrusted data before returning any loadable image URLs.
 * A different dataset, partial view, extra bytes, or excessive input is rejected.
 * Use returned source/camera directly with ClueViewport for the host's crop. */
export function decodeViewerClue(
  payload: string,
  config: ViewerClueConfig,
): DecodedViewerClue {
  const bytes = readBase64(payload),
    data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const read8 = () => {
    if (offset >= bytes.length) throw invalid();
    return bytes[offset++];
  };
  const read16 = (signed = false) => {
    if (offset + 2 > bytes.length) throw invalid();
    const value = signed
      ? data.getInt16(offset, true)
      : data.getUint16(offset, true);
    offset += 2;
    return value;
  };
  const readId = () => {
    let id = "";
    for (let i = 0; i < 16; i++) id += hex[read8()];
    return id;
  };
  const encoding = read8();
  if (![schema, 2, 3, 4].includes(encoding)) throw invalid();
  const versionLength = read8();
  if (versionLength > 64) throw invalid();
  let version = "";
  if (versionLength === 0) version = "guessr-images-" + readId();
  else
    for (let i = 0; i < versionLength; i++)
      version += String.fromCharCode(read8());
  if (!versionPattern.test(version)) throw invalid();
  if (version !== config.version)
    throw new Error(
      "This clue uses a different dataset. Ask the host for a new link.",
    );
  const round = read8();
  const camera: Camera = { level: read8(), dx: read16(true), dy: read16(true) };
  if (!integer(round, 1, VIEWER_CLUE_LIMITS.round) || !validCamera(camera))
    throw invalid();
  let assistance: ViewerClueSnapshot['assistance'];
  if (encoding >= 3) {
    const costs = read16();
    assistance = { widest: costs >> 13, travelSpent: costs & 8191 };
    if (!integer(assistance.widest, camera.level, 6) || !integer(assistance.travelSpent, 0, 5000)) throw invalid();
  }
  const count = read8();
  if (count < 1 || count > VIEWER_CLUE_LIMITS.frames) throw invalid();
  // Retain IDs as inert strings until all geometry has been validated.
  let frames: PreparedFrame[];
  if (encoding === 2 || encoding === 4) {
    const width = read8();
    if (width < 1 || width > count || count % width !== 0) throw invalid();
    const height = count / width;
    if (bytes.length !== offset + 4 * (width + height) + count * 17) throw invalid();
    const columns = Array.from({ length: width }, () => ({ x: read16(true), width: read16() }));
    const rows = Array.from({ length: height }, () => ({ y: read16(true), height: read16() }));
    if (columns.some((column, i) => i > 0 && column.x <= columns[i - 1].x)
      || rows.some((row, i) => i > 0 && row.y <= rows[i - 1].y)) throw invalid();
    const used = new Set<number>();
    frames = Array.from({ length: count }, () => {
      const image = readId(), cell = read8();
      if (cell >= count || used.has(cell)) throw invalid();
      used.add(cell);
      return { image, ...columns[cell % width], ...rows[Math.floor(cell / width)] };
    });
  } else {
    if (bytes.length !== offset + count * 24) throw invalid();
    frames = Array.from({ length: count }, () => ({
      image: readId(), x: read16(true), y: read16(true), width: read16(), height: read16(),
    }));
  }
  validateFrames(frames, assistance ? { dx: 0, dy: 0, level: 6 } : camera);
  const root = imageRoot(config);
  for (const frame of frames) frame.image = root + frame.image + ".webp";
  return { source: { frames }, camera, round, version, origin: { x: 0, y: 0 }, ...(assistance ? { assistance } : {}) };
}

/** Report the complete link length; never truncate a snapshot to fit chat.
 * The supplied base URL should already identify the public viewer page. */
export function viewerClueLink(
  baseUrl: string,
  payload: string,
): { url: string; length: number; fitsTwitch: boolean } {
  const url = new URL(baseUrl);
  url.hash = "clue=" + payload;
  const value = url.href;
  return {
    url: value,
    length: value.length,
    fitsTwitch: value.length <= VIEWER_CLUE_LIMITS.twitchCharacters,
  };
}
