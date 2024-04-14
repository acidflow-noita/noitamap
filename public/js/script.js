"use strict";

const spans2 = document.querySelectorAll(".osOverlayHighlight");

const overlayTexts = [
  {
    id: 0,
    text: "Watchtower. Seems to just be a hint to head to the temples in the sky.",
    x: 13758,
    y: -1100,
    width: 650,
    height: 1600,
  },
  {
    id: 1,
    text: "Barren Temple. You can find a potion of mimicium here to start your quest. Later you will need to revisit to help this temple flourish.",
    x: -6000,
    y: -5700,
    width: 1100,
    height: 900,
  },
  {
    id: 2,
    text: "Ominous Temple. A large pool of ominous liquid is needed here. Sea of Mimicium will be helpful.",
    x: 2100,
    y: -5300,
    width: 1300,
    height: 1100,
  },
  {
    id: 3,

    text: 'Henkevä Temple. "Spirited Temple". Potions here require mimicium. Pheromone will aid you. They might also need a little kick.',
    x: -2600,
    y: -5800,
    width: 1600,
    height: 1650,
  },
  { id: 4, text: "Milk", x: 2420, y: -4500, width: 25, height: 25 },
  {
    id: 5,

    text: "Kivi Temple. A boss fight here might be easier with a spell unlocked in another temple",
    x: 6750,
    y: -5241,
    width: 1230,
    height: 1100,
  },
  { id: 6, text: "Beer", x: 7610, y: -4359, width: 25, height: 25 },
];

const CHUNK_SIZE = 512;

const tileSources = (function () {
  const tileSourceURL = (key, position, patchDate, seed) =>
    `https://${key}-${position}.acidflow.stream/maps/${key}-${position}/${key}-${position}-${patchDate}-${seed}.dzi`;

  // TODO: fix dates and positions
  const definitions = [
    {
      key: "noita-main-regular",
      label: "Regular",
      badges: ["Epilogue 2"],
      patchDate: "2024-04-08",
      seed: "78633191",
      tileSets: ["middle", "left", "right"],
    },
    {
      key: "new-game-plus-main-branch",
      label: "NG+",
      badges: ["Epilogue 2"],
      patchDate: "2024-04-08",
      seed: "78633191",
      tileSets: ["middle", "left", "right"],
    },
    {
      key: "nightmare-main-branch",
      label: "Nightmare",
      badges: ["Epilogue 2"],
      patchDate: "2024-04-08",
      seed: "78633191",
      tileSets: ["middle", "left", "right"],
    },
    {
      key: "regular-beta",
      label: "Regular",
      badges: ["β branch"],
      patchDate: "2024-03-25",
      seed: "78633191",
      tileSets: ["middle", "left", "right"],
    },
    {
      key: "purgatory",
      label: "Purgatory",
      badges: ["Mod"],
      patchDate: "2024-01-18",
      seed: "78633191",
      tileSets: ["middle"],
    },
    {
      key: "apotheosis",
      label: "Apotheosis",
      badges: ["Mod"],
      patchDate: "2024-02-12",
      seed: "78633191",
      tileSets: ["middle"],
    },
    {
      key: "apotheosis-new-game-plus",
      label: "Apotheosis NG+",
      badges: ["Mod"],
      patchDate: "2024-02-12",
      seed: "78633191",
      tileSets: ["middle"],
    },
    {
      key: "apotheosis-tuonela",
      label: "Apotheosis Tuonela",
      badges: ["Mod"],
      patchDate: "2024-02-12",
      seed: "78633191",
      tileSets: ["middle"],
    },
    {
      key: "noitavania",
      label: "Noitavania",
      badges: ["Mod"],
      patchDate: "2024-02-12",
      seed: "78633191",
      tileSets: ["middle"],
    },
    {
      key: "noitavania-new-game-plus",
      label: "Noitavania NG+",
      badges: ["Mod"],
      patchDate: "2024-02-12",
      seed: "78633191",
      tileSets: ["middle"],
    },
    {
      key: "alternate-biomes",
      label: "Alternate Biomes",
      badges: ["Mod"],
      patchDate: "2024-02-12",
      seed: "78633191",
      tileSets: ["middle"],
    },
  ];

  const output = {};
  for (const def of definitions) {
    const urls = [];
    for (const position of def.tileSets) {
      urls.push(tileSourceURL(def.key, position, def.patchDate, def.seed));
    }
    output[def.key] = urls;
  }

  return output;
})();

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
  subPixelRoundingForTransparency: OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS,
  smoothTileEdgesMinZoom: 1,
  minScrollDeltaTime: 10,
  springStiffness: 50,
  preserveViewport: true,
  // animationTime: 10,
  gestureSettingsMouse: { clickToZoom: false },
});

let overlaysState = false;
let prevTiledImage;
let nextTiledImage;

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

// setActiveMap('a specific map name')
function setActiveMap(mapName) {
  const currentMapLink = document.querySelector(`#navLinksList [data-map-key=${mapName}]`);
  if (!currentMapLink) return;

  // remove "active" class from any nav links that still have it
  for (const el of document.querySelectorAll("#navLinksList .nav-link.active")) {
    el.classList.remove("active");
  }
  // add "active" class to the nav-link identified by `mapName`
  currentMapLink.classList.add("active");

  // modify the DOM to show the current map name based on the contents of the link
  // to activate that map
  document.getElementById("currentMapName").innerHTML = currentMapLink.innerHTML;

  // update url to refer to the map we just selected
  const updatedUrlParams = new URLSearchParams(window.location.search);
  updatedUrlParams.set("map", mapName);
  window.history.replaceState(null, "", "?" + updatedUrlParams.toString());
}

