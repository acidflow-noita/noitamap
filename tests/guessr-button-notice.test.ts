// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { buttonNotice } from '../src/guessr/button-notice';
const calls = vi.hoisted(() => ({ popovers: [] as { options: any; dispose: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn> }[] }));
vi.mock('bootstrap/js/dist/popover.js', () => ({ default: class {
  dispose = vi.fn(); show = vi.fn(async () => {});
  constructor(_button: HTMLElement, options: any) { calls.popovers.push({ options, dispose: this.dispose, show: this.show }); }
} }));
afterEach(() => { calls.popovers.length = 0; vi.useRealTimers(); });
it('keeps feedback in the body overlay, expires it and cleans up repeated clicks', async () => {
  vi.useFakeTimers();
  const button = document.createElement('button'), feedback = buttonNotice(button);
  feedback.show('Guess sent'); await Promise.resolve();
  expect(calls.popovers[0].options).toMatchObject({ container: 'body', trigger: 'manual', html: false, content: 'Guess sent' });
  expect(button.childElementCount).toBe(0);
  await vi.advanceTimersByTimeAsync(2400);
  expect(calls.popovers[0].dispose).toHaveBeenCalledOnce();
  feedback.show('Again'); await Promise.resolve(); feedback.show('Latest'); await Promise.resolve();
  expect(calls.popovers[1].dispose).toHaveBeenCalledOnce();
  feedback.dispose(); expect(calls.popovers[2].dispose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
