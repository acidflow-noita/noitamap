import "./app/vendor-globals";

// Application chunks read the OSD global during module evaluation. A dynamic
// boundary guarantees installation even when the bundler regroups imports.
void import("./main").catch((error) =>
  console.error("[Noitamap] Startup modules failed:", error),
);
