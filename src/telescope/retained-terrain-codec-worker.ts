import {
  decodeTerrainPage,
  encodeTerrainPages,
} from "./retained-terrain-codec-core";

self.onmessage = ({ data }) => {
  try {
    const pages =
      data.type === "encode"
        ? encodeTerrainPages(data.pages)
        : data.type === "decode"
          ? data.pages.map(decodeTerrainPage)
          : (() => {
              throw new Error("Unknown retained terrain codec operation");
            })();
    const transfer = pages.map(
      (page: any) => page.pixels?.buffer ?? page.data.buffer,
    );
    self.postMessage({ id: data.id, pages }, { transfer });
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
