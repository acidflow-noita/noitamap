import structures from '../data/structures.json';
import items from '../data/items.json';
import bosses from '../data/bosses.json';
import orbAreas from '../data/orb_areas.json';
import orbs from '../data/orbs.json';
import spatialAwareness from '../data/spatial_awareness.json';
import { assertElementById } from '../util';
import spells from '../data/spells.json';
import biomes from '../data/biomes.json';
import { gameTranslator } from '../game-translations/translator';
import { biomeBoundaries } from '../drawing/biome-boundaries';
import tilesources from '../data/tilesources.json';
import i18next from 'i18next';

const { Rect, Point } = OpenSeadragon;
type Rect = InstanceType<typeof Rect>;
type Point = InstanceType<typeof Point>;

export type PathOfInterest = {
  overlayType: 'path';
  maps: string[];
  path: string;
  color: string;
  text: string;
  biomeName?: string;
};

export type TargetOfInterest = PointOfInterest | AreaOfInterest | PathOfInterest;

export type PointOfInterest = {
  overlayType: 'poi';
  maps: string[];
  name: string;
  aliases?: string[];
  icon: string;
  wiki?: string;
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
  element: HTMLElement;
  location: Rect | Point;
  name?: string;
};

export type Spell = {
  id: string;
  name: string;
  sprite: string;
  spawnProbabilities: Partial<Record<string, number>>;
  isPremadeWandSpell: boolean;
  isWandSpell: boolean;
};

