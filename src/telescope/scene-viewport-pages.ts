import { clipTerrainPresentation } from './terrain-presentation-clip';
import type { ViewportArtBounds } from './viewport-art';
import type { TerrainPixelRect } from './terrain-pixel-clip';

export interface SceneViewportPage extends TerrainPixelRect {
  key: string;
  level: number;
  /** World pixels per image pixel. */
  scale: number;
  size: number;
  gutter: number;
}
type Entry = SceneViewportPage & { context: CanvasRenderingContext2D; bytes: number };
const intersects = (a: TerrainPixelRect, b: TerrainPixelRect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (a: TerrainPixelRect, b: TerrainPixelRect) =>
  a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
function subtract(a: TerrainPixelRect, b: TerrainPixelRect): TerrainPixelRect[] {
  if (!intersects(a, b)) return [a];
  const left = Math.max(a.x, b.x), top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return [
    { x: a.x, y: a.y, width: a.width, height: top - a.y },
    { x: a.x, y: bottom, width: a.width, height: a.y + a.height - bottom },
    { x: a.x, y: top, width: left - a.x, height: bottom - top },
    { x: right, y: top, width: a.x + a.width - right, height: bottom - top },
  ].filter(rect => rect.width > 0 && rect.height > 0);
}

/** World-aligned artwork survives camera movement independently of OSD's LOD.
 * Native pages have their own budget: generating an overview cannot evict an
 * already resolved room. Coarser pages fill only coverage not held by finer
 * pages, including authoritative transparent pixels and overlapping scenes. */
export function createSceneViewportPages(options: {
  maxBytes: number;
  contains: (rect: TerrainPixelRect) => boolean;
  render: (page: SceneViewportPage, cancelled: () => boolean) => Promise<CanvasRenderingContext2D>;
  changed: () => void;
  ready: (ready: boolean) => void;
  failure: (error: unknown) => void;
}) {
  const gutter = 4;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1944)
    throw new RangeError('Scene viewport budget must hold six guarded pixels (1944 bytes)');
  const size = Math.max(1, Math.min(128, 2 ** Math.floor(Math.log2(Math.sqrt(options.maxBytes / 24))) - gutter * 2));
  const allocation = (size + gutter * 2) ** 2 * 4;
  // Include the one in-flight page in this limit; insertion owns its canvas.
  const budget = options.maxBytes;
  const nativeBudget = Math.max(allocation, Math.min(budget - 5 * allocation, Math.floor((budget - allocation) * .8)));
  const previewBudget = budget - allocation - nativeBudget;
  const entries = new Map<string, Entry>();
  let view: TerrainPixelRect = { x: 0, y: 0, width: 0, height: 0 };
  let wanted: SceneViewportPage[] = [], active: SceneViewportPage | undefined;
  let destroyed = false, bytes = 0, rendered = 0, failed: unknown, currentLevel = 0;
  const limits = (level: number) => level === 0 ? nativeBudget : previewBudget;
  const cacheBytes = (level: number) => [...entries.values()].reduce((sum, e) => sum + ((e.level === 0) === (level === 0) ? e.bytes : 0), 0);
  const remove = (entry: Entry) => {
    entries.delete(entry.key); bytes -= entry.bytes;
    entry.context.canvas.width = entry.context.canvas.height = 0;
  };
  const updateReady = () => options.ready(wanted.every(page => entries.has(page.key)));
  const pump = () => {
    if (destroyed || active || failed) return;
    const page = wanted.find(page => !entries.has(page.key));
    if (!page) return;
    active = page;
    void options.render(page, () => destroyed).then(context => {
      if (destroyed) { context.canvas.width = context.canvas.height = 0; return; }
      const entry = { ...page, context, bytes: context.canvas.width * context.canvas.height * 4 };
      // A ready parent replaces its children atomically. Until it is ready the
      // original pages remain visible; new work never clears displayed artwork.
      const candidates = [...entries.values()].filter(e => (e.level === 0) === (page.level === 0))
        .sort((a, b) => Number(intersects(a, view)) - Number(intersects(b, view))
          || Number(contains(page, b)) - Number(contains(page, a)));
      while (cacheBytes(page.level) + entry.bytes > limits(page.level) && candidates.length) remove(candidates.shift()!);
      entries.set(entry.key, entry); bytes += entry.bytes; rendered++;
      options.changed();
    }).catch(error => {
      if (!destroyed && error?.name !== 'AbortError') { failed = error; options.ready(false); options.failure(error); }
    }).finally(() => { active = undefined; pump(); });
  };
  return {
    draw(context: CanvasRenderingContext2D, bounds: ViewportArtBounds) {
      view = { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
      let level = Math.max(0, Math.floor(Math.log2(1 / bounds.scale)));
      const plan = () => {
        const scale = 2 ** level, span = size * scale;
        const pages: SceneViewportPage[] = [];
        for (let y = Math.floor(view.y / span) * span; y < view.y + view.height; y += span)
          for (let x = Math.floor(view.x / span) * span; x < view.x + view.width; x += span) {
            const page = { x, y, width: span, height: span, scale, size, gutter, level, key: `${level}/${x}/${y}` };
            if (options.contains(page)) pages.push(page);
          }
        return pages;
      };
      wanted = plan();
      // Charge actual scene-bearing pages, not empty terrain across the whole
      // viewport. Empty map area must never force a small visible room blurry.
      while (wanted.length * allocation > limits(level)) { level++; wanted = plan(); }
      currentLevel = level;
      const cx = view.x + view.width / 2, cy = view.y + view.height / 2;
      wanted.sort((a, b) => Math.hypot(a.x + a.width / 2 - cx, a.y + a.height / 2 - cy)
        - Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy));
      const ready = [...entries.values()].filter(entry => intersects(entry, view)).sort((a, b) => a.level - b.level);
      const covered: TerrainPixelRect[] = [];
      for (const entry of ready) {
        let rectangles: TerrainPixelRect[] = [entry];
        for (const prior of covered) rectangles = rectangles.flatMap(rect => subtract(rect, prior));
        if (!rectangles.length) continue;
        context.save();
        try {
          clipTerrainPresentation(context, rectangles);
          context.imageSmoothingEnabled = entry.scale * bounds.scale < 1;
          context.imageSmoothingQuality = 'high';
          context.drawImage(entry.context.canvas, entry.x - entry.gutter * entry.scale,
            entry.y - entry.gutter * entry.scale,
            (entry.size + 2 * entry.gutter) * entry.scale, (entry.size + 2 * entry.gutter) * entry.scale);
        } finally { context.restore(); }
        covered.push(entry);
      }
      updateReady(); pump();
    },
    get stats() { return { bytes, maxBytes: budget, workingBytes: active ? allocation : 0,
      nativeBytes: cacheBytes(0), previewBytes: cacheBytes(1), rendered, entries: entries.size,
      pending: wanted.filter(page => !entries.has(page.key)).length, failed: !!failed, level: currentLevel }; },
    dispose() { destroyed = true; wanted = []; for (const entry of [...entries.values()]) remove(entry); },
  };
}
