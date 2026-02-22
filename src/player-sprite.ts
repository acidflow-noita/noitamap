const playerSpriteUrl = 'https://noitamap-pro.acidflow.stream/images/animatedSprites/player.webp';

let playerItem: HTMLElement | null = null;
let isLoading = false;

export function togglePlayer(viewer: OpenSeadragon.Viewer) {
  if (playerItem) {
    viewer.removeOverlay(playerItem);
    playerItem = null;
  } else if (!isLoading) {
    // Create the image element to use as an overlay
    const imgElement = document.createElement('img');
    imgElement.src = playerSpriteUrl;
    imgElement.id = 'player-sprite-overlay';

    // Natively style the image so it doesn't look blurred when zoomed
    imgElement.style.imageRendering = 'pixelated';
    imgElement.style.width = '100%';
    imgElement.style.height = '100%';

    // Add overlay to the viewer
    viewer.addOverlay({
      element: imgElement,
      location: new OpenSeadragon.Rect(212, -88, 12, 19),
    });

    isLoading = false;
    // We store the DOM ID in playerItem to know it exists
    playerItem = imgElement as any;
  }
}
