import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUESSR_REUSED_TRANSLATIONS, resolveReusedGuessrTranslation } from '../src/guessr/reused-translations';

const locale = (language: string): Record<string, unknown> => JSON.parse(readFileSync(`src/locales/${language}/translation.json`, 'utf8'));

describe('vetted shared Guessr translations', () => {
  it('keeps each mapped English label in the same source context', () => {
    for (const source of Object.keys(GUESSR_REUSED_TRANSLATIONS)) {
      expect(resolveReusedGuessrTranslation(source, locale('en'), 'en')).toBe(source);
    }
  });

  it('reuses existing Japanese and Chinese navigation/account translations', () => {
    expect(resolveReusedGuessrTranslation('Back', locale('ja'), 'ja-JP')).toBe('戻る');
    expect(resolveReusedGuessrTranslation('Retry', locale('zh'), 'zh-CN')).toBe('重试');
    expect(resolveReusedGuessrTranslation('Rank', locale('ja'), 'ja')).toBe('順位');
    expect(resolveReusedGuessrTranslation('Sign in with Twitch', locale('zh'), 'zh')).toBe('通过 Twitch 登录');
  });

  it('does not confuse close-action, daily-challenge, and untranslated game-menu text', () => {
    expect(resolveReusedGuessrTranslation('Close', locale('fi'), 'fi')).toBeUndefined();
    expect(resolveReusedGuessrTranslation('Daily', locale('fr'), 'fr')).toBe('Quotidien');
    expect(resolveReusedGuessrTranslation('Daily', locale('ru'), 'ru')).toBe('Дейли');
    expect(resolveReusedGuessrTranslation('Close', locale('ru'), 'ru')).toBe('Закрыть');
    expect(resolveReusedGuessrTranslation('Cancel', locale('fi'), 'fi')).toBeUndefined();
    expect(resolveReusedGuessrTranslation('Cancel', locale('ja'), 'ja')).toBe('キャンセル');
    expect(resolveReusedGuessrTranslation('Gift Pro on Twitch', locale('ja'), 'ja')).toBeUndefined();
  });

  it('accepts vetted cognates and the product name without accepting other English placeholders', () => {
    expect(resolveReusedGuessrTranslation('Total', locale('br'), 'pt-BR')).toBe('Total');
    expect(resolveReusedGuessrTranslation('Total', locale('fr'), 'fr')).toBe('Total');
    expect(resolveReusedGuessrTranslation('Total', locale('en'), 'ja')).toBeUndefined();
    expect(resolveReusedGuessrTranslation('NoitaGuessr', locale('ja'), 'ja')).toBe('NoitaGuessr');
  });

  it('uses the map’s corrected account actions and avoids known legacy missing accents', () => {
    expect(resolveReusedGuessrTranslation('Sign out', locale('fr'), 'fr')).toBe('Se déconnecter');
    expect(resolveReusedGuessrTranslation('Sign in with Patreon', locale('es'), 'es')).toBe('Iniciar sesión con Patreon');
    expect(resolveReusedGuessrTranslation('Sign in with Twitch', locale('cs'), 'cs')).toBeUndefined();
    expect(resolveReusedGuessrTranslation('Sign in with Twitch', { auth: { loginWithTwitch: 'Přihlásit se přes Twitch' } }, 'cs'))
      .toBe('Přihlásit se přes Twitch');
  });

  it('requires a concrete own string value and matching interpolation fields', () => {
    expect(resolveReusedGuessrTranslation('Retry', {}, 'ja')).toBeUndefined();
    expect(resolveReusedGuessrTranslation('Retry', { seedReport: { v2: { retry: {} } } }, 'ja')).toBeUndefined();
    expect(resolveReusedGuessrTranslation('Retry', Object.create(locale('ja')), 'ja')).toBeUndefined();
    expect(resolveReusedGuessrTranslation('Retry', { seedReport: { v2: { retry: '{{unexpected}} 再試行' } } }, 'ja')).toBeUndefined();
    expect(resolveReusedGuessrTranslation('toString', locale('ja'), 'ja')).toBeUndefined();
  });
});
