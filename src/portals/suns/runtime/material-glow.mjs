const f = Math.fround;

// These liquid/gas overrides use material-cell illumination. Their authored
// particle motion stays intact; original cosmetic emitters keep their glow quads.
export function materialCellGlow(material) {
  return material.id === "material_rainbow" || material.id === "rainbow_gas"
    ? Math.max(0, Math.min(1000, Math.trunc(material.glow))) : undefined;
}

// Native cell blit 0x724c1c: gfx_glow/255 * .25, then truncate each RGB byte.
// Gas coverage 0x722340 scales those bytes by alphaByte/256. The post_glow2
// material input expands by four, separately from cosmetic glow's factor 2.5.
// Liquid particle fading is Dust's adaptation of occupied cells to moving shapes.
export function cellGlowColor(color, strength, alpha = 1, gas = false) {
  const factor = f(f(strength / 255) * .25);
  const coverage = Math.max(0, Math.min(1, alpha));
  const alphaByte = Math.round(coverage * 255);
  const channel = shift => {
    const value = Math.trunc(f(((color >>> shift) & 255) * factor));
    return gas ? (value * alphaByte) >> 8 : Math.trunc(value * coverage);
  };
  return (0xff000000 | (channel(16) << 16) | (channel(8) << 8) | channel(0)) >>> 0;
}
