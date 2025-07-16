import i18next from './i18n';
import { SUPPORTED_LANGUAGES, SupportedLanguage } from './i18n';
import { assertElementById } from './util';
import { updateTranslations } from './i18n-dom';

// Translation stats interface
interface TranslationStats {
  [lang: string]: {
    completeness: number;
    translatedKeys: number;
    totalKeys: number;
  };
}

// Load translation stats
let translationStats: TranslationStats = {};
fetch('./data/translation-stats.json')
  .then(response => response.json())
  .then(stats => {
    translationStats = stats;
    // Refresh language selector if it's already created
    if (document.getElementById('languageLinksList')) {
      updateLanguageDropdown();
    }
  })
  .catch(error => {
    console.warn('Could not load translation stats:', error);
  });

// Function to get completeness badge
function getCompletenessBadge(completeness: number): string {
  if (completeness >= 95) {
    return `<span class="badge bg-success ms-2">${completeness}%</span>`;
  } else if (completeness >= 80) {
    return `<span class="badge bg-warning ms-2">${completeness}%</span>`;
  } else if (completeness >= 50) {
    return `<span class="badge bg-secondary ms-2">${completeness}%</span>`;
  } else {
    return `<span class="badge bg-danger ms-2">${completeness}%</span>`;
  }
}

// Function to update language dropdown with stats
function updateLanguageDropdown() {
  const languageLinksList = document.getElementById('languageLinksList') as HTMLUListElement;
  if (!languageLinksList) return;

  // Update existing language links with completeness info
  Array.from(languageLinksList.querySelectorAll('a')).forEach(a => {
    const langCode = a.dataset.lang;
    if (langCode && translationStats[langCode]) {
      const stats = translationStats[langCode];
      const langInfo = SUPPORTED_LANGUAGES[langCode as SupportedLanguage];
      if (langInfo) {
        const badge = getCompletenessBadge(stats.completeness);
        a.innerHTML = `<img src="./flags/${langInfo.flag}.svg" class="flag-icon me-2" style="width: 16px; height: 12px;">${langInfo.name}${badge}`;
      }
    }
  });
}

export function createLanguageSelector() {
  const languageSelector = assertElementById('language-selector', HTMLDivElement);
  const languageSelectorButton = assertElementById('languageSelectorButton', HTMLButtonElement);
  const languageLinksList = assertElementById('languageLinksList', HTMLUListElement);

  const updateLanguageSelectorUI = () => {
    const currentLanguage = i18next.language as SupportedLanguage;
    const langInfo = SUPPORTED_LANGUAGES[currentLanguage] || SUPPORTED_LANGUAGES.en;

    // Show current language with completeness badge if available
    let buttonContent = `<img src="./flags/${langInfo.flag}.svg" class="flag-icon me-2" style="width: 16px; height: 12px;">`;
    if (translationStats[currentLanguage]) {
      const stats = translationStats[currentLanguage];
      const badge = getCompletenessBadge(stats.completeness);
      buttonContent += badge;
    }
    languageSelectorButton.innerHTML = buttonContent;

    Array.from(languageLinksList.querySelectorAll('a')).forEach(a => {
      if (a.dataset.lang === currentLanguage) {
        a.classList.add('active');
      } else {
        a.classList.remove('active');
      }
    });

    updateTranslations();
  };

  // Create language dropdown items
  Object.entries(SUPPORTED_LANGUAGES).forEach(([code, { name, flag }]) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.classList.add('dropdown-item', 'd-flex', 'justify-content-between', 'align-items-center');
    a.dataset.lang = code;

    // Initial content without stats (will be updated when stats load)
    a.innerHTML = `<span><img src="./flags/${flag}.svg" class="flag-icon me-2" style="width: 16px; height: 12px;">${name}</span>`;

    li.appendChild(a);
    languageLinksList.appendChild(li);
  });

  // Update with stats if already loaded
  if (Object.keys(translationStats).length > 0) {
    updateLanguageDropdown();
  }

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
