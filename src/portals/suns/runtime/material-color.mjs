// Native CreateCosmeticParticle samples full texture ARGB once, using the birth
// position before the +0.5 pixel-center offset. Coordinates truncate toward zero
// and wrap, including negative positions (0x716ce0 -> 0x7044a0 -> 0x7042c0).
export function materialColorAt(material, resources, x, y) {
  const image = resources.assets[material.colorTexture];
  if (!image) return material.color ?? 0x44b43cff;
  const wrap = (value, size) => ((Math.trunc(Math.fround(value)) % size) + size) % size;
  const at = (wrap(y, image.height) * image.width + wrap(x, image.width)) * 4;
  return ((image.rgba[at + 3] << 24) |
    (image.rgba[at] << 16) | (image.rgba[at + 1] << 8) | image.rgba[at + 2]) >>> 0;
}

// Math contours are not Noita particles, but should follow the same material.
// Split textured contours at pixel-sized intervals so long edges retain the
// palette instead of receiving a single flat color at their midpoint.
export function* materialGuides(sim, resources, override) {
  const material = sim.guideMaterial;
  for (const [a, b] of sim.guides ?? []) {
    const steps = override == null && material?.colorTexture
      ? Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]))) : 1;
    for (let step = 0; step < steps; step++) {
      const start = steps === 1 ? a : [a[0] + (b[0] - a[0]) * step / steps, a[1] + (b[1] - a[1]) * step / steps];
      const end = steps === 1 ? b : [a[0] + (b[0] - a[0]) * (step + 1) / steps, a[1] + (b[1] - a[1]) * (step + 1) / steps];
      const color = override ?? (material
        ? materialColorAt(material, resources, sim.x + (start[0] + end[0]) / 2, sim.y + (start[1] + end[1]) / 2)
        : 0x44b43cff);
      yield [start, end, color];
    }
  }
}
