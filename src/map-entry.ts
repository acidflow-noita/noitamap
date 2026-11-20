import { AppOSD, type ZoomPos } from './app_osd';
import type { MapName } from './data_sources/tile_data';
import { parseURL } from './data_sources/url';
import { startInitialDaily } from './initial-daily';
import { getStoredRenderer } from './renderer_settings';
import { showStartupFailure, startWhenReady } from './startup';
import { negotiateTabHandoff } from './tab-coordinator';
import { assertElementById } from './util';

async function openViewer(mount: HTMLElement, map: MapName, pos?: ZoomPos) {
  const osd = new AppOSD(mount, getStoredRenderer() === 'webgl');
  try {
    await osd.openBaseMap(map, pos);
    document.getElementById('loadingIndicator')?.style.setProperty('display', 'none');
    return { osd, map };
  } catch (error) {
    osd.viewer.destroy();
    throw error;
  }
}

const handoff = negotiateTabHandoff();
startWhenReady(async () => {
  if (!await handoff) return;
  const route = parseURL();
  const mount = assertElementById('osContainer', HTMLElement);
  const opening = openViewer(mount, route.map ?? 'dynamic-main-branch', route.pos).catch(error => {
    console.warn('[Noitamap] Map failed to open, falling back to regular-main-branch:', error);
    return openViewer(mount, 'regular-main-branch', route.pos);
  });
  const daily = startInitialDaily(route, opening);
  const [{ initializeMapUI, reportMapStartupFailure }, opened] = await Promise.all([import('./main'), opening]);
  await initializeMapUI(opened.osd, opened.map, route, daily).catch(reportMapStartupFailure);
}, showStartupFailure);
