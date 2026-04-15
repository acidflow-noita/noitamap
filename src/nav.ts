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
    a.classList.add(NAV_LINK_IDENTIFIER, 'text-nowrap', 'dropdown-item', 'd-flex', 'align-items-center', 'gap-1');
    a.href = '#';
    a.dataset.bsToggle = 'pill';
    a.dataset.mapKey = mapName;
    // Only translate specific maps, others should keep English names
    const translatableKeys = [
      'maps.mapDynamic',
      'maps.regular',
      'maps.newGamePlus',
      'maps.nightmare',
    ];

    const shouldTranslate = def.labelKey && translatableKeys.includes(def.labelKey);
    const translatedLabel = shouldTranslate ? i18next.t(def.labelKey || '', { defaultValue: def.label }) : def.label;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'me-2';
    labelSpan.textContent = translatedLabel;
    a.appendChild(labelSpan);

    const badges = [...def.badges];
    const isDynamic = def.key === 'dynamic-main-branch';
    const dateStr = isDynamic ? new Date().toISOString().slice(0, 10) : def.patchDate;
    badges.push({
      label: formatDate(dateStr, i18next.language),
      class: ['border', 'border-info-subtle'],
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

      // Add popovers to all badges (consistent with sidebar style)
      span.dataset.bsToggle = 'popover';
      span.dataset.bsPlacement = 'top';
      span.dataset.bsTrigger = 'hover';
      span.dataset.bsHtml = 'true';
      span.setAttribute('tabindex', '0');
      span.dataset.bsTitle = translatedBadgeLabel;

      if (span.classList.contains('border-info-subtle')) {
        span.dataset.bsContent = isDynamic 
          ? i18next.t('badges.dynamicDateTooltip') 
          : i18next.t('badges.patchDateTooltip');
      } else if (badge.labelKey) {
        const tooltipKey = `badges.${badge.labelKey}Tooltip`;
        span.dataset.bsContent = i18next.t(tooltipKey, { defaultValue: translatedBadgeLabel });
      } else {
        span.dataset.bsContent = translatedBadgeLabel;
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
      'maps.mapDynamic',
      'maps.regular',
      'maps.newGamePlus',
      'maps.nightmare',
    ];

    const shouldTranslate = def.labelKey && translatableKeys.includes(def.labelKey);
    const translatedLabel = shouldTranslate ? i18next.t(def.labelKey || '', { defaultValue: def.label }) : def.label;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'me-2';
    labelSpan.textContent = translatedLabel;
    link.appendChild(labelSpan);

    const badges = [...def.badges];
    const isDynamic = def.key === 'dynamic-main-branch';
    const dateStr = isDynamic ? new Date().toISOString().slice(0, 10) : def.patchDate;
    badges.push({
      label: formatDate(dateStr, i18next.language),
      class: ['border', 'border-info-subtle'],
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

      // Add popovers to all badges (consistent with sidebar style)
      span.dataset.bsToggle = 'popover';
      span.dataset.bsPlacement = 'top';
      span.dataset.bsTrigger = 'hover';
      span.dataset.bsHtml = 'true';
      span.setAttribute('tabindex', '0');
      span.dataset.bsTitle = translatedBadgeLabel;

      if (span.classList.contains('border-info-subtle')) {
        span.dataset.bsContent = isDynamic 
          ? i18next.t('badges.dynamicDateTooltip') 
          : i18next.t('badges.patchDateTooltip');
      } else if (badge.labelKey) {
        const tooltipKey = `badges.${badge.labelKey}Tooltip`;
        span.dataset.bsContent = i18next.t(tooltipKey, { defaultValue: translatedBadgeLabel });
      } else {
        span.dataset.bsContent = translatedBadgeLabel;
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

  // Reinitialize popovers on rebuilt badge elements
  navLinksUl.querySelectorAll('[data-bs-toggle="popover"]').forEach(el => {
    // @ts-ignore
    const existing = bootstrap.Popover.getInstance(el);
    if (existing) existing.dispose();
    // @ts-ignore
    new bootstrap.Popover(el);
  });
};

// Utility to get short map name for selection
export const getShortMapName = (def: MapDefinition) => {
  return def.label;
};
