// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { networkReviewSummary } from '../src/guessr/network-review-view';
import type { NetworkReviewFlag } from '../src/guessr/stream-types';

it('shows separate account groups together without changing scores or exposing network identifiers', () => {
  const players = ['200', '201', '300', '301'].map(id => ({ id, name: `Player ${id}`, login: `player${id}` }));
  const flags: NetworkReviewFlag[] = [
    { round: 1, highScorers: ['200'], explorers: ['201'], nonSubmitting: ['201'] },
    { round: 2, highScorers: ['200'], explorers: ['201'], nonSubmitting: [] },
    { round: 1, highScorers: ['300'], explorers: ['301'], nonSubmitting: [] },
  ];
  const summary = networkReviewSummary(flags, players)!;
  expect(summary.querySelector('summary')?.textContent).toBe('Shared connection groups: 2');
  const groups = summary.querySelectorAll('section'); expect(groups).toHaveLength(2);
  expect(groups[0].textContent).toContain('Player 200, Player 201');
  expect(groups[0].textContent).not.toContain('Player 300');
  expect(groups[1].textContent).toContain('Player 300, Player 301');
  expect(summary.textContent).toContain('It does not prove cheating, and scores are unchanged.');
});
