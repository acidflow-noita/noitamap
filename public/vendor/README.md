# Pinned browser dependencies

- OpenSeadragon 6.1.0: copied from the locked npm package's browser build, with
  its BSD license. The HTML carries a SHA-384 integrity check.
- Bootstrap Icons 1.13.1: the npm release's font stylesheet and WOFF/WOFF2 files,
  with its MIT license. This matches the previous CDN version.
- Inter 4.1 is in `../fonts/inter-4.1/`, from the official rsms/inter v4.1 release,
  with the SIL Open Font License. Both normal and italic variable fonts retain
  the number-formatting features used by the UI and result images.

These files are served by the map origin. Do not replace them with unpinned CDN
scripts or stylesheets. Keep license files when updating versions.
