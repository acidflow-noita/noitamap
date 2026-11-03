import { type Bounds, type Point, within } from "./rules";
import type { Pack } from "./rules";
import OpenSeadragon from "openseadragon";
import { PIXEL_MAP_DRAW_OPTIONS } from "../osd-pixel-rendering";
import { frameMap, frameMarkers } from "./map-framing";
import { bindAttribute, bindText } from "./i18n";

const SVG_NS = "http://www.w3.org/2000/svg";
export class MapBoard {
  readonly svg: SVGSVGElement;
  private marks: SVGGElement;
  private view: Bounds;
  private pointers = new Map<number, { x: number; y: number }>();
  private down?: { x: number; y: number; view: Bounds; moved: boolean };
  private pinch?: { distance: number; view: Bounds; anchor: Point };
  private point: Point | null = null;
  private locked = false;
  private resize: ResizeObserver;
  private tiles?: OpenSeadragon.Viewer;
  private tilesReady = false;
  private fittedMarkers: Point[] | null = null;
  private atHome = true;
  private playerMarks = new Map<string, SVGCircleElement>();
  private highlightedPlayer?: string;
  private markerUnit = 1;
  constructor(
    readonly element: HTMLElement,
    readonly bounds: Bounds,
    overview: string,
    readonly onGuess: (point: Point) => void,
    map?: Pack["map"],
  ) {
    this.view = { ...bounds };
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("role", "img");
    bindAttribute(this.svg,
      "aria-label",
      "World overview. Place your guess on this map.",
    );
    const image = document.createElementNS(SVG_NS, "image");
    for (const [key, value] of Object.entries({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      href: overview,
    }))
      image.setAttribute(key, String(value));
    image.setAttribute("preserveAspectRatio", "none");
    image.style.imageRendering = "pixelated";
    this.marks = document.createElementNS(SVG_NS, "g");
    this.svg.append(...(map ? [this.marks] : [image, this.marks]));
    element.replaceChildren();
    if (map) {
      const mount = document.createElement("div");
      mount.className = "map-tiles";
      element.append(mount);
      this.tiles = OpenSeadragon({
        element: mount,
        showNavigationControl: false,
        showNavigator: false,
        mouseNavEnabled: false,
        // The SVG and tile layer share one camera and one resize observer.
        // OSD's later automatic resize must not adjust their zoom independently.
        autoResize: false,
        preserveViewport: true,
        drawer: "canvas",
        maxImageCacheCount: 32,
        maxZoomPixelRatio: 70,
        animationTime: 0,
        ...PIXEL_MAP_DRAW_OPTIONS,
      });
      this.tiles.addTiledImage({
        tileSource: {
          width: map.width,
          height: map.height,
          tileSize: map.tileSize,
          tileOverlap: map.overlap,
          minLevel: 0,
          maxLevel: map.maxLevel,
          getTileUrl: (level: number, x: number, y: number) =>
            `${map.tiles}${level}/${x}_${y}.webp`,
        },
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        success: () => {
          this.tilesReady = true;
          this.updateView();
        },
      });
    }
    element.append(this.svg);
    element.tabIndex = 0;
    bindAttribute(element,
      "aria-label",
      "Guess map. Arrow keys move the pin, plus and minus zoom, Home resets the view.",
    );
    this.updateView();
    element.addEventListener("wheel", this.wheel, { passive: false });
    element.addEventListener("pointerdown", this.start);
    element.addEventListener("pointermove", this.move);
    element.addEventListener("pointerup", this.end);
    element.addEventListener("pointercancel", this.cancel);
    element.addEventListener("keydown", this.key);
    this.resize = new ResizeObserver(() => this.updateView());
    this.resize.observe(element);
  }
  destroy(): void {
    this.tiles?.destroy();
    this.tiles = undefined;
    this.tilesReady = false;
    this.resize.disconnect();
    this.element.removeEventListener("wheel", this.wheel);
    this.element.removeEventListener("pointerdown", this.start);
    this.element.removeEventListener("pointermove", this.move);
    this.element.removeEventListener("pointerup", this.end);
    this.element.removeEventListener("pointercancel", this.cancel);
    this.element.removeEventListener("keydown", this.key);
  }
  private world(x: number, y: number): Point {
    const point = this.svg.createSVGPoint();
    point.x = x;
    point.y = y;
    const transform = this.svg.getScreenCTM();
    return transform
      ? point.matrixTransform(transform.inverse())
      : { x: this.bounds.x, y: this.bounds.y };
  }
  private updateView(): void {
    const width = this.element.clientWidth,
      height = this.element.clientHeight;
    if (this.fittedMarkers) {
      this.view = frameMarkers(
        this.fittedMarkers,
        this.element.clientWidth,
        this.element.clientHeight,
      );
    } else {
      if (this.atHome) this.view = frameMap(this.bounds, width, height);
      else if (width > 0 && height > 0) {
        const nextHeight = (this.view.width * height) / width;
        this.view.y += (this.view.height - nextHeight) / 2;
        this.view.height = nextHeight;
      }
      this.view.x = Math.max(
        this.bounds.x,
        Math.min(
          this.bounds.x + this.bounds.width - this.view.width,
          this.view.x,
        ),
      );
      this.view.y = Math.max(
        this.bounds.y,
        Math.min(
          this.bounds.y + this.bounds.height - this.view.height,
          this.view.y,
        ),
      );
      if (this.view.width > this.bounds.width)
        this.view.x = this.bounds.x + (this.bounds.width - this.view.width) / 2;
      if (this.view.height > this.bounds.height)
        this.view.y =
          this.bounds.y + (this.bounds.height - this.view.height) / 2;
    }
    this.svg.setAttribute(
      "viewBox",
      `${this.view.x} ${this.view.y} ${this.view.width} ${this.view.height}`,
    );
    if (this.tilesReady && width > 0 && height > 0) {
      const viewport = this.tiles!.viewport;
      const size = viewport.getContainerSize();
      if (size.x !== width || size.y !== height)
        viewport.resize(new OpenSeadragon.Point(width, height), true);
      viewport.fitBounds(
        new OpenSeadragon.Rect(
          this.view.x,
          this.view.y,
          this.view.width,
          this.view.height,
        ),
        true,
      );
    }
    this.updateMarkers();
  }
  private updateMarkers(): void {
    const matrix = this.svg.getScreenCTM();
    const unit = matrix
      ? 1 / Math.max(0.00001, Math.hypot(matrix.a, matrix.b))
      : this.view.width / Math.max(300, this.element.clientWidth);
    this.markerUnit = unit;
    this.marks.querySelectorAll("circle").forEach((circle) => {
      circle.setAttribute(
        "r",
        String(unit * Number(circle.getAttribute("data-radius") || 7)),
      );
      circle.setAttribute("stroke-width", String(unit * 2));
    });
    this.marks.querySelectorAll("line").forEach((line) => {
      line.setAttribute("stroke-width", String(unit * 2));
      line.setAttribute("stroke-dasharray", `${unit * 5} ${unit * 4}`);
    });
  }
  zoom(
    factor: number,
    anchor: Point = {
      x: this.view.x + this.view.width / 2,
      y: this.view.y + this.view.height / 2,
    },
  ): void {
    this.fittedMarkers = null;
    this.atHome = false;
    const aspect = this.view.width / this.view.height;
    const width = Math.max(
      Math.min(
        this.element.clientWidth / 70,
        (this.element.clientHeight / 70) * aspect,
      ),
      Math.min(
        Math.max(this.bounds.width, this.bounds.height * aspect),
        this.view.width / factor,
      ),
    );
    const ratio = width / this.view.width;
    this.view = {
      x: anchor.x - (anchor.x - this.view.x) * ratio,
      y: anchor.y - (anchor.y - this.view.y) * ratio,
      width,
      height: this.view.height * ratio,
    };
    this.updateView();
  }
  home(): void {
    this.fittedMarkers = null;
    this.atHome = true;
    this.view = { ...this.bounds };
    this.updateView();
  }
  private wheel = (event: WheelEvent) => {
    event.preventDefault();
    this.zoom(
      event.deltaY < 0 ? 1.25 : 0.8,
      this.world(event.clientX, event.clientY),
    );
  };
  private start = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.element.focus({ preventScroll: true });
    this.element.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 1)
      this.down = {
        x: event.clientX,
        y: event.clientY,
        view: { ...this.view },
        moved: false,
      };
    else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        view: { ...this.view },
        anchor: this.world((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      if (this.down) this.down.moved = true;
    }
  };
  private move = (event: PointerEvent) => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()],
        distance = Math.hypot(a.x - b.x, a.y - b.y);
      this.view = { ...this.pinch.view };
      this.zoom(distance / Math.max(1, this.pinch.distance), this.pinch.anchor);
      const center = this.world((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.view.x += this.pinch.anchor.x - center.x;
      this.view.y += this.pinch.anchor.y - center.y;
      this.updateView();
      return;
    }
    if (!this.down) return;
    const dx = event.clientX - this.down.x,
      dy = event.clientY - this.down.y;
    if (Math.hypot(dx, dy) > 5) this.down.moved = true;
    if (!this.down.moved) return;
    this.fittedMarkers = null;
    this.atHome = false;
    const box = this.element.getBoundingClientRect();
    const scale = Math.min(
      box.width / this.down.view.width,
      box.height / this.down.view.height,
    );
    this.view = {
      ...this.down.view,
      x: this.down.view.x - dx / scale,
      y: this.down.view.y - dy / scale,
    };
    this.updateView();
  };
  private end = (event: PointerEvent) => {
    if (!this.pointers.has(event.pointerId)) return;
    if (this.down && !this.down.moved && !this.locked) {
      const p = this.world(event.clientX, event.clientY);
      if (within(p, this.bounds)) {
        this.point = { x: Math.round(p.x), y: Math.round(p.y) };
        this.onGuess(this.point);
      }
    }
    this.cancel(event);
  };
  private cancel = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    this.down = undefined;
    this.pinch = undefined;
    const remaining = this.pointers.values().next().value;
    if (remaining)
      this.down = { ...remaining, view: { ...this.view }, moved: true };
  };
  private key = (event: KeyboardEvent) => {
    if (["+", "=", "-", "Home"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Home") this.home();
      else this.zoom(event.key === "-" ? 0.8 : 1.25);
      return;
    }
    if (
      this.locked ||
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const step = this.view.width / (event.shiftKey ? 200 : 50),
      p = this.point ?? {
        x: this.view.x + this.view.width / 2,
        y: this.view.y + this.view.height / 2,
      };
    const next = {
      x:
        p.x +
        (event.key === "ArrowRight"
          ? step
          : event.key === "ArrowLeft"
            ? -step
            : 0),
      y:
        p.y +
        (event.key === "ArrowDown"
          ? step
          : event.key === "ArrowUp"
            ? -step
            : 0),
    };
    next.x = Math.max(
      this.bounds.x,
      Math.min(this.bounds.x + this.bounds.width, next.x),
    );
    next.y = Math.max(
      this.bounds.y,
      Math.min(this.bounds.y + this.bounds.height, next.y),
    );
    this.point = next;
    this.onGuess(next);
  };
  setMarkers(guess: Point | null, answer?: Point): void {
    this.playerMarks.clear(); this.highlightedPlayer = undefined;
    this.point = guess;
    this.fittedMarkers = answer ? (guess ? [guess, answer] : [answer]) : null;
    this.marks.replaceChildren();
    const circle = (p: Point, color: string, label: string, radius = 7) => {
      const g = document.createElementNS(SVG_NS, "g");
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", String(p.x));
      c.setAttribute("cy", String(p.y));
      c.setAttribute("r", "220");
      c.setAttribute("data-radius", String(radius));
      c.setAttribute("fill", color);
      c.setAttribute("stroke", "var(--bg)");
      c.setAttribute("stroke-width", "80");
      const title = document.createElementNS(SVG_NS, "title");
      bindText(title, label);
      g.append(title, c);
      this.marks.append(g);
    };
    if (guess && answer) {
      const line = document.createElementNS(SVG_NS, "line");
      for (const [key, value] of Object.entries({
        x1: guess.x,
        y1: guess.y,
        x2: answer.x,
        y2: answer.y,
        stroke: "var(--text-muted)",
        "stroke-width": 60,
        "stroke-dasharray": "140 100",
      }))
        line.setAttribute(key, String(value));
      this.marks.append(line);
    }
    if (answer)
      circle(answer, "var(--daily-fg)", "Actual location", guess ? 10 : 7);
    if (guess) circle(guess, "var(--accent-fg)", "Your guess");
    if (answer) {
      this.atHome = false;
      this.updateView();
    } else this.updateMarkers();
  }
  setPlayers(players: { id: string; name: string; guess: Point | null }[], answer: Point, highlight: (id: string) => void): void {
    this.setMarkers(null, answer);
    const answerMark = this.marks.lastElementChild!;
    const points = [answer];
    for (const player of players) {
      if (!player.guess || !within(player.guess, this.bounds)) continue;
      const mark = document.createElementNS(SVG_NS, 'circle');
      mark.setAttribute('cx', String(player.guess.x)); mark.setAttribute('cy', String(player.guess.y));
      mark.setAttribute('fill', 'var(--accent-fg)'); mark.setAttribute('stroke', 'var(--bg)'); mark.setAttribute('data-radius', '5');
      mark.dataset.player = player.id; mark.style.pointerEvents = 'auto';
      mark.addEventListener('pointerenter', () => highlight(player.id));
      mark.addEventListener('click', () => highlight(player.id));
      this.playerMarks.set(player.id, mark); this.marks.append(mark); points.push(player.guess);
    }
    this.marks.append(answerMark);
    this.fittedMarkers = points; this.atHome = false; this.updateView();
  }
  highlightPlayer(id: string): void {
    const previous = this.highlightedPlayer && this.playerMarks.get(this.highlightedPlayer);
    if (previous) { previous.setAttribute('data-radius', '5'); previous.setAttribute('r', String(this.markerUnit * 5)); previous.setAttribute('stroke', 'var(--bg)'); }
    const mark = this.playerMarks.get(id); this.highlightedPlayer = id;
    if (mark) { mark.setAttribute('data-radius', '11'); mark.setAttribute('r', String(this.markerUnit * 11)); mark.setAttribute('stroke', 'white'); }
  }
  setLocked(value: boolean): void {
    this.locked = value;
    this.element.classList.toggle("locked", value);
  }
}
