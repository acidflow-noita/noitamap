import { uncoveredReportMapRect, type ReportPanelBounds } from '../report-map-highlights';
import { cameraPixelDelta, readCameraMatrix } from '../portals/geometry';

export type CardRect = ReportPanelBounds;
export interface CardPlacement {
  left: number; top: number; width: number; maxHeight: number; sheet: boolean;
  /** Screen-space movement of the marker, not a zoom or a world-space delta. */
  markerShift: { x: number; y: number };
}
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(n, high));
const width = (r: CardRect) => r.right - r.left;
const height = (r: CardRect) => r.bottom - r.top;

/** The card and report share the same map exclusion geometry. Coordinates here
 * are client pixels, including an offset canvas and a reduced visual viewport. */
export function availablePOICardRect(canvas: CardRect, viewport: CardRect, panel?: CardRect): CardRect {
  const visible = {
    left: Math.max(canvas.left, viewport.left), top: Math.max(canvas.top, viewport.top),
    right: Math.min(canvas.right, viewport.right), bottom: Math.min(canvas.bottom, viewport.bottom),
  };
  const local = uncoveredReportMapRect(width(visible), height(visible), panel, visible);
  return local ? {
    left: visible.left + local.left, right: visible.left + local.right,
    top: visible.top + local.top, bottom: visible.top + local.bottom,
  } : visible;
}

/** Choose an unobstructed side using the measured card. Large content scrolls
 * within the chosen space instead of covering the selected sprite. */
export function planPOICardPlacement(input: {
  available: CardRect; marker: CardRect; cardWidth: number; cardHeight: number;
  compact: boolean; allowPan: boolean;
}): CardPlacement {
  const { marker, allowPan } = input;
  const pad = 12, gap = 12;
  const a = {
    left: input.available.left + pad, top: input.available.top + pad,
    right: Math.max(input.available.left + pad + 1, input.available.right - pad),
    bottom: Math.max(input.available.top + pad + 1, input.available.bottom - pad),
  };
  const w = Math.min(Math.max(1, input.cardWidth), width(a));
  const cx = (marker.left + marker.right) / 2, cy = (marker.top + marker.bottom) / 2;
  const mh = Math.min(height(marker), height(a) * .3), mw = Math.min(width(marker), width(a) * .3);
  const shiftInto = (area: CardRect) => ({
    x: clamp(cx, area.left + mw / 2, area.right - mw / 2) - cx,
    y: clamp(cy, area.top + mh / 2, area.bottom - mh / 2) - cy,
  });
  const sheet = input.compact || width(a) < 360;
  if (sheet) {
    let maxHeight = Math.max(1, height(a) * .48);
    // Avoid a scrollbar for the last few pixels of an otherwise fitting card.
    // Spend at most one existing map gutter, and only when the whole natural
    // border box fits clear of the marker without moving it further.
    const fitWholeCard = (limit: number, freeHeight: number) =>
      input.cardHeight > limit && input.cardHeight <= Math.min(limit + gap, freeHeight)
        ? input.cardHeight : limit;
    const below = a.bottom - marker.bottom - gap, above = marker.top - gap - a.top;
    maxHeight = fitWholeCard(maxHeight, Math.min(height(a), below));
    // Subsequent content/viewport changes may shrink the sheet, but never pan
    // the map. Reserve the selected marker's footprint above it where possible.
    if (!allowPan) {
      // A viewport resize can put the marker against the bottom edge. Keep a
      // usable card above it instead of panning again or leaving a tiny strip.
      if (below < Math.min(112, input.cardHeight) && above > below) {
        maxHeight = Math.max(1, Math.min(maxHeight, above));
        maxHeight = fitWholeCard(maxHeight, above);
        return { left: a.left, top: a.top, width: width(a), maxHeight, sheet, markerShift: { x: 0, y: 0 } };
      }
      if (below > 0) maxHeight = Math.min(maxHeight, below);
    }
    const h = Math.min(input.cardHeight, maxHeight);
    const top = a.bottom - h;
    const shift = allowPan ? shiftInto({ ...a, bottom: a.bottom - maxHeight - gap }) : { x: 0, y: 0 };
    return { left: a.left, top, width: width(a), maxHeight, sheet, markerShift: shift };
  }
  const h = Math.min(input.cardHeight, height(a));
  const centerTop = clamp(cy - h / 3, a.top, a.bottom - h);
  const centerLeft = clamp(cx - w / 2, a.left, a.right - w);
  const candidates = [
    { left: marker.right + gap, top: centerTop, width: w, maxHeight: height(a) },
    { left: marker.left - gap - w, top: centerTop, width: w, maxHeight: height(a) },
    { left: centerLeft, top: marker.bottom + gap, width: w, maxHeight: a.bottom - marker.bottom - gap },
    { left: centerLeft, top: Math.max(a.top, marker.top - gap - h), width: w, maxHeight: marker.top - gap - a.top },
  ].filter(p => p.left >= a.left && p.left + p.width <= a.right && p.maxHeight >= Math.min(112, h));
  const fit = candidates.find(p => p.maxHeight >= h) ?? candidates.sort((l, r) => r.maxHeight - l.maxHeight)[0];
  if (fit) {
    // A side card can grow downward only as far as the viewport permits.
    fit.maxHeight = Math.min(fit.maxHeight, a.bottom - fit.top);
    return { ...fit, sheet, markerShift: allowPan ? shiftInto(a) : { x: 0, y: 0 } };
  }
  // A narrow desktop viewport has no room for both full-width card and marker.
  // Reuse the compact fallback rather than putting the card over the sprite.
  return planPOICardPlacement({ ...input, compact: true });
}

