import JSZip from "jszip";
import fs from "fs";
import path from "path";

async function listZip(zipPath: string) {
  const fullPath = path.resolve(process.cwd(), "public", zipPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Zip not found: ${fullPath}`);
    return;
  }
  const data = fs.readFileSync(fullPath);
  const zip = await JSZip.loadAsync(data);
  console.log(`Contents of ${zipPath}:`);
  zip.forEach((relativePath) => {
    console.log(relativePath);
  });
}

const zipFile = process.argv[2];
if (!zipFile) {
  console.error("Please provide a zip filename (e.g. pixel_scenes.zip)");
} else {
  listZip(zipFile).catch(console.error);
}
