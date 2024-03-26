"use strict";

const CHUNK_SIZE = 512;

let tileSources = [
  [
    "https://regular-middle.acidflow.stream/maps/regular-middle/regular-middle-2024-03-25-78633191.dzi",
    "https://regular-left-pw.acidflow.stream/maps/regular-left-pw/regular-left-pw-2024-03-25-78633191.dzi",
    "https://regular-right-pw.acidflow.stream/maps/regular-right-pw/regular-right-pw-2024-03-25-78633191.dzi",
  ],
  [
    "https://nightmare-hd.acidflow.stream/maps/nightmare/nightmare-2024-02-06-78633191.dzi",
    "",
    "",
  ],
  [
    "https://new-game-plus-hd.acidflow.stream/maps/new-game-plus/new-game-plus-2024-02-06-78633191.dzi",
    "",
    "",
  ],
  [
    "https://regular-main-branch.acidflow.stream/maps/regular-main-branch/regular-main-branch-2024-01-18-78633191.dzi",
    "",
    "",
  ],
  [
    "https://purgatory.acidflow.stream/maps/purgatory/purgatory-2024-01-18-78633191.dzi",
    "",
    "",
  ],
  [
    "https://apotheosis.acidflow.stream/maps/apotheosis/apotheosis-2024-02-12-78633191.dzi",
    "",
    "",
  ],
  [
    "https://apotheosis-new-game-plus.acidflow.stream/maps/apotheosis-new-game-plus/apotheosis-new-game-plus-2024-02-12-78633191.dzi",
    "",
    "",
  ],
  [
    "https://noitavania.acidflow.stream/maps/noitavania/noitavania-2024-02-12-78633191.dzi",
    "",
    "",
  ],
  [
    "https://noitavania-new-game-plus.acidflow.stream/maps/noitavania-new-game-plus/noitavania-new-game-plus-2024-02-12-78633191.dzi",
    "",
    "",
  ],
  [
    "https://alternate-biomes.acidflow.stream/maps/alternate-biomes/alternate-biomes-2024-02-12-78633191.dzi",
    "",
    "",
  ],
  [
    "https://apotheosis-tuonela.acidflow.stream/maps/apotheosis-tuonela/apotheosis-tuonela-2024-02-12-78633191.dzi",
    "",
    "",
  ],
];

// Set initial map to regular map
let oldTileSource = 0;

var os = OpenSeadragon({
  maxZoomPixelRatio: 70,
  // animationTime: 1.2, // default
  id: "osContainer",
  prefixUrl: "/vendor/openseadragon-bin-4.1.0/images/",
  showNavigator: false,
  showNavigationControl: false,
  imageSmoothingEnabled: false,
  tileSources: tileSources[0],
  //   tileSources: tileSources,
  subPixelRoundingForTransparency:
    OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS,
  smoothTileEdgesMinZoom: 1,
  minScrollDeltaTime: 10,
  springStiffness: 50,
  preserveViewport: true,
  // animationTime: 10,
  gestureSettingsMouse: { clickToZoom: false },
});

let prevTiledImage;
let nextTiledImage;

