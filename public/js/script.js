"use strict";

// Reference elements for the new toggles
const structuresOverlaysSwitch = document.querySelector("#structuresToggler");
const orbsOverlaysSwitch = document.querySelector("#orbsToggler");
const bossesOverlaysSwitch = document.querySelector("#bossesToggler");
const itemsOverlaysSwitch = document.querySelector("#itemsToggler");
const allOverlaysSwitches = document.querySelectorAll(".overlayToggler");

const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");

searchInput.parentNode.onsubmit = () => false; // Do nothing when user hits return while searching for map POI

// Initialize toggle states
structuresOverlaysSwitch.checked = false;
orbsOverlaysSwitch.checked = false;
bossesOverlaysSwitch.checked = false;
itemsOverlaysSwitch.checked = false;

// Overlay states
let structuresOverlayState = false;
let orbsOverlaysState = false;
let bossesOverlaysState = false;
let itemsOverlaysState = false;

const CHUNK_SIZE = 512;

const overlayTexts = {
  structures: [
    {
      id: 0,
      text: ["Watchtower. Seems to just be a hint to head to the temples in the sky."],
      x: 13758,
      y: -1100,
      width: 650,
      height: 1600,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
    },
    {
      id: 1,
      text: [
        "Barren Temple. You can find a potion of mimicium here to start your quest. Later you will need to revisit to help this temple flourish.",
      ],
      x: -6000,
      y: -5700,
      width: 1100,
      height: 900,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
    },
    {
      id: 2,
      text: [
        "Henkevä Temple. 'Spirited Temple'. Potions here require mimicium. Pheromone will aid you. They might also need a little kick.",
      ],
      x: -2600,
      y: -5800,
      width: 1600,
      height: 1650,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
    },
    {
      id: 3,
      text: ["Ominous Temple. A large pool of ominous liquid is needed here. Sea of Mimicium will be helpful."],
      x: 2100,
      y: -5300,
      width: 1300,
      height: 1100,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
    },
    {
      id: 4,
      text: ["Kivi Temple. A boss fight here might be easier with a spell unlocked in another temple"],
      x: 6750,
      y: -5241,
      width: 1230,
      height: 1100,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
    },
  ],
  items: [
    {
      id: 5,
      text: ["Milk"],
      x: 512 * 4.2,
      y: 512 * -9.3,
      width: 512,
      height: 512,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
    },
    {
      id: 6,
      text: ["Beer"],
      x: 512 * 14.4,
      y: 512 * -9,
      width: 512,
      height: 512,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
    },
  ],
  orbAreas: [
    {
      id: 7,
      text: ["Spawn area for Sandcaves orb: Necromancy. Main/East/West ID: 4, 260, 132"],
      x: 512 * 17,
      y: 512 * 3,
      width: 512 * 6,
      height: 512 * 4,
      maps: ["new-game-plus-main-branch"],
    },
    {
      id: 8,
      text: ["Spawn area for Holy Bomb orb. Main/East/West ID: 5, 261, 133"],
      x: 512 * 8,
      y: 512 * 7,
      width: 512 * 10,
      height: 512 * 12,
      maps: ["new-game-plus-main-branch"],
    },
    {
      id: 9,
      text: ["Spawn area for Nuke orb. Main/East/West ID: 3, 259, 131"],
      x: 512 * 26,
      y: 512 * 20,
      width: 512 * 6,
      height: 512 * 6,
      maps: ["new-game-plus-main-branch"],
    },
    {
      id: 10,
      text: ["Spawn area for Wizards' den orb: Cement. Main/East/West ID: 10, 266, 138"],
      x: 512 * 19,
      y: 512 * 27,
      width: 512 * 5,
      height: 512 * 6,
      maps: ["new-game-plus-main-branch"],
    },
    {
      id: 11,
      text: ["Spawn area for Hell orb: Fireworks! Main/East/West ID: 8, 264, 136"],
      x: 512 * -5,
      y: 512 * 30,
      width: 512 * 10,
      height: 512 * 4,
      maps: ["new-game-plus-main-branch"],
    },
    {
      id: 12,
      text: ["Spawn area for Snow chasm orb: Deercoy. Main/East/West ID: 9, 265, 137"],
      x: 512 * -20,
      y: 512 * 26,
      width: 512 * 7,
      height: 512 * 4,
      maps: ["new-game-plus-main-branch"],
    },
    {
      id: 13,
      text: ["Spawn area for Frozen Vault orb: Tentacle. Main/East/West ID: 2, 258, 130"],
      x: 512 * -22,
      y: 512 * 4,
      width: 512 * 6,
      height: 512 * 3,
      maps: ["new-game-plus-main-branch"],
    },
    {
      id: 14,
      text: ["Spawn area for Lake orb: Thundercloud. Main/East/West ID: 7, 263, 135"],
      x: 512 * -32,
      y: 512 * 10,
      width: 512 * 9,
      height: 512 * 10,
      maps: ["new-game-plus-main-branch"],
    },
    {
      id: 15,
      text: ["Spawn area for Spiral Shot orb. Main/East/West ID: 6, 262, 134"],
      x: 512 * -15,
      y: 512 * 7,
      width: 512 * 8,
      height: 512 * 9,
      maps: ["new-game-plus-main-branch"],
    },
  ],
  bosses: [
    {
      id: 16,
      text: ["Pyramid Boss", "Kolmisilmän Koipi", "Three-Eye's Legs"],
      x: 512 * 19,
      y: 512 * -2,
      width: 512 * 1,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=9984&y=-786&zoom=823",
    },
    {
      id: 17,
      text: ["Leviathan", "Syväolento", "Creature of the Deep"],
      x: 512 * -28,
      y: 512 * 19,
      width: 512 * 1.3,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=-14024&y=9994&zoom=987",
    },
    {
      id: 18,
      text: ["Door boss", "Veska", "Molari", "Mokke", "Seula", "Gate Guardian", "Triangle boss"],
      x: 512 * 5,
      y: 512 * 22,
      width: 512 * 1,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=2837&y=11562&zoom=812",
    },
    {
      id: 19,
      text: ["Dragon", "Suomuhauki", "Scale Pike"],
      x: 512 * 4,
      y: 512 * 14,
      width: 512 * 1,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=2347&y=7444&zoom=917",
    },
    {
      id: 20,
      text: ["Tiny", "Limatoukka", "Slime Maggot", "Slime Caterpillar"],
      x: 512 * 28,
      y: 512 * 32,
      width: 512 * 2,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=14904&y=16428&zoom=1022",
    },
    {
      id: 21,
      text: ["Meat Boss", "Kolmisilmän sydän", "Three-Eye's Heart"],
      x: 512 * 13,
      y: 512 * 16,
      width: 512 * 1,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=6667&y=8448&zoom=770",
    },
    {
      id: 22,
      text: ["Alchemist Boss", "Ylialkemisti", "High Alchemist"],
      x: 512 * -10,
      y: 512 * 1,
      width: 512 * 1,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=-4840&y=851&zoom=796",
    },
    {
      id: 23,
      text: ["Kolmi", "Kolmisilmä", "Three-Eye"],
      x: 512 * 6,
      y: 512 * 25,
      width: 512 * 1.9,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=3556&y=13026&zoom=849",
    },
    {
      id: 24,
      text: ["Mecha Kolmi", "Kolmisilmän silmä", "Three-Eye's Eye"],
      x: 512 * 27,
      y: 512 * 21,
      width: 512 * 1,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=13987&y=11123&zoom=875",
    },
    {
      id: 25,
      text: ["Friend Boss", "Toveri", "Friend"],
      x: 512 * 49,
      y: 512 * 8,
      width: 512 * 1,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=25360&y=4341&zoom=917",
    },
    {
      id: 26,
      text: ["The Master of Masters", "Mestarien mestari", "Grand Master", "Wizard Boss"],
      x: 512 * 24,
      y: 512 * 29,
      width: 512 * 1,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=12573&y=15178&zoom=796",
    },
    {
      id: 27,
      text: ["The Forgotten", "Unohdettu", "Ghost Boss"],
      x: 512 * -23,
      y: 512 * 25,
      width: 512 * 1,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=-11515&y=13123&zoom=744",
    },
    {
      id: 28,
      text: ["Bridge Boss", "Sauvojen tuntija", "Connoisseur of Wands", "Squid Boss", "Pit Boss", "Wand Boss"],
      x: 512 * 7,
      y: 512 * 1,
      width: 512 * 2,
      height: 512 * 2,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=4165&y=889&zoom=970",
    },
    {
      id: 29,
      text: ["Deer Boss", "Tapion vasalli", "Tapio's Vassal", "Island Boss"],
      x: 512 * -27,
      y: 512 * 0,
      width: 512 * 1,
      height: 512 * 1,
      maps: ["regular-main-branch", "regular-beta", "new-game-plus-main-branch"],
      type: "boss",
      url: "https://map.runfast.stream/?map=regular&x=-13670&y=134&zoom=796",
    },
  ],
};

