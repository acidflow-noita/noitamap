// TODO: Add annotations
// annotations plugin
// const annotations = new OpenSeadragon.Annotations({ viewer });

// os.initializeAnnotations();

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
const mapDefinitions = [
  {
    key: "regular-main-branch",
    label: "Regular",
    badges: [
      {
        label: "Epilogue 2",
        class: "text-bg-success",
      },
    ],
    patchDate: "2024-04-08",
    seed: "78633191",
    tileSets: ["middle", "left", "right"],
  },
  {
    key: "new-game-plus-main-branch",
    label: "NG+",
    badges: [
      {
        label: "Epilogue 2",
        class: "text-bg-success",
      },
    ],
    patchDate: "2024-04-08",
    seed: "78633191",
    tileSets: ["middle", "left", "right"],
  },
  {
    key: "nightmare-main-branch",
    label: "Nightmare",
    badges: [
      {
        label: "Epilogue 2",
        class: "text-bg-success",
      },
    ],
    patchDate: "2024-04-08",
    seed: "78633191",
    tileSets: ["middle", "left", "right"],
  },
  {
    key: "regular-beta",
    label: "Regular",
    badges: [
      {
        label: "β branch",
        class: "text-bg-info",
      },
    ],
    patchDate: "2024-03-25",
    seed: "78633191",
    tileSets: ["middle", "left", "right"],
  },
  {
    key: "purgatory",
    label: "Purgatory",
    badges: [
      {
        label: "Mod",
        class: "text-bg-light",
        icon: "bi bi-tools",
      },
    ],
    patchDate: "2024-01-18",
    seed: "78633191",
    tileSets: ["middle"],
    modUrl: "https://github.com/Priskip/purgatory",
  },
  {
    key: "apotheosis",
    label: "Apotheosis",
    badges: [
      {
        label: "Mod",
        class: "text-bg-light",
        icon: "bi bi-tools",
      },
    ],
    patchDate: "2024-02-12",
    seed: "78633191",
    tileSets: ["middle"],
    modUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=3032128572",
  },
  {
    key: "apotheosis-new-game-plus",
    label: "Apotheosis NG+",
    badges: [
      {
        label: "Mod",
        class: "text-bg-light",
        icon: "bi bi-tools",
      },
    ],
    patchDate: "2024-02-12",
    seed: "78633191",
    tileSets: ["middle"],
    modUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=3032128572",
  },
  {
    key: "apotheosis-tuonela",
    label: "Apotheosis Tuonela",
    badges: [
      {
        label: "Mod",
        class: "text-bg-light",
        icon: "bi bi-tools",
      },
    ],
    patchDate: "2024-02-12",
    seed: "78633191",
    tileSets: ["middle"],
    modUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=3032128572",
  },
  {
    key: "noitavania",
    label: "Noitavania",
    badges: [
      {
        label: "Mod",
        class: "text-bg-light",
        icon: "bi bi-tools",
      },
    ],
    patchDate: "2024-02-12",
    seed: "78633191",
    tileSets: ["middle"],
    modUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=2263080245",
  },
  {
    key: "noitavania-new-game-plus",
    label: "Noitavania NG+",
    badges: [
      {
        label: "Mod",
        class: "text-bg-light",
        icon: "bi bi-tools",
      },
    ],
    patchDate: "2024-02-12",
    seed: "78633191",
    tileSets: ["middle"],
    modUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=2263080245",
  },
  {
    key: "alternate-biomes",
    label: "Alternate Biomes",
    badges: [
      {
        label: "Mod",
        class: "text-bg-light",
        icon: "bi bi-tools",
      },
    ],
    patchDate: "2024-02-12",
    seed: "78633191",
    tileSets: ["middle"],
    modUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=2554761457",
  },
];

