#!/usr/bin/env node
/** Attach a validated existing Sage seed record to each publishable daily world.
 * Run with: node --import tsx build_scripts/bake-sage-seed.mjs --out=/out
 * A binary schemaVersion of 4 does not mean the final V4 population is baked.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SageRecordReader, createBakedSageSnapshot, readBakedSageSnapshot } from '../src/sage/records.ts';
const worlds = ['left', 'middle', 'right'];
async function atomicJSON(file, value) {
  const temporary = `${file}.sage-tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n'); await rename(temporary, file);
}
/** @param {string} directory
 * @param {{reader?: Pick<import('../src/sage/records.ts').SageReader, 'read'>, required?: boolean}} [options]
 */
export async function attachSageToBake(directory, { reader = new SageRecordReader(), required = false } = {}) {
  const seed = Number((await readFile(join(directory, 'seed.txt'), 'utf8')).trim());
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff) throw new Error('Invalid bake seed');
  const files = await Promise.all(worlds.map(async world => {
    const path = join(directory, world, 'generation.json');
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data.seed !== seed) throw new Error(`Mismatched ${world} generation seed`);
    return { world, path, data };
  }));
  let snapshot;
  try {
    snapshot = createBakedSageSnapshot(seed, await reader.read(seed));
    if (!readBakedSageSnapshot(snapshot, seed)) throw new Error('Sage returned an invalid or mismatched record');
  } catch (error) {
    if (required) throw error;
    snapshot = createBakedSageSnapshot(seed, null, error instanceof Error ? error.message : 'Sage lookup failed');
  }
  for (const { world, path, data } of files) {
    data.sage = snapshot;
    await atomicJSON(path, data);
    await atomicJSON(join(directory, world, 'sage.json'), snapshot);
  }
  console.log(`[sage] ${snapshot.status} for seed ${seed}; attached to all three worlds${snapshot.reason ? ` (${snapshot.reason})` : ''}`);
  return snapshot;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = process.argv.slice(2).find(arg => arg.startsWith('--out='))?.slice(6) ?? process.env.OUT_DIR ?? '/out';
  await attachSageToBake(resolve(out), { required: process.env.SAGE_REQUIRED === '1' });
}
