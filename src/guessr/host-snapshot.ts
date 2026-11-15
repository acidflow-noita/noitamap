import type { StreamGame, StreamParticipant } from './stream-types';

export function submittedCounts(game: StreamGame): number[] {
  return game.session.rounds.map((_, round) => game.participants.filter(p => p.id !== game.session.host.id && p.guesses[round]?.point).length);
}
export function hostPlayer(game: StreamGame, player: StreamParticipant): StreamParticipant {
  return { id: player.id, login: player.login, name: player.name, color: player.color,
    guesses: player.guesses.map((guess, round) => player.id === game.session.host.id || game.reveals[round] ? guess : null) };
}
/** Hosting does not grant advance access to opponents' pins or future clues. */
export function hostSnapshot(game: StreamGame): StreamGame {
  return { ...game, recentNonces: undefined, receipts: undefined, submittedCounts: submittedCounts(game),
    participants: game.participants.map(player => hostPlayer(game, player)),
    session: { ...game.session, token: '', rounds: game.session.rounds.map((round, i) => ({ ...round, token: '',
      clue: game.reveals[i] || i === game.round && game.timing?.phase === 'play' ? round.clue : { frames: [] },
      difficultyTier: game.reveals[i] || i === game.round && game.timing?.phase === 'play' ? round.difficultyTier : undefined })) } };
}
