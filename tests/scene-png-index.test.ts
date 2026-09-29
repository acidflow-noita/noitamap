import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { indexScenePngs } from '../src/telescope/scene-png-index';

it('never draws material/spawn instruction PNGs as scene artwork', async () => {
  const zip = await JSZip.loadAsync(await readFile(new URL('../public/data.zip', import.meta.url)));
  const index = indexScenePngs(Object.keys(zip.files));
  for (const name of ['friendroom', 'cavern', 'solid_wall_hidden_cavern',
    'watercave_layout_1', 'watercave_layout_5']) {
    expect(zip.file(`data/biome_impl/${name}.png`), name).toBeTruthy();
    expect(index.visualByName.get(name), name).toBeUndefined();
  }
  for (const path of index.visualByName.values())
    expect(path).toMatch(/_(visual|fg)\.png$/);
  expect(index.visualByName.get('essenceroom')).toBe('data/biome_impl/essenceroom_visual.png');
  expect(index.bgByName.size).toBeGreaterThan(0);
});

it('preserves dedicated layer paths and deterministic basename fallback', () => {
  const index = indexScenePngs(['data/biome_impl/a/room.png',
    'data/biome_impl/a/room_visual.png', 'data/biome_impl/b/room_visual.png',
    'data/biome_impl/a/room_background.png', 'data/biome_impl/a/other_bg.png']);
  expect(index.visualByPath.get('b/room')).toBe('data/biome_impl/b/room_visual.png');
  expect(index.visualByName.get('room')).toBe('data/biome_impl/a/room_visual.png');
  expect(index.bgByPath.get('a/room')).toBe('data/biome_impl/a/room_background.png');
  expect(index.bgByPath.get('a/other')).toBe('data/biome_impl/a/other_bg.png');
});
