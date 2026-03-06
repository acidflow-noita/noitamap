import JSZip from "jszip";
import { readFileSync } from "fs";
import { decode } from "fast-png";

const data = readFileSync("public/data.zip");
const zip = await JSZip.loadAsync(data);
const buf = await zip.file("data/biome_maps/biome_map.png").async("nodebuffer");
const decoded = decode(buf);
const pixels = decoded.data;
const ch = decoded.channels;
const allColors = new Set();
for (let i = 0; i < decoded.width * decoded.height; i++) {
  const r = pixels[i * ch],
    g = pixels[i * ch + 1],
    b = pixels[i * ch + 2];
  allColors.add("0x" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0"));
}
console.log("channels:", ch);
console.log("Unique biome colors:", [...allColors].join(" "));
