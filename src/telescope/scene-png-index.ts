export interface ScenePngIndex {
  visualByPath: Map<string, string>;
  visualByName: Map<string, string>;
  bgByPath: Map<string, string>;
  bgByName: Map<string, string>;
}

/** Plain biome_impl PNGs are material/spawn instructions. Only explicit
 * artwork layers may be painted over the resolved material pixels. */
export function indexScenePngs(paths: Iterable<string>): ScenePngIndex {
  const index: ScenePngIndex = {
    visualByPath: new Map(), visualByName: new Map(),
    bgByPath: new Map(), bgByName: new Map(),
  };
  for (const path of paths) {
    if (!path.startsWith('data/biome_impl/') || !path.endsWith('.png')) continue;
    const inner = path.slice('data/biome_impl/'.length);
    const add = (suffix: string, byPath: Map<string, string>, byName: Map<string, string>) => {
      if (!inner.endsWith(suffix)) return;
      const key = inner.slice(0, -suffix.length), name = key.slice(key.lastIndexOf('/') + 1);
      byPath.set(key, path);
      if (!byName.has(name)) byName.set(name, path);
    };
    add('_visual.png', index.visualByPath, index.visualByName);
    add('_background.png', index.bgByPath, index.bgByName);
    add('_bg.png', index.bgByPath, index.bgByName);
    // Temple Wang foregrounds have their own material conversion at decode.
    add('_fg.png', index.visualByPath, index.visualByName);
  }
  return index;
}
