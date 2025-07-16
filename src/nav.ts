import { getAllMapDefinitions } from './data_sources/map_definitions';
import { assertElementById, formatDate } from './util';
import type { MapDefinition } from './data_sources/map_definitions';
import i18next from './i18n';

export const NAV_LINK_IDENTIFIER = 'nav-link';

export const isNavLink = (el: HTMLElement) => el.classList.contains(NAV_LINK_IDENTIFIER);

export const createMapLinks = (): HTMLUListElement => {
  const navLinksUl = assertElementById('navLinksList', HTMLUListElement);

  for (const [mapName, def] of getAllMapDefinitions()) {
    const a = document.createElement('a');
    a.classList.add(NAV_LINK_IDENTIFIER, 'text-nowrap', 'dropdown-item');
    a.href = '#';
    a.dataset.bsToggle = 'pill';
    a.dataset.mapKey = mapName;
    // Use labelKey from definition if available, fallback to original label
    const translatedLabel = def.labelKey ? i18next.t(def.labelKey, { defaultValue: def.label }) : def.label;
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

      // Add explanatory tooltips to patchdate badges only if applicable
      if (span.classList.contains('border-info-subtle')) {
        span.dataset.bsToggle = 'tooltip';
        span.dataset.bsPlacement = 'top';
        span.dataset.bsTitle = 'Patch date this map was captured';
      }

      if (badge.icon) {
        const icon = document.createElement('i');
        badge.icon.split(' ').forEach(styleClass => icon.classList.add(styleClass));
        span.appendChild(icon);
      }

      // Use labelKey from badge if available, fallback to original label
      const translatedBadgeLabel = badge.labelKey
        ? i18next.t(badge.labelKey, { defaultValue: badge.label })
        : badge.label;
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

    // Use labelKey from definition if available, fallback to original label
    const translatedLabel = def.labelKey ? i18next.t(def.labelKey, { defaultValue: def.label }) : def.label;
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

      // Add explanatory tooltips to patchdate badges only if applicable
      if (span.classList.contains('border-info-subtle')) {
        span.dataset.bsToggle = 'tooltip';
        span.dataset.bsPlacement = 'top';
        span.dataset.bsTitle = 'Patch date this map was captured';
      }

      if (badge.icon) {
        const icon = document.createElement('i');
        badge.icon.split(' ').forEach(styleClass => icon.classList.add(styleClass));
        span.appendChild(icon);
      }

      // Use labelKey from badge if available, fallback to original label
      const translatedBadgeLabel = badge.labelKey
        ? i18next.t(badge.labelKey, { defaultValue: badge.label })
        : badge.label;
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
