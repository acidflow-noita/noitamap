import { getAllMapDefinitions } from './data_sources/map_definitions';
import { assertElementById, formatDate } from './util';
import type { MapDefinition } from './data_sources/map_definitions';
import i18next from './i18n';

export const NAV_LINK_IDENTIFIER = 'nav-link';

export const isNavLink = (el: HTMLElement) => el.classList.contains(NAV_LINK_IDENTIFIER);

export const createMapLinks = (): HTMLUListElement => {
  const navLinksUl = assertElementById('navLinksList', HTMLUListElement);

  // Clear placeholder content
  navLinksUl.innerHTML = '';

  for (const [mapName, def] of getAllMapDefinitions()) {
    const a = document.createElement('a');
    a.classList.add(NAV_LINK_IDENTIFIER, 'text-nowrap', 'dropdown-item');
    a.href = '#';
    a.dataset.bsToggle = 'pill';
    a.dataset.mapKey = mapName;
    // Only translate specific maps, others should keep English names
    const translatableKeys = [
      'maps.regular',
      'maps.newGamePlus',
      'maps.nightmare',
      'maps.biomeMap',
      'maps.biomeMapCaptured',
      'maps.mapTestPng',
    ];

    const shouldTranslate = def.labelKey && translatableKeys.includes(def.labelKey);
    const translatedLabel = shouldTranslate ? i18next.t(def.labelKey, { defaultValue: def.label }) : def.label;
    a.textContent = translatedLabel + ' ';

    const badges = [...def.badges];
    badges.push({
      label: formatDate(def.patchDate),
      class: ['border', 'border-info-subtle', 'ms-2'],
    });

    for (const badge of badges) {
      const span = document.createElement('span');
      span.classList.add('badge');
      if (typeof badge.class === 'string') {
        span.classList.add(badge.class);
      } else {
        badge.class.forEach(styleClass => span.classList.add(styleClass));
      }

      // Use labelKey from badge if available, fallback to original label
      const translatedBadgeLabel = badge.labelKey
        ? i18next.t(badge.labelKey, { defaultValue: badge.label })
        : badge.label;

      // Add explanatory tooltips to all badges
      span.dataset.bsToggle = 'tooltip';
      span.dataset.bsPlacement = 'top';

      if (span.classList.contains('border-info-subtle')) {
        span.dataset.bsTitle = 'Patch date this map was captured';
      } else if (badge.labelKey) {
        // Add tooltip for other badges using their label key
        const tooltipKey = `badges.${badge.labelKey}Tooltip`;
        span.dataset.bsTitle = i18next.t(tooltipKey, { defaultValue: translatedBadgeLabel });
      } else {
        // Fallback tooltip for badges without specific keys
        span.dataset.bsTitle = translatedBadgeLabel;
      }

      if (badge.icon) {
        const icon = document.createElement('i');
        badge.icon.split(' ').forEach(styleClass => icon.classList.add(styleClass));
        span.appendChild(icon);
      }

      const text = document.createTextNode(` ${translatedBadgeLabel}`);
      span.appendChild(text);
      a.appendChild(span);
    }
    const li = document.createElement('li');
    li.appendChild(a);
    navLinksUl.appendChild(li);
  }

  return navLinksUl;
};

// Function to update map link translations
export const updateMapLinkTranslations = (): void => {
  const navLinksUl = assertElementById('navLinksList', HTMLUListElement);
  const mapDefinitions = getAllMapDefinitions();

  // Update each existing map link
  for (const [mapName, def] of mapDefinitions) {
    const link = navLinksUl.querySelector(`[data-map-key="${mapName}"]`) as HTMLAnchorElement;
    if (!link) continue;

    // Clear the link content and rebuild it with new translations
    link.innerHTML = '';

    // Only translate specific maps, others should keep English names
    const translatableKeys = [
      'maps.regular',
      'maps.newGamePlus',
      'maps.nightmare',
      'maps.biomeMap',
      'maps.biomeMapCaptured',
      'maps.mapTestPng',
    ];

    const shouldTranslate = def.labelKey && translatableKeys.includes(def.labelKey);
    const translatedLabel = shouldTranslate ? i18next.t(def.labelKey, { defaultValue: def.label }) : def.label;
    link.textContent = translatedLabel + ' ';

    const badges = [...def.badges];
    badges.push({
      label: formatDate(def.patchDate),
      class: ['border', 'border-info-subtle', 'ms-2'],
    });

    for (const badge of badges) {
      const span = document.createElement('span');
      span.classList.add('badge');
      if (typeof badge.class === 'string') {
        span.classList.add(badge.class);
      } else {
        badge.class.forEach(styleClass => span.classList.add(styleClass));
      }

      // Use labelKey from badge if available, fallback to original label
      const translatedBadgeLabel = badge.labelKey
        ? i18next.t(badge.labelKey, { defaultValue: badge.label })
        : badge.label;

      // Add explanatory tooltips to all badges
      span.dataset.bsToggle = 'tooltip';
      span.dataset.bsPlacement = 'top';

      if (span.classList.contains('border-info-subtle')) {
        span.dataset.bsTitle = 'Patch date this map was captured';
      } else if (badge.labelKey) {
        // Add tooltip for other badges using their label key
        const tooltipKey = `badges.${badge.labelKey}Tooltip`;
        span.dataset.bsTitle = i18next.t(tooltipKey, { defaultValue: translatedBadgeLabel });
      } else {
        // Fallback tooltip for badges without specific keys
        span.dataset.bsTitle = translatedBadgeLabel;
      }

      if (badge.icon) {
        const icon = document.createElement('i');
        badge.icon.split(' ').forEach(styleClass => icon.classList.add(styleClass));
        span.appendChild(icon);
      }

      const text = document.createTextNode(` ${translatedBadgeLabel}`);
      span.appendChild(text);
      link.appendChild(span);
    }
  }
};

// Utility to get short map name for selection
export const getShortMapName = (def: MapDefinition) => {
  return def.label;
};
