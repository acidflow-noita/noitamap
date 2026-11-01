import {
  cameraRect,
  intersection,
  planView,
  supportedCamera,
  unionRect,
  type Camera,
  type ClueSource,
  type ViewRect,
} from "./clue-camera";
import { bindAttribute, tr } from "./i18n";
import { clueLoadingPlaceholder } from './loading-placeholders';

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
  async show(camera: Camera, onReady?: () => void): Promise<boolean> {
    if (!supportedCamera(this.source, camera))
      throw new Error(tr("View is outside the clue boundary."));
    const serial = ++this.serial;
    this.stopAnimation();
    this.canvas.dataset.ready = "false";
    const target = cameraRect(camera),
      from = this.rect;
    const animate =
      from &&
      from.width === target.width &&
      from.height === target.height &&
      Math.abs(from.x - target.x) < target.width &&
      Math.abs(from.y - target.y) < target.height &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const area = animate ? unionRect(from, target) : target,
      plan = planView(this.source, area, this.step);
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
    this.canvas.width = target.width;
    this.canvas.height = target.height;
    const context = this.canvas.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    this.canvas.dataset.ready = "false";
    const draw = (rect: ViewRect) => {
      context.clearRect(0, 0, target.width, target.height);
      context.drawImage(
        buffer,
        rect.x - area.x,
        rect.y - area.y,
        target.width,
        target.height,
        0,
        0,
        target.width,
        target.height,
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
    if (animate && (from.x !== target.x || from.y !== target.y)) {
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
  destroy(): void {
    this.closed = true;
    this.serial++;
    this.stopAnimation();
    this.images.clear();
  }
}
