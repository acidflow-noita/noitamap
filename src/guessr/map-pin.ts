import artwork from '../../public/assets/noitaguessr-pin.svg?raw';

// Reuse the supplied logo pin. Its pointed tip, not the image center, owns the
// world coordinate. Sizes below are CSS pixels and do not shrink when zooming.
export const MAP_PIN_PATH = artwork.match(/<path\s+d="([^"]+)"/)![1];
export const MAP_PIN_TIP = { x: 25.7384, y: 63.1753 };
export const GUESS_PIN_COLOR = '#3b82f6';
export const ANSWER_PIN_COLOR = '#37946e';
export const GUESS_PIN_HEIGHT = 44;
export const ANSWER_PIN_HEIGHT = 52;
export const PLAYER_PIN_HEIGHT = 36;
export const HIGHLIGHT_PIN_HEIGHT = 48;