const mapDefinitions = [
  {
    key: "regular-main-branch",
    label: "Regular",
    badges: [
      {
        label: "Latest",
        class: "text-bg-success",
      },
    ],
    patchDate: "2024-08-12",
    seed: "78633191",
    tileSets: ["middle", "left", "right"],
  },
  {
    key: "new-game-plus-main-branch",
    label: "NG+",
    badges: [
      {
        label: "Latest",
        class: "text-bg-success",
      },
    ],
    patchDate: "2024-08-12",
    seed: "78633191",
    tileSets: ["middle", "left", "right"],
  },
  {
    key: "nightmare-main-branch",
    label: "Nightmare",
    badges: [
      {
        label: "Latest",
        class: "text-bg-success",
      },
    ],
    patchDate: "2024-08-12",
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
    patchDate: "2024-08-12",
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
    patchDate: "2024-08-12",
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
    patchDate: "2024-08-12",
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
    patchDate: "2024-08-12",
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
    patchDate: "2024-08-12",
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
    patchDate: "2024-08-12",
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
    patchDate: "2024-08-12",
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
    patchDate: "2024-08-12",
    seed: "78633191",
    tileSets: ["middle"],
    modUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=2554761457",
  },
  {
    key: "biomemap-main-branch",
    label: "Biome Map",
    badges: [
      {
        label: "Special",
        class: "text-bg-primary",
        icon: "bi bi-gear-wide-connected",
      },
    ],
    patchDate: "2024-08-12",
    seed: "78633191",
    tileSets: ["middle"],
  },
  {
    key: "biomemaprendered-main-branch",
    label: "Biome Map Captured",
    badges: [
      {
        label: "Special",
        class: "text-bg-primary",
        icon: "bi bi-gear-wide-connected",
      },
    ],
    patchDate: "2024-08-12",
    seed: "78633191",
    tileSets: ["middle"],
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

// Initialize OpenSeadragon
var os = OpenSeadragon({
  maxZoomPixelRatio: 70,
  // animationTime: 1.2, // Uncomment if needed
  id: "osContainer",
  showNavigator: false,
  showNavigationControl: false,
  imageSmoothingEnabled: false,
  drawer: "canvas",
  // Provide OSD with initial set of tiles
  tileSources: tileSources["regular-main-branch"],
  subPixelRoundingForTransparency: OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS,
  smoothTileEdgesMinZoom: 1,
  minScrollDeltaTime: 10,
  springStiffness: 50,
  preserveViewport: true,
  gestureSettingsMouse: {
    clickToZoom: false,
  },
  opacity: 1,
});

// Setup searching in IIFE to avoid polluting the global scope
(() => {
  const index = FlexSearch.Document({
    document: {
      index: "text",
      store: ["text", "maps", "x", "y", "width", "height"],
    },
    tokenize: "forward",
  });
  for (let array of Object.values(overlayTexts)) {
    for (let overlay of array) {
      index.add(overlay);
    }
  }

  const getCurrentMap = () => {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("map") || "regular-main-branch";
  };

  function withSlowOSDAnimation(viewport, f) {
    // save old ones
    var oldValues = {};
    oldValues.centerSpringXAnimationTime = viewport.centerSpringX.animationTime;
    oldValues.centerSpringYAnimationTime = viewport.centerSpringY.animationTime;
    oldValues.zoomSpringAnimationTime = viewport.zoomSpring.animationTime;

    // set our new ones
    viewport.centerSpringX.animationTime =
      viewport.centerSpringY.animationTime =
      viewport.zoomSpring.animationTime =
        20;

    // callback
    f();

    // restore values
    viewport.centerSpringX.animationTime = oldValues.centerSpringXAnimationTime;
    viewport.centerSpringY.animationTime = oldValues.centerSpringYAnimationTime;
    viewport.zoomSpring.animationTime = oldValues.zoomSpringAnimationTime;
  }

  const panToOverlay = (overlay) => {
    const overlayCenter = new OpenSeadragon.Point(overlay.x + overlay.width / 2, overlay.y + overlay.height / 2);
    const arbitraryZoomLevel = 0.002;
    withSlowOSDAnimation(os.viewport, function () {
      os.viewport.panTo(overlayCenter).zoomTo(arbitraryZoomLevel);
    });
  };

  searchInput.addEventListener("search", function (event) {
    if (event.type === "search") {
      if (event.currentTarget.value === "") searchInput.value = "";
      searchResults.innerHTML = "";
    }
  });

  searchInput.addEventListener("keyup", () => {
    searchResults.innerHTML = "";
    const query = searchInput.value;
    if (!query) {
      return;
    }

    const results = index.search(query, { enrich: true });
    if (results.length === 0) {
      return;
    }

    const currentMap = getCurrentMap();
    for (let result of results[0].result) {
      if (!result.doc.maps.includes(currentMap)) {
        continue;
      }

      const listItem = document.createElement("li");
      listItem.className = "search-result";
      listItem.innerHTML = result.doc.text.join("; ");
      listItem.addEventListener("mouseup", () => {
        panToOverlay(result.doc);
      });
      searchResults.appendChild(listItem);
    }
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
    }
  });
})();

let prevTiledImage;
let nextTiledImage;

const coordElement = document.getElementById("coordinate");

// Mouse tracker for displaying coordinates
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
    const chunkX = Math.floor(viewportPoint.x / CHUNK_SIZE).toString();
    const chunkY = Math.floor(viewportPoint.y / CHUNK_SIZE).toString();
    coordElement.children[0].innerHTML = `(${pixelX}, ${pixelY})<br>chunk: (${chunkX}, ${chunkY})`;
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

// Function to get map version URLs
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
  // We don't want to fetch a cached version of the manifest!
  const versions = {};
  const urls = mapVersionUrls(mapName);
  const promises = urls.map((url) =>
    fetch(url, {
      // Commented out because it's causing CORS issues
      // headers: { 'cache-control': 'no-cache' }
    })
      .then((res) => {
        // Gotta check the response, otherwise the body content doesn't represent what you think it does
        if (!res.ok) {
          throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
        }
        return res.text();
      })
      .catch((err) => {
        console.error(err);
        // Create a synthetic cache bust string if anything errored
        return Math.random().toString(36).slice(2);
      })
      .then((body) => {
        const origin = new URL(url).origin;
        versions[origin] = encodeURIComponent(body.trim());
      })
  );
  // Wait for all requests to have set their key, then return the object
  return Promise.all(promises).then(() => versions);
}

