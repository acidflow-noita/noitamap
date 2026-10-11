const WORLDS = ['left', 'middle', 'right'];
const diagnosticHeaders = ['content-type', 'server', 'cf-ray', 'cf-mitigated', 'retry-after'];

export function publicResponseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => diagnosticHeaders.includes(name.toLowerCase())));
}

/** Check public prerequisites outside the measured run. Preserve denial and
 * publication errors separately from application/performance failures. */
export async function inspectDaily(fetchResource) {
  const requests = [];
  async function get(url) {
    const record = { url }; requests.push(record);
    try {
      const response = await fetchResource(url);
      Object.assign(record, { status: response.status, headers: publicResponseHeaders(response.headers ?? {}),
        bodyExcerpt: response.body.slice(0, 1024) });
      if (response.status < 200 || response.status >= 300) throw Error(`HTTP ${response.status}: ${url}`);
      return response.body;
    } catch (error) {
      record.error = String(error);
      throw error;
    }
  }
  async function all(urls) {
    // Collect every response even when one world rejects the runner.
    const outcomes = await Promise.allSettled(urls.map(get));
    const failed = outcomes.filter(outcome => outcome.status === 'rejected');
    if (failed.length) throw Error(failed.map(outcome => String(outcome.reason)).join('; '));
    return outcomes.map(outcome => outcome.value);
  }
  try {
    const [seedText, previousText, ...manifestTexts] = await all([
      'https://daily-seed.acidflow.stream/current_seed.txt',
      'https://daily-seed.acidflow.stream/previous_seed.txt',
      ...WORLDS.map(world => `https://daily-${world}.acidflow.stream/manifest.json`),
      ...WORLDS.map(world => `https://previous-daily-${world}.acidflow.stream/manifest.json`),
    ]);
    const currentSeed = Number(seedText.trim()), previousPointer = Number(previousText.trim());
    const manifests = manifestTexts.slice(0, 3).map(text => JSON.parse(text));
    const previousManifests = manifestTexts.slice(3).map(text => JSON.parse(text));
    const seed = manifests[0]?.seed, previousSeed = previousManifests[0]?.seed;
    if (![seedText, previousText].every(text => /^\d+$/.test(text.trim()))
      || ![currentSeed, previousPointer, previousSeed, seed].every(n => Number.isInteger(n) && n > 0 && n <= 0xffffffff)
      || !manifests.every(m => m.seed === seed && m.baked === true && m.complete === true)
      || !previousManifests.every(m => m.seed === previousSeed && m.baked === true && m.complete === true))
      throw Error('The three published baked worlds are incomplete or disagree');
    const urls = WORLDS.map(world => `https://daily-${world}.acidflow.stream/map.dzi`);
    const texts = await all(urls);
    const descriptors = texts.map((text, index) => {
      const json = JSON.parse(text), image = json?.Image, url = urls[index];
      if (![image?.Size?.Width, image?.Size?.Height, image?.TileSize].every(n => Number.isInteger(Number(n)) && Number(n) > 0)
        || !['webp', 'png', 'jpg', 'jpeg'].includes(image?.Format)) throw Error(`Invalid JSON DZI: ${url}`);
      return { url, json, contentType: requests.find(request => request.url === url)?.headers?.['content-type'] ?? null };
    });
    // A bake can legitimately trail the daily pointer during publication.
    // Benchmark its actual complete identity, frozen by daily-fixture.mjs.
    return { status: 'ready', daily: { seed, currentSeed, previousSeed, previousPointer, manifests, previousManifests, descriptors }, requests };
  } catch (error) {
    return { status: 'failed', failure: String(error), requests };
  }
}

export function dailyPreflightSummary(preflight) {
  if (preflight.status === 'ready') {
    const { seed, currentSeed, previousSeed, previousPointer } = preflight.daily;
    const mismatch = seed !== currentSeed || previousSeed !== previousPointer;
    return `\nBaked cases replay a captured public bake (seed ${seed}) identically across versions; these timings exclude its CDN transfer latency. Live publication/rollover behavior is not measured by the replay.${mismatch
      ? ` Seed pointers (${currentSeed}, ${previousPointer}) differ from published bakes (${seed}, ${previousSeed}); the fixture uses the published identities.` : ''}\n`;
  }
  if (preflight.status !== 'failed') return '';
  return `\n**INCOMPLETE — Daily unavailable:** ${preflight.failure}\n\nBaked-map tests could not run. Dynamic-only results follow; this workflow still fails. See daily-preflight.json for HTTP diagnostics.\n`;
}

export function performanceExitCode(comparison, config, preflight) {
  return preflight.status === 'failed' || !comparison.comparable
    || (config.enforceTiming && comparison.timingRegressions.length) ? 1 : 0;
}
