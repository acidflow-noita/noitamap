"use strict";

const CHUNK_SIZE = 512;

let tileSources = [
	"https://noitamap-regular-hd.acidflow.stream/maps/regular/regular-2024-02-06-78633191.dzi",
	"https://noitamap-nightmare-hd.acidflow.stream/maps/nightmare/nightmare-2024-02-06-78633191.dzi",
	"https://noitamap-new-game-plus-hd.acidflow.stream/maps/new-game-plus/new-game-plus-2024-02-06-78633191.dzi"
];

tileSources = tileSources.map(function (tileSource, i) {
	return {
		tileSource: tileSource,
		opacity: i === 0 ? 1 : 0,
		preload: i >= 1 ? true : false
	};
});

// Set initial map to regular map
let oldTileSource = 0;

var os = OpenSeadragon({
	id: "os-container",
	prefixUrl: "https://cdn.jsdelivr.net/npm/openseadragon@4.1/build/openseadragon/images/",
	//minZoomLevel: 0,
	//maxZoomLevel: 100,
	maxZoomPixelRatio: 20,
	defaultZoomLevel: 0,
	showNavigator: false,
	// navigatorPosition: "TOP_RIGHT",
	navigatorDisplayRegionColor: "#FF0000",
	// sequenceMode: true,
	preserveViewport: true,
	navigatorHeight: 285,
	navigatorWidth: 200,
	imageSmoothingEnabled: false,
	tileSources: tileSources,
	subPixelRoundingForTransparency: OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS,
	smoothTileEdgesMinZoom: 1,
	minScrollDeltaTime: 10,
	springStiffness: 50,

	/*overlays: [{
		className: "overlay-highlight",
		x: 0.33,
		y: 0.75,
		width: 0.2,
		height: 0.25
	}]*/
});

// Disable click to zoom
this.os.gestureSettingsMouse.clickToZoom = false;

let prevTiledImage
let nextTiledImage

function changeMap(tileSource) {

	prevTiledImage = os.world.getItemAt(oldTileSource);
	nextTiledImage = os.world.getItemAt(tileSource);
	prevTiledImage.setOpacity(0)
	nextTiledImage.setOpacity(1);
	oldTileSource = tileSource;

	switch (tileSource) {
		case 0: {
			document.getElementById("currentMap").innerHTML = "Noitamap — Regular Map (beta branch)";
			break;
		}
		case 1: {
			document.getElementById("currentMap").innerHTML = "Noitamap — Nightmare Map (beta branch)";
			break;
		}
		case 2: {
			document.getElementById("currentMap").innerHTML = "Noitamap — New Game+ Map (beta branch)";
			break;
		}
		default: {
			document.getElementById("currentMap").innerHTML = "Noitamap (beta branch)";
			break;
		}
	}
};

let coordText = "";

os.addHandler('open', function () {
	const tracker = new OpenSeadragon.MouseTracker({
		element: os.container,
		moveHandler: function (event) {
			const webPoint = event.position;
			const viewportPoint = os.viewport.pointFromPixel(webPoint);

			const tiledImage = os.world.getItemAt(oldTileSource);
			const imageSize = tiledImage.getContentSize();
			const worldMiddle = new OpenSeadragon.Point(
				imageSize.x / 2,
				imageSize.y / 2 - 10 * CHUNK_SIZE,
			);

			const imagePoint = tiledImage.viewportToImageCoordinates(viewportPoint);;
			const worldPos = imagePoint.minus(worldMiddle);

			const coordElement = document.getElementById("coordinate");
			coordElement.style.left = `${event.originalEvent.pageX}px`;
			coordElement.style.top = `${event.originalEvent.pageY}px`;

			coordText = `${Math.floor(worldPos.x)}, ${Math.floor(worldPos.y)}`;
			coordElement.children[0].textContent = `(${coordText})`;
		}
	});

	tracker.setTracking(true);
});


// If the user hits ctrl+c with nothing selected, we put the cursor coordinate
// into the user's clipboard.
window.addEventListener('keydown', function (e) {
	if (e.key !== 'c' || !e.ctrlKey)
		return;

	const selection = window.getSelection();
	if (selection.type === "Range")
		return;

	navigator.clipboard.writeText(coordText);
	e.preventDefault();
});
