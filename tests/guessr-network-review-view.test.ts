// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { reviewDisclosure } from '../src/guessr/network-review-view';
import { publicResultReview } from '../src/guessr/stream-types';

it('keeps reasons out of public results and loads the private explanation only after the explicit reveal', async () => {
  const flags = [{ round: 1, highScorers: ['200'], explorers: ['201'], nonSubmitting: ['201'] }];
  const read = vi.fn(async (_signal: AbortSignal) => ['Player 200, Player 201 were flagged in this test.']);
  const publicResult = publicResultReview({ reviewFlags: flags });
  expect(publicResult).toEqual({ reviewSuggested: true });
  const { element, hide } = reviewDisclosure(read);
  const reveal = element.querySelector('button')!;
  expect(element.textContent).toContain('Keep the reasoning off stream');
  expect(reveal.textContent).toBe('Reveal reasoning');
  expect(element.textContent).not.toContain('same internet connection');
  expect(read).not.toHaveBeenCalled();
  reveal.click();
  await vi.waitFor(() => expect(element.textContent).toContain('Player 200, Player 201'));
  hide();
  expect(read.mock.calls[0][0].aborted).toBe(true);
  expect(element.textContent).not.toContain('Player 201');
});
