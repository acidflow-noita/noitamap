interface ProModule {
  init(hooks: NoitamapProHooks): void | Promise<void>;
}

/** Use a local checkout only in development and only when it actually exists. */
export async function loadProModule(): Promise<ProModule> {
  if (import.meta.env.DEV && __LOCAL_PRO_AVAILABLE__) {
    return import("virtual:noitamap-pro");
  }

  // Public checkouts do not include the private sibling repo. They use the
  // same hosted bundle as production; authentication stays inside that bundle.
  // The host build stamp busts old caches, while no-cache also revalidates
  // after Pro-only deployments that do not change the host build stamp.
  const proUrl = `https://noitamap-pro.acidflow.stream/pro.js?v=${__BUILD_VERSION__}`;
  const response = await fetch(proUrl, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Failed to fetch Pro bundle: HTTP ${response.status}`);
  }

  const code = await response.text();
  const blobUrl = URL.createObjectURL(
    new Blob([code], { type: "application/javascript" }),
  );
  try {
    return await import(/* @vite-ignore */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
