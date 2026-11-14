// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { streamingSetting } from '../src/guessr/streaming-setting';
import i18next from '../src/i18n';
import { initializeGuessrTranslations } from '../src/guessr/i18n';

afterEach(async () => { document.body.replaceChildren(); if (i18next.isInitialized) await i18next.changeLanguage('en'); });
it('defaults SvC on and 1v1 off, and changes the explanation without replacing the switch', async () => {
  await initializeGuessrTranslations();
  const values: boolean[] = [], stream = streamingSetting('stream', value => values.push(value));
  const pvp = streamingSetting('pvp', () => {});
  document.body.append(stream.element, pvp.element);
  expect(stream.input.checked).toBe(true); expect(pvp.input.checked).toBe(false);
  expect(stream.element.textContent).toContain('Other players guess each location before it appears on your stream.');
  stream.input.click();
  expect(values).toEqual([true, false]);
  expect(stream.element.textContent).toContain('Everyone plays the same location at the same time.');
  i18next.addResourceBundle('de', 'guessr', { 'I’m streaming': 'Ich streame gerade',
    'Everyone plays the same location at the same time.': 'Alle spielen denselben Ort gleichzeitig.' }, true, true);
  await i18next.changeLanguage('de');
  expect(stream.element.textContent).toContain('Ich streame gerade');
  expect(stream.element.textContent).toContain('Alle spielen denselben Ort gleichzeitig.');
  expect(stream.element.querySelector('input')).toBe(stream.input); expect(stream.input.checked).toBe(false);
});