const tileSources = (function () {
  const tileSourceURL = (key, position, patchDate, seed) =>
    `https://${key}-${position}.acidflow.stream/maps/${key}-${position}/${key}-${position}-${patchDate}-${seed}.dzi`;

  const output = {};
  for (const def of mapDefinitions) {
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
  // We have to provide OSD with initial set of tiles
  tileSources: tileSources["regular-main-branch"],
  subPixelRoundingForTransparency: OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS,
  smoothTileEdgesMinZoom: 1,
  minScrollDeltaTime: 10,
  springStiffness: 50,
  preserveViewport: true,
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

const mapVersionUrls = (mapName) => {
  const fileName = "currentVersion.txt";
  const versions = tileSources[mapName].map((sourceURL) => `${new URL(sourceURL).origin}/${fileName}`);

  return versions;
};

/**
 * Fetches map versions for a given map name.
 * @param {string} mapName - The name of the map to fetch versions for.
 * @returns {Promise<Object>} A promise that resolves to an object containing versions for different origins.
 */
function fetchMapVersions(mapName) {
  // we don't want to fetch a cached version of the manifest!
  const versions = {};
  const urls = mapVersionUrls(mapName);
  const promises = urls.map((url) =>
    fetch(url, {
      // Commented out because it's causing CORS issues
      //headers: { 'cache-control': 'no-cache' }
    })
      .then((res) => {
        // gotta check the response, otherwise the body content doesn't represent what you think it does
        if (!res.ok) {
          throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
        }

        return res.text();
      })
      .catch((err) => {
        console.error(err);
        // create a synthetic cache bust string if anything errored
        return Math.random().toString(36).slice(2);
      })
      .then((body) => {
        const origin = new URL(url).origin;
        versions[origin] = encodeURIComponent(body.trim());
      })
  );
  // wait for all requests to have set their key, then return the object
  return Promise.all(promises).then(() => versions);
}

const changeMap = (() => {
  let cacheBustHandler = undefined;

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

    // Quick hack to fix toggle overlays button
    switch (mapName) {
      case "regular-main-branch":
      case "regular-beta":
        document.body.classList.remove("toggle-hidden");
        break;
      default:
        document.body.classList.add("toggle-hidden");
    }

    // update url to refer to the map we just selected
    const updatedUrlParams = new URLSearchParams(window.location.search);
    updatedUrlParams.set("map", mapName);
    window.history.replaceState(null, "", "?" + updatedUrlParams.toString());
    addTooltips();
  }

  // loadMap('a specific map name')
  async function loadMap(mapName) {
    // mapName = 'regular-main-branch', etc.
    const mapTiles = tileSources[mapName] ?? [];

    // do nothing for invalid mapName
    if (mapTiles.length === 0) {
      console.error("Invalid mapname = %s", mapName);
      return;
    }

    const versions = await fetchMapVersions(mapName);
    // when we change maps, remove the old handler so it doesn't interfere...
    if (cacheBustHandler) {
      os.world.removeHandler("add-item", cacheBustHandler);
      cacheBustHandler = undefined;
    }

    // create the new handler
    cacheBustHandler = (event) => {
      // Append cacheKeys to the images
      // xxx.png?v=UNIX_TIMESTAMP
      // Each Map has their own timestamps
      event.item.source.queryParams = `?v=${versions[new URL(event.item.source.tilesUrl).origin]}`;
      console.log(event.item.source.queryParams);
    };
    os.world.addHandler("add-item", cacheBustHandler);

    // clear the map...
    os.world.removeAll();

    // ... add the new tiles ...
    for (const url of mapTiles) {
      // assumes "url" from tileSource urls does not already include a query string parameter
      os.addTiledImage({ tileSource: url });
    }

    // ... and redraw the map
    os.forceRedraw();
  }

  return async (mapName) => {
    await loadMap(mapName);
    setActiveMap(mapName);
  };
})();

const spans = document.querySelectorAll(".osOverlayHighlight span");

os.addHandler("open", async (event) => {
  const viewport = event.eventSource.viewport;
  const urlParams = new URLSearchParams(window.location.search);
  const mapName = String(urlParams.get("map") ?? "regular-main-branch");
  changeMap(mapName);

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

// Reset zoom level upon click on the logo
function goHome() {
  os.viewport.goHome();
}

// Copy URL to the clipboard for sharing
function getShareUrl() {
  window.navigator.clipboard.writeText(window.location.href);
}

const popoverTriggerList = document.querySelectorAll('[data-bs-toggle="popover"]');
const popoverList = [...popoverTriggerList].map((popoverTriggerEl) => new bootstrap.Popover(popoverTriggerEl));

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

document.addEventListener("DOMContentLoaded", () => {
  const navLinksUl = document.getElementById("navLinksList");
  if (!navLinksUl) return;

  const formatDate = (d) => new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(new Date(d));
  // TODO: fix dates and positions
  //const formatDate = (function () {
  //new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(new Date(date));
  // })();

  for (const def of mapDefinitions) {
    const a = document.createElement("a");
    a.classList.add("nav-link", "text-nowrap");
    a.href = "#";
    a.dataset["bsToggle"] = "pill";
    a.dataset["mapKey"] = def.key;
    a.textContent = def.label + " ";

    const badges = def.badges.slice();
    badges.push({ label: formatDate(def.patchDate), class: "border border-info-subtle ms-2".split(" ") });

    for (const badge of badges) {
      const span = document.createElement("span");
      span.classList.add("badge");

      if (typeof badge.class === "string") {
        span.classList.add(badge.class);
      } else {
        badge.class.forEach((styleClass) => span.classList.add(styleClass));
      }

      // Add explanatory tooltips to patchdate badges only
      if (span.classList.contains("border-info-subtle")) {
        span.dataset["bsToggle"] = "tooltip";
        span.dataset["bsPlacement"] = "top";
        span.dataset["bsTitle"] = "Patch date this map was captured";
      }

      if (badge.icon) {
        const icon = document.createElement("i");
        badge.icon.split(" ").forEach((styleClass) => icon.classList.add(styleClass));
        span.appendChild(icon);
      }

      const text = document.createTextNode(` ${badge.label}`);
      span.appendChild(text);
      a.appendChild(span);
    }

    navLinksUl.appendChild(a);
    addTooltips();
  }
  document.getElementById("navLinksList").addEventListener("click", async (ev) => {
    const mapKey = ev.target.dataset["mapKey"];
    if (!mapKey) return;
    ev.stopPropagation();
    ev.preventDefault();
    changeMap(mapKey);
  });
});

function addTooltips() {
  const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
  const tooltipList = [...tooltipTriggerList].map((tooltipTriggerEl) => new bootstrap.Tooltip(tooltipTriggerEl));
}
