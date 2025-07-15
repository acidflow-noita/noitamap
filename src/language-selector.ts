import i18next from './i18n';
import { SUPPORTED_LANGUAGES, SupportedLanguage } from './i18n';
import { assertElementById } from './util';
import { updateTranslations } from './i18n-dom';

export function createLanguageSelector() {
  const languageSelector = assertElementById('language-selector', HTMLDivElement);
  const languageSelectorButton = assertElementById('languageSelectorButton', HTMLButtonElement);
  const languageLinksList = assertElementById('languageLinksList', HTMLUListElement);

  const updateLanguageSelectorUI = () => {
    const currentLanguage = i18next.language as SupportedLanguage;
    const langInfo = SUPPORTED_LANGUAGES[currentLanguage] || SUPPORTED_LANGUAGES.en;

    languageSelectorButton.innerHTML = `<img src="./flags/${langInfo.flag}.svg" class="flag-icon me-2" style="width: 16px; height: 12px;">`;

    Array.from(languageLinksList.querySelectorAll('a')).forEach(a => {
      if (a.dataset.lang === currentLanguage) {
        a.classList.add('active');
      } else {
        a.classList.remove('active');
      }
    });

    updateTranslations();
  };

  Object.entries(SUPPORTED_LANGUAGES).forEach(([code, { name, flag }]) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.classList.add('dropdown-item');
    a.dataset.lang = code;
    a.innerHTML = `<img src="./flags/${flag}.svg" class="flag-icon me-2" style="width: 16px; height: 12px;">${name}`;
    li.appendChild(a);
    languageLinksList.appendChild(li);
  });

  languageLinksList.addEventListener('click', e => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const link = target.closest('a');
    if (link && link.dataset.lang) {
      i18next.changeLanguage(link.dataset.lang);
    }
  });

  i18next.on('languageChanged', updateLanguageSelectorUI);
  updateLanguageSelectorUI();
}
