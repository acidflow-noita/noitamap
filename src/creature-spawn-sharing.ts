export type SpawnShareNotice = 'locked' | 'unavailable' | null;

interface SpawnSharingHooks {
  loadSpawn(creatureId: string): Promise<string | null>;
  apply(rawSpawn: string, frame: boolean): boolean;
  clearFocus(): void;
  writeRequest(creatureId?: string): void;
  notice(status: SpawnShareNotice): void;
}

/** Auth and map readiness can settle in either order. Keep the requested ID
 * through login, but never let a stale fetch revive a dismissed/replaced view. */
export function createCreatureSpawnSharing(hooks: SpawnSharingHooks, initialId?: string, frame = true) {
  let requested = initialId;
  let entitled: boolean | undefined;
  let mapReady = false;
  let active = false;
  let loading = false;
  let revision = 0;

  function invalidate() {
    revision++;
    loading = false;
    active = false;
    hooks.clearFocus();
  }

  function restore() {
    if (!requested || entitled === undefined) { hooks.notice(null); return; }
    if (!entitled) { hooks.notice('locked'); return; }
    hooks.notice(null);
    if (!mapReady || active || loading) return;
    const id = requested, version = ++revision;
    loading = true;
    const current = () => revision === version && requested === id && entitled && mapReady;
    void hooks.loadSpawn(id).then(raw => {
      if (!current()) return;
      active = !!raw && hooks.apply(raw, frame);
      hooks.notice(active ? null : 'unavailable');
    }).catch(() => {
      if (current()) hooks.notice('unavailable');
    }).finally(() => {
      if (revision === version) loading = false;
    });
  }

  return {
    setEntitled(value: boolean) {
      if (entitled === value) return;
      invalidate();
      entitled = value;
      restore();
    },
    setMapReady(value: boolean) {
      if (mapReady === value) return;
      if (!value) invalidate();
      mapReady = value;
      restore();
    },
    /** Record an explicit card action only after the host successfully focuses
     * its regions. Normal mode is the only shareable geometry we currently have. */
    rememberApplied(creatureId: string): boolean {
      if (!entitled || !mapReady || !creatureId) return false;
      revision++;
      loading = false;
      requested = creatureId;
      active = true;
      frame = false;
      hooks.writeRequest(creatureId);
      hooks.notice(null);
      return true;
    },
    dismiss() {
      requested = undefined;
      invalidate();
      hooks.writeRequest();
      hooks.notice(null);
    },
  };
}