export type Biome = {
  name: string;
  spellTiers: {
    wands?: number[];
    spellShops?: number[];
    holyMountain?: number[];
  };
  location: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
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

function biomeToAOI(biome: Biome): AreaOfInterest[] {
  const { x, y, width, height } = biome.location;
  const areas: AreaOfInterest[] = [
    {
      overlayType: 'aoi',
      maps: ['regular-main-branch'],
      text: [biome.name],
      x,
      y,
      width,
      height,
    },
  ];

  if (biome.spellTiers.holyMountain) {
    areas.push({
      overlayType: 'aoi',
      maps: ['regular-main-branch'],
      text: [`${biome.name} - Holy Mountain`],
      x,
      y: y + height,
      width,
      height: 1,
    });
  }

  return chunkAOICoords(areas);
}

const overlayTexts = {
  structures: pixelPOICoords(structures),
  items: pixelPOICoords(items),
  bosses: pixelPOICoords(bosses),
  orbs: [...chunkAOICoords(orbAreas), ...pixelPOICoords(orbs)],
  spatialAwareness: pixelPOICoords(spatialAwareness),
  biomeBoundaries: biomeBoundaries,
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
function createAOI({ text, x, y, width, height }: AreaOfInterest): OSDOverlay {
  const el = document.createElement('div');
  el.className = 'osOverlayHighlight';

  const span = document.createElement('span');
  // Store original text for retranslation
  const originalText = text.join('\n');
  span.dataset.originalText = originalText;

  // Translate the text for biome overlays
  const translatedText = gameTranslator.translateContent('biomes', originalText);
  span.textContent = translatedText;
  el.appendChild(span);

  const hue = Math.floor(Math.random() * 360);
  el.style.backgroundColor = `hsla(${hue}, 60%, 60%, 0.5)`;

  return { element: el, location: new Rect(x, y, width, height), name: text[0] };
}

// Global tooltip element for biome names
let biomeTooltip: HTMLDivElement | null = null;

function getBiomeTooltip(): HTMLDivElement {
  if (!biomeTooltip) {
    biomeTooltip = document.createElement('div');
    biomeTooltip.id = 'biome-tooltip';
    biomeTooltip.style.position = 'fixed';
    biomeTooltip.style.pointerEvents = 'none';
    biomeTooltip.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
    biomeTooltip.style.color = '#ffffff';
    biomeTooltip.style.padding = '8px 12px';
    biomeTooltip.style.borderRadius = '4px';
    biomeTooltip.style.fontSize = '14px';
    biomeTooltip.style.fontWeight = 'bold';
    biomeTooltip.style.zIndex = '10000';
    biomeTooltip.style.display = 'none';
    biomeTooltip.style.whiteSpace = 'nowrap';
    biomeTooltip.style.border = '2px solid rgba(255, 255, 255, 0.3)';
    biomeTooltip.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.5)';
    document.body.appendChild(biomeTooltip);
  }
  return biomeTooltip;
}

function createPathOverlay({ path, color, text, biomeName }: PathOfInterest): OSDOverlay {
  // Split the path into individual polygons (separated by M commands)
  const polygons: string[] = [];
  const pathCommands = path.split(/(?=M)/); // Split on M but keep M in each part
  
  for (const polygon of pathCommands) {
    if (polygon.trim()) {
      polygons.push(polygon.trim());
    }
  }

  // Calculate bounding box from all coordinates
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const allCoords = path.split(/[MLZ]/).filter(p => p.trim() !== '');
  for (const point of allCoords) {
    const coords = point.trim().split(' ').map(Number).filter(n => !isNaN(n));
    for (let i = 0; i < coords.length; i += 2) {
      if (i + 1 < coords.length) {
        const x = coords[i];
        const y = coords[i + 1];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const width = maxX - minX;
  const height = maxY - minY;

  // Create container element
  const el = document.createElement('div');
  el.style.pointerEvents = 'none'; // Container doesn't handle events
  el.dataset.biomeName = text;
  el.classList.add('biome-overlay-path');
  
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.position = 'absolute';
  svg.style.overflow = 'visible';
  svg.style.pointerEvents = 'none'; // SVG itself doesn't block events

  const visiblePaths: SVGPathElement[] = [];

  // Create separate path elements for each polygon
  for (const polygonPath of polygons) {
    // Create visible path for this polygon
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', polygonPath);
    pathEl.style.fill = color;
    pathEl.style.fillOpacity = '0.3';
    pathEl.style.stroke = '#000000';
    pathEl.style.strokeWidth = '50';
    pathEl.style.transition = 'fill-opacity 0.2s, filter 0.2s';
    pathEl.style.pointerEvents = 'visiblePainted'; // Only respond to events on visible painted areas
    pathEl.style.cursor = 'pointer';
    svg.appendChild(pathEl);
    visiblePaths.push(pathEl);
  }

  el.appendChild(svg);

  // Attach event handlers to each polygon path
  visiblePaths.forEach(pathEl => {
    pathEl.addEventListener('mouseenter', () => {
      const tooltip = getBiomeTooltip();
      
      // Check if we have a biome name and if it's not empty
      if (biomeName && biomeName.trim() !== '' && biomeName !== '_EMPTY_') {
        // biomeName is either already "biome_xxx" or just "xxx"
        // If it doesn't start with "biome_", prepend it
        const translationKey = biomeName.startsWith('biome_') ? biomeName : `biome_${biomeName}`;
        
        // Try to get translation from gameContent.biomes using the full key
        let translatedName = i18next.t(`gameContent.biomes.${translationKey}`, { defaultValue: null });
        
        // If not found, fall back to just the biome name
        if (!translatedName) {
          translatedName = biomeName;
        }
        
        // Format: Translated Name\n(filename)
        tooltip.innerHTML = `${translatedName}<br><span style="font-family: Inter, sans-serif; font-feature-settings: 'tnum', 'zero', 'cv09', 'cv02', 'cv03', 'cv04'; font-weight: 400; opacity: 0.7;">(${text})</span>`;
      } else {
        // No in-game name available
        const noInGameName = i18next.t('noInGameName');
        tooltip.innerHTML = `${noInGameName}<br><span style="font-family: Inter, sans-serif; font-feature-settings: 'tnum', 'zero', 'cv09', 'cv02', 'cv03', 'cv04'; font-weight: 400; opacity: 0.7;">(${text})</span>`;
      }
      
      tooltip.style.display = 'block';
      
      // Increase fill opacity, keep black stroke
      visiblePaths.forEach(p => {
        p.style.fillOpacity = '0.75';
      });
      
      document.querySelectorAll('.biome-overlay-path').forEach((otherEl) => {
        if (otherEl !== el) {
          const otherPaths = otherEl.querySelectorAll('path');
          otherPaths.forEach(p => {
            (p as SVGPathElement).style.fillOpacity = '0.3';
            (p as SVGPathElement).style.strokeOpacity = '0.3';
          });
        }
      });
    });

    pathEl.addEventListener('mouseleave', () => {
      const tooltip = getBiomeTooltip();
      tooltip.style.display = 'none';
      
      // Reset to default state
      visiblePaths.forEach(p => {
        p.style.fillOpacity = '0.3';
        p.style.stroke = '#000000';
        p.style.strokeOpacity = '1';
      });
      
      document.querySelectorAll('.biome-overlay-path').forEach((otherEl) => {
        if (otherEl !== el) {
          const otherPaths = otherEl.querySelectorAll('path');
          otherPaths.forEach(p => {
            (p as SVGPathElement).style.fillOpacity = '0.3';
            (p as SVGPathElement).style.strokeOpacity = '1';
          });
        }
      });
    });

    pathEl.addEventListener('mousemove', (e) => {
      const tooltip = getBiomeTooltip();
      // Position tooltip to the right and above cursor to avoid coordinate text
      tooltip.style.left = `${e.clientX + 20}px`;
      tooltip.style.top = `${e.clientY - 60}px`;
    });
  });

  return { element: el, location: new Rect(minX, minY, width, height) };
}

/**
 * Return the DOM element for the popup on a POI
 */
function createOverlayPopup({ name, aliases, text, wiki }: PointOfInterest, overlayType?: OverlayKey) {
  const popup = document.createElement('div');
  popup.className = 'osOverlayPopup';

  // Store original data for retranslation
  popup.dataset.originalName = name;
  if (text !== undefined) {
    popup.dataset.originalText = text;
  }
  if (overlayType) {
    popup.dataset.overlayType = overlayType;
  }

  const nameElement = document.createElement('h2');
  // Translate the name based on overlay type
  let translatedName = name;
  if (overlayType) {
    switch (overlayType) {
      case 'bosses':
        translatedName = gameTranslator.translateBoss(name);
        break;
      case 'items':
        translatedName = gameTranslator.translateItem(name);
        break;
      case 'structures':
        translatedName = gameTranslator.translateStructure(name);
        break;
      case 'orbs':
        translatedName = gameTranslator.translateContent('orbs', name);
        break;
      case 'spatialAwareness':
        translatedName = gameTranslator.translateContent('spatialAwareness', name);
        break;
    }
  }
  nameElement.textContent = translatedName;
  popup.appendChild(nameElement);

  if (aliases && aliases.length > 0) {
    const aliasesElement = document.createElement('h3');
    aliasesElement.textContent = `(${aliases.map(alias => `"${alias}"`).join(', ')})`;
    popup.appendChild(aliasesElement);
  }

  if (text !== undefined) {
    const textElement = document.createElement('p');
    // Translate the text content based on overlay type
    let translatedText = text;
    if (overlayType) {
      switch (overlayType) {
        case 'bosses':
          translatedText = gameTranslator.translateBoss(text);
          break;
        case 'items':
          translatedText = gameTranslator.translateItem(text);
          break;
        case 'structures':
          translatedText = gameTranslator.translateStructure(text);
          break;
        case 'orbs':
          translatedText = gameTranslator.translateContent('orbs', text);
          break;
        case 'spatialAwareness':
          translatedText = gameTranslator.translateContent('spatialAwareness', text);
          break;
      }
    }
    textElement.textContent = translatedText;
    popup.appendChild(textElement);
  }

  if (wiki !== undefined) {
    const wikiLink = document.createElement('a');
    wikiLink.href = wiki;
    wikiLink.target = '_blank';
    wikiLink.textContent = 'Wiki';
    wikiLink.classList.add('wikiLink');
    popup.appendChild(wikiLink);
  }

  return popup;
}

/**
 * Return the DOM element and the OSD position for an area of interest overlay
 */
function createPOI(poi: PointOfInterest, overlayType?: OverlayKey): OSDOverlay {
  const { name, icon, x, y } = poi;
  const el = document.createElement('div');

  const pin = document.createElement('div');
  pin.className = 'osOverlayPOI';
  el.appendChild(pin);

  const img = document.createElement('img');
  img.src = icon;
  img.alt = name;
  img.className = 'pixelated-image';
  pin.appendChild(img);

  const popup = createOverlayPopup(poi, overlayType);
  el.appendChild(popup);

  return {
    element: el,
    location: new Point(x, y),
  };
}

/**
 * Return an Overlay object based on the type of the input data
 */
function createOverlay(overlay: TargetOfInterest, overlayType?: OverlayKey): OSDOverlay {
  switch (overlay.overlayType) {
    case 'poi':
      return createPOI(overlay, overlayType);
    case 'aoi':
      return createAOI(overlay);
    case 'path':
      return createPathOverlay(overlay);
  }
}

const biomeOverlays = biomes.flatMap(biomeToAOI).map(aoi => {
  const overlay = createOverlay(aoi);
  overlay.element.classList.remove('osOverlayHighlight');
  overlay.element.classList.add('overlay', 'biomes');
  overlay.element.style.backgroundColor = '';
  return overlay;
});

export const createOverlays = (mapName: string): OSDOverlay[] => {
  const overlays: OSDOverlay[] = [];

  // Define z-index priority for overlay types (lower = behind, higher = in front)
  const zIndexPriority: Record<string, number> = {
    'biomeBoundaries': 1,  // Biome boundaries at the back
    'biomes': 2,           // Biome overlays
    'orbAreas': 3,         // Area overlays
    'structures': 10,      // POI overlays in front
    'items': 10,
    'bosses': 10,
    'orbs': 10,
    'spatialAwareness': 10,
  };

  type Entries = [OverlayKey, TargetOfInterest[]];
  for (const [type, overlayDatas] of Object.entries(overlayTexts) as Entries[]) {
    for (const overlayData of overlayDatas) {
      if (!overlayData.maps.includes(mapName)) continue;

      const overlay = createOverlay(overlayData, type);
      overlay.element.classList.add('overlay', type);
      
      // Set z-index based on type
      const zIndex = zIndexPriority[type] || 5;
      overlay.element.style.zIndex = String(zIndex);

      overlays.push(overlay);
    }
  }

  if (mapName === 'regular-main-branch') {
    biomeOverlays.forEach(overlay => {
      overlay.element.style.zIndex = String(zIndexPriority['biomes'] || 2);
    });
    overlays.push(...biomeOverlays);
  }

  // Sort by z-index first, then by Y coordinate within same z-index
  overlays.sort((a, b) => {
    const zIndexA = parseInt(a.element.style.zIndex || '5');
    const zIndexB = parseInt(b.element.style.zIndex || '5');
    if (zIndexA !== zIndexB) {
      return zIndexA - zIndexB;
    }
    return a.location.y - b.location.y;
  });

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

// Move helpers to top-level
const createSpan = (content: string) => {
  const span = document.createElement('span');
  span.textContent = content;
  return span;
};

export const resetBiomeOverlays = () => {
  biomeOverlays.forEach((overlay: OSDOverlay) => {
    const container = overlay.element.firstChild as HTMLDivElement;
    container.innerHTML = '';
    overlay.element.classList.remove('show');
  });
};

// Function to refresh overlay popup translations
export const refreshOverlayTranslations = () => {
  // Find all overlay popups and refresh their content
  const overlayPopups = document.querySelectorAll('.osOverlayPopup');
  overlayPopups.forEach(popup => {
    const popupElement = popup as HTMLElement;

    // Get the stored original data
    const originalName = popupElement.dataset.originalName;
    const originalText = popupElement.dataset.originalText;
    const overlayType = popupElement.dataset.overlayType as OverlayKey | undefined;

    if (!originalName || !overlayType) return;

    // Update the name element
    const nameElement = popupElement.querySelector('h2');
    if (nameElement) {
      let translatedName = originalName;
      switch (overlayType) {
        case 'bosses':
          translatedName = gameTranslator.translateBoss(originalName);
          break;
        case 'items':
          translatedName = gameTranslator.translateItem(originalName);
          break;
        case 'structures':
          translatedName = gameTranslator.translateStructure(originalName);
          break;
        case 'orbs':
          translatedName = gameTranslator.translateContent('orbs', originalName);
          break;
        case 'spatialAwareness':
          translatedName = gameTranslator.translateContent('spatialAwareness', originalName);
          break;
      }
      nameElement.textContent = translatedName;
    }

    // Update the text element if it exists
    if (originalText) {
      const textElement = popupElement.querySelector('p');
      if (textElement) {
        let translatedText = originalText;
        switch (overlayType) {
          case 'bosses':
            translatedText = gameTranslator.translateBoss(originalText);
            break;
          case 'items':
            translatedText = gameTranslator.translateItem(originalText);
            break;
          case 'structures':
            translatedText = gameTranslator.translateStructure(originalText);
            break;
          case 'orbs':
            translatedText = gameTranslator.translateContent('orbs', originalText);
            break;
          case 'spatialAwareness':
            translatedText = gameTranslator.translateContent('spatialAwareness', originalText);
            break;
        }
        textElement.textContent = translatedText;
      }
    }
  });

  // Also refresh biome overlay text (AOI overlays)
  const biomeOverlays = document.querySelectorAll('.overlay.biomes');
  biomeOverlays.forEach(overlay => {
    const container = overlay.firstChild as HTMLDivElement;
    if (!container) return;

    // Find the biome name span (has originalText dataset)
    const biomeNameSpan = container.querySelector('span[data-original-text]') as HTMLElement;
    if (biomeNameSpan && biomeNameSpan.dataset.originalText) {
      const translatedText = gameTranslator.translateContent('biomes', biomeNameSpan.dataset.originalText);
      biomeNameSpan.textContent = translatedText;
    }

    // Percentage spans don't need translation - they're just numbers with %
    // They will remain as-is
  });
};

const getProbabilities = (spell: Spell, tiers: number[]): number[] => {
  return Object.entries(spell.spawnProbabilities)
    .filter(
      ([tier, probability]: [string, number | undefined]) =>
        tiers.includes(Number(tier)) && probability !== undefined && probability !== 0
    )
    .map(([_, probability]: [string, number | undefined]) => probability!);
};

const getMatchingTiers = (spawnTiers: number[], potentialTiers: number[] | undefined) => {
  return potentialTiers?.filter(tier => spawnTiers.includes(tier)) ?? [];
};

const getTotalProbability = (probabilities: number[]) => {
  if (probabilities.length === 0) return 0;
  return probabilities.length / probabilities.reduce((acc, cur) => acc + 1 / cur, 0);
};

// Export selectSpell at top-level
export const selectSpell = (spell: Spell, app: any) => {
  resetBiomeOverlays();
  const spawnTiers = Object.keys(spell.spawnProbabilities).map(Number);

  const affectedOverlays: {
    overlay: OSDOverlay;
    totalProbability: number;
  }[] = [];
  let minProbability = 1;
  let maxProbability = 0;
  let boundingBox: Rect | null = null;
  biomeOverlays.forEach(overlay => {
    if (!overlay.name) return;
    const container = overlay.element.firstChild as HTMLDivElement;

    const biome = biomes.find(biome => biome.name === overlay.name || biome.name === overlay.name?.split(' - ')[0]);
    if (!biome) return;

    const tiers: number[] = [];
    if (overlay.name?.includes('Holy Mountain')) {
      tiers.push(...getMatchingTiers(spawnTiers, biome.spellTiers.holyMountain));
    } else {
      if (spell.isWandSpell || (spell.isPremadeWandSpell && overlay.name === 'Mines')) {
        tiers.push(...getMatchingTiers(spawnTiers, biome.spellTiers.wands));
      }
      tiers.push(...getMatchingTiers(spawnTiers, biome.spellTiers.spellShops));
    }
    const probabilities = getProbabilities(spell, tiers);
    const totalProbability = getTotalProbability(probabilities);
    if (totalProbability === 0) return;

    if (boundingBox) {
      boundingBox = boundingBox.union(overlay.location as Rect);
    } else {
      boundingBox = overlay.location as Rect;
    }

    container.appendChild(createSpan(`${(totalProbability * 100).toFixed(2)}%`));
    affectedOverlays.push({
      overlay,
      totalProbability,
    });
    minProbability = Math.min(minProbability, totalProbability);
    maxProbability = Math.max(maxProbability, totalProbability);
    overlay.element.classList.add('show');
  });

  const addGuaranteedSpawnArea = (biomeName: string) => {
    const guaranteedSpawnOverlay = biomeOverlays.find(overlay => overlay.name === biomeName);
    if (guaranteedSpawnOverlay) {
      guaranteedSpawnOverlay.element.classList.add('show');
      const container = guaranteedSpawnOverlay.element.firstChild as HTMLDivElement;
      container.appendChild(createSpan('100%'));
      affectedOverlays.push({
        overlay: guaranteedSpawnOverlay,
        totalProbability: 1,
      });
    }
  };

  const guaranteedSpells = [
    { idSubstring: 'COLOUR_', biomeName: 'Bunkers' },
    { idSubstring: 'IF_', biomeName: 'Bunkers' },
    { idSubstring: 'BLACK_HOLE_GIGA', biomeName: 'Celestial Scale' },
    { idSubstring: 'RAINBOW_TRAIL', biomeName: 'Rainbow Trail' },
    { idSubstring: 'KANTELE', biomeName: 'Kantele' },
    { idSubstring: 'OCARINA', biomeName: 'Ocarina' },
    { idSubstring: 'ALL_SPELLS', biomeName: 'Robotic Egg' },
  ];

  guaranteedSpells.forEach(({ idSubstring, biomeName }) => {
    if (spell.id.includes(idSubstring)) {
      addGuaranteedSpawnArea(biomeName);
    }
  });

  affectedOverlays.forEach(({ overlay, totalProbability }) => {
    if (totalProbability === 1) {
      overlay.element.style.borderColor = 'hsla(200, 100%, 50%, 0.6)';
      return;
    }

    const hue =
      minProbability === maxProbability
        ? 120
        : 120 - 120 * (1 - (totalProbability - minProbability) / (maxProbability - minProbability));
    overlay.element.style.borderColor = `hsla(${hue}, 100%, 50%, 0.8)`;
    overlay.element.style.background = `hsla(${hue}, 100%, 50%, 0.4)`;
  });

  if (boundingBox) {
    app.osd.withSlowAnimation(() => app.osd.viewport.fitBounds(boundingBox));
  }
};

export const initSpellSelector = (app: any) => {
  const infoButton = assertElementById('spellChanceInfoButton', HTMLButtonElement);
  infoButton.addEventListener('click', ev => {
    ev.preventDefault();
  });

  const spritePath = './assets/icons/spells';
  const createSpellListItem = (spell: Spell) => {
    const spellListItem = document.createElement('li');
    spellListItem.dataset.id = spell.id;

    const spellSprite = document.createElement('img');
    spellSprite.src = `${spritePath}/${spell.sprite}`;
    spellSprite.classList.add('pixelated-image');
    spellSprite.onerror = () => {
      spellSprite.src = './assets/icons/spells/missing.png'; // fallback image
      spellSprite.alt = 'Missing';
    };
    spellListItem.appendChild(spellSprite);

    const infoDiv = document.createElement('div');
    infoDiv.appendChild(createSpan(spell.name));
    infoDiv.appendChild(createSpan('Tiers: ' + Object.keys(spell.spawnProbabilities).join(', ')));
    infoDiv.appendChild(createSpan('Found on wands: ' + (spell.isWandSpell ? 'Yes' : 'No')));
    infoDiv.appendChild(createSpan('Found on pre-made wands: ' + (spell.isPremadeWandSpell ? 'Yes' : 'No')));
    spellListItem.appendChild(infoDiv);

    return spellListItem;
  };

  const spellListItems = spells.map(createSpellListItem);
  const spellListElement = assertElementById('spellList', HTMLUListElement);

  const displayMatchingSpells = (search: string) => {
    spellListElement.innerHTML = '';
    if (search === '') {
      return;
    }

    spellListItems.forEach(spellListItem => {
      if (spellListItem.textContent?.toLowerCase().includes(search.toLowerCase())) {
        spellListElement.appendChild(spellListItem);
      }
    });
  };

  const spellSelector = assertElementById('spellSelector', HTMLInputElement);
  spellSelector.addEventListener('input', ev => {
    const target = ev.target as HTMLInputElement;

    if (target.value === '') {
      resetBiomeOverlays();
    }

    displayMatchingSpells(target.value);
  });

  spellListElement.addEventListener('click', ev => {
    if (!(ev.target instanceof HTMLElement)) return;
    const spellListItem = ev.target.closest('li');
    if (!spellListItem || !spellListItem.dataset.id) return;
    const selectedSpell = spells.find(spell => spell.id === spellListItem.dataset.id);
    if (!selectedSpell) return;
    selectSpell(selectedSpell, app);
  });
};
