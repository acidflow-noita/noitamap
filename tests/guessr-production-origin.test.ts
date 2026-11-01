// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://dynamic-map.noitamap.com/guess/"}
import { afterEach, expect, it, vi } from 'vitest';
import { gameApiOrigin } from '../src/guessr/api';

afterEach(() => vi.unstubAllEnvs());
it('uses the configured production service without enabling localhost behavior', () => {
  vi.stubEnv('VITE_GUESSR_API_URL', ''); vi.stubEnv('PROD', true);
  expect(gameApiOrigin()).toBe('https://guessr-api.sage-data.xyz');
  vi.stubEnv('PROD', false); expect(gameApiOrigin()).toBeNull();
  vi.stubEnv('VITE_GUESSR_API_URL', 'https://test.sage-data.xyz'); expect(gameApiOrigin()).toBe('https://test.sage-data.xyz');
});
