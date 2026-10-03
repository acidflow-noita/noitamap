import OpenSeadragon from "openseadragon";
// Use the bundled Popper build, matching the previously hosted UI script.
// @ts-ignore the UMD bundle does not ship a declaration
import bootstrap from "bootstrap/dist/js/bootstrap.bundle.min.js";

// These globals are also part of the hosted Pro bundle's integration API.
// Install them before any application module evaluates, from our own build.
Object.assign(window, { OpenSeadragon, bootstrap });
