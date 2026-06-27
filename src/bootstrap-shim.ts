/*
 * Temporary no-op Bootstrap shim for the Tailwind/Basecoat migration.
 *
 * Bootstrap's CSS + JS were removed in the atomic cutover (Task 1). The scattered
 * `bootstrap.*` calls (popovers, dropdowns, toasts, modals) are converted to Basecoat
 * one surface at a time (Tasks 2-7); until each is converted, this shim keeps those
 * calls from throwing "ReferenceError: bootstrap is not defined".
 *
 * REMOVE this file and its import in main.ts in Task 8, once no `bootstrap.` refs remain.
 */
const noop = (): void => {};

class StubInstance {
  show = noop;
  hide = noop;
  toggle = noop;
  dispose = noop;
  update = noop;
  enable = noop;
  disable = noop;
}

class StubComponent extends StubInstance {
  constructor(..._args: unknown[]) {
    super();
  }
  static getInstance(): StubInstance | null {
    return null;
  }
  static getOrCreateInstance(): StubInstance {
    return new StubInstance();
  }
}

const w = window as unknown as { bootstrap?: Record<string, unknown> };
w.bootstrap = w.bootstrap || {
  Popover: StubComponent,
  Tooltip: StubComponent,
  Dropdown: StubComponent,
  Toast: StubComponent,
  Modal: StubComponent,
  Collapse: StubComponent,
  Offcanvas: StubComponent,
  Tab: StubComponent,
  Alert: StubComponent,
};

export {};
