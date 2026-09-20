import { resolve, sep } from "node:path";

function isWithin(path: string, directory: string) {
  return path === directory || path.startsWith(directory + sep);
}

/** Prune scratch checkouts before Chokidar follows their Wine/system symlinks. */
export function ignoreTaskScratch(root: string, localProRoot?: string) {
  const taskRoot = resolve(root, "task");
  const proRoot = localProRoot ? resolve(localProRoot) : undefined;

  return (path: string) => {
    const absolutePath = resolve(path);
    if (!isWithin(absolutePath, taskRoot)) return false;

    // Keep the active Pro checkout AND its ancestors traversable for HMR.
    return !(
      proRoot &&
      (isWithin(absolutePath, proRoot) || isWithin(proRoot, absolutePath))
    );
  };
}
