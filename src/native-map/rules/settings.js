export const appSettings = {
	enableStaticPixelScenes: 'all',
	skipCosmeticScenes: true,
	customArt: false,
	enableEdgeNoise: true,
	blockEdgeSpawns: false,
	fixHolyMountainEdgeNoise: true,
	rngInfo: false,
	recolorMaterials: true,
	materialTextures: true,
	engineTerrain: true,
	edgeDecals: true,
	clearSpawnPixels: false,
	visitedCoalmineAltShrine: false,
	excludeTaikasauva: false,
	excludeEdgeCases: false, // Not yet implemented
	biomeOverlayMode: 'normal',
	showEnemies: false,
	enableHamisHints: false,
	gameMode: 'normal',
	noMoreShuffle: false,
	greedCurse: false,
	extraItemsInHolyMountain: 0,
	accessibilityMode: false,
	simplePoiSymbols: false,
	poiScale: 1,
	scalePoisWithZoom: false,
	highlightPoiScale: 1,
	scaleHighlightedPoisWithZoom: true,
	date: null,
	spellFlags: [],
	// Special flags
	sunGem: false,
	darksunGem: false,
	sunState: false,
	darksunState: false,
	// Render debug options (main thread only, but kept here so drawNow() has one source)
	renderLayers: {},
	// Which renderer draws the tile-overlay layer: 'cpu' is the baked overlay
	// canvases (the parity reference), 'gl' is the WebGL2 terrain pass.
	terrainRenderer: 'gl',
	debugLayerTimings: false,
	// Debug: ignore every zoom-based detail cut (mip levels, backdrop/strip
	// gates, material textures, stand-in art) so a frame costs the same at any
	// zoom. Edge decals keep their 1:1 gate: below it the tile count explodes.
	renderEverything: false,
	checkerboardUnpainted: true,
	biomeBoundaryContour: false,
	// Byte budget for the pixel scene ImageBitmap + mip cache, least-recently-drawn first
	pixelSceneBitmapBudgetMB: 256,
	// UI related options are not included here, this is mainly for settings which the web workers will need
}
/** Worker-local state. The host supplies options explicitly; no DOM controls. */
export function updateSettings(values) {
 Object.assign(appSettings, values);
 const d = new Date();
 appSettings.date = values.date ?? {year:d.getFullYear(), month:d.getMonth()+1, day:d.getDate(), hour:d.getHours(), minute:d.getMinutes(), second:d.getSeconds()};
}
