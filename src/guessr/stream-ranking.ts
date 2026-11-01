/** Competition ranks: 1, 2, 2, 4. Stable ID order for display never breaks ties. */
export function rankStreamPlayers<T extends { id: string; score: number }>(
  players: T[],
): (T & { rank: number })[] {
  const ranked = players
    .map((player) => ({ ...player, rank: 0 }))
    .sort(
      (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  for (let i = 0; i < ranked.length; i++)
    ranked[i].rank =
      i && ranked[i].score === ranked[i - 1].score ? ranked[i - 1].rank : i + 1;
  return ranked;
}