// loadMap('a specific map name')
function loadMap(mapName) {
  // mapName = 'regular-main-branch', etc.
  const mapTiles = tileSources[mapName] ?? [];
  if (mapTiles.length === 0) return;

  os.world.removeAll();
  for (const url of mapTiles) {
    os.addTiledImage({ tileSource: url });
  }
  os.forceRedraw();
}

const spans = document.querySelectorAll(".osOverlayHighlight span");

os.addHandler("open", (event) => {
  const urlParams = new URLSearchParams(window.location.search);
  const mapName = String(urlParams.get("map") ?? "regular-main-branch");
  setActiveMap(mapName);
  loadMap(mapName);

  const viewport = event.eventSource.viewport;

  // Default/fallback viewport rectangle, which we try to fit first.
  viewport.fitBounds(new OpenSeadragon.Rect(-53760, -31744, 107520, 73728), true);
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

  viewport.panTo(viewportCenter, true);
  viewport.zoomTo(viewportZoom, undefined, true);
});

// Loading indicator
function updateLoadingIndicator(isFullyLoaded, indicator = document.querySelector(".loadingIndicator")) {
  if (isFullyLoaded) {
    indicator.style.display = "none";
  } else {
    indicator.style.display = "block";
  }
}

os.world.addHandler("add-item", function (event) {
  // Track load status for each TiledImage
  event.item.addHandler("fully-loaded-change", function (event) {
    if (event.fullyLoaded) {
      // Hide indicator
      updateLoadingIndicator(true);
      return;
    }
    // Show indicator
    updateLoadingIndicator(false);
  });
});

// Get additional DZI information from every loaded TiledImage.
// This is used to scale and offset images in a way so that the OSD coordinate system aligns with the Noita world coordinate system.
os.world.addHandler("add-item", (event) => {
  /** @type {{Format: string, Overlap: string, Size: {Width: string, Height: string}, TileSize: string, TopLeft: {X: string, Y: string}}} */
  // @ts-ignore
  const image = event.item.source.Image;
  event.item.setPosition(new OpenSeadragon.Point(Number(image.TopLeft.X), Number(image.TopLeft.Y)), true);
  event.item.setWidth(Number(image.Size.Width), true);

  // Append cacheKeys to the images
  // xxx.png?v=UNIX_TIMESTAMP
  // Each Map has their own timestamps
  event.item.source.queryParams = `?v=${encodeURIComponent(tileCacheKeys[new URL(event.item.source.tilesUrl).host])}`;
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
  window.navigator.clipboard.writeText(window.location.href);
}

const popoverTriggerList = document.querySelectorAll('[data-bs-toggle="popover"]');
const popoverList = [...popoverTriggerList].map((popoverTriggerEl) => new bootstrap.Popover(popoverTriggerEl));

// Todo -- toggle doesnt reset after map change?
let allOverlays = document.getElementsByClassName("osOverlayHighlight");
document.querySelector("#overlayVisibilityToggleButton").addEventListener("click", function () {
  const updatedUrlParamsFromOverlaysToggle = new URLSearchParams(window.location.search);
  const currentMapURLFromOverlaysToggle = String(updatedUrlParamsFromOverlaysToggle.get("map"));
  if (overlaysState) {
    Array.from(allOverlays).forEach((overlay) => {
      os.removeOverlay(overlay.id);
    });
    // Todo -- fix this to make overlays work with other maps
  } else if (
    currentMapURLFromOverlaysToggle === "regular-main-branch" ||
    currentMapURLFromOverlaysToggle === "regular-beta"
  ) {
    overlayTexts.forEach(({ id, text, x, y, width, height }) => {
      let e = document.createElement("div");
      e.id = `overlayId${id}`;
      e.className = "osOverlayHighlight";
      e.innerHTML = `<span id="span${id}" >${text}</span>`;
      os.addOverlay({
        element: e,
        location: new OpenSeadragon.Rect(x, y, width, height),
      });
      const hue = Math.floor(Math.random() * 360);
      e.style.backgroundColor = `hsla(${hue}, 60%, 50%, 0.401)`;
    });
  }
  overlaysState = !overlaysState;
});

os.addHandler("animation-finish", function (event) {
  const center = event.eventSource.viewport.getCenter();
  const zoom = event.eventSource.viewport.getZoom();
  const urlParams = new URLSearchParams(window.location.search);
  urlParams.set("x", center.x.toFixed(0));
  urlParams.set("y", center.y.toFixed(0));
  urlParams.set("zoom", (Math.log2(zoom) * -100).toFixed(0));
  window.history.replaceState(null, "", "?" + urlParams.toString());
});

// annotations plugin
// const annotations = new OpenSeadragon.Annotations({ viewer });

// os.initializeAnnotations();

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("navLinksList").addEventListener("click", (ev) => {
    const mapKey = ev.target.dataset["mapKey"];
    if (!mapKey) return;
    ev.stopPropagation();
    ev.preventDefault();
    setActiveMap(mapKey);
    loadMap(mapKey);
  });
});
