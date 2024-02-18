"use strict";

const CHUNK_SIZE = 512;

let tileSources = [
	"https://regular-hd.acidflow.stream/maps/regular/regular-2024-02-06-78633191.dzi",
	"https://nightmare-hd.acidflow.stream/maps/nightmare/nightmare-2024-02-06-78633191.dzi",
	"https://new-game-plus-hd.acidflow.stream/maps/new-game-plus/new-game-plus-2024-02-06-78633191.dzi",
	"https://regular-main-branch.acidflow.stream/maps/regular-main-branch/regular-main-branch-2024-01-18-78633191.dzi",
	"https://purgatory.acidflow.stream/maps/purgatory/purgatory-2024-01-18-78633191.dzi",
	"https://apotheosis.acidflow.stream/maps/apotheosis/apotheosis-2024-02-12-78633191.dzi",
	"https://apotheosis-new-game-plus.acidflow.stream/maps/apotheosis-new-game-plus/apotheosis-new-game-plus-2024-02-12-78633191.dzi",
	"https://noitavania.acidflow.stream/maps/noitavania/noitavania-2024-02-12-78633191.dzi",
	"https://noitavania-new-game-plus.acidflow.stream/maps/noitavania-new-game-plus/noitavania-new-game-plus-2024-02-12-78633191.dzi",
];

tileSources = tileSources.map(function (tileSource, i) {
	return {
		tileSource: tileSource,
		opacity: i === 0 ? 1 : 0,
		preload: false
	};
});

// Set initial map to regular map
let oldTileSource = 0;

var os = OpenSeadragon({
	// maxZoomPixelRatio: 70,
	// animationTime: 1.2, // default
	id: "os-container",
	prefixUrl: "/vendor/openseadragon-bin-4.1.0/images/",
	showNavigator: false,
	showNavigationControl: false,
	preserveViewport: true,
	imageSmoothingEnabled: false,
	tileSources: tileSources,
	subPixelRoundingForTransparency: OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS,
	smoothTileEdgesMinZoom: 1,
	minScrollDeltaTime: 10,
	springStiffness: 50,
	preserveViewport: true,
	// animationTime: 10,
	defaultZoomLevel: 0,
	maxZoomLevel: 3000,
	// minZoomLevel: 0.05,
	gestureSettingsMouse: { clickToZoom: false },
});

let prevTiledImage;
let nextTiledImage;

