/** Native refraction gate: liquid cells whose inherited liquid_sand is false.
 * Includes lava and liquid_static fluids. Graphics alpha and glow do not gate
 * refraction. Unknown material declarations remain excluded conservatively. */
export function liquidMaterialIds(xml: string, names: readonly string[]): Set<number> {
  const entries = new Map<string, Record<string, string>>();
  for (const match of xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<CellData(?:Child)?\b([^>]*?)>/g)) {
    const attributes: Record<string, string> = {};
    for (const a of match[1].matchAll(/([\w]+)\s*=\s*"([^"]*)"/g)) attributes[a[1]] = a[2];
    if (attributes.name) entries.set(attributes.name, attributes);
  }
  const resolve = (name: string, seen = new Set<string>()): Record<string, string> => {
    if (seen.has(name)) return {};
    seen.add(name);
    const value = entries.get(name) ?? {};
    return { ...(value._parent ? resolve(value._parent, seen) : {}), ...value };
  };
  const ids = new Set<number>();
  names.forEach((name, id) => {
    const m = resolve(name);
    if (m.cell_type === 'liquid' && m.liquid_sand === '0') ids.add(id);
  });
  return ids;
}