function changeMap(tileSource) {
  const updatedUrlParams = new URLSearchParams(window.location.search);
  switch (tileSource) {
    case 0:
      updatedUrlParams.set("map", "regular");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[0][0] });
      os.addTiledImage({ tileSource: tileSources[0][1] });
      os.addTiledImage({ tileSource: tileSources[0][2] });
      os.forceRedraw();
      break;
    case 1:
      updatedUrlParams.set("map", "nightmare");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[1][0] });
      //   os.addTiledImage({ tileSource: tileSources[1][1] });
      //   os.addTiledImage({ tileSource: tileSources[1][2] });
      os.forceRedraw();
      break;
    case 2:
      updatedUrlParams.set("map", "new-game-plus");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[2][0] });
      //   os.addTiledImage({ tileSource: tileSources[2][1] });
      //   os.addTiledImage({ tileSource: tileSources[2][2] });
      os.forceRedraw();
      break;
    case 3:
      updatedUrlParams.set("map", "regular-main-branch");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[3][0] });
      //   os.addTiledImage({ tileSource: tileSources[3][1] });
      //   os.addTiledImage({ tileSource: tileSources[3][2] });
      os.forceRedraw();
      break;
    case 4:
      updatedUrlParams.set("map", "purgatory");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[4][0] });
      //   os.addTiledImage({ tileSource: tileSources[4][1] });
      //   os.addTiledImage({ tileSource: tileSources[4][2] });
      os.forceRedraw();
      break;
    case 5:
      updatedUrlParams.set("map", "apotheosis");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[5][0] });
      //   os.addTiledImage({ tileSource: tileSources[5][1] });
      //   os.addTiledImage({ tileSource: tileSources[5][2] });
      os.forceRedraw();
      break;
    case 6:
      updatedUrlParams.set("map", "apotheosis-new-game-plus");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[6][0] });
      //   os.addTiledImage({ tileSource: tileSources[6][1] });
      //   os.addTiledImage({ tileSource: tileSources[6][2] });
      os.forceRedraw();
      break;
    case 7:
      updatedUrlParams.set("map", "noitavania");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[7][0] });
      //   os.addTiledImage({ tileSource: tileSources[7][1] });
      //   os.addTiledImage({ tileSource: tileSources[7][2] });
      os.forceRedraw();
      break;
    case 8:
      updatedUrlParams.set("map", "noitavania-new-game-plus");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[8][0] });
      //   os.addTiledImage({ tileSource: tileSources[8][1] });
      //   os.addTiledImage({ tileSource: tileSources[8][2] });
      os.forceRedraw();
      break;
    case 9:
      updatedUrlParams.set("map", "alternate-biomes");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[9][0] });
      //   os.addTiledImage({ tileSource: tileSources[9][1] });
      //   os.addTiledImage({ tileSource: tileSources[9][2] });
      os.forceRedraw();
      break;
    case 10:
      updatedUrlParams.set("map", "apotheosis-tuonela");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[10][0] });
      //   os.addTiledImage({ tileSource: tileSources[10][1] });
      //   os.addTiledImage({ tileSource: tileSources[10][2] });
      os.forceRedraw();
      break;
    default:
      updatedUrlParams.set("map", "regular");
      os.world.removeAll();
      os.addTiledImage({ tileSource: tileSources[0][0] });
      os.addTiledImage({ tileSource: tileSources[0][1] });
      os.addTiledImage({ tileSource: tileSources[0][2] });
      os.forceRedraw();
      break;
  }
  window.history.replaceState(null, "", "?" + updatedUrlParams.toString());
}

const coordElement = document.getElementById("coordinate");
const mouseTracker = new OpenSeadragon.MouseTracker({
  // @ts-ignore
  element: os.container,
  moveHandler: (event) => {
    if (event.pointerType != "mouse") {
      return;
    }
    const webPoint = event.position;
    const viewportPoint = os.viewport.pointFromPixel(webPoint);

    const pixelX = Math.floor(viewportPoint.x).toString();
    const pixelY = Math.floor(viewportPoint.y).toString();
    //const chunkX = Math.floor(viewportPoint.x / CHUNK_SIZE).toString();
    //const chunkY = Math.floor(viewportPoint.y / CHUNK_SIZE).toString();

    coordElement.children[0].textContent = `(${pixelX}, ${pixelY})`;
    coordElement.style.left = `${event.originalEvent.pageX}px`;
    coordElement.style.top = `${event.originalEvent.pageY}px`;
  },
  enterHandler: (event) => {
    if (event.pointerType != "mouse") {
      return;
    }
    coordElement.style.visibility = "visible";
  },
  leaveHandler: (event) => {
    if (event.pointerType != "mouse") {
      return;
    }
    coordElement.style.visibility = "hidden";
  },
}).setTracking(true);

