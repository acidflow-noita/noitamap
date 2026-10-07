// Optional startup metadata must not leave the application waiting forever.
export const STARTUP_REQUEST_TIMEOUT_MS = 5000;

export function startWhenReady(start: () => Promise<void>, onError: (error: unknown) => void): void {
  let started = false;
  const launch = () => {
    if (started) return;
    started = true;
    void (async () => {
      try { await start(); }
      catch (error) { onError(error); }
    })();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', launch, { once: true });
  else launch();
}

export function showStartupFailure(error: unknown, message: string, retryLabel: string): void {
  console.error('[Noitamap] Startup failed:', error);
  document.getElementById('loadingIndicator')?.style.setProperty('display', 'none');
  document.getElementById('map-loading-strip')?.classList.remove('visible', 'fade-out');
  if (document.getElementById('startup-error')) return;
  const panel = document.createElement('div');
  panel.id = 'startup-error';
  panel.className = 'alert alert-danger';
  panel.setAttribute('role', 'alert');
  panel.style.cssText = 'position:fixed;z-index:2000;top:50%;left:50%;transform:translate(-50%,-50%);width:min(90vw,36rem);padding:1.5rem;text-align:center;';
  const text = document.createElement('p');
  text.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-outline-light';
  retry.textContent = retryLabel;
  retry.addEventListener('click', () => window.location.reload());
  panel.append(text, retry);
  document.body.append(panel);
  retry.focus();
}
