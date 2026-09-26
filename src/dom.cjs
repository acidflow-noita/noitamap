// for testing pieces from CLI. makes a lot of DOM stuff exist in Node
// use: npx tsx -r src/dom.cjs src/<file>.ts
// Browser-only helpers may also require an OpenSeadragon global.

const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<!DOCTYPE html>`);

global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
