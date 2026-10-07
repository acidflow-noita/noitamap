import { uncoveredReportMapRect, type ReportPanelBounds } from '../report-map-highlights';
import { readCameraMatrix } from '../portals/geometry';

declare const OpenSeadragon: any;
export type CardRect = ReportPanelBounds;
export interface CardAnchor { x: number; y: number; width?: number; height?: number; offsetX?: number; offsetY?: number }
const width = (r: CardRect) => r.right - r.left;
const height = (r: CardRect) => r.bottom - r.top;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/** Client coordinates: the visible canvas, excluding the actual report bounds
 * whether the report is a sidebar, floating panel or bottom sheet. */
export function availablePOICardRect(canvas: CardRect, viewport: CardRect, panel?: CardRect): CardRect | null {
  const visible = {
    left: Math.max(canvas.left, viewport.left), top: Math.max(canvas.top, viewport.top),
    right: Math.min(canvas.right, viewport.right), bottom: Math.min(canvas.bottom, viewport.bottom),
  };
  if (!Object.values(visible).every(Number.isFinite) || width(visible) <= 24 || height(visible) <= 24) return null;
  const free = uncoveredReportMapRect(width(visible), height(visible), panel, visible);
  // If a panel covers the entire visible map, keep the card's close control
  // accessible in the viewport instead of positioning a zero-size card.
  return free && width(free) > 24 && height(free) > 24 ? {
    left: visible.left + free.left, right: visible.left + free.right,
    top: visible.top + free.top, bottom: visible.top + free.bottom,
  } : visible;
}

/** Prefer a side of the selected sprite, then space above/below it. Placement
 * never pans or zooms the map; long content scrolls inside the available area. */
export function planPOICardPlacement(available: CardRect, marker: CardRect, cardWidth: number, cardHeight: number) {
  const pad = 12, gap = 12;
  const a = { left: available.left + pad, top: available.top + pad, right: available.right - pad, bottom: available.bottom - pad };
  const w = Math.min(cardWidth, width(a)), h = Math.min(cardHeight, height(a));
  const x = clamp((marker.left + marker.right - w) / 2, a.left, a.right - w);
  const y = clamp((marker.top + marker.bottom) / 2 - h / 3, a.top, a.bottom - h);
  const belowTop = Math.max(a.top, marker.bottom + gap), aboveBottom = Math.min(a.bottom, marker.top - gap);
  const candidates = [
    { left: marker.right + gap, top: y, maxHeight: a.bottom - y },
    { left: marker.left - gap - w, top: y, maxHeight: a.bottom - y },
    { left: x, top: belowTop, maxHeight: a.bottom - belowTop },
    { left: x, top: Math.max(a.top, aboveBottom - h), maxHeight: Math.min(h, aboveBottom - a.top) },
  ].filter(p => p.left >= a.left && p.left + w <= a.right && p.top >= a.top && p.maxHeight >= Math.min(112, h));
  const fit = candidates.find(p => p.maxHeight >= h) ?? candidates.sort((l, r) => r.maxHeight - l.maxHeight)[0];
  return { ...(fit ?? { left: x, top: y, maxHeight: a.bottom - y }), width: w };
}

