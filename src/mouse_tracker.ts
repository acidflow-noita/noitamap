import { CHUNK_SIZE } from './constants';
import { materialAtWorld, primeMaterialHover } from './material-hover';

declare const OpenSeadragon: any;

export type MouseTrackerOptions = {
  osd: any; // OpenSeadragon.Viewer
  tooltipElement: HTMLElement;
  osdElement: HTMLElement;
};

// Function to parse coordinates
function parseCoordinates(text: string) {
  const match = text.match(/^\((-?\d+),\s*(-?\d+)\)/);
  if (match) {
    const x = parseInt(match[1], 10);
    const y = parseInt(match[2], 10);
    return JSON.stringify({ x: x, y: y });
  }
  return null;
}

export const initMouseTracker = ({ osd, tooltipElement, osdElement }: MouseTrackerOptions) => {
  primeMaterialHover();
  let lastPixelX: number | null = null;
  let lastPixelY: number | null = null;
  let pointer: Pick<PointerEvent, 'clientX' | 'clientY' | 'pageX' | 'pageY'> | undefined;
  const hide = () => {
    pointer = undefined;
    tooltipElement.style.visibility = 'hidden';
  };
  const update = () => {
    if (!pointer || !osd.viewport) return;
    const bounds = osdElement.getBoundingClientRect();
    const x = pointer.clientX - bounds.left, y = pointer.clientY - bounds.top;
    // A captured drag can continue delivering movement outside the map.
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) { hide(); return; }
    const viewportPoint = osd.viewport.pointFromPixel(new OpenSeadragon.Point(x, y), true);
    const px = Math.floor(viewportPoint.x), py = Math.floor(viewportPoint.y);
    if (px !== lastPixelX || py !== lastPixelY) {
      lastPixelX = px;
      lastPixelY = py;
      const mat = materialAtWorld(px, py);
      const materialHtml = mat ? `<br>material: ${mat}` : '';
      tooltipElement.children[0].innerHTML = `(${px}, ${py})<br>chunk: (${Math.floor(px / CHUNK_SIZE)}, ${Math.floor(py / CHUNK_SIZE)})${materialHtml}`;
    }
    tooltipElement.style.left = `${pointer.pageX}px`;
    tooltipElement.style.top = `${pointer.pageY}px`;
    tooltipElement.style.visibility = 'visible';
  };
  // A second OSD MouseTracker ignores movement after losing its tracked
  // pointer until another enter arrives. This readout needs only native
  // movement on the stable container, independent of map/overlay replacement.
  const move = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    pointer = { clientX: event.clientX, clientY: event.clientY, pageX: event.pageX, pageY: event.pageY };
    update();
  };
  const leave = (event: PointerEvent) => { if (event.pointerType === 'mouse') hide(); };
  const seedChanged = () => {
    lastPixelX = lastPixelY = null;
    update();
  };
  osdElement.addEventListener('pointermove', move, { passive: true, capture: true });
  osdElement.addEventListener('pointerenter', move, { passive: true });
  osdElement.addEventListener('pointerleave', leave);
  osdElement.addEventListener('pointercancel', leave);
  window.addEventListener('blur', hide);
  osd.addHandler('viewport-change', update);
  osd.addHandler('map-handoff-complete', seedChanged);
  const dispose = () => {
    osdElement.removeEventListener('pointermove', move, true);
    osdElement.removeEventListener('pointerenter', move);
    osdElement.removeEventListener('pointerleave', leave);
    osdElement.removeEventListener('pointercancel', leave);
    window.removeEventListener('blur', hide);
    osd.removeHandler('viewport-change', update);
    osd.removeHandler('map-handoff-complete', seedChanged);
    osd.removeHandler('before-destroy', dispose);
    hide();
  };
  osd.addHandler('before-destroy', dispose);

  const copyCoordinates = async (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (tooltipElement.style.visibility === 'hidden') return;
    if (event.code !== 'KeyC' || (!event.ctrlKey && !event.metaKey)) return;

    const coordinatesText = tooltipElement.innerText;
    const parsedCoordinates = parseCoordinates(coordinatesText);
    if (!parsedCoordinates) {
      console.error('Could not parse coordinates');
      return;
    }

    try {
      await navigator.clipboard.writeText(parsedCoordinates);
      console.log('Coordinates copied to clipboard:', parsedCoordinates);
    } catch (err) {
      console.error('Could not copy coordinates:', err);
    }
  };

  return { copyCoordinates };
};