function changeMap(tileSource) {

	prevTiledImage = os.world.getItemAt(oldTileSource);
	nextTiledImage = os.world.getItemAt(tileSource);
	prevTiledImage.setOpacity(0)
	nextTiledImage.setOpacity(1);
	oldTileSource = tileSource;

	const updatedUrlParams = new URLSearchParams(window.location.search);
	switch (tileSource) {
		case 0:
			updatedUrlParams.set("map", "regular");
			break;
		case 1:
			updatedUrlParams.set("map", "nightmare");
			break;
		case 2:
			updatedUrlParams.set("map", "new-game-plus");
			break;
		case 3:
			updatedUrlParams.set("map", "regular-main-branch");
			break;
		case 4:
			updatedUrlParams.set("map", "purgatory");
			break;
		case 5:
			updatedUrlParams.set("map", "apotheosis");
			break;
		case 6:
			updatedUrlParams.set("map", "apotheosis-new-game-plus");
			break;
		case 7:
			updatedUrlParams.set("map", "noitavania");
			break;
		case 8:
			updatedUrlParams.set("map", "noitavania-new-game-plus");
			break;
		default: updatedUrlParams.set("map", "regular");
			break;
	};
	window.history.replaceState(null, "", "?" + updatedUrlParams.toString());
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

os.addHandler("open", () => {
	const urlParams = new URLSearchParams(window.location.search);
	if (urlParams.has("map") && urlParams.has("x") && urlParams.has("y") && urlParams.has("zoom")) {
		const currentMapURL = String(urlParams.get("map"));
		const viewportX = Number(urlParams.get("x"));
		const viewportY = Number(urlParams.get("y"));
		const zoom = Math.pow(2, Number(urlParams.get("zoom")) / 100);
		switch (currentMapURL) {
			case "regular": {
				if (!document.getElementById("mapId0").classList.contains("active")) {
					document.getElementById("mapId0").classList.add("active");

					document.getElementById("mapId1").classList.remove("active");
					document.getElementById("mapId2").classList.remove("active");
					document.getElementById("mapId3").classList.remove("active");
					document.getElementById("mapId4").classList.remove("active");
					document.getElementById("mapId5").classList.remove("active");
					document.getElementById("mapId7").classList.remove("active");
					document.getElementById("mapId8").classList.remove("active");

					urlParams.set("map", "regular");
					changeMap(0);

				};
				break;
			}
			case "nightmare": {
				if (!document.getElementById("mapId1").classList.contains("active")) {
					document.getElementById("mapId1").classList.add("active");

					document.getElementById("mapId0").classList.remove("active");
					document.getElementById("mapId2").classList.remove("active");
					document.getElementById("mapId3").classList.remove("active");
					document.getElementById("mapId4").classList.remove("active");
					document.getElementById("mapId5").classList.remove("active");
					document.getElementById("mapId6").classList.remove("active");
					document.getElementById("mapId7").classList.remove("active");
					document.getElementById("mapId8").classList.remove("active");

					urlParams.set("map", "nightmare");
					changeMap(1);
				};
				break;
			}
			case "new-game-plus": {
				if (!document.getElementById("mapId2").classList.contains("active")) {
					document.getElementById("mapId2").classList.add("active");

					document.getElementById("mapId0").classList.remove("active");
					document.getElementById("mapId1").classList.remove("active");
					document.getElementById("mapId3").classList.remove("active");
					document.getElementById("mapId4").classList.remove("active");
					document.getElementById("mapId5").classList.remove("active");
					document.getElementById("mapId6").classList.remove("active");
					document.getElementById("mapId7").classList.remove("active");
					document.getElementById("mapId8").classList.remove("active");

					urlParams.set("map", "new-game-plus");
					changeMap(2);
				};
				break;
			}
			case "regular-main-branch": {
				if (!document.getElementById("mapId3").classList.contains("active")) {
					document.getElementById("mapId3").classList.add("active");

					document.getElementById("mapId0").classList.remove("active");
					document.getElementById("mapId1").classList.remove("active");
					document.getElementById("mapId2").classList.remove("active");
					document.getElementById("mapId4").classList.remove("active");
					document.getElementById("mapId5").classList.remove("active");
					document.getElementById("mapId6").classList.remove("active");
					document.getElementById("mapId7").classList.remove("active");
					document.getElementById("mapId8").classList.remove("active");

					urlParams.set("map", "regular-main-branch");
					changeMap(3);
				};
				break;
			}
			case "purgatory": {
				if (!document.getElementById("mapId4").classList.contains("active")) {
					document.getElementById("mapId4").classList.add("active");

					document.getElementById("mapId0").classList.remove("active");
					document.getElementById("mapId1").classList.remove("active");
					document.getElementById("mapId2").classList.remove("active");
					document.getElementById("mapId3").classList.remove("active");
					document.getElementById("mapId5").classList.remove("active");
					document.getElementById("mapId6").classList.remove("active");
					document.getElementById("mapId7").classList.remove("active");
					document.getElementById("mapId8").classList.remove("active");

					urlParams.set("map", "purgatory");
					changeMap(4);
				};
				break;
			}
			case "apotheosis": {
				if (!document.getElementById("mapId5").classList.contains("active")) {
					document.getElementById("mapId5").classList.add("active");

					document.getElementById("mapId0").classList.remove("active");
					document.getElementById("mapId1").classList.remove("active");
					document.getElementById("mapId2").classList.remove("active");
					document.getElementById("mapId3").classList.remove("active");
					document.getElementById("mapId4").classList.remove("active");
					document.getElementById("mapId6").classList.remove("active");
					document.getElementById("mapId7").classList.remove("active");
					document.getElementById("mapId8").classList.remove("active");

					urlParams.set("map", "apotheosis");
					changeMap(5);
				};
				break;
			}
			case "apotheosis-new-game-plus": {
				if (!document.getElementById("mapId6").classList.contains("active")) {
					document.getElementById("mapId6").classList.add("active");

					document.getElementById("mapId0").classList.remove("active");
					document.getElementById("mapId1").classList.remove("active");
					document.getElementById("mapId2").classList.remove("active");
					document.getElementById("mapId3").classList.remove("active");
					document.getElementById("mapId4").classList.remove("active");
					document.getElementById("mapId5").classList.remove("active");
					document.getElementById("mapId7").classList.remove("active");
					document.getElementById("mapId8").classList.remove("active");

					urlParams.set("map", "apotheosis-new-game-plus");
					changeMap(6);
				};
				break;
			}
			case "noitavania": {
				if (!document.getElementById("mapId7").classList.contains("active")) {
					document.getElementById("mapId7").classList.add("active");

					document.getElementById("mapId0").classList.remove("active");
					document.getElementById("mapId1").classList.remove("active");
					document.getElementById("mapId2").classList.remove("active");
					document.getElementById("mapId3").classList.remove("active");
					document.getElementById("mapId4").classList.remove("active");
					document.getElementById("mapId5").classList.remove("active");
					document.getElementById("mapId6").classList.remove("active");
					document.getElementById("mapId8").classList.remove("active");

					urlParams.set("map", "noitavania");
					changeMap(7);
				};
				break;
			}
			case "noitavania-new-game-plus": {
				if (!document.getElementById("mapId8").classList.contains("active")) {
					document.getElementById("mapId8").classList.add("active");

					document.getElementById("mapId0").classList.remove("active");
					document.getElementById("mapId1").classList.remove("active");
					document.getElementById("mapId2").classList.remove("active");
					document.getElementById("mapId3").classList.remove("active");
					document.getElementById("mapId4").classList.remove("active");
					document.getElementById("mapId5").classList.remove("active");
					document.getElementById("mapId6").classList.remove("active");
					document.getElementById("mapId8").classList.remove("active");

					urlParams.set("map", "noitavania-new-game-plus");
					changeMap(8);
				};
				break;
			}
			default: {
				if (!document.getElementById("mapId0").classList.contains("active")) {
					document.getElementById("mapId0").classList.add("active");

					document.getElementById("mapId1").classList.remove("active");
					document.getElementById("mapId2").classList.remove("active");
					document.getElementById("mapId3").classList.remove("active");
					document.getElementById("mapId4").classList.remove("active");

					urlParams.set("map", "regular");
					changeMap(0);
				};
				break;
			}
		};
		os.viewport.panTo(new OpenSeadragon.Point(viewportX, viewportY), true);
		os.viewport.zoomTo(zoom);
		const mapQs = urlParams.get("map");
		return mapQs;
	}
});

os.addHandler("animation-finish", function (event) {
	const center = event.eventSource.viewport.getCenter();
	const zoom = event.eventSource.viewport.getZoom();
	const urlParams = new URLSearchParams(window.location.search);
	// urlParams.set("map", mapQs);
	urlParams.set("x", center.x.toFixed(10));
	urlParams.set("y", center.y.toFixed(10));
	urlParams.set("zoom", (Math.log2(zoom) * 100).toFixed(0));
	window.history.replaceState(null, "", "?" + urlParams.toString());
});

const alertPlaceholder = document.getElementById('liveAlertPlaceholder')
const appendAlert = (message, type) => {
	const wrapper = document.createElement('div')
	wrapper.innerHTML = [
		`<div class="alert alert-${type} alert-dismissible" role="alert">`,
		`   <div>${message}</div>`,
		'   <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>',
		'</div>'
	].join('')

	alertPlaceholder.append(wrapper)
}

function goHome() {
	os.viewport.goHome();
};

function getShareUrl() {
	// TODO: The URL should be updated here
	window.navigator.clipboard.writeText(window.location.href);
};


const popoverTriggerList = document.querySelectorAll('[data-bs-toggle="popover"]')
const popoverList = [...popoverTriggerList].map(popoverTriggerEl => new bootstrap.Popover(popoverTriggerEl))

// (x: 0.08697259561936987, y: 0.5495140252995913, width: 0.014120588864484205, height: 0.011647328900440127, degrees: 0)

// function fitB() {
// 	const bounds = new OpenSeadragon.Rect(0.08697259561936987, 0.5495140252995913, 0.014120588864484205, 0.011647328900440127, 0);
// 	const bounds2 = new OpenSeadragon.Rect(-0.3728888888888868, 5.440092820663267e-15, 1.7457777777777777, 1.44, 0);
// 	let aT = os.animationTime;
// 	console.log(aT);
// 	console.log("===");
// 	os.viewport.fitBounds(bounds, false);
// };


// const annotations = new OpenSeadragon.Annotations({ viewer });

os.initializeAnnotations();
