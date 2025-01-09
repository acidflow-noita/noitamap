import { MapName } from './data_sources/tile_data';
import { AppOSD, ZoomPos } from './app_osd';
import { getAllOverlays, OverlayKey, showOverlay, TargetOfInterest } from './data_sources/overlays';

export type AppState = {
  pos: ZoomPos;
  map: MapName;
};

export type AppCreateOpts = {
  mountTo: HTMLElement;
  overlayButtons: HTMLDivElement;
  initialState: Partial<AppState>;
  useWebGL?: boolean;
};

type AppConstructOpts = {
  initialState: AppState;
  overlayButtons: HTMLDivElement;
  osd: AppOSD;
};

export type StateUpdateCallback = (state: AppState) => void;

export interface App {
  on(event: 'state-change', listener: (state: AppState) => void): this;
  on(event: 'loading-change', listener: (isLoading: boolean) => void): this;
}

export class App extends EventEmitter2 {
  readonly osd: AppOSD;
  private state: AppState;
  private overlayButtons: HTMLDivElement;

  private constructor({ initialState, osd, overlayButtons }: AppConstructOpts) {
    super();

    this.osd = osd;
    this.state = initialState;
    this.overlayButtons = overlayButtons;

    this.bindHandlers();
    this.updateOverlaySelectors();
  }

  private updateZoomPos(zoomPos: Partial<ZoomPos>): void {
    this.state.pos = {
      ...this.state.pos,
      ...zoomPos,
    };
    this.emit('state-change', this.state);
  }

  private bindHandlers() {
    const osd = this.osd;

    osd.onLoading(isLoading => this.emit('loading-change', isLoading));

    osd.addHandler('viewport-change', () => {
      this.updateZoomPos(osd.getZoomPos());
    });
    // Dirty fix for Wiki links not working with left mouse button
    osd.addHandler('canvas-click', ev => {
      const target = ev.originalTarget;

      if (target instanceof HTMLAnchorElement && target.href && target.classList.contains('wikiLink')) {
        ev.originalEvent.preventDefault();
        window.open(target.href, '_blank');
      }
    });
  }

  private updateOverlaySelectors() {
    const currentMap = this.state.map;
    const enableOverlayButton: Record<OverlayKey, boolean> = {} as any;

    // figure out, for each kind of overlay, if its button should be
    // enabled or disabled. buttons should be disabled if none of
    // the overlays are present on this map
    for (const [key, overlayDatas] of getAllOverlays()) {
      // each iteration is a type of overlay (orb, boss, etc)
      // `key` is the name (an OverlayKey)

      // of all the overlays for this type, do _any_ of them (array.some)
      // have a "maps" property that includes currentMap?
      enableOverlayButton[key] = overlayDatas.some(data =>
        //
        data.maps.includes(currentMap)
      );
    }

    // go through the results and apply disabled to the overlay buttons
    // that should be disabled
    for (const [key, enabled] of Object.entries(enableOverlayButton)) {
      const overlayToggle = this.overlayButtons.querySelector(`input[data-overlay-key="${key}"]`) as HTMLInputElement;
      overlayToggle.disabled = !enabled;
      if (!enabled) {
        overlayToggle.checked = false;
        showOverlay(key as OverlayKey, false);
      }
    }
  }

  public getMap(): MapName {
    return this.state.map;
  }

  public async setMap(mapName: MapName): Promise<void> {
    if (this.state.map === mapName) return;

    await this.osd.setMap(mapName, this.state.pos);
    this.state.map = mapName;

    this.updateOverlaySelectors();
    this.emit('state-change', this.state);
  }

  public goto(toi: TargetOfInterest) {
    let x = toi.x;
    let y = toi.y;

    if (toi.overlayType === 'aoi') {
      x += toi.width / 2;
      y += toi.height / 2;
    }

    this.updateZoomPos({
      x,
      y,
    });
    this.osd.panToTarget(x, y);
  }

  public home() {
    this.osd.viewport.fitBounds(this.osd.getCombinedItemsRect());
  }

  static async create({ mountTo, overlayButtons, initialState, useWebGL }: AppCreateOpts) {
    const mapName = initialState.map ?? 'regular-main-branch';
    const osd = new AppOSD(mountTo, useWebGL);

    // if we do not have an initial position, we have to fully initialize
    // OpenSeadragon so that we can zoom it to fit and get what the position
    // _should_ be...
    await osd.setMap(mapName, initialState.pos);

    // our app _requires_ that we have a known position, so we initialize
    // it after we've figured out the ZoomPos data from AppOSD
    return new App({
      overlayButtons,
      initialState: {
        pos: osd.getZoomPos(),
        map: mapName,
      },
      osd,
    });
  }
}
