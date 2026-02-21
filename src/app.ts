import { MapName } from './data_sources/tile_data';
import { AppOSD, ZoomPos } from './app_osd';
import { getAllOverlays, OverlayKey, showOverlay, TargetOfInterest } from './data_sources/overlays';
import { getAllMapDefinitions, MapDefinition } from './data_sources/map_definitions';

export type AppState = {
  pos: ZoomPos;
  map: MapName;
};

export type AppCreateOpts = {
  mountTo: HTMLElement;
  overlayButtons: HTMLDivElement;
  initialState: Partial<AppState>;
  useWebGL: boolean;
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
      const overlayLabel = this.overlayButtons.querySelector(`label[for="${overlayToggle.id}"]`) as HTMLLabelElement;

      overlayToggle.disabled = !enabled;

      if (!enabled) {
        overlayToggle.checked = false;
        showOverlay(key as OverlayKey, false);

        // Dispose of any existing popover first
        const existingPopover = bootstrap.Popover.getInstance(overlayLabel);
        if (existingPopover) {
          existingPopover.dispose();
        }

        // Add popover for disabled buttons
        overlayLabel.setAttribute('data-bs-toggle', 'popover');
        overlayLabel.setAttribute('data-bs-placement', 'top');
        overlayLabel.setAttribute('data-bs-trigger', 'hover focus');
        overlayLabel.setAttribute('data-i18n-title', 'overlay.notAvailable.title');
        overlayLabel.setAttribute('data-bs-title', 'Not Available');
        overlayLabel.setAttribute('data-i18n-content', 'overlay.notAvailable.content');
        overlayLabel.setAttribute('data-bs-content', 'Not available for this map');
        overlayLabel.setAttribute('tabindex', '0');

        // Initialize the popover
        new bootstrap.Popover(overlayLabel);
      } else {
        // Dispose of existing popover if any
        const existingPopover = bootstrap.Popover.getInstance(overlayLabel);
        if (existingPopover) {
          existingPopover.dispose();
        }

        // Restore original popover attributes for enabled buttons
        overlayLabel.setAttribute('data-bs-toggle', 'popover');
        overlayLabel.setAttribute('data-bs-placement', 'top');
        overlayLabel.setAttribute('data-bs-trigger', 'hover focus');
        overlayLabel.setAttribute('data-i18n-title', `${key}.title`);
        overlayLabel.setAttribute('data-i18n-content', `${key}.content`);

        // Initialize the restored popover
        new bootstrap.Popover(overlayLabel);
      }
    }
  }

  public getMap(): MapName {
    return this.state.map;
  }

  public getMapDef(mapName: MapName): MapDefinition | undefined {
    const mapDefs = getAllMapDefinitions();
    const mapDefEntry = mapDefs.find(([name, _]) => name === mapName);
    return mapDefEntry ? mapDefEntry[1] : undefined;
  }

  public async setMap(mapName: MapName): Promise<void> {
    if (this.state.map === mapName) return;

    await this.osd.setMap(mapName, this.state.pos);
    this.state.map = mapName;

    this.updateOverlaySelectors();
    this.emit('state-change', this.state);

    // Update translations after map change to refresh popovers
    import('./i18n-dom').then(({ updateTranslations }) => {
      updateTranslations();
    });
  }

  public goto(toi: TargetOfInterest) {
    let x = (toi as any).x;
    let y = (toi as any).y;

    if (toi.overlayType === 'aoi') {
      x += (toi as any).width / 2;
      y += (toi as any).height / 2;
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
