const playerSpriteUrl = 'https://noitamap-pro.acidflow.stream/images/animatedSprites/player.webp';

declare const OpenSeadragon: any;

let playerItem: HTMLElement | null = null;
let isLoading = false;

export function togglePlayer(viewer: any) {
  if (playerItem) {
    viewer.removeOverlay(playerItem);
    playerItem = null;
  } else if (!isLoading) {
    const imgElement = document.createElement('img');
    imgElement.src = playerSpriteUrl;
    imgElement.id = 'player-sprite-overlay';

    imgElement.style.imageRendering = 'pixelated';
    imgElement.style.width = '100%';
    imgElement.style.height = '100%';

    viewer.addOverlay({
      element: imgElement,
      location: new OpenSeadragon.Rect(212, -88, 12, 19),
    });

    isLoading = false;
    playerItem = imgElement;
  }
}