interface CardAnchor { x: number; y: number; width?: number; height?: number; offsetX?: number; offsetY?: number }
export interface POICardPlacementOptions {
  viewer: any; anchor: CardAnchor; isCurrent(): boolean;
  /** Shared across translated/variant rebuilds so they cannot move the camera. */
  opening: { mayPan: boolean };
}

/** One owner of card geometry for ordinary, spoiler and orb cards. */
export function mountPOICardPlacement(card: HTMLElement, options: POICardPlacementOptions): () => void {
  const { viewer, anchor, isCurrent, opening } = options;
  const osd = viewer.viewer ?? viewer;
  const canvas = viewer.canvas as HTMLElement;
  let disposed = false, frame = 0;
  const rectOf = (r: DOMRect): CardRect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const layout = () => {
    frame = 0;
    if (disposed || !card.isConnected || !isCurrent()) return;
    const c = canvas.getBoundingClientRect();
    const visual = window.visualViewport;
    const visible = {
      left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
      right: (visual?.offsetLeft ?? 0) + (visual?.width ?? window.innerWidth),
      bottom: (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight),
    };
    const report = document.querySelector<HTMLElement>('#seed-report-v3.open, #seed-report-sidebar.open');
    const reportRect = report && !report.hidden && getComputedStyle(report).display !== 'none' ? rectOf(report.getBoundingClientRect()) : undefined;
    const available = availablePOICardRect(rectOf(c), visible, reportRect);
    const cw = canvas.clientWidth || c.width, ch = canvas.clientHeight || c.height;
    if (width(available) < 25 || height(available) < 25 || cw <= 0 || ch <= 0) return;
    const matrix = readCameraMatrix((x, y) => viewer.viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true), cw, viewer.viewport.getFlip?.() ?? false);
    const sx = c.width / cw, sy = c.height / ch;
    const project = (x: number, y: number) => ({ x: c.left + (matrix.a * x + matrix.c * y + matrix.e) * sx, y: c.top + (matrix.b * x + matrix.d * y + matrix.f) * sy });
    const center = project(anchor.x, anchor.y);
    const aw = anchor.width ?? 20, ah = anchor.height ?? 24, ox = anchor.offsetX ?? aw / 2, oy = anchor.offsetY ?? ah / 2;
    const corners = [[-ox, -oy], [aw - ox, -oy], [-ox, ah - oy], [aw - ox, ah - oy]].map(([x, y]) => project(anchor.x + x, anchor.y + y));
    const marker = {
      left: Math.min(center.x - 18, ...corners.map(p => p.x)), right: Math.max(center.x + 18, ...corners.map(p => p.x)),
      top: Math.min(center.y - 18, ...corners.map(p => p.y)), bottom: Math.max(center.y + 18, ...corners.map(p => p.y)),
    };
    // Placement must not measure its own previous max-height or the displaced
    // sticky header's scroll overflow. Measure the natural border box without
    // scrolling, then restore the user's position after applying the final size.
    // These synchronous writes are completed before paint/ResizeObserver delivery.
    const scrollTop = card.scrollTop, scrollLeft = card.scrollLeft;
    const compact = visible.right - visible.left <= 900 || width(available) < 384;
    card.style.maxWidth = `${Math.max(1, width(available) - 24)}px`;
    card.style.maxHeight = 'none';
    card.scrollTop = 0;
    const measure = (sheet: boolean, cardWidth?: number) => {
      card.classList.toggle('poi-card-sheet', sheet);
      card.style.width = cardWidth === undefined ? '' : `${cardWidth}px`;
      return card.getBoundingClientRect();
    };
    const measured = measure(compact, compact ? Math.max(1, width(available) - 24) : undefined);
    let plan = planPOICardPlacement({ available, marker, cardWidth: measured.width, cardHeight: measured.height, compact, allowPan: opening.mayPan });
    // A desktop card can fall back to a full-width sheet. Reflow at that width
    // before positioning it: wrapped creature details can be much shorter there.
    if (plan.sheet && !compact) {
      const sheet = measure(true, plan.width);
      plan = planPOICardPlacement({ available, marker, cardWidth: sheet.width, cardHeight: sheet.height, compact: true, allowPan: opening.mayPan });
    }
    card.classList.toggle('poi-card-sheet', plan.sheet);
    card.style.width = `${plan.width}px`;
    card.style.left = `${plan.left}px`;
    card.style.top = `${plan.top}px`;
    card.style.maxHeight = `${plan.maxHeight}px`;
    card.scrollTop = scrollTop;
    card.scrollLeft = scrollLeft;
    card.style.visibility = '';
    if (opening.mayPan) {
      opening.mayPan = false;
      const { x, y } = plan.markerShift;
      const shift = cameraPixelDelta(matrix, -x / sx, -y / sy);
      if (shift && (Math.abs(x) > .5 || Math.abs(y) > .5)) {
        const current = viewer.viewport.getCenter(true);
        viewer.viewport.panTo(new OpenSeadragon.Point(current.x + shift.x, current.y + shift.y), true);
        schedule();
      }
    }
  };
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(layout); };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  resize?.observe(card); resize?.observe(canvas);
  const report = document.querySelector<HTMLElement>('#seed-report-v3, #seed-report-sidebar');
  const reportChanges = report ? new MutationObserver(schedule) : null;
  if (report) {
    resize?.observe(report);
    reportChanges?.observe(report, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  }
  const content = new MutationObserver(schedule);
  content.observe(card, { childList: true, subtree: true, characterData: true });
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  osd.addHandler?.('animation', schedule);
  osd.addHandler?.('resize', schedule);
  // A measured position is available before the first paint; no cursor clamp
  // races with a second requestAnimationFrame positioner.
  layout();
  return () => {
    disposed = true; if (frame) cancelAnimationFrame(frame);
    resize?.disconnect(); content.disconnect(); reportChanges?.disconnect();
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    osd.removeHandler?.('animation', schedule); osd.removeHandler?.('resize', schedule);
  };
}
