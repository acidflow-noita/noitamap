import {
  cameraRect,
  intersection,
  planView,
  supportedCamera,
  unionRect,
  type Camera,
  type ClueSource,
  type PreparedFrame,
  type ViewRect,
} from "./clue-camera";
import { bindAttribute, tr } from "./i18n";
import { clueLoadingPlaceholder } from './loading-placeholders';
import { mapPinIcon } from './map-pin';
import type { ReplayMotion } from './replay-motion';

type ClueTransition = boolean | { replayFrom: Camera; motion: ReplayMotion };

/** Draws native pixels from the prepared images. Panning changes the crop,
 * keeping about 10% of the previous view visible on each ordinary step. */
export class ClueViewport {
  readonly canvas = document.createElement("canvas");
  private rect?: ViewRect;
  private serial = 0;
  private closed = false;
  private stopAnimation = () => {};
  private images = new Map<string, Promise<HTMLImageElement>>();
  constructor(
    private mount: HTMLElement,
    private source: ClueSource,
    private step = 256,
    private onDraw?: (rect: ViewRect) => void,
  ) {
    this.canvas.setAttribute("role", "img");
    bindAttribute(this.canvas, "aria-label", "The location to identify");
    bindAttribute(mount, "data-loading-label", "Loading clue map…");
    bindAttribute(mount, "data-paused-label", "Paused");
    mount.replaceChildren(this.canvas, clueLoadingPlaceholder());
    if (mount.classList.contains('clue')) mount.append(mapPinIcon('clue'));
  }
  private async image(url: string): Promise<HTMLImageElement> {
    let pending = this.images.get(url);
    if (!pending) {
      pending = (async () => {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      })();
      this.images.set(url, pending);
      pending.catch(() => {
        if (this.images.get(url) === pending) this.images.delete(url);
      });
    }
    // Keep only a small number of decoded source images per active clue.
    this.images.delete(url);
    this.images.set(url, pending);
    while (this.images.size > 6)
      this.images.delete(this.images.keys().next().value!);
    return pending;
  }
  async show(camera: Camera, onReady?: () => void, transition: ClueTransition = true): Promise<boolean> {
    if (!supportedCamera(this.source, camera))
      throw new Error(tr("View is outside the clue boundary."));
    this.stop();
    const serial = this.serial;
    this.canvas.dataset.ready = "false";
    const target = cameraRect(camera);
    const replay = typeof transition === 'object' ? transition : undefined;
    const from = replay ? cameraRect(replay.replayFrom) : this.rect;
    const moved = from && (from.x !== target.x || from.y !== target.y || from.width !== target.width);
    const animate = transition && from && moved && (replay ? !replay.motion.reduced :
      from.width === target.width && from.height === target.height &&
      Math.abs(from.x - target.x) < target.width && Math.abs(from.y - target.y) < target.height &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches);
    const area = animate ? unionRect(from, target) : target;
    let plan: PreparedFrame[], covered = true;
    try {
      plan = planView(this.source, area, this.step);
    } catch (error) {
      if (!replay || !animate) throw error;
      // A sparse older recording may have both endpoints but no terrain between them.
      plan = [...planView(this.source, from, this.step), ...planView(this.source, target, this.step)];
      covered = false;
    }
    const images = await Promise.all(
      plan.map((frame) => this.image(frame.image)),
    );
    if (this.closed || serial !== this.serial) return false;
    const buffer = document.createElement("canvas");
    buffer.width = area.width;
    buffer.height = area.height;
    const bufferContext = buffer.getContext("2d")!;
    bufferContext.imageSmoothingEnabled = false;
    for (let i = 0; i < plan.length; i++) {
      const frame = plan[i],
        cut = intersection(frame, area);
      if (!cut) continue;
      bufferContext.drawImage(
        images[i],
        cut.x - frame.x,
        cut.y - frame.y,
        cut.width,
        cut.height,
        cut.x - area.x,
        cut.y - area.y,
        cut.width,
        cut.height,
      );
    }
    onReady?.();
    const context = this.canvas.getContext("2d")!;
    this.canvas.dataset.ready = "false";
    const draw = (rect: ViewRect) => {
      const width = Math.round(rect.width), height = Math.round(rect.height);
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, width, height);
      context.drawImage(
        buffer,
        rect.x - area.x,
        rect.y - area.y,
        rect.width,
        rect.height,
        0,
        0,
        width,
        height,
      );
      this.rect = rect;
      this.mount.style.setProperty(
        "--target-x",
        `${(-rect.x / rect.width) * 100}%`,
      );
      this.mount.style.setProperty(
        "--target-y",
        `${(-rect.y / rect.height) * 100}%`,
      );
      this.mount.classList.toggle(
        "target-outside",
        rect.x > 0 ||
          rect.x + rect.width < 0 ||
          rect.y > 0 ||
          rect.y + rect.height < 0,
      );
      this.mount.classList.remove("loading");
      this.onDraw?.(rect);
    };
    if (animate && replay) {
      draw(from);
      await this.moveReplayCamera(buffer, area, from, target, covered, replay.motion, draw);
      if (this.closed || serial !== this.serial) return false;
      draw(target);
    } else if (animate) {
      await new Promise<void>((resolve) => {
        const start = performance.now();
        let tick = 0;
        this.stopAnimation = () => {
          cancelAnimationFrame(tick);
          resolve();
        };
        const frame = (now: number) => {
          const t = Math.min(1, (now - start) / 160),
            ease = t * (2 - t);
          draw({
            ...target,
            x: Math.round(from.x + (target.x - from.x) * ease),
            y: Math.round(from.y + (target.y - from.y) * ease),
          });
          if (t < 1) tick = requestAnimationFrame(frame);
          else resolve();
        };
        draw(from);
        tick = requestAnimationFrame(frame);
      });
    } else draw(target);
    if (this.closed || serial !== this.serial) return false;
    this.stopAnimation = () => {};
    this.canvas.dataset.ready = "true";
    return true;
  }
  /** Project native pixels through the two recorded views. Keep the pin at its normal screen size. */
  private async moveReplayCamera(
    buffer: HTMLCanvasElement, area: ViewRect, from: ViewRect, to: ViewRect, covered: boolean,
    motion: ReplayMotion, draw: (rect: ViewRect) => void
  ) {
    const layer = document.createElement('div');
    layer.className = 'replay-pan-layer';
    layer.setAttribute('aria-hidden', 'true');
    const aspect = to.width / to.height;
    const baseWidth = Math.max(area.width, area.height * aspect);
    buffer.style.width = (area.width / baseWidth) * 100 + '%';
    buffer.style.height = (area.height * aspect / baseWidth) * 100 + '%';
    layer.append(buffer);
    const pinLayer = document.createElement('div');
    pinLayer.className = 'replay-pin-layer';
    pinLayer.setAttribute('aria-hidden', 'true');
    const pin = mapPinIcon('clue');
    pin.classList.add('replay-pan-marker');
    pinLayer.append(pin);
    this.mount.append(layer, pinLayer);
    const translation = (x: number, y: number, view: ViewRect) =>
      `translate(${100 * (x - view.x) / view.width}%, ${100 * (y - view.y) / view.height}%)`;
    const terrain = (view: ViewRect) => `${translation(area.x, area.y, view)} scale(${baseWidth / view.width})`;
    const start = covered ? from : to;
    this.stopAnimation = () => motion.cancel();
    try {
      await Promise.all([
        motion.animate(layer, [
          { transform: terrain(start), opacity: covered ? 1 : 0 }, { transform: terrain(to), opacity: 1 },
        ], progress => {
          if (this.closed || !covered) return;
          // Transforms interpolate inverse zoom and the projected world origin.
          const width = 1 / ((1 - progress) / from.width + progress / to.width);
          const height = width / aspect;
          draw({ width, height,
            x: width * ((1 - progress) * from.x / from.width + progress * to.x / to.width),
            y: height * ((1 - progress) * from.y / from.height + progress * to.y / to.height) });
        }),
        motion.animate(pinLayer, [
          { transform: translation(0, 0, start), opacity: covered ? 1 : 0 },
          { transform: translation(0, 0, to), opacity: 1 },
        ]),
      ]);
    } finally {
      layer.remove();
      pinLayer.remove();
    }
  }
  stop(): void {
    this.serial++;
    const stop = this.stopAnimation;
    this.stopAnimation = () => {};
    stop();
  }
  destroy(): void {
    this.closed = true;
    this.stop();
    this.images.clear();
  }
}