/** One event-driven positioner, owned and disposed by this particular card. */
export function mountPOICardPlacement(card: HTMLElement, options: {
  viewer: any; anchor: CardAnchor; isCurrent(): boolean;
}): () => void {
  const { viewer, anchor, isCurrent } = options;
  const osd = viewer.viewer ?? viewer, canvas = viewer.canvas as HTMLElement;
  const visual = window.visualViewport;
  let disposed = false, frame = 0, panels: HTMLElement[] = [];
  const rectOf = (r: DOMRect): CardRect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const layout = () => {
    frame = 0;
    if (disposed) return;
    if (!card.isConnected || !isCurrent()) { dispose(); return; }
    const c = canvas.getBoundingClientRect();
    const visible = {
      left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
      right: (visual?.offsetLeft ?? 0) + (visual?.width ?? window.innerWidth),
      bottom: (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight),
    };
    let available = availablePOICardRect(rectOf(c), visible);
    for (const panel of panels) {
      if (available && panel.classList.contains('open') && !panel.hidden && getComputedStyle(panel).display !== 'none') {
        available = availablePOICardRect(available, available, rectOf(panel.getBoundingClientRect()));
      }
    }
    const cw = canvas.clientWidth || c.width, ch = canvas.clientHeight || c.height;
    if (!available || cw <= 0 || ch <= 0) { card.style.visibility = 'hidden'; return; }
    const matrix = readCameraMatrix((x, y) => viewer.viewport.pixelFromPoint(new OpenSeadragon.Point(x, y), true), cw, viewer.viewport.getFlip?.() ?? false);
    const project = (x: number, y: number) => ({
      x: c.left + (matrix.a * x + matrix.c * y + matrix.e) * c.width / cw,
      y: c.top + (matrix.b * x + matrix.d * y + matrix.f) * c.height / ch,
    });
    const center = project(anchor.x, anchor.y);
    if (![center.x, center.y].every(Number.isFinite)) { card.style.visibility = 'hidden'; return; }
    const aw = anchor.width ?? 20, ah = anchor.height ?? 24, ox = anchor.offsetX ?? aw / 2, oy = anchor.offsetY ?? ah / 2;
    const corners = [[-ox, -oy], [aw - ox, -oy], [-ox, ah - oy], [aw - ox, ah - oy]]
      .map(([x, y]) => project(anchor.x + x, anchor.y + y));
    const marker = {
      left: Math.min(center.x - 18, ...corners.map(p => p.x)), right: Math.max(center.x + 18, ...corners.map(p => p.x)),
      top: Math.min(center.y - 18, ...corners.map(p => p.y)), bottom: Math.max(center.y + 18, ...corners.map(p => p.y)),
    };
    // Measure natural content, not the previous capped height or sticky-header
    // scroll overflow. Restore the user's scroll position before painting.
    const scrollTop = card.scrollTop, scrollLeft = card.scrollLeft;
    card.style.width = '';
    card.style.maxWidth = `${width(available) - 24}px`;
    card.style.maxHeight = 'none';
    card.scrollTop = 0;
    const measured = card.getBoundingClientRect();
    const plan = planPOICardPlacement(available, marker, measured.width, measured.height);
    card.style.width = `${plan.width}px`;
    card.style.left = `${plan.left}px`;
    card.style.top = `${plan.top}px`;
    card.style.maxHeight = `${plan.maxHeight}px`;
    card.scrollTop = scrollTop;
    card.scrollLeft = scrollLeft;
    card.style.visibility = '';
  };
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(layout); };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  const panelChanges = new MutationObserver(schedule);
  const bindPanels = () => {
    const next = [...document.querySelectorAll<HTMLElement>('#seed-report-v3, #seed-report-sidebar, .drawing-sidebar, .drawing-toolbar')];
    if (next.length === panels.length && next.every((el, i) => el === panels[i])) return false;
    for (const panel of panels) { resize?.unobserve(panel); panel.removeEventListener('transitionend', schedule); }
    panelChanges.disconnect();
    panels = next;
    for (const panel of panels) {
      resize?.observe(panel);
      panelChanges.observe(panel, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
      panel.addEventListener('transitionend', schedule);
    }
    return true;
  };
  const structure = new MutationObserver(() => {
    if (!card.isConnected) dispose();
    else if (bindPanels()) schedule();
  });
  const content = new MutationObserver(schedule);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    resize?.disconnect(); panelChanges.disconnect(); structure.disconnect(); content.disconnect();
    for (const panel of panels) panel.removeEventListener('transitionend', schedule);
    card.removeEventListener('load', schedule, true);
    window.removeEventListener('resize', schedule);
    visual?.removeEventListener('resize', schedule); visual?.removeEventListener('scroll', schedule);
    osd.removeHandler?.('viewport-change', schedule); osd.removeHandler?.('before-destroy', dispose);
  };
  resize?.observe(card); resize?.observe(canvas);
  bindPanels();
  structure.observe(document.body, { childList: true });
  const drawingContainer = document.getElementById('drawing-sidebar-container');
  if (drawingContainer) structure.observe(drawingContainer, { childList: true });
  content.observe(card, { childList: true, subtree: true, characterData: true });
  card.addEventListener('load', schedule, true);
  window.addEventListener('resize', schedule);
  visual?.addEventListener('resize', schedule); visual?.addEventListener('scroll', schedule);
  osd.addHandler?.('viewport-change', schedule); osd.addHandler?.('before-destroy', dispose);
  layout();
  return dispose;
}
