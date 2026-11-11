// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://dynamic-map.noitamap.com/guess/daily/?a=private-attempt&token=private-token"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dailyResultShare } from '../src/guessr/daily-share';
import { initializeGuessrTranslations } from '../src/guessr/i18n';
import i18next from '../src/i18n';
import type { RankedState } from '../src/guessr/api';

const mocks = vi.hoisted(() => ({ render: vi.fn(), copy: vi.fn(), share: vi.fn(), download: vi.fn(), notice: vi.fn(), count: 0 }));
vi.mock('../src/guessr/daily-share-image', async original => ({ ...await original<object>(), renderDailyShareImage: mocks.render }));
vi.mock('../src/image-export', () => ({ downloadBlob: (...args: unknown[]) => mocks.download(...args) }));
vi.mock('../src/guessr/button-notice', () => ({ buttonNotice: () => ({ show: mocks.notice, dispose() {} }) }));
vi.mock('bootstrap/js/dist/dialog.js', () => ({ default: class {
  constructor(private el: HTMLElement) {}
  async show() { this.el.setAttribute('open', ''); }
  dispose() { this.el.removeAttribute('open'); }
} }));
let control: ReturnType<typeof dailyResultShare>;
const png = () => new Blob(['test PNG'], { type: 'image/png' });
function result(): RankedState {
  return { day: '2026-11-08', status: 'complete', totalRounds: 10, score: 45000,
    results: Array.from({ length: 10 }, (_, ordinal) => ({ ordinal, guess: { score: 4500 } })) } as RankedState;
}
function open() {
  control = dailyResultShare(result())!;
  document.body.append(control.element); control.element.click();
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!;
async function ready() { await vi.waitFor(() => expect(button('Download PNG').disabled).toBe(false)); }

beforeEach(async () => {
  vi.clearAllMocks();
  await initializeGuessrTranslations(); await i18next.changeLanguage('en');
  mocks.render.mockResolvedValue(png()); mocks.copy.mockResolvedValue(undefined); mocks.share.mockResolvedValue(undefined);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:preview-${++mocks.count}`) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.stubGlobal('ClipboardItem', class { constructor(public data: unknown) {} static supports() { return true; } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: mocks.copy } });
  Object.defineProperty(navigator, 'share', { configurable: true, value: mocks.share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Sharing must not request game data'); }));
});
afterEach(async () => {
  control?.destroy(); control = null;
  document.body.replaceChildren(); await i18next.changeLanguage('en');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('prepares on demand and copies, downloads or shares only a ready PNG, without game requests', async () => {
  control = dailyResultShare(result())!; document.body.append(control.element);
  expect(mocks.render).not.toHaveBeenCalled();
  control.element.click();
  expect(document.querySelector('dialog')).not.toBeNull();
  expect(button('Download PNG').disabled).toBe(true);
  await ready();
  button('Copy image').click();
  expect(mocks.copy).toHaveBeenCalledOnce(); // Already called before any await.
  await vi.waitFor(() => expect(mocks.notice).toHaveBeenCalledWith('Copied'));
  button('Download PNG').click();
  expect(mocks.download).toHaveBeenCalledWith(expect.any(File), 'noitaguessr-daily-2026-11-08.png');
  button('Share image').click();
  expect(mocks.share).toHaveBeenCalledOnce();
  const payload = mocks.share.mock.calls[0][0];
  expect(Object.keys(payload).sort()).toEqual(['files', 'title']);
  expect(payload.files[0].type).toBe('image/png');
  expect(JSON.stringify(payload)).not.toMatch(/private-attempt|private-token|https:/);
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps download available when native copy/share are unsupported or copying is rejected', async () => {
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  mocks.copy.mockRejectedValue(new Error('Permission denied'));
  open(); await ready();
  expect(button('Share image').hidden).toBe(true);
  button('Copy image').click();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('Download the PNG instead'));
  expect(mocks.notice).not.toHaveBeenCalled();
  expect(button('Download PNG').disabled).toBe(false);
  control!.destroy();
  vi.stubGlobal('ClipboardItem', undefined);
  open(); await ready(); expect(button('Copy image').hidden).toBe(true);
});

it('treats native share cancellation as cancellation and permits trying again', async () => {
  mocks.share.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
  open(); await ready(); button('Share image').click();
  await vi.waitFor(() => expect(button('Share image').disabled).toBe(false));
  expect(document.querySelector('[role="status"]')!.textContent).toBe('');
});

it('recovers from encoding failure and does not silently export an incomplete game', async () => {
  expect(dailyResultShare({ ...result(), status: 'expired' })).toBeNull();
  mocks.render.mockRejectedValueOnce(new Error('Encoder failed'));
  open();
  await vi.waitFor(() => expect(button('Retry').hidden).toBe(false));
  expect(button('Download PNG').disabled).toBe(true);
  button('Retry').click(); await ready();
});

it('updates image language and discards stale renders after a language switch or close', async () => {
  let resolveOld!: (blob: Blob) => void;
  mocks.render.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  open(); await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
  await i18next.changeLanguage('de');
  await vi.waitFor(() => expect(button('PNG herunterladen').disabled).toBe(false));
  const preview = document.querySelector<HTMLImageElement>('.result-share-preview img')!, url = preview.src;
  expect(preview.alt).toContain('45.000');
  resolveOld(png()); await Promise.resolve();
  expect(preview.src).toBe(url);
  control!.destroy(); expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  const calls = mocks.render.mock.calls.length;
  await i18next.changeLanguage('en'); expect(mocks.render).toHaveBeenCalledTimes(calls);
  mocks.render.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  open(); await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(calls + 1));
  control!.destroy(); const urls = vi.mocked(URL.createObjectURL).mock.calls.length;
  resolveOld(png()); await Promise.resolve();
  expect(URL.createObjectURL).toHaveBeenCalledTimes(urls);
  expect(document.querySelector('dialog')).toBeNull();
});
