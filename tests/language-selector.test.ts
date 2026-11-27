// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BootstrapCombobox from 'bootstrap/js/dist/combobox.js';
import Combobox from '../src/bootstrap-combobox';
import { mountLanguageSelector } from '../src/language-selector-core';
import { createNGPlusLevelPicker } from '../src/ng-plus-level-picker';

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
    const button = html.querySelector<HTMLButtonElement>('#languageSelectorButton');
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

  it('uses the same Bootstrap control and caret for the map language and NG+ level', () => {
    const html = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
    const button = html.querySelector<HTMLButtonElement>('#languageSelectorButton')!;
    const language = mountLanguageSelector({ button, menu: button.nextElementSibling as HTMLElement });
    const ngPlus = createNGPlusLevelPicker(vi.fn());
    try {
      const caret = (toggle: HTMLButtonElement) => {
        expect(toggle.matches('.form-control.form-control-sm.combobox-toggle')).toBe(true);
        return toggle.querySelector(':scope > svg.combobox-caret[aria-hidden="true"]');
      };
      const languageCaret = caret(button);
      const levelCaret = caret(ngPlus.button);
      expect(languageCaret?.getAttribute('viewBox')).toBe('0 0 10 16');
      expect(languageCaret?.isEqualNode(levelCaret)).toBe(true);
      language.refresh();
      ngPlus.setLevel(28);
      expect(button.querySelector('.combobox-value img')).not.toBeNull();
      expect(ngPlus.button.querySelector('.combobox-value')?.textContent).toBe('NG+28');
      expect(caret(button)).toBe(languageCaret);
      expect(caret(ngPlus.button)).toBe(levelCaret);
    } finally {
      language.destroy();
      Combobox.getInstance(ngPlus.button)?.dispose();
    }
  });
});
