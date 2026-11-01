import { assertElementById } from './util';
import { updateTranslations } from './i18n-dom';
import { mountLanguageSelector } from './language-selector-core';

export function createLanguageSelector() {
  const languageSelectorButton = assertElementById('languageSelectorButton', HTMLButtonElement);
  const languageLinksList = assertElementById('languageLinksList', HTMLDivElement);
  return mountLanguageSelector({
    button: languageSelectorButton,
    menu: languageLinksList,
    onLanguageChanged: updateTranslations,
  });
}
