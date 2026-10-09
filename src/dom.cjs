// for testing pieces from CLI. makes a lot of DOM stuff exist in Node
// use: npx tsx -r src/jsdom.cjs src/<file>ts
// may need to also import OpenSeadragon, FlexSearch, etc. and set into global

const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<!DOCTYPE html>`);

global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
