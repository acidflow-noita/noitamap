import { bindAttribute, bindText } from './i18n';

export const guessrFeatures = {
  replays: {
    title: 'Round replays',
    note: 'Watch a player’s moves and guesses with the play button beside their score. Select another score to switch replays.',
  },
  markers: {
    title: 'Player pins',
    note: 'Select a player in the round scores to see their guess and the correct location together.',
  },
  hostReview: {
    title: 'Host-only review',
    note: 'Only the host can read the moderation details when a game is flagged for review.',
  },
  limits: {
    title: 'Daily limit countdown',
    note: 'When a daily limit blocks play, the notice shows a countdown and the reset time in your time zone.',
  },
} as const;

type Feature = keyof typeof guessrFeatures;
export const latestFeatures: readonly Feature[] = ['replays', 'markers', 'hostReview', 'limits'];

export function newFeatureBadge(feature: Feature) {
  const badge = document.createElement('span');
  badge.className = 'badge badge-subtle theme-success guessr-new-badge';
  badge.dataset.newFeature = feature;
  badge.hidden = !latestFeatures.includes(feature);
  return bindText(badge, 'New');
}

export function featureLabel(feature: Feature, text: string = guessrFeatures[feature].title) {
  const label = document.createElement('span');
  label.className = 'guessr-feature-label';
  label.append(bindText(document.createElement('span'), text), ' ', newFeatureBadge(feature));
  return label;
}

export function replayLegend() {
  const label = featureLabel('replays', 'Replays');
  bindAttribute(label, 'title', guessrFeatures.replays.note);
  return label;
}
