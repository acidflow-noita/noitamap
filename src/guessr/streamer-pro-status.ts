import type { LiveRoomView } from './live-room-types';
import Popover from 'bootstrap/js/dist/popover.js';
import { onGuessrLanguageChanged, tr } from './i18n';

type ProProof = Pick<LiveRoomView, 'hostPro' | 'hostProVerifiedUntil'> & { gameId?: string | null };
// Display mirrors the verified Twitch grants in the auth Worker. This never
// authorizes hosting; the Worker still verifies the signed-in identity.
export const hasKnownStreamerPro = (channel: string) => ['wuote', 'dunkorslam'].includes(channel.toLowerCase());

/** Hosting already requires Pro. This badge describes that game's admission,
 * not a live membership lookup or the lifetime of an authentication ticket. */
export function streamerProStatus(options: { local?: boolean; channel?: string } = {}) {
  const badge = document.createElement('span');
  badge.tabIndex = 0;
  let proof: ProProof = {}, explanation = '';
  const popup = new Popover(badge, { trigger: 'hover focus', placement: 'bottom', container: 'body',
    content: () => explanation, html: false, animation: false });
  const paint = () => {
    const known = !!options.channel && hasKnownStreamerPro(options.channel);
    const local = options.local && !known;
    const active = known || !local && !!proof.gameId;
    badge.hidden = !proof.gameId && !known;
    badge.className = 'badge stream-pro-status' + (active ? ' pro animation-pop' : '');
    badge.dataset.proStatus = local ? 'local' : active ? 'active' : 'unknown';
    badge.textContent = local ? tr('Local test') : tr('Pro');
    badge.setAttribute('aria-label', local ? tr('Local test') : tr('Pro'));
    explanation = known ? tr('Streamer has Pro') : local ? tr('This is a local test game. Streamer Pro access is not checked here.')
      : tr('The streamer’s Pro access was confirmed for this game.');
    badge.setAttribute('aria-description', explanation);
    popup.setContent({ '.popover-body': explanation });
  };
  paint();
  const unsubscribe = onGuessrLanguageChanged(paint);
  return { badge, update(value: ProProof) { proof = value; paint(); },
    dispose() { unsubscribe(); popup.dispose(); } };
}
