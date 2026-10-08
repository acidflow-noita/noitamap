// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createSourceFile, forEachChild, isPropertyAssignment, isIfStatement, ScriptTarget, transpileModule } from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';

const source = createSourceFile('main.ts', readFileSync('src/main.ts', 'utf8'), ScriptTarget.Latest);
let openSource = '', handoffSource = '';
function visit(node: any) {
  if (isPropertyAssignment(node) && node.name.getText(source) === 'openTodaysDaily') openSource = node.initializer.getText(source);
  if (isIfStatement(node) && node.expression.getText(source) === 'drawingDailyRequest') handoffSource = node.thenStatement.getText(source);
  forEachChild(node, visit);
}
visit(source);
const build = new Function('app', 'runDynamicMapFromURL', transpileModule(`
  let pendingDynamicSeed: number | null = 12631;
  let drawingDailyRequest: { run?: Promise<unknown> } | undefined;
  const dynamicOpts = { viewer: 'fixture' };
  const open = ${openSource};
  return { open, handoff: () => ${handoffSource}, pendingSeed: () => pendingDynamicSeed };
`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText);
afterEach(() => { history.replaceState(null, '', '/'); });

function fixture(map: string) {
  const run = vi.fn().mockResolvedValue({ seed: 200 });
  const app = { getMap: () => map, setMap: vi.fn(async () => { map = 'dynamic-main-branch'; flow.handoff(); }) };
  const flow = build(app, run);
  return { flow, run, app };
}
it('loads exactly one published Daily on a static-to-dynamic import', async () => {
  history.replaceState(null, '', '/?m=r&se=12631&seed=12631&nb=1&x=-312&y=1354&z=1000');
  const f = fixture('regular-main-branch');
  expect(await f.flow.open()).toBe(true);
  expect(f.app.setMap).toHaveBeenCalledExactlyOnceWith('dynamic-main-branch');
  expect(f.run).toHaveBeenCalledExactlyOnceWith({ viewer: 'fixture' }, true);
  expect(f.flow.pendingSeed()).toBeNull();
  const p = new URL(location.href).searchParams;
  expect(p.has('se')).toBe(false); expect(p.has('seed')).toBe(false); expect(p.has('nb')).toBe(false);
  expect(p.get('ds')).toBe('1'); expect(p.get('x')).toBe('-312'); expect(p.get('z')).toBe('1000');
});
it('waits for the Daily pipeline before allowing shapes to attach on an already dynamic map', async () => {
  const f = fixture('dynamic-main-branch'); let done!: (value: unknown) => void;
  f.run.mockImplementation(() => new Promise(r => { done = r; }));
  let complete = false; const pending = f.flow.open().then((value: boolean) => { complete = true; return value; });
  await Promise.resolve(); expect(complete).toBe(false); expect(f.app.setMap).not.toHaveBeenCalled();
  done({ seed: 201 }); expect(await pending).toBe(true);
});
it('does not claim an obsolete/cancelled Daily request completed', async () => {
  const f = fixture('dynamic-main-branch'); f.run.mockResolvedValue(null);
  expect(await f.flow.open()).toBe(false);
});