os.addHandler("open", () => {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has("map")) {
    const currentMapURL = String(urlParams.get("map"));
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
          document.getElementById("mapId9").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "regular");
          changeMap(0);
        }
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
          document.getElementById("mapId9").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "nightmare");
          changeMap(1);
        }
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
          document.getElementById("mapId9").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "new-game-plus");
          changeMap(2);
        }
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
          document.getElementById("mapId9").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "regular-main-branch");
          changeMap(3);
        }
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
          document.getElementById("mapId9").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "purgatory");
          changeMap(4);
        }
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
          document.getElementById("mapId9").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "apotheosis");
          changeMap(5);
        }
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
          document.getElementById("mapId9").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "apotheosis-new-game-plus");
          changeMap(6);
        }
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
          document.getElementById("mapId9").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "noitavania");
          changeMap(7);
        }
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
          document.getElementById("mapId9").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "noitavania-new-game-plus");
          changeMap(8);
        }
        break;
      }
      case "alternate-biomes": {
        if (!document.getElementById("mapId9").classList.contains("active")) {
          document.getElementById("mapId9").classList.add("active");

          document.getElementById("mapId0").classList.remove("active");
          document.getElementById("mapId1").classList.remove("active");
          document.getElementById("mapId2").classList.remove("active");
          document.getElementById("mapId3").classList.remove("active");
          document.getElementById("mapId4").classList.remove("active");
          document.getElementById("mapId5").classList.remove("active");
          document.getElementById("mapId6").classList.remove("active");
          document.getElementById("mapId7").classList.remove("active");
          document.getElementById("mapId8").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "alternate-biomes");
          changeMap(9);
        }
        break;
      }
      case "apotheosis-tuonela": {
        if (!document.getElementById("mapId10").classList.contains("active")) {
          document.getElementById("mapId10").classList.add("active");

          document.getElementById("mapId0").classList.remove("active");
          document.getElementById("mapId1").classList.remove("active");
          document.getElementById("mapId2").classList.remove("active");
          document.getElementById("mapId3").classList.remove("active");
          document.getElementById("mapId4").classList.remove("active");
          document.getElementById("mapId5").classList.remove("active");
          document.getElementById("mapId6").classList.remove("active");
          document.getElementById("mapId7").classList.remove("active");
          document.getElementById("mapId8").classList.remove("active");
          document.getElementById("mapId9").classList.remove("active");

          urlParams.set("map", "apotheosis-tuonela");
          changeMap(10);
        }
        break;
      }
      default: {
        if (!document.getElementById("mapId0").classList.contains("active")) {
          document.getElementById("mapId0").classList.add("active");
          document.getElementById("mapId1").classList.remove("active");
          document.getElementById("mapId2").classList.remove("active");
          document.getElementById("mapId3").classList.remove("active");
          document.getElementById("mapId4").classList.remove("active");
          document.getElementById("mapId5").classList.remove("active");
          document.getElementById("mapId6").classList.remove("active");
          document.getElementById("mapId7").classList.remove("active");
          document.getElementById("mapId8").classList.remove("active");
          document.getElementById("mapId9").classList.remove("active");
          document.getElementById("mapId10").classList.remove("active");

          urlParams.set("map", "regular");
          changeMap(0);
        }
        break;
      }
    }
    const mapQs = urlParams.get("map");
    return mapQs;
  }
  if (!urlParams.has("map")) {
    urlParams.set("map", "regular");
    changeMap(0);
  }
});

// Store/load viewport position and zoom level in/from URL parameters.
os.addHandler("open", (event) => {
  const viewport = event.eventSource.viewport;
  const urlParams = new URLSearchParams(window.location.search);
  // Default/fallback viewport rectangle, which we try to fit first.
  viewport.fitBounds(
    new OpenSeadragon.Rect(-53760, -31744, 107520, 73728),
    true
  );
  const viewportCenter = viewport.getCenter();
  let viewportZoom = viewport.getZoom();
  // Get offset/zoom parameters from the URL, and overwrite the default/fallback.
  if (urlParams.has("x")) {
    viewportCenter.x = Number(urlParams.get("x"));
  }
  if (urlParams.has("y")) {
    viewportCenter.y = Number(urlParams.get("y"));
  }
  if (urlParams.has("zoom")) {
    viewportZoom = Math.pow(2, Number(urlParams.get("zoom")) / -100);
  }
  console.log(viewportCenter, viewportZoom);
  viewport.panTo(viewportCenter, true);
  viewport.zoomTo(viewportZoom, undefined, true);
});
os.addHandler("animation-finish", function (event) {
  const center = event.eventSource.viewport.getCenter();
  const zoom = event.eventSource.viewport.getZoom();
  const urlParams = new URLSearchParams(window.location.search);
  // urlParams.set("map", mapQs);
  urlParams.set("x", center.x.toFixed(0));
  urlParams.set("y", center.y.toFixed(0));
  urlParams.set("zoom", (Math.log2(zoom) * -100).toFixed(0));
  window.history.replaceState(null, "", "?" + urlParams.toString());
});

// Get additional DZI information from every loaded TiledImage.
// This is used to scale and offset images in a way so that the OSD coordinate system aligns with the Noita world coordinate system.
os.world.addHandler("add-item", (event) => {
  /** @type {{Format: string, Overlap: string, Size: {Width: string, Height: string}, TileSize: string, TopLeft: {X: string, Y: string}}} */
  // @ts-ignore
  const image = event.item.source.Image;
  event.item.setPosition(
    new OpenSeadragon.Point(Number(image.TopLeft.X), Number(image.TopLeft.Y)),
    true
  );
  event.item.setWidth(Number(image.Size.Width), true);
});

const alertPlaceholder = document.getElementById("liveAlertPlaceholder");
const appendAlert = (message, type) => {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = [
    `<div class="alert alert-${type} alert-dismissible" role="alert">`,
    `   <div>${message}</div>`,
    '   <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>',
    "</div>",
  ].join("");

  alertPlaceholder.append(wrapper);
};

function goHome() {
  os.viewport.goHome();
}

function getShareUrl() {
  // TODO: The URL should be updated here
  window.navigator.clipboard.writeText(window.location.href);
}

const popoverTriggerList = document.querySelectorAll(
  '[data-bs-toggle="popover"]'
);
const popoverList = [...popoverTriggerList].map(
  (popoverTriggerEl) => new bootstrap.Popover(popoverTriggerEl)
);

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

// os.initializeAnnotations();
