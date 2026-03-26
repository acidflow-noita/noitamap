const konamiCode = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
];

const GAMBA_COUNT = 12;
const OVERLAY_COUNT = 100;
const SPAWN_DURATION = 5000; // ms to spawn all images

let konamiIndex = 0;

function handleKonamiCode(event: KeyboardEvent) {
  if (event.key === konamiCode[konamiIndex]) {
    konamiIndex++;
    if (konamiIndex === konamiCode.length) {
      konamiIndex = 0;
      showGambaOverlay();
    }
  } else {
    konamiIndex = 0;
  }
}

function showGambaOverlay() {
  const overlay = document.createElement('div');
  overlay.classList.add('easter-egg-overlay');
  document.body.appendChild(overlay);

  // Show the gambling disclaimer toast (no autohide — dismiss only via X)
  const toastEl = document.getElementById('gambaWarningToast');
  if (toastEl) {
    // @ts-ignore – bootstrap is loaded globally
    new bootstrap.Toast(toastEl, { autohide: false }).show();
  }

  // Grid-based placement: 10 columns x 10 rows = 100 cells
  // Each image is placed in its own cell with jitter for natural feel
  const COLS = 7;
  const ROWS = 7;
  const cellW = 100 / COLS; // vw per cell
  const cellH = 100 / ROWS; // vh per cell

  const images: { gifNum: number; left: string; top: string; scale: number; rotation: number }[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      for (let k = 0; k < 1; k++) {
        // Center of cell + random jitter (±30% of cell size)
        const cx = col * cellW + cellW / 2 + (Math.random() - 0.5) * cellW * 0.6;
        const cy = row * cellH + cellH / 2 + (Math.random() - 0.5) * cellH * 0.6;
        images.push({
          gifNum: Math.floor(Math.random() * GAMBA_COUNT) + 1,
          left: `${cx}vw`,
          top: `${cy}vh`,
          scale: Math.random() * 0.3 + 0.5,
          rotation: Math.random() < 0.8 ? 0 : Math.round((Math.random() * 60 - 30) * 100) / 100,
        });
      }
    }
  }

  // Shuffle spawn order so the grid fills randomly, not left-to-right
  for (let i = images.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [images[i], images[j]] = [images[j], images[i]];
  }

  // Ease-in timing: t^2.5 curve — starts slow, rapidly speeds up
  const total = images.length;
  const delays: number[] = [];
  for (let i = 0; i < total; i++) {
    const t = i / (total - 1); // 0..1
    delays.push(Math.pow(t, 2.5) * SPAWN_DURATION);
  }

  let spawned = 0;
  let animDone = false;

  // Spawn images with staggered timing
  for (let i = 0; i < total; i++) {
    setTimeout(() => {
      const cfg = images[i];
      const img = document.createElement('img');
      img.src = `assets/icons/gamba/joke${cfg.gifNum}.gif`;
      img.classList.add('easter-egg-item');
      img.style.left = cfg.left;
      img.style.top = cfg.top;
      img.style.transform = `translate(-50%, -50%) scale(${cfg.scale}) rotate(${cfg.rotation}deg)`;
      overlay.appendChild(img);

      spawned++;
      if (spawned === total) {
        animDone = true;
      }
    }, delays[i]);
  }

  // Click to dismiss — only after animation finishes
  const dismissHandler = () => {
    if (!animDone) return;
    overlay.remove();
    document.removeEventListener('click', dismissHandler);
  };
  document.addEventListener('click', dismissHandler);
}

export function initKonamiCode() {
  window.addEventListener('keydown', handleKonamiCode);
}
