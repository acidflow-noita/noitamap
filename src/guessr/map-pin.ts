import artwork from '../../public/assets/noitaguessr-pin.svg?raw';

// Guess pins use the supplied logo, anchored at its tip. The solution target
// is centred on the coordinate. Sizes stay fixed in CSS pixels while zooming.
export const MAP_PIN_PATH = artwork.match(/<path\s+d="([^"]+)"/)![1];
export const MAP_PIN_TIP = { x: 25.7384, y: 63.1753 };
export const ANSWER_PIN_CENTER = { x: 32, y: 32 };
export const GUESS_PIN_COLOR = '#3b82f6';
export const ANSWER_PIN_COLOR = '#37946e';
export const GUESS_PIN_HEIGHT = 44;
export const ANSWER_PIN_HEIGHT = 52;
export const PLAYER_PIN_HEIGHT = 36;
export const HIGHLIGHT_PIN_HEIGHT = 48;
