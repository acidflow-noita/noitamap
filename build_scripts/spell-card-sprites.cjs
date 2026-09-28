/** Build the game's spell cards once; marker rendering stays a single atlas draw. */
const path = require('node:path');
const { PNG } = require('pngjs');

// gun_enums.lua: ACTION_TYPE_PROJECTILE = 0 through ACTION_TYPE_PASSIVE = 7.
const SPELL_BACKGROUNDS = [
  'projectile', 'static_projectile', 'modifier', 'draw_many',
  'material', 'other', 'utility', 'passive',
];

async function buildSpellCards(zip) {
  const source = await zip.file('data/scripts/gun/gun_actions.lua').async('string');
  // Read only each action's declarative header, before its Lua action function.
  // Remove disabled action definitions and comments before reading the fields.
  const declarations = source.replace(/--\[(=*)\[[\s\S]*?\]\1\](?:--)?/g, '')
    .replace(/--[^\n]*/g, '');
  const images = new Map();
  async function image(file) {
    if (!images.has(file)) {
      const entry = zip.file(file);
      if (!entry) throw new Error(`Missing spell-card asset: ${file}`);
      images.set(file, PNG.sync.read(await entry.async('nodebuffer')));
    }
    return images.get(file);
  }

  const cards = new Map();
  for (const [, id, header] of declarations.matchAll(/\bid\s*=\s*"([^"]+)"([\s\S]*?)(?=\baction\s*=\s*function)/g)) {
    const type = header.match(/\btype\s*=\s*ACTION_TYPE_(\w+)/)?.[1].toLowerCase();
    if (!SPELL_BACKGROUNDS.includes(type)) throw new Error(`Unknown spell-card type for ${id}: ${type}`);
    const background = await image(`data/ui_gfx/inventory/item_bg_${type}.png`);
    const iconPaths = [...header.matchAll(/\b(sprite(?:_unidentified)?)\s*=\s*"([^"]+)"/g)]
      // The game declares a few unidentified sprites absent from data.zip.
      // Those retain the renderer's generic unidentified-icon fallback.
      .filter(([, field, file]) => field === 'sprite' || (file.endsWith('.png') && zip.file(file)))
      .map(match => match[2]);
    if (!iconPaths.length) throw new Error(`Missing spell-card sprite for ${id}`);
    for (const iconPath of iconPaths) {
      const key = `spell:card/${path.basename(iconPath, '.png')}`;
      if (cards.has(key)) continue;
      const icon = await image(iconPath);
      const width = background.width;
      const height = background.height;
      const dx = (width - icon.width) / 2;
      const dy = (height - icon.height) / 2;
      if (dx < 0 || dy < 0 || !Number.isInteger(dx) || !Number.isInteger(dy)) {
        throw new Error(`Spell icon ${iconPath} does not fit its native card`);
      }
      const data = new Uint8ClampedArray(background.data);
      for (let y = 0; y < icon.height; y++) {
        for (let x = 0; x < icon.width; x++) {
          const src = (y * icon.width + x) * 4;
          const dst = ((y + dy) * width + x + dx) * 4;
          const alpha = icon.data[src + 3] / 255;
          if (alpha === 0) continue;
          const under = data[dst + 3] / 255 * (1 - alpha);
          const total = alpha + under;
          for (let c = 0; c < 3; c++) {
            data[dst + c] = Math.round((icon.data[src + c] * alpha + data[dst + c] * under) / total);
          }
          data[dst + 3] = Math.round(total * 255);
        }
      }
      // base_custom_card.xml / custom_cards/action.xml place the 20px card
      // at (10,19) relative to the entity and its 16px glyph at (8,17).
      cards.set(key, { key, data, width, height,
        xmlData: { offset_x: 10, offset_y: 19 } });
    }
  }
  return [...cards.values()];
}

module.exports = { buildSpellCards };
