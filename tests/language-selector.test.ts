// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BootstrapCombobox from 'bootstrap/js/dist/combobox.js';
import Combobox from '../src/bootstrap-combobox';
import { mountLanguageSelector } from '../src/language-selector-core';

const language = vi.hoisted(() => ({ change: vi.fn() }));
vi.mock('../src/i18n', () => ({
  default: { on: vi.fn(), changeLanguage: language.change },
  currentLanguage: () => 'en', languageLocale: (code: string) => code,
  SUPPORTED_LANGUAGES: { en: { name: 'English', flag: 'gb' }, ru: { name: 'Русский', flag: 'ru' } },
}));
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('language combobox ownership', () => {
  it('avoids native auto-initialization before the shared selector is ready', () => {
    const html = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
    const button = html.querySelector<HTMLButtonElement>('.language-selector .combobox-toggle')
      ?? html.querySelector<HTMLButtonElement>('#languageDropdown');
    expect(button).not.toBeNull();
    document.body.append(button!.parentElement!);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(BootstrapCombobox.getInstance(button!)).toBeNull();
    const menu = button!.nextElementSibling as HTMLElement;
    const selector = mountLanguageSelector({ button: button!, menu });
    try {
      const instance = BootstrapCombobox.getInstance(button!);
      expect(instance).toBeInstanceOf(Combobox);
      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(BootstrapCombobox.getInstance(button!)).toBe(instance);
      menu.querySelector<HTMLAnchorElement>('[data-lang="ru"]')!.click();
      expect(language.change).toHaveBeenCalledExactlyOnceWith('ru');
      expect(errors).not.toHaveBeenCalled();
    } finally { selector.destroy(); }
    expect(BootstrapCombobox.getInstance(button!)).toBeNull();
  });
});