// Function to hide overlays (if needed)
const hideOverlays = () => {
  overlaysSwitchWrapper.classList.add("hidden");
};

// Function to display overlays (if needed)
const displayOverlays = () => {
  overlaysSwitchWrapper.classList.remove("hidden");
};

// Function to draw overlay items
const drawOverlayItems = (items) => {
  items.forEach(({ id, text, x, y, width, height }) => {
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
};

// Change map function encapsulated in an IIFE
const changeMap = (() => {
  let cacheBustHandler = undefined;

  // Function to set the active map
  function setActiveMap(mapName) {
    const currentMapLink = document.querySelector(`#navLinksList [data-map-key=${mapName}]`);
    if (!currentMapLink) return;

    // Remove "active" class from any nav links that still have it
    document.querySelectorAll("#navLinksList .nav-link.active").forEach((el) => {
      el.classList.remove("active");
    });

    // Add "active" class to the nav-link identified by `mapName`
    currentMapLink.classList.add("active");

    // Modify the DOM to show the current map name based on the contents of the link
    document.getElementById("currentMapName").innerHTML = currentMapLink.innerHTML;

    // Handle map-specific UI adjustments
    switch (mapName) {
      case "regular-main-branch":
      case "regular-beta":
      case "new-game-plus-main-branch":
        document.body.classList.remove("toggle-hidden");
        // Enable or disable togglers based on map support
        updateTogglersBasedOnMap(mapName);
        break;
      default:
        document.body.classList.add("toggle-hidden");
        document.querySelectorAll(".overlayToggler").forEach((toggler) => {
          toggler.disabled = true;
          toggler.checked = false;
        });
        break;
    }

    updateOverlayVisibility(); // Update overlay visibility based on toggler states

    // Update URL to refer to the selected map
    const updatedUrlParams = new URLSearchParams(window.location.search);
    updatedUrlParams.set("map", mapName);
    window.history.replaceState(null, "", "?" + updatedUrlParams.toString());

    addTooltips();
  }

  // Function to update togglers' disabled state based on the current map
  function updateTogglersBasedOnMap(mapName) {
    // Determine which overlay types are supported by the current map
    const supportedOverlayTypes = ["structures", "bosses", "items", "orbAreas"];
    supportedOverlayTypes.forEach((type) => {
      const isSupported = overlayTexts[type].some((overlay) => overlay.maps.includes(mapName));
      const toggler = getTogglerByType(type);
      if (toggler) {
        toggler.disabled = !isSupported;
        if (!isSupported) {
          toggler.checked = false;
          // Ensure overlays are hidden if the toggler is disabled
          removeOverlaysByType(type);
        }
      }
    });
  }

  // Utility function to get toggler element by overlay type
  function getTogglerByType(type) {
    switch (type) {
      case "structures":
        return structuresOverlaysSwitch;
      case "orbAreas":
        return orbsOverlaysSwitch;
      case "bosses":
        return bossesOverlaysSwitch;
      case "items":
        return itemsOverlaysSwitch;
      default:
        return null;
    }
  }

  function updateOverlayVisibility() {
    const urlParams = new URLSearchParams(window.location.search);
    const currentMap = urlParams.get("map") || "regular-main-branch";

    // Handle structures overlay
    if (structuresOverlaysSwitch.checked && isOverlaySupported("structures", currentMap)) {
      addOverlaysByType("structures", currentMap);
    } else {
      removeOverlaysByType("structures");
    }

    // Handle orbs overlay
    if (orbsOverlaysSwitch.checked && isOverlaySupported("orbAreas", currentMap)) {
      addOverlaysByType("orbAreas", currentMap);
    } else {
      removeOverlaysByType("orbAreas");
    }

    // Handle bosses overlay
    if (bossesOverlaysSwitch.checked && isOverlaySupported("bosses", currentMap)) {
      addOverlaysByType("bosses", currentMap);
    } else {
      removeOverlaysByType("bosses");
    }

    // Handle items overlay
    if (itemsOverlaysSwitch.checked && isOverlaySupported("items", currentMap)) {
      addOverlaysByType("items", currentMap);
    } else {
      removeOverlaysByType("items");
    }
  }

  // Function to check if a particular overlay type is supported by the current map
  function isOverlaySupported(type, mapName) {
    return overlayTexts[type].some((overlay) => overlay.maps.includes(mapName));
  }

  function addOverlaysByType(type, mapName) {
    if (!overlayTexts[type]) return;

    const filteredOverlays = overlayTexts[type].filter(({ maps }) => maps.includes(mapName));

    filteredOverlays.forEach(({ id, text, x, y, width, height }) => {
      if (!document.getElementById(`overlayId${id}`)) {
        // Check if overlay already exists
        let e = document.createElement("div");
        e.id = `overlayId${id}`;
        e.className = "osOverlayHighlight";
        e.innerHTML = `<span id="span${id}">${text}</span>`;
        os.addOverlay({
          element: e,
          location: new OpenSeadragon.Rect(x, y, width, height),
        });
        const hue = Math.floor(Math.random() * 360);
        e.style.backgroundColor = `hsla(${hue}, 60%, 60%, 0.5)`;
      }
    });
  }

  // Function to remove overlays by type
  function removeOverlaysByType(type) {
    if (!overlayTexts[type]) return;

    overlayTexts[type].forEach(({ id }) => {
      const overlayElement = document.getElementById(`overlayId${id}`);
      if (overlayElement) {
        os.removeOverlay(overlayElement.id);
        overlayElement.remove();
      }
    });
  }

  // Attach event listeners to each toggle switch
  structuresOverlaysSwitch.addEventListener("change", () => handleOverlayToggle("structures"));
  orbsOverlaysSwitch.addEventListener("change", () => handleOverlayToggle("orbAreas"));
  bossesOverlaysSwitch.addEventListener("change", () => handleOverlayToggle("bosses"));
  itemsOverlaysSwitch.addEventListener("change", () => handleOverlayToggle("items"));

  // Handle individual overlay toggles
  function handleOverlayToggle(type) {
    const urlParams = new URLSearchParams(window.location.search);
    const currentMap = urlParams.get("map") || "regular-main-branch";

    if (getTogglerByType(type).checked && isOverlaySupported(type, currentMap)) {
      addOverlaysByType(type, currentMap);
    } else {
      removeOverlaysByType(type);
    }
  }

  // Function to load the map
  async function loadMap(mapName) {
    const mapTiles = tileSources[mapName] || [];

    // Do nothing for invalid mapName
    if (mapTiles.length === 0) {
      console.error("Invalid mapname =", mapName);
      return;
    }

    const versions = await fetchMapVersions(mapName);

    // When we change maps, remove the old handler so it doesn't interfere...
    if (cacheBustHandler) {
      os.world.removeHandler("add-item", cacheBustHandler);
      cacheBustHandler = undefined;
    }

    // Create the new handler
    cacheBustHandler = (event) => {
      // Append cacheKeys to the images
      // xxx.png?v=UNIX_TIMESTAMP
      // Each Map has their own timestamps
      event.item.source.queryParams = `?v=${versions[new URL(event.item.source.tilesUrl).origin]}`;
      console.log(event.item.source.queryParams);
    };
    os.world.addHandler("add-item", cacheBustHandler);

    // Clear the map...
    os.world.removeAll();

    // ... add the new tiles ...
    for (const url of mapTiles) {
      // Assumes "url" from tileSource does not already include a query string parameter
      os.addTiledImage({ tileSource: url });
    }

    // ... and redraw the map
    os.forceRedraw();
  }

  // Return the main function to change the map
  return async (mapName) => {
    await loadMap(mapName);
    setActiveMap(mapName);
  };
})();

// Handle map opening
os.addHandler("open", async (event) => {
  const viewport = event.eventSource.viewport;
  const urlParams = new URLSearchParams(window.location.search);
  const mapName = String(urlParams.get("map") ?? "regular-main-branch");
  await changeMap(mapName);

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

// Loading indicator function
function updateLoadingIndicator(isFullyLoaded, indicator = document.querySelector(".loadingIndicator")) {
  if (isFullyLoaded) {
    indicator.style.display = "none";
  } else {
    indicator.style.display = "block";
  }
}

// Track load status for each TiledImage
os.world.addHandler("add-item", function (event) {
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

// Align OSD coordinate system with the Noita world coordinate system
os.world.addHandler("add-item", (event) => {
  /** @type {{Format: string, Overlap: string, Size: {Width: string, Height: string}, TileSize: string, TopLeft: {X: string, Y: string}}} */
  // @ts-ignore
  const image = event.item.source.Image;
  event.item.setPosition(new OpenSeadragon.Point(Number(image.TopLeft.X), Number(image.TopLeft.Y)), true);
  event.item.setWidth(Number(image.Size.Width), true);
});

// Function to reset zoom level
function resetZoom() {
  os.viewport.goHome();
}

// Function to copy URL to the clipboard for sharing
function getShareUrl() {
  window.navigator.clipboard.writeText(window.location.href);
}

// Function to remove all existing overlays
function removeAllOverlays() {
  document.querySelectorAll(".osOverlayHighlight").forEach((overlay) => {
    os.removeOverlay(overlay.id);
    overlay.remove(); // Also remove the overlay element from the DOM
  });
}

// Function to add tooltips
function addTooltips() {
  const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
  const tooltipList = [...tooltipTriggerList].map((tooltipTriggerEl) => new bootstrap.Tooltip(tooltipTriggerEl));
}

// Function to handle the animation-finish event to update URL parameters
os.addHandler("animation-finish", function (event) {
  const center = event.eventSource.viewport.getCenter();
  const zoom = event.eventSource.viewport.getZoom();
  const urlParams = new URLSearchParams(window.location.search);
  urlParams.set("x", center.x.toFixed(0));
  urlParams.set("y", center.y.toFixed(0));
  urlParams.set("zoom", (Math.log2(zoom) * -100).toFixed(0));
  window.history.replaceState(null, "", "?" + urlParams.toString());
});

// DOMContentLoaded event to initialize map links and tooltips
document.addEventListener("DOMContentLoaded", () => {
  const navLinksUl = document.getElementById("navLinksList");
  if (!navLinksUl) return;

  const formatDate = (d) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(d));

  for (const def of mapDefinitions) {
    const a = document.createElement("a");
    a.classList.add("nav-link", "text-nowrap");
    a.href = "#";
    a.dataset.bsToggle = "pill";
    a.dataset.mapKey = def.key;
    a.textContent = def.label + " ";

    const badges = [...def.badges];
    badges.push({
      label: formatDate(def.patchDate),
      class: ["border", "border-info-subtle", "ms-2"],
    });

    for (const badge of badges) {
      const span = document.createElement("span");
      span.classList.add("badge");
      if (typeof badge.class === "string") {
        span.classList.add(badge.class);
      } else {
        badge.class.forEach((styleClass) => span.classList.add(styleClass));
      }

      // Add explanatory tooltips to patchdate badges only if applicable
      if (span.classList.contains("border-info-subtle")) {
        span.dataset.bsToggle = "tooltip";
        span.dataset.bsPlacement = "top";
        span.dataset.bsTitle = "Patch date this map was captured";
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

  // Handle map link clicks
  navLinksUl.addEventListener("click", async (ev) => {
    const mapKey = ev.target.dataset.mapKey;
    if (!mapKey) return;
    ev.stopPropagation();
    ev.preventDefault();
    await changeMap(mapKey);
  });
});

// Utility function to add tooltips (duplicated to ensure functionality)
function addTooltips() {
  const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
  const tooltipList = [...tooltipTriggerList].map((tooltipTriggerEl) => new bootstrap.Tooltip(tooltipTriggerEl));
}

// Drawing toggle (assuming annotations are managed elsewhere)
const drawingToggleSwitch = document.getElementById("drawingToggleSwitch");

// Function to erase drawings
function eraseDrawings() {
  if (os.annotations && typeof os.annotations.clean === "function") {
    os.annotations.clean();
    console.log("cleared");
  }
}

// Uncomment and implement annotations if needed
// drawingToggleSwitch.addEventListener("change", (event) => {
//   if (event.currentTarget.checked && os.areAnnotationsActive() == false) {
//     os.initializeAnnotations();
//     console.log("checked");
//   } else {
//     os.shutdownAnnotations();
//     console.log("not checked");
//   }
// });

// Initialize Bootstrap popovers
const popoverTriggerList = document.querySelectorAll('[data-bs-toggle="popover"]');
const popoverList = [...popoverTriggerList].map((popoverTriggerEl) => new bootstrap.Popover(popoverTriggerEl));

const popover = new bootstrap.Popover(".popover-dismiss", {
  trigger: "focus",
});
