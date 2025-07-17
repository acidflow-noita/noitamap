import structures from '../data/structures.json';
import items from '../data/items.json';
import bosses from '../data/bosses.json';
import orbAreas from '../data/orb_areas.json';
import orbs from '../data/orbs.json';
import { assertElementById } from '../util';
import spells from '../data/spells.json';
import biomes from '../data/biomes.json';
import { gameTranslator } from '../game-translations/translator';

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
  element: HTMLDivElement;
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
function createOverlay(overlay: PointOfInterest | AreaOfInterest, overlayType?: OverlayKey): OSDOverlay {
  switch (overlay.overlayType) {
    case 'poi':
      return createPOI(overlay, overlayType);
    case 'aoi':
      return createAOI(overlay);
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

  type Entries = [OverlayKey, (PointOfInterest | AreaOfInterest)[]];
  for (const [type, overlayDatas] of Object.entries(overlayTexts) as Entries[]) {
    for (const overlayData of overlayDatas) {
      if (!overlayData.maps.includes(mapName)) continue;

      const overlay = createOverlay(overlayData, type);
      overlay.element.classList.add('overlay', type);

      overlays.push(overlay);
    }
  }

  if (mapName === 'regular-main-branch') overlays.push(...biomeOverlays);

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
        }
        textElement.textContent = translatedText;
      }
    }
  });

  // Also refresh biome overlay text (AOI overlays)
  const biomeOverlays = document.querySelectorAll('.overlay.biomes span');
  biomeOverlays.forEach(span => {
    const spanElement = span as HTMLElement;
    const originalText = spanElement.dataset.originalText;
    if (originalText && !originalText.includes('%')) {
      // Skip percentage displays
      // Translate biome names using stored original text
      const translatedText = gameTranslator.translateContent('biomes', originalText);
      spanElement.textContent = translatedText;
    }
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
