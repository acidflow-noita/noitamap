import { CHUNK_SIZE } from './constants';

declare const OpenSeadragon: any;

export type MouseTrackerOptions = {
  osd: any; // OpenSeadragon.Viewer
  tooltipElement: HTMLElement;
  osdElement: HTMLElement;
};

export const initMouseTracker = ({ osd, tooltipElement, osdElement }: MouseTrackerOptions) => {
  let pointer: Pick<PointerEvent, 'clientX' | 'clientY' | 'pageX' | 'pageY'> | undefined;
  let coordinates: { x: number; y: number } | undefined;
  const hide = () => {
    pointer = undefined;
    coordinates = undefined;
    tooltipElement.style.visibility = 'hidden';
  };
  const update = () => {
    if (!pointer || !osd.viewport) return;
    const bounds = osdElement.getBoundingClientRect();
    const x = pointer.clientX - bounds.left, y = pointer.clientY - bounds.top;
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) { hide(); return; }
    const point = osd.viewport.pointFromPixel(new OpenSeadragon.Point(x, y), true);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      coordinates = undefined;
      tooltipElement.style.visibility = 'hidden';
      return;
    }
    const px = Math.floor(point.x), py = Math.floor(point.y);
    if (coordinates?.x !== px || coordinates?.y !== py) {
      coordinates = { x: px, y: py };
      tooltipElement.children[0].innerHTML = `(${px}, ${py})<br>chunk: (${Math.floor(px / CHUNK_SIZE)}, ${Math.floor(py / CHUNK_SIZE)})`;
    }
    tooltipElement.style.left = `${pointer.pageX}px`;
    tooltipElement.style.top = `${pointer.pageY}px`;
    tooltipElement.style.visibility = 'visible';
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    pointer = { clientX: event.clientX, clientY: event.clientY, pageX: event.pageX, pageY: event.pageY };
    update();
  };
  const leave = (event: PointerEvent) => { if (event.pointerType === 'mouse') hide(); };

  const copyCoordinates = async (event: KeyboardEvent) => {
    if (event.code !== 'KeyC' || (!event.ctrlKey && !event.metaKey)) return;
    if (event.shiftKey || event.altKey || event.repeat) return;
    const target = event.target instanceof Element ? event.target : document.activeElement;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    if (window.getSelection()?.toString()) return;
    if (event.defaultPrevented || !coordinates || tooltipElement.style.visibility === 'hidden') return;
    const value = JSON.stringify(coordinates);

    try {
      await navigator.clipboard.writeText(value);
      console.log('Coordinates copied to clipboard:', value);
    } catch (err) {
      console.error('Could not copy coordinates:', err);
    }
  };

  // Listen on the persistent container, independently of OSD's pointer state
  // and of overlays/canvas children replaced during a map change.
  osdElement.addEventListener('pointermove', move, { passive: true, capture: true });
  osdElement.addEventListener('pointerenter', move, { passive: true });
  osdElement.addEventListener('pointerleave', leave);
  osdElement.addEventListener('pointercancel', leave);
  window.addEventListener('blur', hide);
  osd.addHandler('viewport-change', update);
  // Window's bubbling phase follows the drawing tools' document handlers.
  window.addEventListener('keydown', copyCoordinates);
  const dispose = () => {
    osdElement.removeEventListener('pointermove', move, true);
    osdElement.removeEventListener('pointerenter', move);
    osdElement.removeEventListener('pointerleave', leave);
    osdElement.removeEventListener('pointercancel', leave);
    window.removeEventListener('blur', hide);
    window.removeEventListener('keydown', copyCoordinates);
    osd.removeHandler('viewport-change', update);
    osd.removeHandler('before-destroy', dispose);
    hide();
  };
  osd.addHandler('before-destroy', dispose);
  hide();
  return { copyCoordinates, dispose };
};
