import structures from '../data/structures.json';
import items from '../data/items.json';
import bosses from '../data/bosses.json';
import orbAreas from '../data/orb_areas.json';
import orbs from '../data/orbs.json';
import { assertElementById } from '../util';

const { Rect, Point } = OpenSeadragon;
type Rect = InstanceType<typeof Rect>;
type Point = InstanceType<typeof Point>;

export type TargetOfInterest = PointOfInterest | AreaOfInterest;

export type PointOfInterest = {
  overlayType: 'poi';
  maps: string[];
  name: string;
  aliases?: string[];
  icon: string;
  wiki: string;
  text?: string;
  x: number;
  y: number;
};

export type AreaOfInterest = {
  overlayType: 'aoi';
  maps: string[];
  text: string[];
  x: number;
  y: number;
  width: number;
  height: number;
};

type OSDOverlay = {
  element: HTMLDivElement;
  location: Rect | Point;
};

const CHUNK_SIZE = 512;

const mapAOICoords = (multiplier: number) => (overlays: Omit<AreaOfInterest, 'overlayType'>[]) =>
  overlays.map(({ x, y, width, height, ...rest }) => ({
    ...rest,
    x: multiplier * x,
    y: multiplier * y,
    width: multiplier * width,
    height: multiplier * height,
    overlayType: 'aoi' as const,
  }));

const mapPOICoords = (multiplier: number) => (overlays: Omit<PointOfInterest, 'overlayType'>[]) =>
  overlays.map(({ x, y, ...rest }) => ({
    ...rest,
    x: multiplier * x,
    y: multiplier * y,
    overlayType: 'poi' as const,
  }));

const chunkAOICoords = mapAOICoords(CHUNK_SIZE);
const pixelAOICoords = mapAOICoords(1);
const pixelPOICoords = mapPOICoords(1);

const overlayTexts = {
  structures: pixelAOICoords(structures),
  items: pixelPOICoords(items),
  bosses: pixelPOICoords(bosses),
  orbs: [...chunkAOICoords(orbAreas), ...pixelPOICoords(orbs)],
};

export const getAllOverlays = (): [OverlayKey, TargetOfInterest[]][] => {
  return Object.entries(overlayTexts) as [OverlayKey, TargetOfInterest[]][];
};

export type OverlayKey = keyof typeof overlayTexts;

export const isValidOverlayKey = (name: string | undefined): name is OverlayKey => {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(overlayTexts, name);
};
export const asOverlayKey = (name: string | undefined): OverlayKey | undefined =>
  isValidOverlayKey(name) ? name : undefined;

/**
 * Return the DOM element and the OSD position for an area of interest overlay
 */
function createAOI({ text, x, y, width, height }: AreaOfInterest) {
  const el = document.createElement('div');
  el.className = 'osOverlayHighlight';

  const span = document.createElement('span');
  span.textContent = text.join('\n');
  el.appendChild(span);

  const hue = Math.floor(Math.random() * 360);
  el.style.backgroundColor = `hsla(${hue}, 60%, 60%, 0.5)`;

  return { element: el, location: new Rect(x, y, width, height) };
}

/**
 * Return the DOM element for the popup on a POI
 */
function createOverlayPopup({ name, aliases, wiki }: Pick<PointOfInterest, 'name' | 'aliases' | 'wiki' | 'text'>) {
  const popup = document.createElement('div');
  popup.className = 'osOverlayPopup';

  const nameElement = document.createElement('h2');
  nameElement.textContent = name;
  popup.appendChild(nameElement);

  if (aliases && aliases.length > 0) {
    const aliasesElement = document.createElement('h3');
    aliasesElement.textContent = `(${aliases.map(alias => `"${alias}"`).join(', ')})`;
    popup.appendChild(aliasesElement);
  }

  const wikiLink = document.createElement('a');
  wikiLink.href = wiki;
  wikiLink.target = '_blank';
  wikiLink.textContent = 'Wiki';
  popup.appendChild(wikiLink);

  return popup;
}

/**
 * Return the DOM element and the OSD position for an area of interest overlay
 */
function createPOI({ name, aliases, icon, wiki, x, y }: PointOfInterest): OSDOverlay {
  const el = document.createElement('div');

  const pin = document.createElement('div');
  pin.className = 'osOverlayPOI';
  el.appendChild(pin);

  const img = document.createElement('img');
  img.src = icon;
  img.alt = name;
  img.className = 'pixelated-image';
  pin.appendChild(img);

  const popup = createOverlayPopup({ name, aliases, wiki });
  el.appendChild(popup);

  return {
    element: el,
    location: new Point(x, y),
  };
}

/**
 * Return an Overlay object based on the type of the input data
 */
function createOverlay(overlay: PointOfInterest | AreaOfInterest): OSDOverlay {
  switch (overlay.overlayType) {
    case 'poi':
      return createPOI(overlay);
    case 'aoi':
      return createAOI(overlay);
  }
}

export const createOverlays = (mapName: string): OSDOverlay[] => {
  const overlays: OSDOverlay[] = [];

  type Entries = [OverlayKey, (PointOfInterest | AreaOfInterest)[]];
  for (const [type, overlayDatas] of Object.entries(overlayTexts) as Entries[]) {
    for (const overlayData of overlayDatas) {
      if (!overlayData.maps.includes(mapName)) continue;

      const overlay = createOverlay(overlayData);
      overlay.element.classList.add('overlay', type);

      overlays.push(overlay);
    }
  }

  overlays.sort((a, b) => a.location.y - b.location.y);

  return overlays;
};

export const showOverlay = (overlayKey: OverlayKey, show: boolean) => {
  try {
    const osdRootElement = assertElementById('osContainer', HTMLElement);
    if (show) {
      osdRootElement.classList.add(`show-${overlayKey}`);
    } else {
      osdRootElement.classList.remove(`show-${overlayKey}`);
    }
  } catch (e) {
    console.error(e);
  }
};
