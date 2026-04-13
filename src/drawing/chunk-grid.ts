import { CHUNK_SIZE } from "../constants";

declare const OpenSeadragon: any;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let viewer: any = null;
let animHandler: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let visible = false;

function getMapBounds(): { left: number; top: number; right: number; bottom: number } | null {
  if (!viewer) return null;
  const world = viewer.world;
  if (world.getItemCount() === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < world.getItemCount(); i++) {
    const item = world.getItemAt(i);
    const b = item.getBounds();
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { left: minX, top: minY, right: maxX, bottom: maxY };
}

function draw() {
  if (!canvas || !ctx || !viewer) return;

  const vp = viewer.viewport;
  const container = viewer.container as HTMLElement;
  const w = container.clientWidth;
  const h = container.clientHeight;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  ctx.clearRect(0, 0, w, h);

  const mapBounds = getMapBounds();
  if (!mapBounds) return;

  // Intersect visible viewport with map bounds
  const vpBounds = vp.getBounds();
  const left = Math.max(vpBounds.x, mapBounds.left);
  const top = Math.max(vpBounds.y, mapBounds.top);
  const right = Math.min(vpBounds.x + vpBounds.width, mapBounds.right);
  const bottom = Math.min(vpBounds.y + vpBounds.height, mapBounds.bottom);

  if (left >= right || top >= bottom) return;

  // Calculate first/last chunk lines within map bounds
  const startCX = Math.floor(mapBounds.left / CHUNK_SIZE) * CHUNK_SIZE;
  const endCX = Math.ceil(mapBounds.right / CHUNK_SIZE) * CHUNK_SIZE;
  const startCY = Math.floor(mapBounds.top / CHUNK_SIZE) * CHUNK_SIZE;
  const endCY = Math.ceil(mapBounds.bottom / CHUNK_SIZE) * CHUNK_SIZE;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();

  // Vertical lines (clamped to visible area)
  for (let gx = startCX; gx <= endCX; gx += CHUNK_SIZE) {
    if (gx < left || gx > right) continue;
    const p = vp.viewportToViewerElementCoordinates(new OpenSeadragon.Point(gx, top));
    const p2 = vp.viewportToViewerElementCoordinates(new OpenSeadragon.Point(gx, bottom));
    ctx.moveTo(Math.round(p.x) + 0.5, p.y);
    ctx.lineTo(Math.round(p2.x) + 0.5, p2.y);
  }

  // Horizontal lines (clamped to visible area)
  for (let gy = startCY; gy <= endCY; gy += CHUNK_SIZE) {
    if (gy < top || gy > bottom) continue;
    const p = vp.viewportToViewerElementCoordinates(new OpenSeadragon.Point(left, gy));
    const p2 = vp.viewportToViewerElementCoordinates(new OpenSeadragon.Point(right, gy));
    ctx.moveTo(p.x, Math.round(p.y) + 0.5);
    ctx.lineTo(p2.x, Math.round(p2.y) + 0.5);
  }

  ctx.stroke();
}

export function initChunkGrid(osdViewer: any) {
  viewer = osdViewer;
}

export function showChunkGrid(show: boolean) {
  if (show === visible) return;
  visible = show;

  if (show) {
    if (!viewer) return;
    const container = viewer.container as HTMLElement;

    canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;";
    container.appendChild(canvas);
    ctx = canvas.getContext("2d");

    animHandler = () => draw();
    viewer.addHandler("animation", animHandler);
    viewer.addHandler("animation-finish", animHandler);
    viewer.addHandler("resize", animHandler);

    resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(container);

    draw();
  } else {
    if (animHandler && viewer) {
      viewer.removeHandler("animation", animHandler);
      viewer.removeHandler("animation-finish", animHandler);
      viewer.removeHandler("resize", animHandler);
      animHandler = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (canvas) {
      canvas.remove();
      canvas = null;
      ctx = null;
    }
  }
}
