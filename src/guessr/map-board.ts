import { type Bounds, type Point, within } from "./rules";
import type { Pack } from "./rules";
import OpenSeadragon from "openseadragon";
import { PIXEL_MAP_DRAW_OPTIONS } from "../osd-pixel-rendering";
import { frameMap, frameMarkers } from "./map-framing";
import { bindAttribute, bindText } from "./i18n";
import { twitchColor } from './player-color';
import { MAP_PIN_PATH, MAP_PIN_TIP, ANSWER_PIN_CENTER, GUESS_PIN_COLOR, ANSWER_PIN_COLOR,
  GUESS_PIN_HEIGHT, ANSWER_PIN_HEIGHT, PLAYER_PIN_HEIGHT, HIGHLIGHT_PIN_HEIGHT } from './map-pin';

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
  // Retain the result after manual pan/zoom so reset can fit those points again.
  private resultMarkers: Point[] | null = null;
  private atHome = true;
  private homeFit: 'fill' | 'contain' = 'fill';
  private pinListeners = new Set<(placed: boolean) => void>();
  private playerMarks = new Map<string, SVGGElement>();
  private highlightedPlayer?: string;
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
    this.pinListeners.clear();
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
      if (this.atHome) this.view = frameMap(this.bounds, width, height, this.homeFit);
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
    this.marks.querySelectorAll<SVGGElement>('[data-pin-height]').forEach((pin) => {
      const scale = unit * Number(pin.dataset.pinHeight) / 64;
      const anchor = pin.dataset.pinKind === 'answer' ? ANSWER_PIN_CENTER : MAP_PIN_TIP;
      pin.setAttribute('transform', `translate(${pin.dataset.x} ${pin.dataset.y}) scale(${scale}) translate(${-anchor.x} ${-anchor.y})`);
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
    const aspect = this.view.width / this.view.height;
    // Result padding can exceed the world bounds; zoom-out must not shrink it.
    const resultWidth = this.resultMarkers
      ? frameMarkers(this.resultMarkers, this.element.clientWidth, this.element.clientHeight).width : 0;
    const width = Math.max(
      Math.min(
        this.element.clientWidth / 70,
        (this.element.clientHeight / 70) * aspect,
      ),
      Math.min(
        Math.max(this.bounds.width, this.bounds.height * aspect, resultWidth, this.view.width),
        this.view.width / factor,
      ),
    );
    if (width === this.view.width) return;
    this.fittedMarkers = null;
    this.atHome = false;
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
    this.fittedMarkers = this.resultMarkers;
    this.atHome = !this.resultMarkers;
    this.homeFit = 'fill';
    this.view = { ...this.bounds };
    this.updateView();
  }
  showEntireMap(): void {
    this.fittedMarkers = null;
    this.atHome = true;
    this.homeFit = 'contain';
    this.updateView();
  }
  onPinChange(listener: (placed: boolean) => void): () => void {
    this.pinListeners.add(listener);
    listener(this.point !== null);
    return () => this.pinListeners.delete(listener);
  }
  private setPoint(point: Point | null): void {
    const changed = (point !== null) !== (this.point !== null);
    this.point = point;
    if (changed) for (const listener of this.pinListeners) listener(point !== null);
  }
  centerOnPin(): void {
    if (!this.point) return;
    this.fittedMarkers = null; this.atHome = false;
    this.view.x = this.point.x - this.view.width / 2;
    this.view.y = this.point.y - this.view.height / 2;
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
    // The SVG owns touch gestures because OSD navigation is intentionally off.
    // Cancel synthetic clicks and scrolling without affecting toolbar buttons.
    event.preventDefault();
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
        const point = { x: Math.round(p.x), y: Math.round(p.y) };
        this.setPoint(point);
        this.onGuess(point);
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
    this.setPoint(next);
    this.onGuess(next);
  };
  setMarkers(guess: Point | null, answer?: Point, guessLabel = 'Your guess'): void {
    this.playerMarks.clear(); this.highlightedPlayer = undefined;
    this.setPoint(guess);
    this.resultMarkers = answer ? (guess ? [guess, answer] : [answer]) : null;
    this.fittedMarkers = this.resultMarkers;
    this.marks.replaceChildren();
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
    if (guess) this.addPin(guess, GUESS_PIN_COLOR, guessLabel, GUESS_PIN_HEIGHT, 'guess');
    if (answer)
      this.addPin(answer, ANSWER_PIN_COLOR, 'Actual location', ANSWER_PIN_HEIGHT, 'answer');
    if (answer) {
      this.atHome = false;
      this.updateView();
    } else this.updateMarkers();
  }
  private addPin(point: Point, color: string, label: string | (() => string), height: number, kind: string): SVGGElement {
    const group = document.createElementNS(SVG_NS, 'g');
    group.classList.add('guessr-map-pin'); group.dataset.pinKind = kind;
    group.setAttribute('fill', color);
    group.dataset.x = String(point.x); group.dataset.y = String(point.y); group.dataset.pinHeight = String(height);
    const title = document.createElementNS(SVG_NS, 'title'); bindText(title, label); group.append(title);
    if (kind === 'answer') {
      for (const [stroke, width] of [['#020618', '6'], ['#ffffff', '3.5'], [color, '2']] as const) {
        const ring = document.createElementNS(SVG_NS, 'circle');
        ring.setAttribute('cx', '32'); ring.setAttribute('cy', '32'); ring.setAttribute('r', '20');
        ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', stroke); ring.setAttribute('stroke-width', width);
        const ticks = document.createElementNS(SVG_NS, 'path');
        ticks.setAttribute('d', 'M32 3V8M32 56V61M3 32H8M56 32H61');
        ticks.setAttribute('fill', 'none'); ticks.setAttribute('stroke', stroke);
        ticks.setAttribute('stroke-width', width); ticks.setAttribute('stroke-linecap', 'butt');
        group.append(ring, ticks);
      }
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', '32'); dot.setAttribute('cy', '32'); dot.setAttribute('r', '5');
      dot.setAttribute('fill', color); dot.setAttribute('stroke', '#ffffff'); dot.setAttribute('stroke-width', '1.5');
      group.append(dot);
      this.marks.append(group); return group;
    }
    // Keep the logo's centre readable over terrain or overlapping markers.
    const centre = document.createElementNS(SVG_NS, 'circle');
    centre.setAttribute('cx', '25.74'); centre.setAttribute('cy', '25.74'); centre.setAttribute('r', '9.36');
    centre.setAttribute('fill', '#020618'); group.append(centre);
    for (const [stroke, width] of [['#020618', '6'], ['#ffffff', '2']] as const) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', MAP_PIN_PATH); path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('fill', color); path.setAttribute('stroke', stroke);
      path.setAttribute('stroke-width', width); path.setAttribute('stroke-linejoin', 'round');
      group.append(path);
    }
    this.marks.append(group); return group;
  }
  setPlayers(players: { id: string; name: string; color?: string; guess: Point | null }[], answer: Point, highlight: (id: string) => void): void {
    this.setMarkers(null, answer);
    const points = [answer];
    for (const player of players) {
      if (!player.guess || !within(player.guess, this.bounds)) continue;
      const mark = this.addPin(player.guess, twitchColor(player.color) ?? GUESS_PIN_COLOR, () => player.name, PLAYER_PIN_HEIGHT, 'player');
      mark.dataset.player = player.id; mark.style.pointerEvents = 'auto';
      mark.addEventListener('pointerenter', () => highlight(player.id));
      mark.addEventListener('pointerleave', () => highlight(''));
      mark.addEventListener('click', () => highlight(player.id));
      this.playerMarks.set(player.id, mark); this.marks.append(mark); points.push(player.guess);
    }
    this.raiseSolution();
    this.resultMarkers = points; this.fittedMarkers = this.resultMarkers; this.atHome = false; this.updateView();
  }
  highlightPlayer(id: string): void {
    const previous = this.highlightedPlayer && this.playerMarks.get(this.highlightedPlayer);
    if (previous) { previous.dataset.pinHeight = String(PLAYER_PIN_HEIGHT); previous.classList.remove('selected'); }
    const mark = this.playerMarks.get(id); this.highlightedPlayer = id;
    if (mark) { mark.dataset.pinHeight = String(HIGHLIGHT_PIN_HEIGHT); mark.classList.add('selected'); this.marks.append(mark); }
    for (const [playerId, element] of this.playerMarks) element.style.opacity = id && playerId !== id ? '0.18' : '1';
    this.raiseSolution();
    this.updateMarkers();
  }
  private raiseSolution(): void {
    // SVG paints in DOM order. CSS z-index does not order SVG groups.
    const solution = this.marks.querySelector<SVGGElement>('[data-pin-kind="answer"]');
    if (solution) { solution.style.opacity = '1'; this.marks.append(solution); }
  }
  setLocked(value: boolean): void {
    this.locked = value;
    this.element.classList.toggle("locked", value);
  }
}
