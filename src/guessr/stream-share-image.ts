import type { StreamShareData } from './stream-share-data';
import { drawResultBackdrop, renderResultImage, resultImageText } from './result-share-image';

type Translate = (source: string, values?: Record<string, string | number>) => string;
export function streamShareLabels(data: StreamShareData, locale: string, translate: Translate) {
  const number = new Intl.NumberFormat(locale);
  const difference = translate('{{points}} points', { count: Math.abs(data.gap), points: number.format(Math.abs(data.gap)) });
  const player = (value: StreamShareData['player']) => ({ name: value.name, color: value.color, total: number.format(value.score),
    rank: translate('Rank {{rank}} of {{players}}', { rank: number.format(value.rank), players: number.format(data.players) }) });
  return {
    kind: data.kind,
    title: translate(data.mode === 'pvp' ? '1v1' : 'Chat vs Streamer'),
    date: new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${data.day}T00:00:00Z`)),
    headline: data.conceded ? translate('{{player}} conceded the match.', { player: data.conceded }) : data.kind === 'streamer' ? data.player.name : data.gap > 0
      ? translate('You scored more points than {{player}} (difference: {{score}})', { player: data.streamer.name, score: difference })
      : data.gap < 0 ? translate('You scored fewer points than {{player}} (difference: {{score}})', { player: data.streamer.name, score: difference })
        : translate('Same score as {{player}}', { player: data.streamer.name }),
    versus: translate('Versus'),
    player: player(data.player), streamer: player(data.streamer),
    outscored: `${translate('Players with lower scores than yours')}: ${number.format(data.outscored)} / ${number.format(data.chatters)}`,
    rounds: data.player.rounds.map((score, index) => ({ label: translate('Round {{round}}', { round: number.format(index + 1) }),
      player: number.format(score), streamer: number.format(data.streamer.rounds[index]),
      winner: Math.sign(score - data.streamer.rounds[index]),
    })),
  };
}

export function drawStreamShareImage(ctx: CanvasRenderingContext2D, labels: ReturnType<typeof streamShareLabels>,
  logo: CanvasImageSource, topography: CanvasImageSource): void {
  drawResultBackdrop(ctx, logo, topography);
  const text = resultImageText(ctx);
  text(labels.title, 600, 62, 32, 800, '#f8fafc', 520, 'center');
  text(labels.date, 600, 109, 21, 400, '#cbd5e1', 1000, 'center');
  if (labels.kind === 'chatter') {
    text(labels.headline, 600, 174, 36, 700, '#f8fafc', 1096, 'center');
    text(labels.player.name, 340, 233, 32, 600, labels.player.color, 440, 'center');
    text(labels.streamer.name, 860, 233, 32, 600, labels.streamer.color, 440, 'center');
    text(labels.player.total, 340, 293, 76, 700, '#f8fafc', 440, 'center');
    text(labels.streamer.total, 860, 293, 76, 700, '#f8fafc', 440, 'center');
    text(labels.versus, 600, 293, 25, 700, '#94a3b8', 84, 'center');
    text(labels.player.rank, 340, 347, 23, 400, '#cbd5e1', 460, 'center');
    text(labels.streamer.rank, 860, 347, 23, 400, '#cbd5e1', 460, 'center');
  } else {
    text(labels.player.name, 600, 176, 38, 700, labels.player.color, 1080, 'center');
    text(labels.player.total, 600, 263, 108, 700, '#f8fafc', 1080, 'center');
    text(labels.player.rank, 600, 326, 25, 400, '#cbd5e1', 1080, 'center');
    text(labels.outscored, 600, 362, 24, 400, '#cbd5e1', 1080, 'center');
  }

  // The approved Daily grid, with the same player order in every cell.
  if (!labels.rounds.length) return;
  const left = 80, top = 384, column = 208, row = 134;
  ctx.strokeStyle = '#64748b'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(left, top, column * 5, row * 2, 16); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(left, top + row); ctx.lineTo(1120, top + row);
  for (let index = 1; index < 5; index++) {
    const x = left + index * column; ctx.moveTo(x, top); ctx.lineTo(x, top + row * 2);
  }
  ctx.stroke();
  labels.rounds.forEach((round, index) => {
    const x = left + index % 5 * column, y = top + Math.floor(index / 5) * row;
    text(round.label, x + column / 2, y + 33, 21, 400, '#cbd5e1', 180, 'center');
    if (labels.kind === 'chatter') {
      // Only the higher score takes its player's username color.
      text(round.player, x + 94, y + 85, 28, round.winner > 0 ? 700 : round.winner === 0 ? 600 : 400,
        round.winner > 0 ? labels.player.color : '#f8fafc', 80, 'right');
      text(round.streamer, x + 194, y + 85, 28, round.winner < 0 ? 700 : round.winner === 0 ? 600 : 400,
        round.winner < 0 ? labels.streamer.color : '#f8fafc', 80, 'right');
    } else text(round.player, x + 178, y + 87, 40, 600, '#f8fafc', 160, 'right');
  });
}

export function renderStreamShareImage(labels: ReturnType<typeof streamShareLabels>): Promise<Blob> {
  return renderResultImage((ctx, logo, topography) => drawStreamShareImage(ctx, labels, logo, topography));
}
