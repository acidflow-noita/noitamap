import { cameraRect, type ClueSource, type PreparedFrame } from './clue-camera';
import type { ImageGameConfig } from './image-game';
import type { StreamResult } from './stream-types';
import type { StreamRoundView } from './stream-round-data';
import { within, type Point } from './rules';

export function resultMapConfig(result: StreamResult, fallback?: ImageGameConfig): ImageGameConfig | undefined {
  const config = result.config ?? fallback;
  if (!config || config.version !== result.version || !config.map || !config.bounds) return;
  const { map, bounds } = config;
  if (map.width !== bounds.width || map.height !== bounds.height || !Number.isInteger(map.tileSize) || map.tileSize <= 0
    || !Number.isInteger(map.overlap) || map.overlap < 0 || !Number.isInteger(map.maxLevel) || typeof map.tiles !== 'string') return;
  return config;
}

/** Reconstruct the initial clue from the same public native-resolution tiles.
 * Published answers suffice; no private lookup, render Worker or D1 query. */
export function resultClue(config: ImageGameConfig, answer: Point): ClueSource | undefined {
  if (!within(answer, config.bounds)) return;
  const c = config.map, view = cameraRect({ dx: 0, dy: 0, level: 0 });
  const left = answer.x + view.x - config.bounds.x, top = answer.y + view.y - config.bounds.y;
  if (left < 0 || top < 0 || left + view.width > c.width || top + view.height > c.height) return;
  const frames: PreparedFrame[] = [];
  for (let y = Math.floor(top / c.tileSize); y <= Math.floor((top + view.height - 1) / c.tileSize); y++) {
    for (let x = Math.floor(left / c.tileSize); x <= Math.floor((left + view.width - 1) / c.tileSize); x++) {
      const imageX = Math.max(0, x * c.tileSize - c.overlap), imageY = Math.max(0, y * c.tileSize - c.overlap);
      frames.push({ image: `${c.tiles.replace(/\/$/, '')}/${c.maxLevel}/${x}_${y}.webp`,
        x: config.bounds.x + imageX - answer.x, y: config.bounds.y + imageY - answer.y,
        width: Math.min(c.width, (x + 1) * c.tileSize + c.overlap) - imageX,
        height: Math.min(c.height, (y + 1) * c.tileSize + c.overlap) - imageY });
    }
  }
  return { frames };
}

export function resultRoundView(result: StreamResult, index: number): StreamRoundView {
  const round = result.rounds[index];
  return { round: index + 1, host: result.host, answer: round.answer, label: round.name,
    players: result.players.map(player => {
      const position = result.positions?.[player.id]?.[index];
      return { id: player.id, name: player.name, login: player.login, color: player.color,
        guess: position ? { x: position[0], y: position[1] } : null,
        recorded: position !== undefined ? position !== null : player.rounds[index].score > 0,
        score: player.rounds[index].score, total: player.rounds.slice(0, index + 1).reduce((sum, r) => sum + r.score, 0) };
    }) };
}
