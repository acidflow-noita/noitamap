import i18next from './i18n';
import { updateMapLinkTranslations } from './nav';
import { refreshOverlayTranslations } from './data_sources/overlays';
import { refreshSearchTranslations } from './main';

export function updateTranslations() {
  // Nuke any rendered popover/tooltip elements before re-creating their
  // instances. Dispose() is supposed to clean these up, but if a popover was
  // visible when we re-create the instance (common during a language switch
  // while hovering the perf button), the rendered element can be left
  // orphaned in the DOM and never dismissed.
  document.querySelectorAll('.popover, .tooltip').forEach((el) => el.remove());

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

  setTimeout(() => {
    // Update map link translations
    updateMapLinkTranslations();

    // Update overlay popup translations
    refreshOverlayTranslations();

    // Update search results translations
    refreshSearchTranslations();
  }, 50);
}
