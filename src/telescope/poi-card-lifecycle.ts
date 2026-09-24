export type POICardOwner = 'map' | 'report';

export interface POICardRequest {
  isCurrent(): boolean;
  afterNavigation(arrival: Promise<boolean | void> | null, show: () => void, cancel?: () => void): void;
}

/** One visible or pending card, tied to its seed and the interaction that opened it. */
export class POICardLifecycle {
  private revision = 0;
  private active: { owner: POICardOwner; cancel?: () => void; timer?: ReturnType<typeof setTimeout> } | null = null;

  constructor(private seed: () => number | null, private removeCard: () => void) {}

  get owner(): POICardOwner | undefined { return this.active?.owner; }

  /** One Escape dismisses the card/flight before its containing report. */
  handleEscape(event: KeyboardEvent): boolean {
    if (event.key !== 'Escape' || event.cancelBubble || !this.active) return false;
    // Bootstrap's focused dropdown is the top interaction layer. Its own
    // key handler closes the menu and returns focus before the card closes.
    if (event.target instanceof Element && event.target.closest(
      '.dropdown-menu.show, [data-bs-toggle="dropdown"][aria-expanded="true"]',
    )) return false;
    // Bootstrap also preventDefault()s Escape on an already closed toggle,
    // without consuming it. Allow that next Escape to dismiss the card.
    const closedDropdownToggle = event.target instanceof Element
      && event.target.closest('[data-bs-toggle="dropdown"][aria-expanded="false"]');
    if (event.defaultPrevented && !closedDropdownToggle) return false;
    event.preventDefault();
    event.stopPropagation();
    this.close();
    return true;
  }

  /** Guard work queued before an opening, such as waiting for the report to mount. */
  guard(): () => boolean {
    const revision = this.revision, seed = this.seed();
    return () => revision === this.revision && seed === this.seed();
  }

  begin(owner: POICardOwner = 'map'): POICardRequest {
    this.close();
    const active = { owner } as NonNullable<POICardLifecycle['active']>;
    this.active = active;
    const validContext = this.guard();
    const isCurrent = () => this.active === active && validContext();
    return {
      isCurrent,
      afterNavigation: (arrival, show, cancel) => {
        if (!isCurrent()) { cancel?.(); return; }
        active.cancel = cancel;
        const arrived = (completed: boolean | void) => {
          if (!isCurrent()) return;
          active.cancel = undefined;
          active.timer = undefined;
          if (completed === false) this.close();
          else show();
        };
        if (arrival) void arrival.then(arrived, () => arrived(false));
        else active.timer = setTimeout(() => arrived(true), 250);
      },
    };
  }

  close(options?: { reportOnly?: boolean }): boolean {
    if (options?.reportOnly && this.active?.owner !== 'report') return false;
    const active = this.active;
    this.active = null;
    this.revision++;
    if (active?.timer !== undefined) clearTimeout(active.timer);
    active?.cancel?.();
    this.removeCard();
    return true;
  }
}
