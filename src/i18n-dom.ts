import i18next from './i18n';
import { updateMapLinkTranslations } from './nav';
import { refreshOverlayTranslations } from './data_sources/overlays';
import { refreshSearchTranslations } from './main';

export function updateTranslations() {
  const elementsWithDataI18n = document.querySelectorAll('[data-i18n]');
  elementsWithDataI18n.forEach(element => {
    const key = element.getAttribute('data-i18n');
    if (key) {
      element.textContent = i18next.t(key);
    }
  });

  const elementsWithDataI18nTitle = document.querySelectorAll('[data-i18n-title]');
  elementsWithDataI18nTitle.forEach(element => {
    const key = element.getAttribute('data-i18n-title');
    if (key) {
      const translatedTitle = i18next.t(key);
      element.setAttribute('title', translatedTitle);
      element.setAttribute('data-bs-title', translatedTitle);
      element.setAttribute('data-bs-original-title', translatedTitle);
    }
  });

  const elementsWithDataI18nContent = document.querySelectorAll('[data-i18n-content]');
  elementsWithDataI18nContent.forEach(element => {
    const key = element.getAttribute('data-i18n-content');
    if (key) {
      const translatedContent = i18next.t(key);
      element.setAttribute('data-bs-content', translatedContent);
    }
  });

  const elementsWithDataI18nPlaceholder = document.querySelectorAll('[data-i18n-placeholder]');
  elementsWithDataI18nPlaceholder.forEach(element => {
    const key = element.getAttribute('data-i18n-placeholder');
    if (key && element instanceof HTMLInputElement) {
      element.placeholder = i18next.t(key);
    }
  });

  const popoverTriggerList = document.querySelectorAll('[data-bs-toggle="popover"]');
  popoverTriggerList.forEach(popoverTriggerEl => {
    // @ts-ignore
    const existingPopover = bootstrap.Popover.getInstance(popoverTriggerEl);
    if (existingPopover) {
      existingPopover.dispose();
    }
    // @ts-ignore
    new bootstrap.Popover(popoverTriggerEl);
  });

  const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
  tooltipTriggerList.forEach(tooltipTriggerEl => {
    // @ts-ignore
    const existingTooltip = bootstrap.Tooltip.getInstance(tooltipTriggerEl);
    if (existingTooltip) {
      existingTooltip.dispose();
    }
    // @ts-ignore
    new bootstrap.Tooltip(tooltipTriggerEl);
  });

  // Update map link translations
  updateMapLinkTranslations();

  // Update overlay popup translations
  refreshOverlayTranslations();

  // Update search results translations
  refreshSearchTranslations();
}
