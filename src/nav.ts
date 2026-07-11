import { getAllMapDefinitions } from './data_sources/map_definitions';
import { assertElementById, formatDate } from './util';
import type { Badge, MapDefinition } from './data_sources/map_definitions';
import i18next from './i18n';

export const NAV_LINK_IDENTIFIER = 'nav-link';

export const isNavLink = (el: HTMLElement) => el.classList.contains(NAV_LINK_IDENTIFIER);

const TRANSLATABLE_LABEL_KEYS = [
  'maps.mapDynamic',
  'maps.regular',
  'maps.newGamePlus',
  'maps.nightmare',
];

export const getMapLabel = (def: MapDefinition): string => {
  const shouldTranslate = def.labelKey && TRANSLATABLE_LABEL_KEYS.includes(def.labelKey);
  return shouldTranslate
    ? i18next.t(def.labelKey || '', { defaultValue: def.label })
    : def.label;
};

/** Build the full badge list for a map def, including the synthetic date badge. */
const getMapBadges = (def: MapDefinition, iconOnly: boolean): { badges: Badge[]; isDynamic: boolean; dateBadgeIndex: number } => {
  const badges = [...def.badges];
  const isDynamic = def.key === 'dynamic-main-branch';
  const dateStr = isDynamic ? new Date().toISOString().slice(0, 10) : def.patchDate;
  badges.push({
    label: formatDate(dateStr, i18next.language),
    class: ['border', 'border-info-subtle'],
    icon: iconOnly ? 'bi bi-calendar3' : undefined,
  });
  return { badges, isDynamic, dateBadgeIndex: badges.length - 1 };
};

/**
 * Create a single badge span with popover wiring.
 * @param iconOnly — when true, suppresses the visible text label and adds a
 *   compact class so the badge renders as a small icon/color dot. The popover
 *   still shows the full label on hover.
 */
const createBadgeSpan = (badge: Badge, isDynamic: boolean, iconOnly: boolean, isDateBadge: boolean): HTMLSpanElement => {
  const span = document.createElement('span');
  span.classList.add('badge');
  if (typeof badge.class === 'string') {
    span.classList.add(badge.class);
  } else {
    badge.class.forEach(c => span.classList.add(c));
  }
  if (iconOnly) span.classList.add('map-badge-icon-only');

  const translatedBadgeLabel = badge.labelKey
    ? i18next.t(badge.labelKey, { defaultValue: badge.label })
    : badge.label;

  span.dataset.bsToggle = 'popover';
  span.dataset.bsPlacement = 'bottom';
  span.dataset.bsTrigger = 'hover';
  span.dataset.bsHtml = 'true';
  span.setAttribute('tabindex', '0');
  span.dataset.bsTitle = translatedBadgeLabel;

  if (isDateBadge) {
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
    badge.icon.split(' ').forEach(c => icon.classList.add(c));
    span.appendChild(icon);
  }

  if (!iconOnly) {
    span.appendChild(document.createTextNode(` ${translatedBadgeLabel}`));
  }
  return span;
};

/** Append all badges for a map def to the given parent, optionally icon-only. */
export const renderMapBadges = (parent: HTMLElement, def: MapDefinition, iconOnly: boolean = false): void => {
  const { badges, isDynamic, dateBadgeIndex } = getMapBadges(def, iconOnly);
  badges.forEach((badge, i) => {
    parent.appendChild(createBadgeSpan(badge, isDynamic, iconOnly, i === dateBadgeIndex));
  });
};

/** Re-initialize bootstrap popovers on any .badge[data-bs-toggle="popover"] under `root`. */
export const refreshBadgePopovers = (root: HTMLElement): void => {
  root.querySelectorAll('[data-bs-toggle="popover"]').forEach(el => {
    // @ts-ignore
    const existing = bootstrap.Popover.getInstance(el);
    if (existing) existing.dispose();
    // @ts-ignore
    new bootstrap.Popover(el);
  });
};

const buildDropdownLink = (mapName: string, def: MapDefinition): HTMLAnchorElement => {
  const a = document.createElement('a');
  a.classList.add(NAV_LINK_IDENTIFIER, 'text-nowrap', 'dropdown-item', 'd-flex', 'align-items-center', 'gap-1');
  a.href = '#';
  a.dataset.bsToggle = 'pill';
  a.dataset.mapKey = mapName;

  const labelSpan = document.createElement('span');
  labelSpan.className = 'me-2';
  labelSpan.textContent = getMapLabel(def);
  a.appendChild(labelSpan);

  renderMapBadges(a, def, false);
  return a;
};

export const createMapLinks = (): HTMLUListElement => {
  const navLinksUl = assertElementById('navLinksList', HTMLUListElement);
  navLinksUl.replaceChildren();

  for (const [mapName, def] of getAllMapDefinitions()) {
    const li = document.createElement('li');
    li.appendChild(buildDropdownLink(mapName, def));
    navLinksUl.appendChild(li);
  }

  return navLinksUl;
};

// Function to update map link translations
export const updateMapLinkTranslations = (): void => {
  const navLinksUl = assertElementById('navLinksList', HTMLUListElement);
  for (const [mapName, def] of getAllMapDefinitions()) {
    const link = navLinksUl.querySelector(`[data-map-key="${mapName}"]`) as HTMLAnchorElement | null;
    if (!link) continue;
    const wasActive = link.classList.contains('active');
    link.replaceChildren();

    const labelSpan = document.createElement('span');
    labelSpan.className = 'me-2';
    labelSpan.textContent = getMapLabel(def);
    link.appendChild(labelSpan);

    renderMapBadges(link, def, false);
    if (wasActive) link.classList.add('active');
  }
  refreshBadgePopovers(navLinksUl);
};

// Utility to get short map name for selection
export const getShortMapName = (def: MapDefinition) => {
  return def.label;
};
