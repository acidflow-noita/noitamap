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

let konamiIndex = 0;

function handleKonamiCode(event: KeyboardEvent) {
  if (event.key === konamiCode[konamiIndex]) {
    konamiIndex++;
    if (konamiIndex === konamiCode.length) {
      konamiIndex = 0;
      showMaggotOverlay();
    }
  } else {
    konamiIndex = 0;
  }
}

function showMaggotOverlay() {
  const overlay = document.createElement('div');
  overlay.classList.add('maggot-overlay');

  for (let i = 0; i < 300; i++) {
    const maggot = document.createElement('img');
    maggot.src = 'assets/icons/puns/maggot.webp';
    maggot.classList.add('maggot');
    maggot.style.left = `${Math.random() * 100}vw`;
    maggot.style.top = `${Math.random() * 100}vh`;
    const scale = Math.random() * 2 + 0.1;
    const rotation = Math.random() * 360;
    maggot.style.transform = `scale(${scale}) rotate(${rotation}deg)`;
    overlay.appendChild(maggot);
  }

  document.body.appendChild(overlay);

  setTimeout(() => {
    overlay.remove();
  }, 10000);
}

export function initKonamiCode() {
  window.addEventListener('keydown', handleKonamiCode);
}
