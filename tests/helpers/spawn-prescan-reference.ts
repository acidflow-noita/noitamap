import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createSourceFile, isFunctionDeclaration, ScriptTarget } from 'typescript';
import type { Plugin } from 'vite';

/** Run the pinned upstream algorithm after the host's normal build transforms.
 * The independent linear lookup is retained even if unused imports were pruned. */
export function referenceSpawnPrescan(root: string): Plugin {
  const files = new Set(['noita-telescope', 'noita-telescope-vm'].map(fork => resolve(root, 'lib', fork, 'js/poi_scanner.js')));
  return { name: 'reference-linear-spawn-prescan', enforce: 'post', async transform(code, id) {
    if (!files.has(id)) return;
    const raw = await readFile(id, 'utf8');
    const lookup = (await readFile(resolve(dirname(id), 'spawn_functions.js'), 'utf8'))
      .match(/export function getSpawnFunctionIndex\([\s\S]*?\n\}/)![0]
      .replace('export function getSpawnFunctionIndex', 'function __baselineSpawnLookup');
    const original = raw.match(/export function prescanSpawnFunctions\([\s\S]*?\n\}/)![0]
      .replace('export function', 'function').replace('getSpawnFunctionIndex(', '__baselineSpawnLookup(');
    const ast = createSourceFile(id, code, ScriptTarget.Latest);
    const node = ast.statements.find(s => isFunctionDeclaration(s) && s.name?.text === 'prescanSpawnFunctions');
    if (!node) throw new Error('Missing prescan reference boundary');
    return code.slice(0, node.getStart(ast)) + original + code.slice(node.end) + '\n' + lookup;
  } };
}
