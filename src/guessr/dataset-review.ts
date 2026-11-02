import {
  cameraRect,
  clampCamera,
  moveCamera,
  planView,
  viewSize,
  type Camera,
  type ClueSource,
  type ViewRect,
} from "./clue-camera";
import { ClueViewport } from "./clue-viewport";
import { setControlIcon } from "./control-icons";

type Location = ClueSource & {
  id: string;
  name: string;
  x: number;
  y: number;
  hard: boolean;
};
const places: Location[] = JSON.parse(
  document.getElementById("dataset-data")!.textContent!,
);
const byId = (id: string) => document.getElementById(id)!;
const nav = document.querySelector("nav")!;
let selected = 0,
  camera: Camera = { dx: 0, dy: 0, level: 0 },
  viewport: ClueViewport;
let pending = false,
  serial = 0;
const travel: { button: HTMLButtonElement; east: number; south: number }[] = [];
const button = (id: string) => byId(id) as HTMLButtonElement;

for (const [i, place] of places.entries()) {
  const item = document.createElement("button");
  item.textContent = `${place.id}, ${place.name}`;
  item.onclick = () => choose(i);
  nav.append(item);
}
for (const [label, icon, east, south] of [
  ["Travel north", "arrow-up", 0, -1],
  ["Travel west", "arrow-left", -1, 0],
  ["Travel south", "arrow-down", 0, 1],
  ["Travel east", "arrow-right", 1, 0],
] as const) {
  const item = document.createElement("button");
  setControlIcon(item, icon, label);
  item.dataset.direction =
    south < 0 ? "north" : south > 0 ? "south" : east < 0 ? "west" : "east";
  item.onclick = () =>
    void show(moveCamera(places[selected], camera, east, south));
  byId("travel").append(item);
  travel.push({ button: item, east, south });
}
setControlIcon(button("zin"), "zoom-in", "Zoom in");
setControlIcon(button("zout"), "zoom-out", "Zoom out");
setControlIcon(button("reset"), "arrow-counterclockwise", "Return to start");
button("zin").onclick = () =>
  void show(
    clampCamera(places[selected], { ...camera, level: camera.level - 1 }),
  );
button("zout").onclick = () =>
  void show(
    clampCamera(places[selected], { ...camera, level: camera.level + 1 }),
  );
button("reset").onclick = () =>
  void show({ dx: 0, dy: 0, level: camera.level });

function update(): void {
  const p = places[selected],
    size = viewSize(camera.level);
  byId("name").textContent = `${p.id}, ${p.name}`;
  byId("coords").textContent =
    `Starting point: ${p.x}, ${p.y}${p.hard ? ", hard candidate" : ""}`;
  byId("info").textContent =
    `${size.width} × ${size.height} native pixels, offset: ${camera.dx}, ${camera.dy} pixels`;
  button("zin").disabled = pending || camera.level === 0;
  button("zout").disabled = pending || camera.level === 6;
  button("reset").disabled = pending || (camera.dx === 0 && camera.dy === 0);
  for (const control of travel) {
    const next = moveCamera(p, camera, control.east, control.south);
    control.button.disabled =
      pending || (next.dx === camera.dx && next.dy === camera.dy);
    control.button.title =
      camera.level === 6
        ? "Zoom in to move"
        : control.button.disabled && !pending
          ? "Edge of available area"
          : control.button.getAttribute("aria-label")!;
  }
  [...nav.children].forEach((item, i) =>
    item.setAttribute("aria-current", String(i === selected)),
  );
}
function outline(rect: ViewRect): void {
  const box = byId("camera-box");
  for (const [name, value] of Object.entries(rect))
    box.setAttribute(name, String(value));
}
async function show(next: Camera): Promise<void> {
  if (pending || next.level < 0 || next.level > 6) return;
  const request = ++serial;
  pending = true;
  byId("error").textContent = "";
  update();
  try {
    await viewport.show(next, () => {
      camera = next;
      update();
    });
    if (request !== serial) return;
    const links = byId("original");
    links.replaceChildren();
    const plan = planView(places[selected], cameraRect(camera));
    for (const [i, frame] of plan.entries()) {
      const link = document.createElement("a");
      link.href = frame.image;
      link.textContent =
        plan.length === 1
          ? "Open prepared source image"
          : `Source image ${i + 1}`;
      links.append(link, document.createTextNode(" "));
    }
  } catch {
    if (request === serial)
      byId("error").textContent = "This view could not load. Try again.";
  } finally {
    if (request === serial) {
      pending = false;
      update();
    }
  }
}
function choose(index: number): void {
  serial++;
  viewport?.destroy();
  selected = index;
  pending = false;
  camera = { dx: 0, dy: 0, level: 0 };
  const place = places[selected];
  (byId("context") as HTMLImageElement).src = place.views!["0,0,6"].image;
  viewport = new ClueViewport(byId("camera"), place, 256, outline);
  viewport.canvas.id = "current";
  void show(camera);
}
choose(0);
window.addEventListener("pagehide", () => viewport.destroy());
