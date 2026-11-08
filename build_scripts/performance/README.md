The workflow builds the candidate, its first parent and the fixed reference once
in isolated local clones. Builds can run in parallel; the candidate type and
unit checks run once. The six browser jobs still use separate standard runners:
Chromium and Firefox, three paired trials each. Each runner measures all three
revisions sequentially with the existing cold/warm/reload, mod-navigation,
baked-Daily and pan/zoom checks. Thresholds and repeat counts are unchanged.

`package-versions.mjs` packages only the three public `dist` trees, the benchmark
scripts and the candidate's installed `playwright`/`playwright-core` packages.
Identical files are hard-linked before compression, so the shared archive stores
common assets once. Its paths are relative to its versions manifest and work
after extraction on another runner. The archive is capped at 256 MiB and kept
for one day; compact reports and build logs remain available for seven days.

The browser jobs use the [official Playwright image](https://playwright.dev/docs/docker)
whose version matches those installed packages. They do not check out source,
install the application's packages or rebuild the site. They use the standard
runner UID (1001), matching the mounted home directory required by Firefox.
Mesa/Xauth and browser executables are checked before measurement; a missing
dependency fails setup explicitly instead of starting another installation.
The existing Mesa renderer and pixel-readback checks remain mandatory.

Build commands have individual timeouts and progress messages. Job and step
limits also bound shared preparation, artifact transfer and measurement. Setup
outcomes are saved separately from measured results. The overall verdict stays
HOLD for failed preparation or missing trials, without presenting an installation
failure as a measured map slowdown. Ordinary timing warnings remain REVIEW
unless `enforceTiming` is enabled in `config.json`.

Packaging and report tests need no browser. Run them with:

```sh
npm test -- tests/performance-packaging.test.ts tests/performance-comparison.test.ts tests/performance-preflight.test.ts tests/performance-trials.test.ts tests/performance-report.test.ts
```

Actual runner-time savings and container graphics compatibility must be checked
in the next GitHub Actions run. A local unit test or successful Pages deployment
does not establish those results. Manual browser testing remains separate.
