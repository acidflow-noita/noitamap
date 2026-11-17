import type { LiveRoomView } from './live-room-types';
import Popover from 'bootstrap/js/dist/popover.js';
import { onGuessrLanguageChanged, tr } from './i18n';

type ProProof = Pick<LiveRoomView, 'hostPro' | 'hostProVerifiedUntil' | 'hostId'> & { gameId?: string | null };
// Display mirrors the verified Twitch grants in the auth Worker. This never
// authorizes hosting; the Worker still verifies the signed-in identity.
export const hasKnownStreamerPro = (userId?: string) => ['564553302', '241636'].includes(userId || '');

/** Hosting already requires Pro. This badge describes that game's admission,
 * not a live membership lookup or the lifetime of an authentication ticket. */
export function streamerProStatus(options: { local?: boolean; channel?: string; player?: boolean } = {}) {
  const badge = document.createElement('span');
  badge.tabIndex = 0;
  let proof: ProProof = {}, explanation = '';
  const popup = new Popover(badge, { trigger: 'hover focus', placement: 'bottom', container: 'body',
    content: () => explanation, html: false, animation: false });
  const paint = () => {
    const known = hasKnownStreamerPro(proof.hostId);
    const local = options.local && !known;
    const active = known || !local && !!proof.gameId;
    const hidden = !proof.gameId && !known, classes = 'badge stream-pro-status' + (active ? ' pro' : '');
    const status = local ? 'local' : active ? 'active' : 'unknown', label = local ? tr('Local test') : tr('Pro');
    if (badge.hidden !== hidden) badge.hidden = hidden;
    if (badge.className !== classes) badge.className = classes;
    if (badge.dataset.proStatus !== status) badge.dataset.proStatus = status;
    if (badge.textContent !== label) badge.textContent = label;
    if (badge.getAttribute('aria-label') !== label) badge.setAttribute('aria-label', label);
    const nextExplanation = options.player && active ? tr('Pro access was confirmed for this game.') : known ? tr('Streamer has Pro') : local ? tr('This is a local test game. Streamer Pro access is not checked here.')
      : tr('The streamer’s Pro access was confirmed for this game.');
    if (explanation !== nextExplanation) {
      explanation = nextExplanation; badge.setAttribute('aria-description', explanation);
      popup.setContent({ '.popover-body': explanation });
    }
  };
  paint();
  const unsubscribe = onGuessrLanguageChanged(paint);
  return { badge, update(value: ProProof) { proof = value; paint(); },
    dispose() { unsubscribe(); popup.dispose(); } };
}
